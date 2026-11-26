use chrono::{DateTime, Utc};
use launcher_db::{ActiveSessionRecord, DbError, InstalledGame, LauncherDb, PlaySession};
use opensync_api::OpenSyncClient;
use opensync_proton::{
    LaunchCommandSpec, ProtonError, ProtonInstallation, build_launch_command, discover_executables,
    wrap_launch_for_flatpak_host,
};
use opensync_sync::{SyncReport, sync_game_saves};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::process::Command;

/// On macOS, holds a `caffeinate` assertion for the live game process so the machine does
/// not sleep mid-session (which would interrupt tracking and post-exit save sync). The child
/// is bound to the game's PID with `-w`, so it exits on its own when the game closes.
#[cfg(target_os = "macos")]
struct SleepExclusionGuard {
    child: Option<tokio::process::Child>,
}

#[cfg(target_os = "macos")]
impl SleepExclusionGuard {
    fn for_process(pid: Option<u32>) -> Self {
        let Some(pid) = pid else {
            return Self { child: None };
        };
        let child = Command::new("/usr/bin/caffeinate")
            .args(["-i", "-d", "-s", "-w", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok();
        Self { child }
    }
}

#[cfg(target_os = "macos")]
impl Drop for SleepExclusionGuard {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
        }
    }
}

#[cfg(not(target_os = "macos"))]
struct SleepExclusionGuard;

#[cfg(not(target_os = "macos"))]
impl SleepExclusionGuard {
    fn for_process(_pid: Option<u32>) -> Self {
        Self
    }
}

#[derive(Debug, Error)]
pub enum RunnerError {
    #[error("db error: {0}")]
    Db(#[from] DbError),
    #[error("proton error: {0}")]
    Proton(#[from] ProtonError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("no launchable executable found in {0}")]
    NoExecutableFound(PathBuf),
    #[error("game failed to start: process exited after {elapsed:?} with status {code:?}")]
    GameFailedToStart {
        code: Option<i32>,
        elapsed: Duration,
    },
}

pub type RunnerResult<T> = Result<T, RunnerError>;

#[derive(Debug, Clone)]
pub enum PostExitSyncStatus {
    Synced(SyncReport),
    QueuedOffline(String),
    SkippedDisabled,
}

#[derive(Debug, Clone)]
pub struct SessionOutcome {
    pub exit_code: Option<i32>,
    pub session: PlaySession,
    pub sync_status: PostExitSyncStatus,
}

/// Tracks active screen time while excluding system sleep / suspend jumps.
/// On each heartbeat tick, if wall-clock jumped more than `suspend_threshold` ahead of
/// the active tick budget (or monotonic delta exceeds expected tick), the sleep gap is
/// subtracted so lid-closed suspend time never inflates screen time.
#[derive(Debug, Clone)]
pub struct SessionClock {
    active_duration: Duration,
    last_wall: DateTime<Utc>,
    last_mono: Duration,
    suspend_threshold: Duration,
}

impl SessionClock {
    pub fn start(now_wall: DateTime<Utc>) -> Self {
        Self {
            active_duration: Duration::ZERO,
            last_wall: now_wall,
            last_mono: Duration::ZERO,
            suspend_threshold: Duration::from_secs(15),
        }
    }

    pub fn with_suspend_threshold(mut self, threshold: Duration) -> Self {
        self.suspend_threshold = threshold;
        self
    }

    /// Advances the clock with the current wall time and monotonic elapsed duration.
    /// Any interval where wall time jumped significantly beyond monotonic active time
    /// (indicating OS suspend/hibernate) is excluded from active playtime.
    pub fn tick(&mut self, now_wall: DateTime<Utc>, mono_elapsed: Duration) {
        let mono_delta = mono_elapsed.saturating_sub(self.last_mono);
        let wall_delta = (now_wall - self.last_wall)
            .to_std()
            .unwrap_or(Duration::ZERO);

        // If wall time jumped much farther than monotonic time, the machine slept. On Linux
        // CLOCK_MONOTONIC pauses during suspend, and on macOS `Instant` is backed by
        // `mach_absolute_time`, which likewise pauses while the Mac sleeps — while wall time
        // keeps advancing. The gap is therefore excluded from active screen time on both
        // platforms. Even if monotonic kept ticking (e.g. CLOCK_BOOTTIME / VM pause), cap
        // huge single gaps beyond suspend_threshold.
        // On Unix (Linux CLOCK_MONOTONIC, macOS mach_absolute_time) the monotonic clock pauses
        // during sleep, so `mono_delta` already excludes suspend time. Keep only that portion
        // when wall time jumped ahead, and trust the smaller delta if the wall clock went back.
        #[cfg(unix)]
        let active = if wall_delta > mono_delta.saturating_add(self.suspend_threshold) {
            mono_delta
        } else {
            mono_delta.min(wall_delta)
        };

        // On Windows (and other non-Unix targets) `Instant` keeps ticking through sleep, so a
        // long delta is indistinguishable from real playtime. Stay conservative and cap each
        // heartbeat at the suspend threshold rather than counting a whole sleep interval.
        #[cfg(not(unix))]
        let active = if mono_delta <= self.suspend_threshold
            && wall_delta <= mono_delta.saturating_add(self.suspend_threshold)
        {
            mono_delta
        } else {
            Duration::ZERO
        };
        self.active_duration += active;

        self.last_wall = now_wall;
        self.last_mono = mono_elapsed;
    }

    pub fn active_duration(&self) -> Duration {
        self.active_duration
    }

    pub fn active_secs(&self) -> u64 {
        self.active_duration.as_secs()
    }
}

#[derive(Debug, Clone)]
pub struct LaunchOptions {
    pub auto_sync_on_close: bool,
    /// Brief settle delay after process exit so games finish flushing save files to disk.
    pub sync_settle_delay: Duration,
    /// Interval between screen-time heartbeats (detects OS sleep/suspend).
    pub heartbeat_interval: Duration,
    pub extra_args: Vec<String>,
    pub prefixes_root: PathBuf,
    /// Per-game prefix override. `None` uses `<prefixes_root>/<game_id>`.
    pub prefix_override: Option<PathBuf>,
    /// User-supplied environment variables. Applied after the runtime's own values so a
    /// deliberate override (e.g. `STEAM_COMPAT_DATA_PATH`) wins.
    pub extra_env: Vec<(String, String)>,
    /// When set, the game's stdout and stderr are appended here instead of inheriting the
    /// launcher's terminal, so the UI can show a real log after a launch fails.
    pub log_path: Option<PathBuf>,
}

impl Default for LaunchOptions {
    fn default() -> Self {
        Self {
            auto_sync_on_close: true,
            sync_settle_delay: Duration::from_millis(500),
            heartbeat_interval: Duration::from_secs(5),
            extra_args: Vec::new(),
            prefixes_root: PathBuf::from("./prefixes"),
            prefix_override: None,
            extra_env: Vec::new(),
            log_path: None,
        }
    }
}

/// Splits a user-entered argument string into argv entries. Single and double quotes group
/// spaces, and a backslash can escape a quote, space or another backslash (a trailing
/// backslash is kept literally). Unclosed quotes are accepted so typing is forgiving.
pub fn parse_launch_args(raw: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    let mut chars = raw.chars().peekable();

    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else if c == '\\' && q == '"' {
                match chars.peek().copied() {
                    Some(next @ ('"' | '\\')) => {
                        current.push(next);
                        chars.next();
                    }
                    _ => current.push(c),
                }
            } else {
                current.push(c);
            }
            continue;
        }

        match c {
            '"' | '\'' => {
                quote = Some(c);
                started = true;
            }
            '\\' => match chars.peek().copied() {
                Some(next) if next.is_whitespace() || matches!(next, '"' | '\'' | '\\') => {
                    current.push(next);
                    chars.next();
                    started = true;
                }
                _ => {
                    current.push(c);
                    started = true;
                }
            },
            c if c.is_whitespace() => {
                if started {
                    args.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            _ => {
                current.push(c);
                started = true;
            }
        }
    }
    if started {
        args.push(current);
    }
    args
}

const GAME_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Opens (or rotates) the per-game log file and writes a session header. The returned handle
/// is cloned into the child's stdout/stderr so output from both streams stays interleaved.
fn open_game_log(path: &Path, header: &str) -> std::io::Result<File> {
    if let Ok(meta) = fs::metadata(path)
        && meta.len() > GAME_LOG_MAX_BYTES
    {
        let rotated = path.with_extension("old.log");
        let _ = fs::remove_file(&rotated);
        let _ = fs::rename(path, rotated);
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{header}")?;
    file.flush()?;
    Ok(file)
}

/// Resolves the command to execute for an installed game (using saved override or auto-discovery).
pub fn resolve_launch_command(
    game: &InstalledGame,
    proton: Option<&ProtonInstallation>,
    prefixes_root: &Path,
    extra_args: &[String],
    prefix_override: Option<&Path>,
) -> RunnerResult<LaunchCommandSpec> {
    let exe = if let Some(rel) = &game.executable_rel_path {
        let abs = game.install_dir.join(rel);
        // `.app` bundles are directories, so accept files or valid `.app` bundles only
        // (ignoring empty strings or plain subdirectories so auto-discovery still works).
        if abs.is_file() || opensync_proton::is_macos_app_bundle(&abs) {
            let kind = opensync_proton::detect_binary_kind(&abs);
            let size = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
            opensync_proton::DiscoveredExecutable {
                rel_path: rel.clone(),
                abs_path: abs,
                kind,
                size,
            }
        } else {
            discover_executables(&game.install_dir, &game.name)
                .into_iter()
                .next()
                .ok_or_else(|| RunnerError::NoExecutableFound(game.install_dir.clone()))?
        }
    } else {
        discover_executables(&game.install_dir, &game.name)
            .into_iter()
            .next()
            .ok_or_else(|| RunnerError::NoExecutableFound(game.install_dir.clone()))?
    };

    let prefix_dir = prefix_override
        .map(Path::to_path_buf)
        .unwrap_or_else(|| prefixes_root.join(game.game_id.to_string()));
    Ok(build_launch_command(&exe, &prefix_dir, proton, extra_args)?)
}

/// Launches a game, tracks active screen time with suspend exclusion until exit,
/// records the play session in SQLite, and automatically syncs saves when the game closes.
/// If the server is unreachable at close time, queues the game in `pending_syncs`.
pub async fn launch_and_track(
    db: &LauncherDb,
    client: Option<&OpenSyncClient>,
    game: &InstalledGame,
    proton: Option<&ProtonInstallation>,
    options: LaunchOptions,
) -> RunnerResult<SessionOutcome> {
    launch_and_track_with_hook(db, client, game, proton, options, |_, _| {}).await
}

/// Same as [`launch_and_track`], plus a callback invoked the instant the child game process
/// exits (before any post-exit settle delay or differential save sync runs) so callers can
/// immediately transition UI state and activity logs from `Playing` to `Auto-syncing saves…`.
pub async fn launch_and_track_with_hook<F>(
    db: &LauncherDb,
    client: Option<&OpenSyncClient>,
    game: &InstalledGame,
    proton: Option<&ProtonInstallation>,
    options: LaunchOptions,
    on_process_exit: F,
) -> RunnerResult<SessionOutcome>
where
    F: FnOnce(u64, Option<i32>),
{
    let mut spec = resolve_launch_command(
        game,
        proton,
        &options.prefixes_root,
        &options.extra_args,
        options.prefix_override.as_deref(),
    )?;

    // User variables are applied last: they deliberately win over Proton's defaults and are
    // also forwarded by the Flatpak host wrapper, which reads `spec.env`.
    if !options.extra_env.is_empty() {
        let user_keys: HashSet<&str> = options
            .extra_env
            .iter()
            .map(|(key, _)| key.as_str())
            .collect();
        spec.env
            .retain(|(key, _)| !user_keys.contains(key.as_str()));
        spec.env.extend(options.extra_env.iter().cloned());
    }
    let spec = wrap_launch_for_flatpak_host(spec);

    let started_at = Utc::now();
    let log_file = match &options.log_path {
        Some(path) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            let header = format!(
                "\n===== {} · {} · runtime: {} =====",
                started_at.to_rfc3339(),
                game.name,
                spec.runtime_label
            );
            Some(open_game_log(path, &header)?)
        }
        None => None,
    };

    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .current_dir(&spec.working_dir)
        .kill_on_drop(false);
    if let Some(file) = &log_file {
        let stdout = file.try_clone()?;
        let stderr = file.try_clone()?;
        cmd.stdout(Stdio::from(stdout)).stderr(Stdio::from(stderr));
    }
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }

    let mono_start = Instant::now();
    let mut clock = SessionClock::start(started_at);
    let mut child = cmd.spawn()?;
    let pid = child.id();
    // Prevent macOS idle/system/display sleep for the lifetime of this process. A `.app`
    // launched via `open -W` is represented by the `open` child, which exits with the app.
    let _sleep_guard = SleepExclusionGuard::for_process(pid);

    let _ = db.upsert_active_session(&ActiveSessionRecord {
        profile_id: game.profile_id.clone(),
        game_id: game.game_id,
        game_name: game.name.clone(),
        install_dir: game.install_dir.clone(),
        runtime: spec.runtime_label.clone(),
        pid,
        started_at,
        last_heartbeat_at: started_at,
        active_secs: 0,
    });

    let status: ExitStatus = loop {
        tokio::select! {
            res = child.wait() => {
                clock.tick(Utc::now(), mono_start.elapsed());
                break res?;
            }
            _ = tokio::time::sleep(options.heartbeat_interval) => {
                let now = Utc::now();
                clock.tick(now, mono_start.elapsed());
                let _ = db.heartbeat_active_session(
                    &game.profile_id,
                    game.game_id,
                    now,
                    clock.active_secs(),
                );
            }
        }
    };

    let ended_at = Utc::now();
    let elapsed = mono_start.elapsed();
    // A game that dies almost immediately never really started (e.g. Proton failing with
    // `/lib/ld-linux.so.2: could not open` inside a Flatpak without 32-bit libs). Treat it
    // as a launch failure rather than recording a fake play session + successful save sync.
    if !status.success() && elapsed < Duration::from_secs(5) {
        let _ = db.clear_active_session(&game.profile_id, game.game_id);
        on_process_exit(0, status.code());
        return Err(RunnerError::GameFailedToStart {
            code: status.code(),
            elapsed,
        });
    }
    // Ensure very short sessions that still ran (> 0ms) record at least their rounded active seconds.
    let active_secs = clock.active_secs();
    on_process_exit(active_secs, status.code());

    let mut session = db.record_play_session(
        &game.profile_id,
        game.game_id,
        started_at,
        ended_at,
        active_secs,
        &spec.runtime_label,
        false,
    )?;

    let sync_status = if !options.auto_sync_on_close {
        PostExitSyncStatus::SkippedDisabled
    } else {
        if !options.sync_settle_delay.is_zero() {
            tokio::time::sleep(options.sync_settle_delay).await;
        }
        match client {
            Some(c) => match sync_game_saves(c, game.game_id, &game.install_dir, false).await {
                Ok(report) => {
                    let _ = db.update_game_synced_at(&game.profile_id, game.game_id, Utc::now());
                    let _ = db.clear_pending_sync(&game.profile_id, game.game_id);
                    let _ = db.mark_session_synced(session.id);
                    session.synced = true;
                    PostExitSyncStatus::Synced(report)
                }
                Err(err) => {
                    let msg = err.to_string();
                    let _ = db.queue_pending_sync(&game.profile_id, game.game_id, &msg);
                    PostExitSyncStatus::QueuedOffline(msg)
                }
            },
            None => {
                let msg = "offline at session exit".to_string();
                let _ = db.queue_pending_sync(&game.profile_id, game.game_id, &msg);
                PostExitSyncStatus::QueuedOffline(msg)
            }
        }
    };

    let _ = db.clear_active_session(&game.profile_id, game.game_id);

    Ok(SessionOutcome {
        exit_code: status.code(),
        session,
        sync_status,
    })
}
