use chrono::{DateTime, Utc};
use futures_util::stream::{self, StreamExt};
use launcher_db::{
    ActiveSessionRecord, ActivityLogEntry, DbError, GameEnvVar, GameLaunchConfig, InstalledGame,
    LauncherDb, PendingSync, PlaytimeSummary, Profile, SecretStore,
};
use opensync_api::{ApiError, Game, OpenSyncClient, User, safe_image_mime};
use opensync_proton::{
    GeProtonRelease, ProtonError, ProtonInstallation, default_proton_search_roots,
    detect_proton_in_roots, discover_executables, download_and_install_ge_proton_with_control,
};
use opensync_runner::{
    LaunchOptions, PostExitSyncStatus, RunnerError, SessionOutcome, launch_and_track_with_hook,
    parse_launch_args,
};
use opensync_sync::{
    DirFingerprint, SyncError, SyncReport, compute_dir_fingerprint, inspect_unsynced_saves,
    sync_game_saves, sync_game_saves_with_fingerprint,
};
use opensync_transfer::{
    DownloadControl, DownloadOutcome, SpeedSample, TransferError, UploadControl, UploadOutcome,
    download_and_extract_game, manifest_fingerprint, safe_rel_path, upload_folder,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock as StdRwLock};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::{Mutex as AsyncMutex, Notify, RwLock, broadcast};
use uuid::Uuid;

pub use launcher_db::default_data_dir;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("db error: {0}")]
    Db(#[from] DbError),
    #[error("api error: {0}")]
    Api(#[from] ApiError),
    #[error("transfer error: {0}")]
    Transfer(#[from] TransferError),
    #[error("sync error: {0}")]
    Sync(#[from] SyncError),
    #[error("runner error: {0}")]
    Runner(#[from] RunnerError),
    #[error("proton error: {0}")]
    Proton(#[from] ProtonError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("no active profile selected")]
    NoActiveProfile,
    #[error("profile not found: {0}")]
    ProfileNotFound(String),
    #[error("upload job not found: {0}")]
    UploadNotFound(String),
    #[error("game {0} is not installed for the active profile")]
    GameNotInstalled(i64),
    #[error("unsafe game slug rejected: {0}")]
    UnsafeGameSlug(String),
    #[error("install directory escapes the games directory: {0}")]
    UnsafeInstallDir(PathBuf),
    #[error("invalid launch option: {0}")]
    InvalidLaunchOption(String),
    #[error("reconnect failed after {attempts} attempts: {last_error}")]
    ReconnectExhausted { attempts: u32, last_error: String },
}

pub type CoreResult<T> = Result<T, CoreError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting { attempt: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ConnectionStateDto {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting { attempt: u32 },
}

impl From<&ConnectionState> for ConnectionStateDto {
    fn from(s: &ConnectionState) -> Self {
        match s {
            ConnectionState::Disconnected => Self::Disconnected,
            ConnectionState::Connecting => Self::Connecting,
            ConnectionState::Connected => Self::Connected,
            ConnectionState::Reconnecting { attempt } => Self::Reconnecting { attempt: *attempt },
        }
    }
}

impl From<ConnectionState> for ConnectionStateDto {
    fn from(s: ConnectionState) -> Self {
        Self::from(&s)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DownloadKind {
    Game { game_id: i64, fresh: bool },
    Proton { tag_name: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DownloadStatus {
    Queued,
    Downloading,
    Verifying,
    Paused,
    Completed,
    Failed { error: String },
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadJobSnapshot {
    pub id: String,
    pub name: String,
    pub kind: DownloadKind,
    pub status: DownloadStatus,
    pub bytes_downloaded: u64,
    pub total_bytes: u64,
    pub bytes_per_sec: f64,
    pub files_extracted: usize,
    pub total_files: usize,
    pub current_file: Option<String>,
    pub speed_samples: Vec<SpeedSample>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum UploadStatus {
    Queued,
    Uploading,
    Indexing,
    Paused,
    Ready,
    Failed { error: String },
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadJobSnapshot {
    pub id: String,
    pub name: String,
    pub game_id: Option<i64>,
    pub status: UploadStatus,
    pub bytes_uploaded: u64,
    pub total_bytes: u64,
    pub files_uploaded: usize,
    pub total_files: usize,
    pub current_file: Option<String>,
    pub bytes_per_sec: f64,
    pub speed_samples: Vec<SpeedSample>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InterruptedSessionDto {
    pub profile_id: String,
    pub game_id: i64,
    pub game_name: String,
    pub install_dir: String,
    pub runtime: String,
    pub started_at: DateTime<Utc>,
    pub last_heartbeat_at: DateTime<Utc>,
    pub active_secs: u64,
    pub has_unsynced_saves: bool,
    pub changed_files: usize,
    pub deleted_files: usize,
    pub changed_bytes: u64,
    pub sample_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShutdownStatusDto {
    pub active_syncs: usize,
    pub playing_games: Vec<String>,
    pub active_downloads: usize,
    pub active_uploads: usize,
    pub ready_to_exit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShutdownResultDto {
    pub completed: bool,
    pub active_syncs_remaining: usize,
    pub playing_games: Vec<String>,
    pub wal_checkpointed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LauncherEvent {
    ConnectionChanged {
        state: ConnectionStateDto,
    },
    DownloadUpdated {
        job: DownloadJobSnapshot,
    },
    UploadUpdated {
        job: UploadJobSnapshot,
    },
    GameSessionStarted {
        game_id: i64,
        name: String,
        slug: String,
    },
    GameSessionEnded {
        game_id: i64,
        name: String,
        duration_secs: u64,
        synced: bool,
        uploaded_files: usize,
        uploaded_bytes: u64,
        deleted_paths: usize,
        error: Option<String>,
    },
    /// Emitted when a differential save sync starts (post-exit auto-sync, manual sync,
    /// or crash-recovery sync).
    GameSyncStarted {
        game_id: i64,
        name: String,
        trigger: String,
    },
    /// Emitted when a differential save sync completes.
    GameSyncCompleted {
        game_id: i64,
        name: String,
        trigger: String,
        uploaded_files: usize,
        uploaded_bytes: u64,
        deleted_paths: usize,
    },
    /// Emitted whenever a new persistent activity log entry is recorded.
    ActivityLogged {
        entry: ActivityLogEntry,
    },
    /// Emitted on startup when an interrupted (force-quit) game session is detected.
    InterruptedSessionDetected {
        session: InterruptedSessionDto,
    },
    /// Emitted when the user or OS requests a window close while work is active.
    ShutdownRequested {
        status: ShutdownStatusDto,
    },
    /// Emitted during safe shutdown while flushing active save syncs and SQLite WAL.
    ShutdownProgress {
        stage: String,
        active_syncs: usize,
        message: String,
    },
    /// A saved profile's display label or avatar changed; consumers should refresh their
    /// profile snapshot and cached avatars.
    ProfileUpdated {
        profile: Profile,
    },
    /// One background auto-sync pass finished (emitted even when nothing changed).
    BackgroundSyncCompleted {
        synced_games: usize,
        flushed_pending: usize,
    },
    ProtonInstalled {
        installation: ProtonInstallation,
    },
}

#[derive(Debug, Clone)]
pub struct ReconnectPolicy {
    pub initial_delay: Duration,
    pub max_delay: Duration,
    pub max_attempts: u32,
}

impl Default for ReconnectPolicy {
    fn default() -> Self {
        Self {
            initial_delay: Duration::from_millis(250),
            max_delay: Duration::from_secs(15),
            max_attempts: 10,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ReconnectOutcome {
    pub attempts: u32,
    pub flushed_syncs: usize,
}

/// Result of a single background auto-sync pass.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BackgroundSyncOutcome {
    pub synced_games: usize,
    pub flushed_pending: usize,
}

#[derive(Debug, Clone)]
pub struct LauncherPaths {
    pub library_root: PathBuf,
    pub proton_dir: PathBuf,
    pub prefixes_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub logs_dir: PathBuf,
}

impl LauncherPaths {
    pub fn under(root: impl AsRef<Path>) -> Self {
        let r = root.as_ref();
        Self {
            library_root: r.join("games"),
            proton_dir: r.join("proton"),
            prefixes_dir: r.join("prefixes"),
            cache_dir: r.join("cache"),
            logs_dir: r.join("logs"),
        }
    }
}

/// Default destination for downloaded games: `~/Games/OpenSync` on macOS/Windows and
/// `<Games>/OpenSync` on Linux (checking `Games` then `games` before creating one).
/// This never consults `$XDG_DATA_HOME`; it is independent of the data directory.
pub fn default_games_dir() -> PathBuf {
    let home_env = std::env::var("HOME")
        .ok()
        .filter(|h| !h.trim().is_empty())
        .or_else(|| {
            std::env::var("USERPROFILE")
                .ok()
                .filter(|h| !h.trim().is_empty())
        });
    if let Some(home) = home_env {
        let home = PathBuf::from(home);
        #[cfg(target_os = "macos")]
        {
            return home.join("Games").join("OpenSync");
        }
        #[cfg(not(target_os = "macos"))]
        {
            let games = [home.join("Games"), home.join("games")]
                .into_iter()
                .find(|p| p.is_dir())
                .unwrap_or_else(|| home.join("Games"));
            return games.join("OpenSync");
        }
    }
    PathBuf::from("Games").join("OpenSync")
}

struct ActiveSession {
    profile: Profile,
    client: OpenSyncClient,
    state: ConnectionState,
}

struct ActiveDownloadEntry {
    seq: u64,
    snapshot: DownloadJobSnapshot,
    control: DownloadControl,
}

struct ActiveUploadEntry {
    seq: u64,
    snapshot: UploadJobSnapshot,
    control: UploadControl,
    staging_root: Option<PathBuf>,
    /// Next expected byte offset for each staged file (used by `stage_upload_chunk`).
    staged_offsets: Arc<Mutex<HashMap<String, usize>>>,
}

pub struct SyncActivityGuard {
    counter: Arc<AtomicUsize>,
    notify: Arc<Notify>,
}

impl Drop for SyncActivityGuard {
    fn drop(&mut self) {
        let prev = self.counter.fetch_sub(1, Ordering::SeqCst);
        if prev <= 1 {
            self.notify.notify_waiters();
        }
    }
}

pub struct LauncherCore {
    db: LauncherDb,
    secrets: Arc<dyn SecretStore>,
    paths: LauncherPaths,
    library_root: StdRwLock<PathBuf>,
    active: RwLock<Option<ActiveSession>>,
    events: broadcast::Sender<LauncherEvent>,
    downloads: StdRwLock<HashMap<String, ActiveDownloadEntry>>,
    uploads: StdRwLock<HashMap<String, ActiveUploadEntry>>,
    bandwidth_limit: AtomicU64,
    next_job_seq: AtomicU64,
    /// (profile_id, game_id) pairs with a live game session. Background sync and offline
    /// queue flushing must never touch these games' save folders mid-session.
    playing_games: Mutex<HashSet<(String, i64)>>,
    /// (profile_id, game_id) pairs currently being uninstalled.
    uninstalling_games: Mutex<HashSet<(String, i64)>>,
    /// Tracks interrupted sessions already logged during this process run.
    notified_interrupted: Mutex<HashSet<(String, i64)>>,
    /// Cached Proton scan results; invalidated/refreshed by `rescan_proton` and GE-Proton installs.
    proton_cache: StdRwLock<Option<Vec<ProtonInstallation>>>,
    /// Metadata-only directory fingerprints keyed by `(profile_id, game_id)` so idle background
    /// auto-sync passes skip HTTP manifest fetches and SHA-256 hashing when nothing changed.
    sync_fingerprints: Mutex<HashMap<(String, i64), DirFingerprint>>,
    /// Number of save sync operations currently in flight.
    active_syncs: Arc<AtomicUsize>,
    /// Notified whenever `active_syncs` drops to 0.
    sync_idle_notify: Arc<Notify>,
    /// Set to `true` once safe shutdown begins so new background auto-syncs do not start.
    shutting_down: AtomicBool,
    /// Serializes background auto-sync passes so the 30s ticker can never overlap itself.
    background_sync_lock: AsyncMutex<()>,
}

impl LauncherCore {
    pub fn new(db: LauncherDb, secrets: Arc<dyn SecretStore>, paths: LauncherPaths) -> Self {
        let (events, _) = broadcast::channel(512);
        Self {
            db,
            secrets,
            library_root: StdRwLock::new(paths.library_root.clone()),
            paths,
            active: RwLock::new(None),
            events,
            downloads: StdRwLock::new(HashMap::new()),
            uploads: StdRwLock::new(HashMap::new()),
            bandwidth_limit: AtomicU64::new(0),
            next_job_seq: AtomicU64::new(1),
            playing_games: Mutex::new(HashSet::new()),
            uninstalling_games: Mutex::new(HashSet::new()),
            notified_interrupted: Mutex::new(HashSet::new()),
            proton_cache: StdRwLock::new(None),
            sync_fingerprints: Mutex::new(HashMap::new()),
            active_syncs: Arc::new(AtomicUsize::new(0)),
            sync_idle_notify: Arc::new(Notify::new()),
            shutting_down: AtomicBool::new(false),
            background_sync_lock: AsyncMutex::new(()),
        }
    }

    /// Registers an in-flight save sync operation and returns an RAII guard that decrements
    /// the counter and wakes any safe-shutdown waiter when dropped.
    pub fn begin_sync_activity(&self) -> SyncActivityGuard {
        self.active_syncs.fetch_add(1, Ordering::SeqCst);
        SyncActivityGuard {
            counter: Arc::clone(&self.active_syncs),
            notify: Arc::clone(&self.sync_idle_notify),
        }
    }

    pub fn active_sync_count(&self) -> usize {
        self.active_syncs.load(Ordering::SeqCst)
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    pub fn db(&self) -> &LauncherDb {
        &self.db
    }

    pub fn paths(&self) -> &LauncherPaths {
        &self.paths
    }

    /// Log file a game's stdout/stderr is captured into, scoped by profile so two
    /// servers sharing the same numeric `game_id` never mix logs.
    pub fn game_log_path(&self, profile_id: &str, game_id: i64) -> PathBuf {
        let dir = safe_cache_component(profile_id);
        let seg = if dir.is_empty() { "default" } else { dir.as_str() };
        self.paths.logs_dir.join(seg).join(format!("{game_id}.log"))
    }

    /// Reads at most the trailing `max_bytes` (capped at 512 KiB) of a game's captured
    /// output without loading the whole file into memory, trimming a partial first line.
    pub fn read_game_log(
        &self,
        profile_id: &str,
        game_id: i64,
        max_bytes: usize,
    ) -> CoreResult<Option<String>> {
        const MAX_TAIL_BYTES: usize = 512 * 1024;
        let cap = max_bytes.clamp(1, MAX_TAIL_BYTES);
        let path = self.game_log_path(profile_id, game_id);
        let mut file = match File::open(&path) {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };
        let len = file.metadata()?.len();
        let truncated = len > cap as u64;
        let to_read = if truncated { cap } else { len as usize };
        if truncated {
            file.seek(SeekFrom::End(-(cap as i64)))?;
        }
        let mut bytes = Vec::with_capacity(to_read);
        file.take(to_read as u64).read_to_end(&mut bytes)?;
        let mut start = 0;
        if truncated
            && let Some(offset) = bytes.iter().position(|b| *b == b'\n')
        {
            start = offset + 1;
        }
        Ok(Some(String::from_utf8_lossy(&bytes[start..]).into_owned()))
    }

    pub fn clear_game_log(&self, profile_id: &str, game_id: i64) -> CoreResult<()> {
        match std::fs::remove_file(self.game_log_path(profile_id, game_id)) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err.into()),
        }
    }

    /// Current destination root for downloaded games.
    pub fn games_dir(&self) -> PathBuf {
        self.library_root.read().unwrap().clone()
    }

    /// Persists and switches the destination for future downloads. Existing installs
    /// keep their absolute `install_dir` from SQLite and are unaffected.
    pub fn set_games_dir(&self, path: PathBuf) -> CoreResult<PathBuf> {
        std::fs::create_dir_all(&path)?;
        self.db.set_setting("games_dir", &path.to_string_lossy())?;
        *self.library_root.write().unwrap() = path.clone();
        Ok(path)
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<LauncherEvent> {
        self.events.subscribe()
    }

    fn emit(&self, event: LauncherEvent) {
        let _ = self.events.send(event);
    }

    fn emit_connection_state(&self, state: &ConnectionState) {
        self.emit(LauncherEvent::ConnectionChanged {
            state: ConnectionStateDto::from(state),
        });
    }

    pub async fn connection_state(&self) -> ConnectionState {
        self.active
            .read()
            .await
            .as_ref()
            .map(|a| a.state.clone())
            .unwrap_or(ConnectionState::Disconnected)
    }

    pub async fn active_profile(&self) -> Option<Profile> {
        self.active.read().await.as_ref().map(|a| a.profile.clone())
    }

    /// Marks a game as actively running so background sync leaves its save files alone,
    /// and persists an `active_sessions` record in SQLite so a force-quit or crash while
    /// playing is automatically detected on the next launcher startup.
    pub fn mark_game_playing(&self, profile_id: &str, game_id: i64) {
        self.playing_games
            .lock()
            .unwrap()
            .insert((profile_id.to_string(), game_id));
        if self
            .db
            .get_active_session(profile_id, game_id)
            .ok()
            .flatten()
            .is_none()
            && let Ok(Some(inst)) = self.db.get_installed_game(profile_id, game_id)
        {
            let now = Utc::now();
            let _ = self.db.upsert_active_session(&ActiveSessionRecord {
                profile_id: profile_id.to_string(),
                game_id,
                game_name: inst.name,
                install_dir: inst.install_dir,
                runtime: "native".to_string(),
                pid: None,
                started_at: now,
                last_heartbeat_at: now,
                active_secs: 0,
            });
        }
    }

    /// Clears the live-session marker and removes the SQLite `active_sessions` record
    /// once a game exits cleanly.
    pub fn mark_game_stopped(&self, profile_id: &str, game_id: i64) {
        self.playing_games
            .lock()
            .unwrap()
            .remove(&(profile_id.to_string(), game_id));
        let _ = self.db.clear_active_session(profile_id, game_id);
    }

    /// True while the given game is running under the given profile, or has an unresolved
    /// force-quit session in `active_sessions` awaiting user confirmation.
    pub fn is_game_playing(&self, profile_id: &str, game_id: i64) -> bool {
        if self
            .playing_games
            .lock()
            .unwrap()
            .contains(&(profile_id.to_string(), game_id))
        {
            return true;
        }
        self.db
            .get_active_session(profile_id, game_id)
            .ok()
            .flatten()
            .is_some()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_activity(
        &self,
        profile_id: &str,
        game_id: Option<i64>,
        game_name: Option<&str>,
        kind: &str,
        level: &str,
        title: &str,
        detail: &str,
    ) -> Option<ActivityLogEntry> {
        let entry = self
            .db
            .append_activity_log(profile_id, game_id, game_name, kind, level, title, detail)
            .ok()?;
        self.emit(LauncherEvent::ActivityLogged {
            entry: entry.clone(),
        });
        Some(entry)
    }

    pub async fn list_activity_logs(&self, limit: usize) -> CoreResult<Vec<ActivityLogEntry>> {
        let Some(profile) = self.active_profile().await else {
            return Ok(Vec::new());
        };
        Ok(self.db.list_activity_logs(&profile.id, limit)?)
    }

    pub async fn clear_activity_logs(&self) -> CoreResult<()> {
        let profile = self
            .active_profile()
            .await
            .ok_or(CoreError::NoActiveProfile)?;
        self.db.clear_activity_logs(&profile.id)?;
        Ok(())
    }

    pub fn list_profiles(&self) -> CoreResult<Vec<Profile>> {
        Ok(self.db.list_profiles()?)
    }

    /// Signs into an OpenSync instance, stores the profile and cookie, remembers it as active,
    /// and connects immediately.
    pub async fn connect_with_password(
        &self,
        label: &str,
        server_url: &str,
        username: &str,
        password: &str,
    ) -> CoreResult<Profile> {
        let anon = OpenSyncClient::new(server_url, None)?;
        let (user, cookie) = anon.login(username, password).await?;
        let profile =
            self.db
                .upsert_profile(label, anon.base_url(), &user.username, user.id, &user.role)?;
        self.secrets.set(&profile.id, &cookie)?;
        self.db.set_active_profile_id(Some(&profile.id))?;

        let client = anon.with_cookie(Some(cookie));
        *self.active.write().await = Some(ActiveSession {
            profile: profile.clone(),
            client,
            state: ConnectionState::Connected,
        });
        self.emit_connection_state(&ConnectionState::Connected);
        Ok(profile)
    }

    /// Registers a new account on an OpenSync instance and persists the remembered profile.
    pub async fn register_and_connect(
        &self,
        label: &str,
        server_url: &str,
        username: &str,
        password: &str,
    ) -> CoreResult<Profile> {
        let anon = OpenSyncClient::new(server_url, None)?;
        let (user, cookie) = anon.register(username, password).await?;
        let profile =
            self.db
                .upsert_profile(label, anon.base_url(), &user.username, user.id, &user.role)?;
        self.secrets.set(&profile.id, &cookie)?;
        self.db.set_active_profile_id(Some(&profile.id))?;

        let client = anon.with_cookie(Some(cookie));
        *self.active.write().await = Some(ActiveSession {
            profile: profile.clone(),
            client,
            state: ConnectionState::Connected,
        });
        self.emit_connection_state(&ConnectionState::Connected);
        Ok(profile)
    }

    /// Restores the last active profile saved in SQLite + `SecretStore` across launcher restarts.
    /// If the server is online, verifies the remembered session cookie and marks `Connected`.
    /// If the server is temporarily offline, loads the profile in `Disconnected` state so
    /// offline play and auto-reconnect work seamlessly.
    pub async fn restore_remembered_profile(&self) -> CoreResult<Option<Profile>> {
        let Some(active_id) = self.db.get_active_profile_id()? else {
            return Ok(None);
        };
        match self.switch_profile(&active_id).await {
            Ok(profile) => Ok(Some(profile)),
            Err(CoreError::ProfileNotFound(_)) => {
                self.db.set_active_profile_id(None)?;
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }

    /// Switches to an existing saved profile, restoring its remembered session cookie and
    /// scoping installed games / sync queue / screen time to that profile.
    pub async fn switch_profile(&self, profile_id: &str) -> CoreResult<Profile> {
        let profile = self
            .db
            .get_profile(profile_id)?
            .ok_or_else(|| CoreError::ProfileNotFound(profile_id.to_string()))?;
        let cookie = self.secrets.get(&profile.id)?;
        let client = OpenSyncClient::new(&profile.server_url, cookie)?;
        self.db.set_active_profile_id(Some(&profile.id))?;

        let state = match client.me().await {
            Ok(user) => {
                let updated = self.db.upsert_profile(
                    &profile.label,
                    &profile.server_url,
                    &user.username,
                    user.id,
                    &user.role,
                )?;
                *self.active.write().await = Some(ActiveSession {
                    profile: updated.clone(),
                    client,
                    state: ConnectionState::Connected,
                });
                self.emit_connection_state(&ConnectionState::Connected);
                let _ = self.flush_pending_syncs().await;
                return Ok(updated);
            }
            Err(ApiError::Network(_)) => ConnectionState::Disconnected,
            Err(ApiError::Unauthorized) => ConnectionState::Disconnected,
            Err(_) => ConnectionState::Disconnected,
        };

        *self.active.write().await = Some(ActiveSession {
            profile: profile.clone(),
            client,
            state: state.clone(),
        });
        self.emit_connection_state(&state);
        Ok(profile)
    }

    /// Deletes a saved profile, removes its stored cookie, cleans up its local library directory
    /// and cached covers, and disconnects if it was the active profile.
    pub async fn delete_profile(&self, profile_id: &str) -> CoreResult<()> {
        if self.db.get_profile(profile_id)?.is_none() {
            return Err(CoreError::ProfileNotFound(profile_id.to_string()));
        }

        self.secrets.delete(profile_id)?;
        self.db.delete_profile(profile_id)?;

        let profile_lib_dir = self.games_dir().join(profile_id);
        if profile_lib_dir.exists() {
            tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&profile_lib_dir))
                .await
                .map_err(|e| std::io::Error::other(format!("cleanup task panicked: {e}")))??;
        }

        let profile_log_dir = self.paths.logs_dir.join(safe_cache_component(profile_id));
        if profile_log_dir.is_dir() {
            let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&profile_log_dir))
                .await;
        }

        // Best-effort cleanup of cached covers and avatars belonging to this profile.
        let caches = [
            self.paths.cache_dir.join("covers"),
            self.paths.cache_dir.join("pfps"),
        ];
        let prefix = format!("{}_", safe_cache_component(profile_id));
        for dir in caches {
            if dir.is_dir() {
                let dir_clone = dir.clone();
                let prefix_clone = prefix.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    if let Ok(entries) = std::fs::read_dir(&dir_clone) {
                        for entry in entries.filter_map(Result::ok) {
                            if let Some(name) = entry.file_name().to_str()
                                && name.starts_with(&prefix_clone)
                            {
                                let _ = std::fs::remove_file(entry.path());
                            }
                        }
                    }
                })
                .await;
            }
        }

        let cleared_active = {
            let mut guard = self.active.write().await;
            if guard.as_ref().is_some_and(|a| a.profile.id == profile_id) {
                *guard = None;
                true
            } else {
                false
            }
        };
        if cleared_active {
            self.emit_connection_state(&ConnectionState::Disconnected);
        }

        Ok(())
    }

    /// Fetches the active account's public profile (including stats and avatar path) from
    /// `/api/auth/me`.
    pub async fn get_current_user_profile(&self) -> CoreResult<User> {
        let client = self.active_client().await?;
        Ok(client.me().await?)
    }

    /// Renames the local display label of the active saved profile and emits `ProfileUpdated`.
    pub async fn rename_profile(&self, label: &str) -> CoreResult<Profile> {
        let profile = self
            .active_profile()
            .await
            .ok_or(CoreError::NoActiveProfile)?;
        let updated = self.db.rename_profile(&profile.id, label)?;
        self.replace_active_profile(updated.clone()).await;
        Ok(updated)
    }

    /// Changes the active account's username on the server and persists the new value in the
    /// saved profile. A server-side collision returns the server's error message verbatim.
    pub async fn change_username(&self, username: &str) -> CoreResult<Profile> {
        let (profile, client) = self.active_profile_and_client().await?;
        let user = client.update_username(username).await?;
        let updated = self
            .db
            .update_profile_username(&profile.id, &user.username)?;
        self.replace_active_profile(updated.clone()).await;
        Ok(updated)
    }

    /// Reads a user's avatar from the on-disk cache, falling back to the server. The cache is
    /// keyed by `(profile_id, user_id)` so avatars remain available while offline, and a
    /// default/missing image is reported as `None` (the UI then shows a monogram).
    pub async fn fetch_cached_user_pfp(
        &self,
        pfp_path: Option<&str>,
        user_id: i64,
    ) -> CoreResult<Option<(Vec<u8>, String)>> {
        let profile = self
            .active_profile()
            .await
            .ok_or(CoreError::NoActiveProfile)?;
        let dir = self.paths.cache_dir.join("pfps");
        let base = pfp_cache_base(&profile.id, user_id);
        let mime_path = dir.join(format!("{base}.mime"));

        if let Ok(ct_raw) = std::fs::read_to_string(&mime_path) {
            let ct = ct_raw.trim().to_ascii_lowercase();
            let data_path = dir.join(format!("{base}.{}", ext_for_mime(&ct)));
            if let Ok(bytes) = std::fs::read(&data_path)
                && !bytes.is_empty()
                && let Some(safe) = safe_image_mime(&bytes)
            {
                return Ok(Some((bytes, safe.to_string())));
            }
        }

        let client = self.active_client().await?;
        let Some((bytes, content_type)) = client.fetch_pfp(pfp_path, user_id).await? else {
            return Ok(None);
        };
        let dir_clone = dir.clone();
        let base_clone = base.clone();
        let bytes_clone = bytes.clone();
        let ct_clone = content_type.clone();
        tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            std::fs::create_dir_all(&dir_clone)?;
            std::fs::write(
                dir_clone.join(format!("{base_clone}.{}", ext_for_mime(&ct_clone))),
                &bytes_clone,
            )?;
            std::fs::write(dir_clone.join(format!("{base_clone}.mime")), &ct_clone)?;
            Ok(())
        })
        .await
        .map_err(|e| std::io::Error::other(format!("pfp cache write panicked: {e}")))??;

        Ok(Some((bytes, content_type)))
    }

    /// Uploads raw JPG/PNG bytes for the active account, refreshes the local avatar cache and
    /// emits `ProfileUpdated`. Returns the server-relative path of the new image.
    pub async fn upload_active_profile_pfp(
        &self,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> CoreResult<String> {
        let (profile, client) = self.active_profile_and_client().await?;
        let pfp_path = client.upload_pfp(bytes, content_type).await?;
        self.clear_cached_user_pfp(&profile.id, profile.user_id);
        // Warm the cache immediately so the new avatar works offline on the next launch.
        let _ = self
            .fetch_cached_user_pfp(Some(&pfp_path), profile.user_id)
            .await;
        self.emit(LauncherEvent::ProfileUpdated { profile });
        Ok(pfp_path)
    }

    /// Removes the active account's avatar, clears its cache entry and emits `ProfileUpdated`.
    pub async fn remove_active_profile_pfp(&self) -> CoreResult<String> {
        let (profile, client) = self.active_profile_and_client().await?;
        let pfp_path = client.remove_pfp().await?;
        self.clear_cached_user_pfp(&profile.id, profile.user_id);
        self.emit(LauncherEvent::ProfileUpdated { profile });
        Ok(pfp_path)
    }

    /// Deletes the active account on the server (surfacing errors such as the last-admin
    /// guard), then forgets its local profile, session, library and cache.
    pub async fn delete_active_account(&self) -> CoreResult<()> {
        let profile = self
            .active_profile()
            .await
            .ok_or(CoreError::NoActiveProfile)?;
        let client = self.active_client().await?;
        client.delete_me().await?;
        self.delete_profile(&profile.id).await
    }

    fn clear_cached_user_pfp(&self, profile_id: &str, user_id: i64) {
        let dir = self.paths.cache_dir.join("pfps");
        let base = pfp_cache_base(profile_id, user_id);
        for ext in ["mime", "jpg", "png", "bin"] {
            let _ = std::fs::remove_file(dir.join(format!("{base}.{ext}")));
        }
    }

    async fn replace_active_profile(&self, profile: Profile) {
        {
            let mut guard = self.active.write().await;
            if let Some(active) = guard.as_mut() {
                active.profile = profile.clone();
            }
        }
        self.emit(LauncherEvent::ProfileUpdated { profile });
    }

    /// Checks whether the active profile's server is currently reachable and marks the
    /// connection `Disconnected` if a network failure occurs.
    pub async fn probe_connection(&self) -> CoreResult<bool> {
        let client = self.active_client().await?;
        match client.health().await {
            Ok(h) if h.ok => {
                let changed = {
                    let mut guard = self.active.write().await;
                    if let Some(a) = guard.as_mut() {
                        let c = a.state != ConnectionState::Connected;
                        a.state = ConnectionState::Connected;
                        c
                    } else {
                        false
                    }
                };
                if changed {
                    self.emit_connection_state(&ConnectionState::Connected);
                }
                Ok(true)
            }
            _ => {
                let changed = {
                    let mut guard = self.active.write().await;
                    if let Some(a) = guard.as_mut() {
                        let c = a.state != ConnectionState::Disconnected;
                        a.state = ConnectionState::Disconnected;
                        c
                    } else {
                        false
                    }
                };
                if changed {
                    self.emit_connection_state(&ConnectionState::Disconnected);
                }
                Ok(false)
            }
        }
    }

    /// Automatically reconnects to the active profile's OpenSync server using exponential backoff.
    /// Once reachable, verifies the stored session with `/api/auth/me` and automatically flushes
    /// any offline queued save syncs.
    pub async fn reconnect_with_backoff(
        &self,
        policy: ReconnectPolicy,
    ) -> CoreResult<ReconnectOutcome> {
        let (profile_id, client) = {
            let guard = self.active.read().await;
            let active = guard.as_ref().ok_or(CoreError::NoActiveProfile)?;
            (active.profile.id.clone(), active.client.clone())
        };

        let mut delay = policy.initial_delay;
        let mut last_error = String::new();

        for attempt in 1..=policy.max_attempts {
            let reconnecting = ConnectionState::Reconnecting { attempt };
            if let Some(a) = self.active.write().await.as_mut() {
                a.state = reconnecting.clone();
            }
            self.emit_connection_state(&reconnecting);

            match client.health().await {
                Ok(h) if h.ok => match client.me().await {
                    Ok(_) => {
                        let _ = self.db.touch_profile_connected(&profile_id);
                        if let Some(a) = self.active.write().await.as_mut() {
                            a.state = ConnectionState::Connected;
                        }
                        self.emit_connection_state(&ConnectionState::Connected);
                        let flushed = self.flush_pending_syncs().await.unwrap_or(0);
                        return Ok(ReconnectOutcome {
                            attempts: attempt,
                            flushed_syncs: flushed,
                        });
                    }
                    Err(ApiError::Unauthorized) => {
                        if let Some(a) = self.active.write().await.as_mut() {
                            a.state = ConnectionState::Disconnected;
                        }
                        self.emit_connection_state(&ConnectionState::Disconnected);
                        return Err(CoreError::Api(ApiError::Unauthorized));
                    }
                    Err(e) => {
                        last_error = e.to_string();
                    }
                },
                Ok(_) => {
                    last_error = "server health returned ok=false".to_string();
                }
                Err(e) => {
                    last_error = e.to_string();
                }
            }

            if attempt < policy.max_attempts {
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(policy.max_delay);
            }
        }

        if let Some(a) = self.active.write().await.as_mut() {
            a.state = ConnectionState::Disconnected;
        }
        self.emit_connection_state(&ConnectionState::Disconnected);
        Err(CoreError::ReconnectExhausted {
            attempts: policy.max_attempts,
            last_error,
        })
    }

    /// Lists games from the active OpenSync server.
    pub async fn fetch_remote_games(&self) -> CoreResult<Vec<Game>> {
        let client = self.active_client().await?;
        match client.list_games().await {
            Ok(games) => Ok(games),
            Err(ApiError::Network(e)) => {
                let changed = {
                    let mut guard = self.active.write().await;
                    if let Some(a) = guard.as_mut() {
                        let c = a.state != ConnectionState::Disconnected;
                        a.state = ConnectionState::Disconnected;
                        c
                    } else {
                        false
                    }
                };
                if changed {
                    self.emit_connection_state(&ConnectionState::Disconnected);
                }
                Err(CoreError::Api(ApiError::Network(e)))
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Returns remembered downloaded games scoped to the currently active profile.
    pub async fn list_downloaded_games(&self) -> CoreResult<Vec<InstalledGame>> {
        let profile = self
            .active_profile()
            .await
            .ok_or(CoreError::NoActiveProfile)?;
        Ok(self.db.list_installed_games(&profile.id)?)
    }

    /// Fetches a game's cover art, serving it from `paths.cache_dir/covers/` when already cached
    /// so cover images remain available even when the server is offline.
    pub async fn fetch_cached_cover(&self, game_id: i64) -> CoreResult<(Vec<u8>, String)> {
        let (profile, client) = self.active_profile_and_client().await?;
        let covers_dir = self.paths.cache_dir.join("covers");
        let base = format!("{}_{}", profile.id, game_id);
        let mime_path = covers_dir.join(format!("{base}.mime"));

        if let Ok(ct_raw) = std::fs::read_to_string(&mime_path) {
            let ct = ct_raw.trim().to_ascii_lowercase();
            let data_path = covers_dir.join(format!("{base}.{}", ext_for_mime(&ct)));
            if let Ok(bytes) = std::fs::read(&data_path)
                && !bytes.is_empty()
            {
                // A cached .mime file is untrusted data (it may predate this fix or have
                // been tampered with). Re-derive the literal from the bytes on every read.
                if let Some(safe) = safe_image_mime(&bytes) {
                    return Ok((bytes, safe.to_string()));
                }
            }
        }

        let (bytes, content_type) = client.fetch_cover(game_id).await?;
        let dir_clone = covers_dir.clone();
        let base_clone = base.clone();
        let bytes_clone = bytes.clone();
        let ct_clone = content_type.clone();
        tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            std::fs::create_dir_all(&dir_clone)?;
            let data_path = dir_clone.join(format!("{base_clone}.{}", ext_for_mime(&ct_clone)));
            let mime_file = dir_clone.join(format!("{base_clone}.mime"));
            std::fs::write(&data_path, &bytes_clone)?;
            std::fs::write(&mime_file, &ct_clone)?;
            Ok(())
        })
        .await
        .map_err(|e| std::io::Error::other(format!("cover cache write panicked: {e}")))??;

        Ok((bytes, content_type))
    }

    /// Downloads a game from the active OpenSync instance using high-speed streaming extraction,
    /// auto-discovers its launch executable, and persists the installation in SQLite.
    pub async fn download_game(
        &self,
        game_id: i64,
        fresh: bool,
        control: DownloadControl,
    ) -> CoreResult<(InstalledGame, DownloadOutcome)> {
        let (profile, client) = self.active_profile_and_client().await?;
        let detail = client.get_game(game_id).await?;
        let verify_clean = fresh || !detail.overlay.has_overlay;

        let games_dir = self.games_dir();
        let install_dir = match self.db.get_remembered_install_dir(&profile.id, game_id)? {
            Some(dir) => {
                assert_install_dir_contained(&games_dir, &profile.id, &dir)?;
                dir
            }
            None => install_dir_for_slug(&games_dir, &profile.id, &detail.game.slug)?,
        };

        let outcome =
            download_and_extract_game(&client, game_id, &install_dir, fresh, verify_clean, control)
                .await?;

        let installed = self.record_installed_game(
            &profile.id,
            game_id,
            &detail.game.name,
            &detail.game.slug,
            &install_dir,
            &outcome,
            !fresh && detail.overlay.has_overlay,
        )?;
        Ok((installed, outcome))
    }

    /// Starts a managed background game download tracked by the Download Manager.
    /// Emits `LauncherEvent::DownloadUpdated` throughout the lifecycle until `Completed`,
    /// `Failed`, or `Cancelled`.
    pub async fn start_game_download(
        self: &Arc<Self>,
        game_id: i64,
        fresh: bool,
    ) -> CoreResult<String> {
        let (profile, client) = self.active_profile_and_client().await?;
        let detail = client.get_game(game_id).await?;
        let verify_clean = fresh || !detail.overlay.has_overlay;
        let has_overlay = detail.overlay.has_overlay;
        let game_name = detail.game.name.clone();
        let game_slug = detail.game.slug.clone();
        let initial_total = detail.game.total_size;

        let games_dir = self.games_dir();
        let install_dir = match self.db.get_remembered_install_dir(&profile.id, game_id)? {
            Some(dir) => {
                assert_install_dir_contained(&games_dir, &profile.id, &dir)?;
                dir
            }
            None => install_dir_for_slug(&games_dir, &profile.id, &game_slug)?,
        };

        let job_id = Uuid::new_v4().to_string();
        let seq = self.next_job_seq.fetch_add(1, Ordering::Relaxed);
        let control = DownloadControl::new(initial_total, 0);
        control.set_bandwidth_limit(self.bandwidth_limit.load(Ordering::SeqCst));

        let initial_snapshot = DownloadJobSnapshot {
            id: job_id.clone(),
            name: game_name.clone(),
            kind: DownloadKind::Game { game_id, fresh },
            status: DownloadStatus::Queued,
            bytes_downloaded: 0,
            total_bytes: initial_total,
            bytes_per_sec: 0.0,
            files_extracted: 0,
            total_files: 0,
            current_file: None,
            speed_samples: Vec::new(),
        };

        {
            let mut map = self.downloads.write().unwrap();
            map.insert(
                job_id.clone(),
                ActiveDownloadEntry {
                    seq,
                    snapshot: initial_snapshot.clone(),
                    control: control.clone(),
                },
            );
        }
        self.emit(LauncherEvent::DownloadUpdated {
            job: initial_snapshot,
        });

        let core = Arc::clone(self);
        let jid = job_id.clone();
        tokio::spawn(async move {
            // Transition Queued -> Downloading (unless already paused or cancelled).
            if control.is_cancelled() {
                core.finalize_cancelled(&jid);
                return;
            }
            if !control.is_paused() {
                core.update_download_snapshot(&jid, |snap| {
                    snap.status = DownloadStatus::Downloading;
                });
            }

            // Periodic progress forwarder while download_and_extract_game runs.
            let poll_core = Arc::clone(&core);
            let poll_jid = jid.clone();
            let poll_ctrl = control.clone();
            let ticker = tokio::spawn(async move {
                let mut last_bytes = u64::MAX;
                let mut last_files = usize::MAX;
                let mut last_file: Option<String> = None;
                let mut last_samples = usize::MAX;
                loop {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    let tp = poll_ctrl.snapshot();
                    let changed = tp.bytes_downloaded != last_bytes
                        || tp.files_extracted != last_files
                        || tp.current_file != last_file
                        || tp.speed_samples.len() != last_samples;
                    if changed {
                        last_bytes = tp.bytes_downloaded;
                        last_files = tp.files_extracted;
                        last_file = tp.current_file.clone();
                        last_samples = tp.speed_samples.len();
                        let is_paused = poll_ctrl.is_paused();
                        poll_core.update_download_snapshot(&poll_jid, |snap| {
                            if !matches!(
                                snap.status,
                                DownloadStatus::Cancelled
                                    | DownloadStatus::Completed
                                    | DownloadStatus::Failed { .. }
                            ) {
                                snap.status = if is_paused {
                                    DownloadStatus::Paused
                                } else {
                                    DownloadStatus::Downloading
                                };
                            }
                            snap.bytes_downloaded = tp.bytes_downloaded;
                            if tp.total_bytes > 0 {
                                snap.total_bytes = tp.total_bytes;
                            }
                            snap.bytes_per_sec = if is_paused { 0.0 } else { tp.bytes_per_sec };
                            snap.files_extracted = tp.files_extracted;
                            snap.total_files = tp.total_files;
                            snap.current_file = tp.current_file;
                            snap.speed_samples = tp.speed_samples;
                        });
                    }
                }
            });

            let result = download_and_extract_game(
                &client,
                game_id,
                &install_dir,
                fresh,
                verify_clean,
                control.clone(),
            )
            .await;

            ticker.abort();
            let _ = ticker.await;

            let final_tp = control.snapshot();
            match result {
                Ok(outcome) => {
                    match core.record_installed_game(
                        &profile.id,
                        game_id,
                        &game_name,
                        &game_slug,
                        &install_dir,
                        &outcome,
                        !fresh && has_overlay,
                    ) {
                        Ok(_) => {
                            core.update_download_snapshot(&jid, |snap| {
                                snap.status = DownloadStatus::Completed;
                                let final_total = outcome.total_bytes.max(final_tp.total_bytes);
                                snap.total_bytes = final_total;
                                snap.bytes_downloaded = final_total.max(final_tp.bytes_downloaded);
                                snap.bytes_per_sec = outcome.avg_bytes_per_sec;
                                snap.files_extracted = outcome.files.len();
                                snap.total_files = outcome.files.len();
                                snap.current_file = None;
                                snap.speed_samples = final_tp.speed_samples;
                            });
                        }
                        Err(err) => {
                            core.update_download_snapshot(&jid, |snap| {
                                snap.status = DownloadStatus::Failed {
                                    error: err.to_string(),
                                };
                                snap.bytes_per_sec = 0.0;
                            });
                        }
                    }
                }
                Err(TransferError::Cancelled) => {
                    core.finalize_cancelled(&jid);
                }
                Err(err) => {
                    if control.is_cancelled() {
                        core.finalize_cancelled(&jid);
                    } else {
                        core.update_download_snapshot(&jid, |snap| {
                            snap.status = DownloadStatus::Failed {
                                error: err.to_string(),
                            };
                            snap.bytes_per_sec = 0.0;
                            snap.bytes_downloaded = final_tp.bytes_downloaded;
                            snap.speed_samples = final_tp.speed_samples;
                        });
                    }
                }
            }
        });

        Ok(job_id)
    }

    /// Streams, SHA-512 verifies, and extracts a GE-Proton release through the Download Manager,
    /// emitting `DownloadUpdated` events and `ProtonInstalled` on success.
    pub async fn start_ge_proton_download(
        self: &Arc<Self>,
        release: GeProtonRelease,
    ) -> CoreResult<String> {
        let job_id = Uuid::new_v4().to_string();
        let seq = self.next_job_seq.fetch_add(1, Ordering::Relaxed);
        let control = DownloadControl::new(release.tarball_size, 1);
        control.set_bandwidth_limit(self.bandwidth_limit.load(Ordering::SeqCst));

        let initial_snapshot = DownloadJobSnapshot {
            id: job_id.clone(),
            name: release.tag_name.clone(),
            kind: DownloadKind::Proton {
                tag_name: release.tag_name.clone(),
            },
            status: DownloadStatus::Queued,
            bytes_downloaded: 0,
            total_bytes: release.tarball_size,
            bytes_per_sec: 0.0,
            files_extracted: 0,
            total_files: 1,
            current_file: Some(release.tarball_name.clone()),
            speed_samples: Vec::new(),
        };

        {
            let mut map = self.downloads.write().unwrap();
            map.insert(
                job_id.clone(),
                ActiveDownloadEntry {
                    seq,
                    snapshot: initial_snapshot.clone(),
                    control: control.clone(),
                },
            );
        }
        self.emit(LauncherEvent::DownloadUpdated {
            job: initial_snapshot,
        });

        let core = Arc::clone(self);
        let jid = job_id.clone();
        tokio::spawn(async move {
            if control.is_cancelled() {
                core.finalize_cancelled(&jid);
                return;
            }
            if !control.is_paused() {
                core.update_download_snapshot(&jid, |snap| {
                    snap.status = DownloadStatus::Downloading;
                });
            }

            let started = Instant::now();
            struct TelemetryState {
                last_sample_at: Instant,
                last_emit_at: Instant,
                last_sample_bytes: u64,
            }
            let telemetry = Arc::new(Mutex::new(TelemetryState {
                last_sample_at: started,
                last_emit_at: started
                    .checked_sub(Duration::from_secs(1))
                    .unwrap_or(started),
                last_sample_bytes: 0,
            }));

            let prog_core = Arc::clone(&core);
            let prog_jid = jid.clone();
            let prog_ctrl = control.clone();
            let prog_tel = telemetry.clone();
            let on_progress = move |downloaded: u64, total: u64| {
                let mut tel = prog_tel.lock().unwrap();
                let dt = tel.last_sample_at.elapsed();
                let mut new_sample: Option<(f64, SpeedSample)> = None;
                if dt >= Duration::from_millis(100) || (total > 0 && downloaded >= total) {
                    let delta = downloaded.saturating_sub(tel.last_sample_bytes);
                    let bps = if dt.as_secs_f64() > 0.0 {
                        delta as f64 / dt.as_secs_f64()
                    } else {
                        0.0
                    };
                    new_sample = Some((
                        bps,
                        SpeedSample {
                            elapsed_ms: started.elapsed().as_millis() as u64,
                            bytes_per_sec: bps,
                        },
                    ));
                    tel.last_sample_at = Instant::now();
                    tel.last_sample_bytes = downloaded;
                }

                let should_emit = tel.last_emit_at.elapsed() >= Duration::from_millis(50)
                    || (total > 0 && downloaded >= total);
                if should_emit {
                    tel.last_emit_at = Instant::now();
                }
                drop(tel);

                let is_paused = prog_ctrl.is_paused();
                let maybe_snap = {
                    let mut map = prog_core.downloads.write().unwrap();
                    if let Some(entry) = map.get_mut(&prog_jid) {
                        entry.snapshot.bytes_downloaded = downloaded;
                        if total > 0 {
                            entry.snapshot.total_bytes = total;
                        }
                        if !matches!(
                            entry.snapshot.status,
                            DownloadStatus::Cancelled
                                | DownloadStatus::Completed
                                | DownloadStatus::Failed { .. }
                                | DownloadStatus::Verifying
                        ) {
                            entry.snapshot.status = if is_paused {
                                DownloadStatus::Paused
                            } else {
                                DownloadStatus::Downloading
                            };
                        }
                        if let Some((bps, sample)) = new_sample {
                            entry.snapshot.bytes_per_sec = if is_paused { 0.0 } else { bps };
                            entry.snapshot.speed_samples.push(sample);
                            if entry.snapshot.speed_samples.len() > 60 {
                                entry.snapshot.speed_samples.remove(0);
                            }
                        }
                        if should_emit {
                            Some(entry.snapshot.clone())
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                };
                if let Some(job) = maybe_snap {
                    prog_core.emit(LauncherEvent::DownloadUpdated { job });
                }
            };

            let verify_core = Arc::clone(&core);
            let verify_jid = jid.clone();
            let on_verifying = move || {
                verify_core.update_download_snapshot(&verify_jid, |snap| {
                    if !matches!(snap.status, DownloadStatus::Cancelled) {
                        snap.status = DownloadStatus::Verifying;
                        snap.bytes_per_sec = 0.0;
                    }
                });
            };

            let res = download_and_install_ge_proton_with_control(
                &release.tarball_url,
                release.sha512_url.as_deref(),
                &core.paths.proton_dir,
                control.paused_flag(),
                control.cancelled_flag(),
                control.bandwidth_limit_flag(),
                on_progress,
                on_verifying,
            )
            .await;

            match res {
                Ok(installation) => {
                    core.rescan_proton();
                    core.update_download_snapshot(&jid, |snap| {
                        snap.status = DownloadStatus::Completed;
                        let final_bytes = snap.bytes_downloaded.max(snap.total_bytes);
                        snap.bytes_downloaded = final_bytes;
                        snap.total_bytes = final_bytes;
                        snap.bytes_per_sec = 0.0;
                        snap.files_extracted = 1;
                        snap.total_files = 1;
                        snap.current_file = None;
                    });
                    core.emit(LauncherEvent::ProtonInstalled { installation });
                }
                Err(ProtonError::Cancelled) => {
                    core.finalize_cancelled(&jid);
                }
                Err(err) => {
                    if control.is_cancelled() {
                        core.finalize_cancelled(&jid);
                    } else {
                        core.update_download_snapshot(&jid, |snap| {
                            snap.status = DownloadStatus::Failed {
                                error: err.to_string(),
                            };
                            snap.bytes_per_sec = 0.0;
                        });
                    }
                }
            }
        });

        Ok(job_id)
    }

    pub async fn pause_download(&self, job_id: &str) -> bool {
        let updated = {
            let mut map = self.downloads.write().unwrap();
            let Some(entry) = map.get_mut(job_id) else {
                return false;
            };
            if !matches!(
                entry.snapshot.status,
                DownloadStatus::Queued | DownloadStatus::Downloading
            ) {
                return false;
            }
            entry.control.pause();
            entry.snapshot.status = DownloadStatus::Paused;
            entry.snapshot.bytes_per_sec = 0.0;
            entry.snapshot.clone()
        };
        self.emit(LauncherEvent::DownloadUpdated { job: updated });
        true
    }

    pub async fn resume_download(&self, job_id: &str) -> bool {
        let updated = {
            let mut map = self.downloads.write().unwrap();
            let Some(entry) = map.get_mut(job_id) else {
                return false;
            };
            if !matches!(entry.snapshot.status, DownloadStatus::Paused) {
                return false;
            }
            entry.control.resume();
            entry.snapshot.status = DownloadStatus::Downloading;
            entry.snapshot.clone()
        };
        self.emit(LauncherEvent::DownloadUpdated { job: updated });
        true
    }

    pub async fn cancel_download(&self, job_id: &str) -> bool {
        let updated = {
            let mut map = self.downloads.write().unwrap();
            let Some(entry) = map.get_mut(job_id) else {
                return false;
            };
            if !matches!(
                entry.snapshot.status,
                DownloadStatus::Queued
                    | DownloadStatus::Downloading
                    | DownloadStatus::Paused
                    | DownloadStatus::Verifying
            ) {
                return false;
            }
            entry.control.cancel();
            entry.snapshot.status = DownloadStatus::Cancelled;
            entry.snapshot.bytes_per_sec = 0.0;
            entry.snapshot.clone()
        };
        self.emit(LauncherEvent::DownloadUpdated { job: updated });
        true
    }

    /// Sets the global download bandwidth limit in bytes/sec (0 = unlimited) and applies it
    /// immediately to all active and future download jobs.
    pub async fn set_bandwidth_limit(&self, bytes_per_sec: u64) {
        self.bandwidth_limit.store(bytes_per_sec, Ordering::SeqCst);
        let map = self.downloads.read().unwrap();
        for entry in map.values() {
            entry.control.set_bandwidth_limit(bytes_per_sec);
        }
    }

    /// Returns a snapshot of all tracked downloads in insertion order.
    pub async fn list_downloads(&self) -> Vec<DownloadJobSnapshot> {
        let map = self.downloads.read().unwrap();
        let mut items: Vec<(u64, DownloadJobSnapshot)> = map
            .values()
            .map(|entry| {
                let mut snap = entry.snapshot.clone();
                if matches!(entry.snapshot.kind, DownloadKind::Game { .. })
                    && matches!(
                        snap.status,
                        DownloadStatus::Downloading | DownloadStatus::Paused
                    )
                {
                    let tp = entry.control.snapshot();
                    snap.bytes_downloaded = tp.bytes_downloaded.max(snap.bytes_downloaded);
                    if tp.total_bytes > 0 {
                        snap.total_bytes = tp.total_bytes;
                    }
                    snap.files_extracted = tp.files_extracted.max(snap.files_extracted);
                    if tp.total_files > 0 {
                        snap.total_files = tp.total_files;
                    }
                    if tp.current_file.is_some() {
                        snap.current_file = tp.current_file;
                    }
                    if !matches!(snap.status, DownloadStatus::Paused) {
                        snap.bytes_per_sec = tp.bytes_per_sec;
                    }
                    if !tp.speed_samples.is_empty() {
                        snap.speed_samples = tp.speed_samples;
                    }
                }
                (entry.seq, snap)
            })
            .collect();
        items.sort_by_key(|(seq, _)| *seq);
        items.into_iter().map(|(_, s)| s).collect()
    }

    /// Creates a new game on the server and starts a tracked upload job. When `folder` is
    /// supplied the whole tree is uploaded in the background; otherwise a local staging area
    /// is created for chunk-by-chunk posting followed by `finalize_dropped_upload`.
    pub async fn start_game_upload(
        self: &Arc<Self>,
        name: &str,
        description: &str,
        system_requirements: &str,
        folder: Option<&str>,
        cover: Option<(Vec<u8>, String)>,
    ) -> CoreResult<String> {
        let (profile, client) = self.active_profile_and_client().await?;
        let game = client
            .create_game(name, description, system_requirements)
            .await?;
        if let Some((bytes, content_type)) = cover {
            client
                .upload_game_cover(game.id, bytes, &content_type)
                .await?;
        }

        let job_id = Uuid::new_v4().to_string();
        let seq = self.next_job_seq.fetch_add(1, Ordering::Relaxed);
        let control = UploadControl::new(0, 0);
        let snapshot = UploadJobSnapshot {
            id: job_id.clone(),
            name: name.to_string(),
            game_id: Some(game.id),
            status: UploadStatus::Queued,
            bytes_uploaded: 0,
            total_bytes: 0,
            files_uploaded: 0,
            total_files: 0,
            current_file: None,
            bytes_per_sec: 0.0,
            speed_samples: Vec::new(),
        };
        let staging_root = folder
            .is_none()
            .then(|| self.paths.cache_dir.join("uploads").join(&job_id));
        if let Some(root) = &staging_root {
            std::fs::create_dir_all(root.join("files"))?;
        }
        {
            let mut map = self.uploads.write().unwrap();
            map.insert(
                job_id.clone(),
                ActiveUploadEntry {
                    seq,
                    snapshot: snapshot.clone(),
                    control: control.clone(),
                    staging_root,
                    staged_offsets: Arc::new(Mutex::new(HashMap::new())),
                },
            );
        }
        self.emit(LauncherEvent::UploadUpdated { job: snapshot });

        if let Some(folder) = folder {
            self.spawn_upload_pipeline(
                job_id.clone(),
                game.id,
                profile.id,
                client,
                PathBuf::from(folder),
                None,
            );
        }
        Ok(job_id)
    }

    /// Stages one chunk of a drag-and-drop upload inside the job's local `files/` directory.
    /// Returns `true` once the final chunk of a file has been written and renamed into place.
    pub fn stage_upload_chunk(
        &self,
        job_id: &str,
        rel_path: &str,
        index: usize,
        total: usize,
        size: u64,
        chunk: &[u8],
    ) -> CoreResult<bool> {
        let safe = safe_rel_path(rel_path)?;
        if total == 0 {
            return Err(CoreError::Io(io::Error::other(
                "total must be greater than zero",
            )));
        }
        let (root, offsets, control) = {
            let map = self.uploads.read().unwrap();
            let entry = map
                .get(job_id)
                .ok_or_else(|| CoreError::UploadNotFound(job_id.to_string()))?;
            let root = entry
                .staging_root
                .clone()
                .ok_or_else(|| CoreError::UploadNotFound(job_id.to_string()))?;
            (
                root,
                Arc::clone(&entry.staged_offsets),
                entry.control.clone(),
            )
        };
        let mut offsets = offsets.lock().unwrap();
        // The per-file byte count tracked in the entry is the source of truth: JS chunkers use
        // fixed-size chunks with a smaller tail, so `size / total` is not a reliable stride.
        let current = offsets.get(rel_path).copied().unwrap_or(0);
        if (current == 0 && index != 0) || current.saturating_add(chunk.len()) > size as usize {
            return Err(CoreError::Io(io::Error::other(format!(
                "chunk out of order for {rel_path}: offset {current}, index {index}"
            ))));
        }

        let files_root = root.join("files");
        let final_path = files_root.join(&safe);
        let part_path = files_root.join(format!("{}.part", safe.to_string_lossy()));
        if let Some(parent) = final_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        {
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&part_path)?;
            file.write_all(chunk)?;
            file.flush()?;
        }
        let new_offset = current + chunk.len();
        offsets.insert(rel_path.to_string(), new_offset);

        if index + 1 != total {
            return Ok(false);
        }
        if new_offset as u64 != size {
            return Err(CoreError::Io(io::Error::other(format!(
                "size mismatch for {rel_path}: expected {size}, got {new_offset}"
            ))));
        }
        std::fs::rename(&part_path, &final_path)?;

        control.set_current_file(Some(rel_path.to_string()));
        control.add_bytes(size);
        control.finish_file();
        self.update_upload_snapshot(job_id, |snap| {
            snap.total_bytes += size;
            snap.total_files += 1;
            snap.bytes_uploaded = control.snapshot().bytes_uploaded;
            snap.current_file = Some(rel_path.to_string());
        });
        Ok(true)
    }

    /// Starts the upload pipeline for a drag-and-drop job whose chunks have been staged.
    pub async fn finalize_dropped_upload(self: &Arc<Self>, job_id: &str) -> CoreResult<()> {
        let (root, game_id) = {
            let map = self.uploads.read().unwrap();
            let entry = map
                .get(job_id)
                .ok_or_else(|| CoreError::UploadNotFound(job_id.to_string()))?;
            let root = entry
                .staging_root
                .clone()
                .ok_or_else(|| CoreError::UploadNotFound(job_id.to_string()))?;
            let game_id = entry
                .snapshot
                .game_id
                .ok_or_else(|| CoreError::UploadNotFound(job_id.to_string()))?;
            (root, game_id)
        };
        let (profile, client) = self.active_profile_and_client().await?;
        // Chunks are staged under `<job>/files/`; the uploader must walk that directory so
        // relative paths do not pick up a spurious `files/` prefix.
        self.spawn_upload_pipeline(
            job_id.to_string(),
            game_id,
            profile.id,
            client,
            root.join("files"),
            Some(root),
        );
        Ok(())
    }

    /// Common background pipeline: chunked upload -> indexing -> `ready` polling.
    fn spawn_upload_pipeline(
        self: &Arc<Self>,
        job_id: String,
        game_id: i64,
        profile_id: String,
        client: OpenSyncClient,
        root: PathBuf,
        cleanup_root: Option<PathBuf>,
    ) {
        let core = Arc::clone(self);
        let staged_source = cleanup_root.is_some();
        let Some(control) = self
            .uploads
            .read()
            .unwrap()
            .get(&job_id)
            .map(|entry| entry.control.clone())
        else {
            return;
        };

        if control.is_cancelled() {
            core.cancel_upload_job(&job_id, &client, game_id);
            return;
        }
        if !control.is_paused() {
            core.update_upload_snapshot(&job_id, |snap| {
                if !matches!(snap.status, UploadStatus::Cancelled) {
                    snap.status = UploadStatus::Uploading;
                }
            });
        }

        tokio::spawn(async move {
            let poll_core = Arc::clone(&core);
            let poll_jid = job_id.clone();
            let poll_ctrl = control.clone();
            let ticker = tokio::spawn(async move {
                let mut last_bytes = u64::MAX;
                let mut last_files = usize::MAX;
                let mut last_file: Option<String> = None;
                let mut last_samples = usize::MAX;
                let mut last_paused = false;
                loop {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    let up = poll_ctrl.snapshot();
                    let changed = up.bytes_uploaded != last_bytes
                        || up.files_uploaded != last_files
                        || up.current_file != last_file
                        || up.speed_samples.len() != last_samples
                        || up.paused != last_paused;
                    if changed {
                        last_bytes = up.bytes_uploaded;
                        last_files = up.files_uploaded;
                        last_file = up.current_file.clone();
                        last_samples = up.speed_samples.len();
                        last_paused = up.paused;
                        let is_paused = poll_ctrl.is_paused();
                        poll_core.update_upload_snapshot(&poll_jid, |snap| {
                            if !matches!(
                                snap.status,
                                UploadStatus::Ready
                                    | UploadStatus::Failed { .. }
                                    | UploadStatus::Cancelled
                                    | UploadStatus::Indexing
                            ) {
                                snap.status = if is_paused {
                                    UploadStatus::Paused
                                } else {
                                    UploadStatus::Uploading
                                };
                            }
                            snap.bytes_uploaded = up.bytes_uploaded;
                            if up.total_bytes > 0 {
                                snap.total_bytes = up.total_bytes;
                            }
                            snap.files_uploaded = up.files_uploaded;
                            if up.total_files > 0 {
                                snap.total_files = up.total_files;
                            }
                            snap.current_file = up.current_file;
                            snap.bytes_per_sec = if is_paused { 0.0 } else { up.bytes_per_sec };
                            snap.speed_samples = up.speed_samples;
                        });
                    }
                }
            });

            let result = upload_folder(&client, game_id, &root, &control).await;
            ticker.abort();
            let _ = ticker.await;

            match result {
                Ok(outcome) => {
                    core.update_upload_snapshot(&job_id, |snap| {
                        if !matches!(snap.status, UploadStatus::Cancelled) {
                            snap.status = UploadStatus::Indexing;
                            snap.bytes_per_sec = 0.0;
                            snap.current_file = None;
                        }
                    });
                    if let Err(err) = core
                        .finish_upload_indexing(
                            &job_id,
                            &client,
                            game_id,
                            &profile_id,
                            &root,
                            staged_source,
                            &outcome,
                            &control,
                        )
                        .await
                    {
                        if matches!(err, CoreError::Transfer(TransferError::Cancelled))
                            || control.is_cancelled()
                        {
                            core.cancel_upload_job(&job_id, &client, game_id);
                        } else {
                            core.update_upload_snapshot(&job_id, |snap| {
                                snap.status = UploadStatus::Failed {
                                    error: err.to_string(),
                                };
                                snap.bytes_per_sec = 0.0;
                            });
                        }
                    }
                }
                Err(TransferError::Cancelled) => {
                    core.cancel_upload_job(&job_id, &client, game_id);
                }
                Err(err) => {
                    if control.is_cancelled() {
                        core.cancel_upload_job(&job_id, &client, game_id);
                    } else {
                        core.update_upload_snapshot(&job_id, |snap| {
                            snap.status = UploadStatus::Failed {
                                error: err.to_string(),
                            };
                            snap.bytes_per_sec = 0.0;
                        });
                    }
                }
            }

            if let Some(cleanup_root) = cleanup_root {
                let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&cleanup_root))
                    .await;
            }
        });
    }

    #[allow(clippy::too_many_arguments)]
    async fn finish_upload_indexing(
        &self,
        job_id: &str,
        client: &OpenSyncClient,
        game_id: i64,
        profile_id: &str,
        source_root: &Path,
        staged_source: bool,
        outcome: &UploadOutcome,
        control: &UploadControl,
    ) -> CoreResult<()> {
        client.upload_game_complete(game_id).await?;
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if control.is_cancelled() {
                return Err(CoreError::Transfer(TransferError::Cancelled));
            }
            match client.get_game_status(game_id).await {
                Ok(status) if status.status == "ready" => break,
                Ok(status) if status.status.contains("fail") || status.status.contains("error") => {
                    return Err(CoreError::Api(ApiError::Http {
                        status: 500,
                        message: format!("game processing failed: {}", status.status),
                    }));
                }
                Ok(_) => {}
                Err(ApiError::Network(_)) => {}
                Err(err) => return Err(err.into()),
            }
            if Instant::now() >= deadline {
                return Err(CoreError::Api(ApiError::Http {
                    status: 408,
                    message: "timed out waiting for game indexing".to_string(),
                }));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        // The game is now indexed on the server. Bring the local files into the launcher's
        // games directory and register the install so it is immediately playable.
        let detail = client.get_game(game_id).await?;
        let target_dir = install_dir_for_slug(&self.games_dir(), profile_id, &detail.game.slug)?;
        let src_for_move = source_root.to_path_buf();
        let dst_for_move = target_dir.clone();
        let move_res = tokio::task::spawn_blocking(move || {
            move_game_into_install_dir(&src_for_move, &dst_for_move, staged_source)
        })
        .await
        .map_err(|e| std::io::Error::other(format!("move task panicked: {e}")))
        .and_then(|inner| inner);
        if let Err(err) = move_res {
            // A failed move must never delete the original (non-staged) user folder; the
            // install record still points at the target so the user can retry later.
            let _ = self.record_activity(
                profile_id,
                Some(game_id),
                Some(&detail.game.name),
                "sync_error",
                "danger",
                "Could not move uploaded game files into the games directory",
                &err.to_string(),
            );
        }

        let manifest = client.get_manifest(game_id).await?;
        let download_outcome = DownloadOutcome {
            install_dir: target_dir.clone(),
            files: Vec::new(),
            total_bytes: outcome.total_bytes,
            elapsed: Duration::ZERO,
            avg_bytes_per_sec: 0.0,
            manifest_hash: manifest_fingerprint(&manifest),
        };
        let installed = self.record_installed_game(
            profile_id,
            game_id,
            &detail.game.name,
            &detail.game.slug,
            &target_dir,
            &download_outcome,
            false,
        )?;
        let _ = self.record_activity(
            profile_id,
            Some(game_id),
            Some(&installed.name),
            "game_install",
            "accent",
            &format!("Installed {}", installed.name),
            &format!(
                "Uploaded game files are available in {}",
                target_dir.display()
            ),
        );

        let samples = control.snapshot().speed_samples;
        self.update_upload_snapshot(job_id, |snap| {
            if matches!(snap.status, UploadStatus::Cancelled) {
                return;
            }
            snap.status = UploadStatus::Ready;
            snap.bytes_uploaded = outcome.total_bytes;
            snap.total_bytes = outcome.total_bytes;
            snap.files_uploaded = outcome.files.len();
            snap.total_files = outcome.files.len();
            snap.current_file = None;
            snap.bytes_per_sec = 0.0;
            snap.speed_samples = samples;
        });
        Ok(())
    }

    fn cancel_upload_job(self: &Arc<Self>, job_id: &str, client: &OpenSyncClient, game_id: i64) {
        let client = client.clone();
        let core = Arc::clone(self);
        let job_id = job_id.to_string();
        tokio::spawn(async move {
            // Best-effort cleanup of the incomplete game on the server.
            let _ = client.delete_game(game_id).await;
            core.finalize_upload_cancelled(&job_id);
        });
    }

    pub async fn pause_upload(&self, job_id: &str) -> bool {
        let updated = {
            let mut map = self.uploads.write().unwrap();
            let Some(entry) = map.get_mut(job_id) else {
                return false;
            };
            if !matches!(
                entry.snapshot.status,
                UploadStatus::Queued | UploadStatus::Uploading
            ) {
                return false;
            }
            entry.control.pause();
            entry.snapshot.status = UploadStatus::Paused;
            entry.snapshot.bytes_per_sec = 0.0;
            entry.snapshot.clone()
        };
        self.emit(LauncherEvent::UploadUpdated { job: updated });
        true
    }

    pub async fn resume_upload(&self, job_id: &str) -> bool {
        let updated = {
            let mut map = self.uploads.write().unwrap();
            let Some(entry) = map.get_mut(job_id) else {
                return false;
            };
            if !matches!(entry.snapshot.status, UploadStatus::Paused) {
                return false;
            }
            entry.control.resume();
            entry.snapshot.status = UploadStatus::Uploading;
            entry.snapshot.clone()
        };
        self.emit(LauncherEvent::UploadUpdated { job: updated });
        true
    }

    pub async fn cancel_upload(&self, job_id: &str) -> bool {
        let updated = {
            let mut map = self.uploads.write().unwrap();
            let Some(entry) = map.get_mut(job_id) else {
                return false;
            };
            if !matches!(
                entry.snapshot.status,
                UploadStatus::Queued
                    | UploadStatus::Uploading
                    | UploadStatus::Paused
                    | UploadStatus::Indexing
            ) {
                return false;
            }
            entry.control.cancel();
            entry.snapshot.status = UploadStatus::Cancelled;
            entry.snapshot.bytes_per_sec = 0.0;
            entry.snapshot.clone()
        };
        self.emit(LauncherEvent::UploadUpdated { job: updated });
        true
    }

    /// Returns a snapshot of all tracked uploads in insertion order.
    pub async fn list_uploads(&self) -> Vec<UploadJobSnapshot> {
        let map = self.uploads.read().unwrap();
        let mut items: Vec<(u64, UploadJobSnapshot)> = map
            .values()
            .map(|entry| {
                let mut snap = entry.snapshot.clone();
                if matches!(
                    snap.status,
                    UploadStatus::Uploading | UploadStatus::Paused | UploadStatus::Indexing
                ) {
                    let up = entry.control.snapshot();
                    snap.bytes_uploaded = up.bytes_uploaded.max(snap.bytes_uploaded);
                    if up.total_bytes > 0 {
                        snap.total_bytes = up.total_bytes;
                    }
                    snap.files_uploaded = up.files_uploaded.max(snap.files_uploaded);
                    if up.total_files > 0 {
                        snap.total_files = up.total_files;
                    }
                    if up.current_file.is_some() {
                        snap.current_file = up.current_file;
                    }
                    if !matches!(snap.status, UploadStatus::Paused) {
                        snap.bytes_per_sec = up.bytes_per_sec;
                    }
                    if !up.speed_samples.is_empty() {
                        snap.speed_samples = up.speed_samples;
                    }
                }
                (entry.seq, snap)
            })
            .collect();
        items.sort_by_key(|(seq, _)| *seq);
        items.into_iter().map(|(_, snap)| snap).collect()
    }

    fn update_upload_snapshot<F>(&self, job_id: &str, mutate: F)
    where
        F: FnOnce(&mut UploadJobSnapshot),
    {
        let updated = {
            let mut map = self.uploads.write().unwrap();
            let Some(entry) = map.get_mut(job_id) else {
                return;
            };
            mutate(&mut entry.snapshot);
            entry.snapshot.clone()
        };
        self.emit(LauncherEvent::UploadUpdated { job: updated });
    }

    fn finalize_upload_cancelled(&self, job_id: &str) {
        let maybe_updated = {
            let mut map = self.uploads.write().unwrap();
            let Some(entry) = map.get_mut(job_id) else {
                return;
            };
            if matches!(entry.snapshot.status, UploadStatus::Cancelled) {
                None
            } else {
                entry.snapshot.status = UploadStatus::Cancelled;
                entry.snapshot.bytes_per_sec = 0.0;
                Some(entry.snapshot.clone())
            }
        };
        if let Some(job) = maybe_updated {
            self.emit(LauncherEvent::UploadUpdated { job });
        }
    }

    /// Uninstalls a downloaded game for the active profile. Before touching local files the
    /// install directory is remembered (so a later download can restore the exact same path)
    /// and, when the server is reachable, a final differential save sync pushes local edits to
    /// the cloud. Offline or non-network sync errors are logged but never block the uninstall.
    pub async fn uninstall_game(&self, game_id: i64) -> CoreResult<()> {
        let profile = self
            .active_profile()
            .await
            .ok_or(CoreError::NoActiveProfile)?;
        struct UninstallGuard<'a> {
            set: &'a Mutex<HashSet<(String, i64)>>,
            key: (String, i64),
        }
        impl Drop for UninstallGuard<'_> {
            fn drop(&mut self) {
                if let Ok(mut guard) = self.set.lock() {
                    guard.remove(&self.key);
                }
            }
        }
        let uninstall_key = (profile.id.clone(), game_id);
        {
            let mut guard = self.uninstalling_games.lock().unwrap();
            guard.insert(uninstall_key.clone());
        }
        let _uninstall_guard = UninstallGuard {
            set: &self.uninstalling_games,
            key: uninstall_key,
        };
        let installed = self
            .db
            .get_installed_game(&profile.id, game_id)?
            .ok_or(CoreError::GameNotInstalled(game_id))?;

        // Remember the directory first so a redownload can restore it with its cloud saves.
        self.db
            .set_remembered_install_dir(&profile.id, game_id, &installed.install_dir)?;

        if installed.install_dir.is_dir()
            && self.connection_state().await == ConnectionState::Connected
        {
            if let Ok(client) = self.active_client().await {
                let _sync_guard = self.begin_sync_activity();
                self.emit(LauncherEvent::GameSyncStarted {
                    game_id,
                    name: installed.name.clone(),
                    trigger: "uninstall".to_string(),
                });
                match sync_game_saves(&client, game_id, &installed.install_dir, false).await {
                    Ok(report) => {
                        let detail = format_sync_report_detail(&report);
                        let _ = self.record_activity(
                            &profile.id,
                            Some(game_id),
                            Some(&installed.name),
                            "sync_complete",
                            "accent",
                            &format!("Synced saves before uninstalling {}", installed.name),
                            &detail,
                        );
                        self.emit(LauncherEvent::GameSyncCompleted {
                            game_id,
                            name: installed.name.clone(),
                            trigger: "uninstall".to_string(),
                            uploaded_files: report.uploaded_files,
                            uploaded_bytes: report.uploaded_bytes,
                            deleted_paths: report.deleted_paths,
                        });
                    }
                    // The server went away mid-sync (or another network failure occurred):
                    // proceed with the uninstall, leaving the changes for a later sync.
                    Err(SyncError::Api(ApiError::Network(_))) => {
                        let _ = self.record_activity(
                            &profile.id,
                            Some(game_id),
                            Some(&installed.name),
                            "sync_offline",
                            "warn",
                            &format!("Save sync skipped while uninstalling {}", installed.name),
                            "Server unreachable; local save changes were not uploaded",
                        );
                    }
                    Err(err) => {
                        // Mass-deletion guard, hash mismatch, etc. — never abort the uninstall.
                        let _ = self.record_activity(
                            &profile.id,
                            Some(game_id),
                            Some(&installed.name),
                            "sync_error",
                            "danger",
                            &format!("Save sync failed while uninstalling {}", installed.name),
                            &err.to_string(),
                        );
                    }
                }
            }
        }

        let _ = self.record_activity(
            &profile.id,
            Some(game_id),
            Some(&installed.name),
            "game_uninstall",
            "info",
            &format!("Uninstalled {}", installed.name),
            &format!(
                "Removed {}; install directory remembered for redownload",
                installed.install_dir.display()
            ),
        );
        if installed.install_dir.exists() {
            // The stored path may have come from an older, vulnerable version. Refuse
            // to delete anything outside the profile's games directory.
            assert_install_dir_contained(&self.games_dir(), &profile.id, &installed.install_dir)?;
            let dir = installed.install_dir.clone();
            tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&dir))
                .await
                .map_err(|e| std::io::Error::other(format!("uninstall task panicked: {e}")))??;
        }
        self.db.remove_installed_game(&profile.id, game_id)?;
        let _ = self.db.clear_pending_sync(&profile.id, game_id);
        self.sync_fingerprints
            .lock()
            .unwrap()
            .remove(&(profile.id, game_id));
        Ok(())
    }

    /// Sets or clears the custom relative executable path for an installed game.
    pub async fn set_game_executable(
        &self,
        game_id: i64,
        rel_path: Option<String>,
    ) -> CoreResult<()> {
        let profile = self
            .active_profile()
            .await
            .ok_or(CoreError::NoActiveProfile)?;
        if self.db.get_installed_game(&profile.id, game_id)?.is_none() {
            return Err(CoreError::GameNotInstalled(game_id));
        }
        let cleaned = match rel_path {
            Some(raw) => {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    let safe = safe_rel_path(trimmed)?;
                    Some(safe.to_string_lossy().replace('\\', "/"))
                }
            }
            None => None,
        };
        self.db
            .update_game_executable(&profile.id, game_id, cleaned.as_deref())?;
        Ok(())
    }

    /// Sets or clears the custom Proton runtime override for an installed game.
    pub async fn set_game_proton(
        &self,
        game_id: i64,
        proton_name: Option<String>,
    ) -> CoreResult<()> {
        let profile = self
            .active_profile()
            .await
            .ok_or(CoreError::NoActiveProfile)?;
        if self.db.get_installed_game(&profile.id, game_id)?.is_none() {
            return Err(CoreError::GameNotInstalled(game_id));
        }
        let cleaned = proton_name.and_then(|raw| {
            let trimmed = raw.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        });
        self.db
            .update_game_proton_override(&profile.id, game_id, cleaned.as_deref())?;
        Ok(())
    }

    /// Atomically saves the custom prefix, launch arguments and environment variables for a
    /// game and returns the normalized configuration. Empty values clear the override and
    /// restore automatic behaviour. This works for games that are still in the library but
    /// not yet installed.
    pub async fn set_game_launch_config(
        &self,
        game_id: i64,
        wine_prefix: Option<String>,
        launch_args: Option<String>,
        env_vars: Vec<GameEnvVar>,
    ) -> CoreResult<GameLaunchConfig> {
        let profile = self
            .active_profile()
            .await
            .ok_or(CoreError::NoActiveProfile)?;

        if wine_prefix.as_deref().is_some_and(|raw| raw.contains('\0')) {
            return Err(CoreError::InvalidLaunchOption(
                "Wine prefix path cannot contain NUL bytes".to_string(),
            ));
        }

        let prefix = wine_prefix.and_then(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            let home = std::env::var("HOME")
                .ok()
                .filter(|h| !h.trim().is_empty())
                .or_else(|| {
                    std::env::var("USERPROFILE")
                        .ok()
                        .filter(|h| !h.trim().is_empty())
                })
                .map(PathBuf::from);
            let expanded = if trimmed == "~" {
                home.clone()
            } else {
                trimmed.strip_prefix("~/").map(|rest| {
                    home.as_ref()
                        .map(|h| h.join(rest))
                        .unwrap_or_else(|| PathBuf::from(rest))
                })
            };
            let path = expanded.unwrap_or_else(|| PathBuf::from(trimmed));
            let absolute = if path.is_absolute() {
                path
            } else {
                self.paths
                    .prefixes_dir
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .join(path)
            };
            Some(absolute.to_string_lossy().into_owned())
        });

        if launch_args.as_deref().is_some_and(|raw| raw.contains('\0')) {
            return Err(CoreError::InvalidLaunchOption(
                "launch arguments cannot contain NUL bytes".to_string(),
            ));
        }
        let args = launch_args.and_then(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });
        if args.as_ref().is_some_and(|a| a.len() > 8192) {
            return Err(CoreError::InvalidLaunchOption(
                "launch arguments are too long (8192 character limit)".to_string(),
            ));
        }

        let mut clean_vars: Vec<GameEnvVar> = Vec::new();
        for var in env_vars {
            let key = var.key.trim();
            if var.value.contains('\0') {
                return Err(CoreError::InvalidLaunchOption(format!(
                    "value for {key:?} cannot contain NUL bytes"
                )));
            }
            let valid_key = !key.is_empty()
                && key.len() <= 256
                && key.chars().enumerate().all(|(i, c)| {
                    if i == 0 {
                        c == '_' || c.is_ascii_alphabetic()
                    } else {
                        c == '_' || c.is_ascii_alphanumeric()
                    }
                });
            if !valid_key {
                return Err(CoreError::InvalidLaunchOption(format!(
                    "invalid environment variable name: {key:?} (use A-Z, 0-9 and _, not starting with a digit)"
                )));
            }
            if var.value.len() > 8192 {
                return Err(CoreError::InvalidLaunchOption(format!(
                    "value for {key} is too long (8192 character limit)"
                )));
            }
            if let Some(existing) = clean_vars.iter_mut().find(|v| v.key == key) {
                existing.value = var.value;
            } else {
                clean_vars.push(GameEnvVar {
                    key: key.to_string(),
                    value: var.value,
                });
            }
        }
        if clean_vars.len() > 64 {
            return Err(CoreError::InvalidLaunchOption(
                "too many environment variables (64 maximum)".to_string(),
            ));
        }

        let normalized = GameLaunchConfig {
            profile_id: profile.id,
            game_id,
            wine_prefix: prefix,
            launch_args: args,
            env_vars: clean_vars,
        };
        self.db.upsert_game_launch_config(&normalized)?;
        Ok(normalized)
    }

    /// Lists all pending offline save syncs queued for the active profile.
    pub async fn list_pending_syncs(&self) -> CoreResult<Vec<PendingSync>> {
        let profile = self
            .active_profile()
            .await
            .ok_or(CoreError::NoActiveProfile)?;
        Ok(self.db.list_pending_syncs(&profile.id)?)
    }

    /// Runs an on-demand differential save sync for a downloaded game.
    pub async fn sync_game_now(
        &self,
        game_id: i64,
        force_mass_deletion: bool,
    ) -> CoreResult<SyncReport> {
        let (profile, client) = self.active_profile_and_client().await?;
        let installed = self
            .db
            .get_installed_game(&profile.id, game_id)?
            .ok_or(CoreError::GameNotInstalled(game_id))?;

        let _sync_guard = self.begin_sync_activity();
        self.emit(LauncherEvent::GameSyncStarted {
            game_id,
            name: installed.name.clone(),
            trigger: "manual".to_string(),
        });

        match sync_game_saves_with_fingerprint(
            &client,
            game_id,
            &installed.install_dir,
            force_mass_deletion,
        )
        .await
        {
            Ok((report, post_fp)) => {
                self.db
                    .update_game_synced_at(&profile.id, game_id, Utc::now())?;
                self.db.clear_pending_sync(&profile.id, game_id)?;
                self.sync_fingerprints
                    .lock()
                    .unwrap()
                    .insert((profile.id.clone(), game_id), post_fp);
                let detail = format_sync_report_detail(&report);
                let _ = self.record_activity(
                    &profile.id,
                    Some(game_id),
                    Some(&installed.name),
                    "sync_complete",
                    "accent",
                    &format!("Synced saves for {}", installed.name),
                    &detail,
                );
                self.emit(LauncherEvent::GameSyncCompleted {
                    game_id,
                    name: installed.name.clone(),
                    trigger: "manual".to_string(),
                    uploaded_files: report.uploaded_files,
                    uploaded_bytes: report.uploaded_bytes,
                    deleted_paths: report.deleted_paths,
                });
                Ok(report)
            }
            Err(err) => {
                let _ = self.record_activity(
                    &profile.id,
                    Some(game_id),
                    Some(&installed.name),
                    "sync_error",
                    "danger",
                    &format!("Save sync failed for {}", installed.name),
                    &err.to_string(),
                );
                Err(err.into())
            }
        }
    }

    /// Flushes all offline queued save syncs for the active profile.
    pub async fn flush_pending_syncs(&self) -> CoreResult<usize> {
        if self.is_shutting_down() {
            return Ok(0);
        }
        let (profile, client) = self.active_profile_and_client().await?;
        let pending = self.db.list_pending_syncs(&profile.id)?;
        let mut flushed = 0usize;
        for item in pending {
            if self.is_game_playing(&profile.id, item.game_id) {
                continue;
            }
            if let Some(installed) = self.db.get_installed_game(&profile.id, item.game_id)? {
                let _sync_guard = self.begin_sync_activity();
                if let Ok((report, post_fp)) = sync_game_saves_with_fingerprint(
                    &client,
                    item.game_id,
                    &installed.install_dir,
                    false,
                )
                .await
                {
                    let _ = self
                        .db
                        .update_game_synced_at(&profile.id, item.game_id, Utc::now());
                    let _ = self.db.clear_pending_sync(&profile.id, item.game_id);
                    self.sync_fingerprints
                        .lock()
                        .unwrap()
                        .insert((profile.id.clone(), item.game_id), post_fp);
                    let _ = self.record_activity(
                        &profile.id,
                        Some(item.game_id),
                        Some(&installed.name),
                        "sync_complete",
                        "accent",
                        &format!("Flushed queued save sync for {}", installed.name),
                        &format_sync_report_detail(&report),
                    );
                    flushed += 1;
                }
            }
        }
        Ok(flushed)
    }

    /// Runs one background auto-sync pass. Connectivity is probed when the session is offline
    /// or pending syncs exist; once online, pending syncs are flushed and every installed game
    /// that is not currently playing gets a differential save sync. Failures for individual
    /// games are ignored so one bad game cannot block the rest.
    pub async fn run_background_auto_sync_once(&self) -> CoreResult<BackgroundSyncOutcome> {
        if self.is_shutting_down() {
            return Ok(BackgroundSyncOutcome::default());
        }
        let _guard = self.background_sync_lock.lock().await;
        if self.is_shutting_down() {
            return Ok(BackgroundSyncOutcome::default());
        }
        let Some(profile) = self.active_profile().await else {
            return Ok(BackgroundSyncOutcome::default());
        };
        let client = self.active_client().await?;
        let pending = self.db.list_pending_syncs(&profile.id).unwrap_or_default();
        let needs_probe =
            self.connection_state().await != ConnectionState::Connected || !pending.is_empty();
        if needs_probe && !self.probe_connection().await? {
            return Ok(BackgroundSyncOutcome::default());
        }

        let flushed_pending = if pending.is_empty() {
            0
        } else {
            self.flush_pending_syncs().await.unwrap_or(0)
        };
        let pending_before_flush: HashSet<i64> = pending.into_iter().map(|p| p.game_id).collect();
        let pending_after_flush: HashSet<i64> = if pending_before_flush.is_empty() {
            HashSet::new()
        } else {
            self.db
                .list_pending_syncs(&profile.id)
                .unwrap_or_default()
                .into_iter()
                .map(|p| p.game_id)
                .collect()
        };
        let installed = self
            .db
            .list_installed_games(&profile.id)
            .unwrap_or_default();
        let uninstalling_snapshot: HashSet<(String, i64)> = self
            .uninstalling_games
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        let targets: Vec<_> = installed
            .into_iter()
            .filter(|game| {
                !self.is_game_playing(&profile.id, game.game_id)
                    && !uninstalling_snapshot.contains(&(profile.id.clone(), game.game_id))
            })
            .collect();

        let synced_counts: Vec<usize> = stream::iter(targets)
            .map(|game| {
                let client = client.clone();
                let profile_id = profile.id.clone();
                let is_pending = pending_before_flush.contains(&game.game_id)
                    || pending_after_flush.contains(&game.game_id);
                async move {
                    if self.is_shutting_down() {
                        return 0;
                    }
                    // Targets were filtered before buffering; a game may have started or begun
                    // uninstalling while queued. Re-check before touching its save folder.
                    if self.is_game_playing(&profile_id, game.game_id)
                        || self
                            .uninstalling_games
                            .lock()
                            .map(|g| g.contains(&(profile_id.clone(), game.game_id)))
                            .unwrap_or(false)
                    {
                        return 0;
                    }
                    let fp_key = (profile_id.clone(), game.game_id);
                    if !is_pending {
                        let cached = self.sync_fingerprints.lock().unwrap().get(&fp_key).copied();
                        if let Some(cached_fp) = cached {
                            let dir_for_fp = game.install_dir.clone();
                            let pre_fp = tokio::task::spawn_blocking(move || {
                                compute_dir_fingerprint(&dir_for_fp)
                            })
                            .await
                            .ok()
                            .and_then(Result::ok);
                            if pre_fp == Some(cached_fp) {
                                return 0;
                            }
                        }
                    }

                    let _sync_guard = self.begin_sync_activity();
                    if let Ok((report, post_fp)) = sync_game_saves_with_fingerprint(
                        &client,
                        game.game_id,
                        &game.install_dir,
                        false,
                    )
                    .await
                    {
                        let _ =
                            self.db
                                .update_game_synced_at(&profile_id, game.game_id, Utc::now());
                        let _ = self.db.clear_pending_sync(&profile_id, game.game_id);
                        self.sync_fingerprints
                            .lock()
                            .unwrap()
                            .insert(fp_key, post_fp);
                        if report.uploaded_files > 0 || report.deleted_paths > 0 {
                            let _ = self.record_activity(
                                &profile_id,
                                Some(game.game_id),
                                Some(&game.name),
                                "sync_complete",
                                "accent",
                                &format!("Background auto-synced {}", game.name),
                                &format_sync_report_detail(&report),
                            );
                        }
                        1
                    } else {
                        0
                    }
                }
            })
            .buffer_unordered(6)
            .collect()
            .await;
        let synced_games: usize = synced_counts.into_iter().sum();

        let outcome = BackgroundSyncOutcome {
            synced_games,
            flushed_pending,
        };
        self.emit(LauncherEvent::BackgroundSyncCompleted {
            synced_games: outcome.synced_games,
            flushed_pending: outcome.flushed_pending,
        });
        Ok(outcome)
    }

    /// Starts the periodic auto-sync loop. The first pass runs immediately, then once per
    /// `interval`. The returned handle may be aborted by the caller.
    pub fn spawn_background_auto_sync(
        self: &Arc<Self>,
        interval: Duration,
    ) -> tokio::task::JoinHandle<()> {
        let core = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticker.tick().await;
                if core.is_shutting_down() {
                    break;
                }
                if let Err(err) = core.run_background_auto_sync_once().await {
                    tracing::warn!(error = %err, "background auto-sync pass failed");
                }
            }
        })
    }

    /// Launches a downloaded game, tracks screen time with suspend protection, and automatically
    /// syncs saves when the game closes (or queues an offline sync if the server is unreachable).
    pub async fn launch_game(
        &self,
        game_id: i64,
        mut options: LaunchOptions,
    ) -> CoreResult<SessionOutcome> {
        let (profile, client, connected) = {
            let guard = self.active.read().await;
            let active = guard.as_ref().ok_or(CoreError::NoActiveProfile)?;
            (
                active.profile.clone(),
                active.client.clone(),
                active.state == ConnectionState::Connected,
            )
        };
        let installed = self
            .db
            .get_installed_game(&profile.id, game_id)?
            .ok_or(CoreError::GameNotInstalled(game_id))?;

        let launch_config = self
            .db
            .get_game_launch_config(&profile.id, game_id)?
            .unwrap_or_default();
        options.prefixes_root = self.paths.prefixes_dir.clone();
        if options.prefix_override.is_none() {
            options.prefix_override = launch_config.wine_prefix.as_deref().map(PathBuf::from);
        }
        // Callers (e.g. tests or embedded use) may have supplied their own arguments; the
        // saved per-game configuration is appended after them so it always takes effect.
        options.extra_args.extend(
            launch_config
                .launch_args
                .as_deref()
                .map(parse_launch_args)
                .unwrap_or_default(),
        );
        options.extra_env.extend(
            launch_config
                .env_vars
                .iter()
                .map(|var| (var.key.clone(), var.value.clone())),
        );
        if options.log_path.is_none() {
            options.log_path = Some(self.game_log_path(&profile.id, game_id));
        }
        let proton_list = self.detect_proton();
        let chosen_proton = installed
            .proton_override
            .as_deref()
            .and_then(|name| proton_list.iter().find(|p| p.name == name))
            .or_else(|| proton_list.first());

        let runtime_label = chosen_proton
            .map(|p| p.name.clone())
            .unwrap_or_else(|| "native".to_string());

        // Guard the live session: background auto-sync and queued-flush must not touch this
        // game's save folder while it is running.
        self.mark_game_playing(&profile.id, game_id);
        let _ = self.record_activity(
            &profile.id,
            Some(game_id),
            Some(&installed.name),
            "game_start",
            "info",
            &format!("Started {}", installed.name),
            &format!("Runtime: {runtime_label}"),
        );
        self.emit(LauncherEvent::GameSessionStarted {
            game_id,
            name: installed.name.clone(),
            slug: installed.slug.clone(),
        });

        let auto_sync_on_close = options.auto_sync_on_close;
        let game_name_for_hook = installed.name.clone();
        let profile_id_for_hook = profile.id.clone();
        let mut post_exit_sync_guard: Option<SyncActivityGuard> = None;

        let sync_client = if connected { Some(&client) } else { None };
        let result = launch_and_track_with_hook(
            &self.db,
            sync_client,
            &installed,
            chosen_proton,
            options,
            |active_secs, _exit_code| {
                let dur_label = format_duration_brief(active_secs);
                if auto_sync_on_close {
                    post_exit_sync_guard = Some(self.begin_sync_activity());
                    let _ = self.record_activity(
                        &profile_id_for_hook,
                        Some(game_id),
                        Some(&game_name_for_hook),
                        "game_close",
                        "info",
                        &format!("Closed {}", game_name_for_hook),
                        &format!("Played {dur_label} · Auto-syncing saves…"),
                    );
                    self.emit(LauncherEvent::GameSyncStarted {
                        game_id,
                        name: game_name_for_hook.clone(),
                        trigger: "post_exit".to_string(),
                    });
                } else {
                    let _ = self.record_activity(
                        &profile_id_for_hook,
                        Some(game_id),
                        Some(&game_name_for_hook),
                        "game_close",
                        "info",
                        &format!("Closed {}", game_name_for_hook),
                        &format!("Played {dur_label}"),
                    );
                }
            },
        )
        .await;

        drop(post_exit_sync_guard);
        self.mark_game_stopped(&profile.id, game_id);

        match result {
            Ok(outcome) => {
                let (uploaded_files, uploaded_bytes, deleted_paths, error) =
                    match &outcome.sync_status {
                        PostExitSyncStatus::Synced(report) => {
                            let detail = format_sync_report_detail(report);
                            let _ = self.record_activity(
                                &profile.id,
                                Some(game_id),
                                Some(&installed.name),
                                "sync_complete",
                                "accent",
                                &format!("Auto-synced {}", installed.name),
                                &detail,
                            );
                            self.emit(LauncherEvent::GameSyncCompleted {
                                game_id,
                                name: installed.name.clone(),
                                trigger: "post_exit".to_string(),
                                uploaded_files: report.uploaded_files,
                                uploaded_bytes: report.uploaded_bytes,
                                deleted_paths: report.deleted_paths,
                            });
                            (
                                report.uploaded_files,
                                report.uploaded_bytes,
                                report.deleted_paths,
                                None,
                            )
                        }
                        PostExitSyncStatus::QueuedOffline(msg) => {
                            let _ = self.record_activity(
                                &profile.id,
                                Some(game_id),
                                Some(&installed.name),
                                "sync_offline",
                                "warn",
                                &format!("Queued offline save sync for {}", installed.name),
                                msg,
                            );
                            (0, 0, 0, Some(msg.clone()))
                        }
                        PostExitSyncStatus::SkippedDisabled => (0, 0, 0, None),
                    };

                self.emit(LauncherEvent::GameSessionEnded {
                    game_id,
                    name: installed.name.clone(),
                    duration_secs: outcome.session.duration_secs,
                    synced: outcome.session.synced,
                    uploaded_files,
                    uploaded_bytes,
                    deleted_paths,
                    error,
                });
                Ok(outcome)
            }
            Err(err) => {
                let msg = err.to_string();
                let _ = self.record_activity(
                    &profile.id,
                    Some(game_id),
                    Some(&installed.name),
                    "sync_error",
                    "danger",
                    &format!("Launch failed for {}", installed.name),
                    &msg,
                );
                self.emit(LauncherEvent::GameSessionEnded {
                    game_id,
                    name: installed.name.clone(),
                    duration_secs: 0,
                    synced: false,
                    uploaded_files: 0,
                    uploaded_bytes: 0,
                    deleted_paths: 0,
                    error: Some(msg),
                });
                Err(err.into())
            }
        }
    }

    /// Inspects SQLite `active_sessions` for any game sessions that were left open because the
    /// launcher was force-quit or crashed while playing.
    ///
    /// - If an interrupted session has unsynced local save changes, returns it in the result list
    ///   (and keeps the row in `active_sessions` until [`resolve_interrupted_session`] is called)
    ///   so the UI can offer to sync the user's saves.
    /// - If an interrupted session has zero local save changes, automatically records the
    ///   recovered play session, clears the `active_sessions` row, and logs the clean recovery.
    pub async fn detect_interrupted_sessions(&self) -> CoreResult<Vec<InterruptedSessionDto>> {
        let Some(profile) = self.active_profile().await else {
            return Ok(Vec::new());
        };
        let (client, connected) = {
            let guard = self.active.read().await;
            match guard.as_ref() {
                Some(a) => (
                    Some(a.client.clone()),
                    a.state == ConnectionState::Connected,
                ),
                None => (None, false),
            }
        };

        let active_rows = self.db.list_active_sessions(&profile.id)?;
        if active_rows.is_empty() {
            return Ok(Vec::new());
        }

        let live_in_memory: HashSet<(String, i64)> = self.playing_games.lock().unwrap().clone();

        let mut out = Vec::new();
        for rec in active_rows {
            // Skip any game currently running inside this live launcher process.
            if live_in_memory.contains(&(rec.profile_id.clone(), rec.game_id)) {
                continue;
            }

            let installed = self
                .db
                .get_installed_game(&profile.id, rec.game_id)
                .ok()
                .flatten();
            let last_synced_sys = installed
                .as_ref()
                .and_then(|i| i.last_synced_at)
                .map(std::time::SystemTime::from);
            let started_sys = Some(std::time::SystemTime::from(rec.started_at));

            let clean_manifest = if connected {
                if let Some(c) = &client {
                    c.get_manifest(rec.game_id).await.ok()
                } else {
                    None
                }
            } else {
                None
            };

            let dir_for_scan = rec.install_dir.clone();
            let manifest_clone = clean_manifest.clone();
            let inspection = tokio::task::spawn_blocking(move || {
                inspect_unsynced_saves(
                    &dir_for_scan,
                    manifest_clone.as_ref(),
                    last_synced_sys,
                    started_sys,
                )
            })
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();

            let first_notice = self
                .notified_interrupted
                .lock()
                .unwrap()
                .insert((rec.profile_id.clone(), rec.game_id));

            if inspection.has_changes {
                let dto = InterruptedSessionDto {
                    profile_id: rec.profile_id.clone(),
                    game_id: rec.game_id,
                    game_name: rec.game_name.clone(),
                    install_dir: rec.install_dir.to_string_lossy().to_string(),
                    runtime: rec.runtime.clone(),
                    started_at: rec.started_at,
                    last_heartbeat_at: rec.last_heartbeat_at,
                    active_secs: rec.active_secs,
                    has_unsynced_saves: true,
                    changed_files: inspection.changed_files,
                    deleted_files: inspection.deleted_files,
                    changed_bytes: inspection.changed_bytes,
                    sample_paths: inspection.sample_paths,
                };
                if first_notice {
                    let _ = self.record_activity(
                        &profile.id,
                        Some(rec.game_id),
                        Some(&rec.game_name),
                        "crash_detected",
                        "warn",
                        &format!("Interrupted session detected for {}", rec.game_name),
                        &format!(
                            "{} unsynced save file(s) ({}) found after unexpected close",
                            dto.changed_files + dto.deleted_files,
                            format_bytes_brief(dto.changed_bytes)
                        ),
                    );
                    self.emit(LauncherEvent::InterruptedSessionDetected {
                        session: dto.clone(),
                    });
                }
                out.push(dto);
            } else {
                // No unsynced save files exist: finalize the interrupted play session and clear
                // the active_sessions marker automatically.
                let _ = self.db.record_play_session(
                    &rec.profile_id,
                    rec.game_id,
                    rec.started_at,
                    rec.last_heartbeat_at,
                    rec.active_secs,
                    &rec.runtime,
                    true,
                );
                let _ = self.db.clear_active_session(&rec.profile_id, rec.game_id);
                if first_notice {
                    let _ = self.record_activity(
                        &profile.id,
                        Some(rec.game_id),
                        Some(&rec.game_name),
                        "crash_detected",
                        "info",
                        &format!("Recovered session for {}", rec.game_name),
                        "Launcher closed while game was open · No modified save files detected",
                    );
                }
            }
        }

        Ok(out)
    }

    /// Resolves an interrupted game session detected on startup:
    /// - When `sync_saves` is `true`, performs differential save sync, records the recovered
    ///   play session as synced, clears the `active_sessions` marker, and logs the recovery.
    /// - When `sync_saves` is `false`, records the recovered play session without syncing and
    ///   clears the `active_sessions` marker.
    pub async fn resolve_interrupted_session(
        &self,
        game_id: i64,
        sync_saves: bool,
        force_mass_deletion: bool,
    ) -> CoreResult<Option<SyncReport>> {
        let profile = self
            .active_profile()
            .await
            .ok_or(CoreError::NoActiveProfile)?;
        let rec = self.db.get_active_session(&profile.id, game_id)?;
        let installed = self
            .db
            .get_installed_game(&profile.id, game_id)?
            .ok_or(CoreError::GameNotInstalled(game_id))?;

        if !sync_saves {
            if let Some(rec) = &rec {
                let _ = self.db.record_play_session(
                    &profile.id,
                    game_id,
                    rec.started_at,
                    rec.last_heartbeat_at,
                    rec.active_secs,
                    &rec.runtime,
                    false,
                );
            }
            self.db.clear_active_session(&profile.id, game_id)?;
            self.notified_interrupted
                .lock()
                .unwrap()
                .remove(&(profile.id.clone(), game_id));
            let _ = self.record_activity(
                &profile.id,
                Some(game_id),
                Some(&installed.name),
                "crash_resolved",
                "info",
                &format!("Dismissed save recovery for {}", installed.name),
                "Local save files kept on disk without uploading",
            );
            return Ok(None);
        }

        let client = self.active_client().await?;
        let _sync_guard = self.begin_sync_activity();
        self.emit(LauncherEvent::GameSyncStarted {
            game_id,
            name: installed.name.clone(),
            trigger: "recovery".to_string(),
        });

        let report = sync_game_saves(
            &client,
            game_id,
            &installed.install_dir,
            force_mass_deletion,
        )
        .await?;
        self.db
            .update_game_synced_at(&profile.id, game_id, Utc::now())?;
        self.db.clear_pending_sync(&profile.id, game_id)?;
        if let Some(rec) = &rec {
            let _ = self.db.record_play_session(
                &profile.id,
                game_id,
                rec.started_at,
                rec.last_heartbeat_at,
                rec.active_secs,
                &rec.runtime,
                true,
            );
        }
        self.db.clear_active_session(&profile.id, game_id)?;
        self.notified_interrupted
            .lock()
            .unwrap()
            .remove(&(profile.id.clone(), game_id));

        let detail = format_sync_report_detail(&report);
        let _ = self.record_activity(
            &profile.id,
            Some(game_id),
            Some(&installed.name),
            "sync_complete",
            "accent",
            &format!("Recovered & synced saves for {}", installed.name),
            &detail,
        );
        self.emit(LauncherEvent::GameSyncCompleted {
            game_id,
            name: installed.name.clone(),
            trigger: "recovery".to_string(),
            uploaded_files: report.uploaded_files,
            uploaded_bytes: report.uploaded_bytes,
            deleted_paths: report.deleted_paths,
        });

        Ok(Some(report))
    }

    /// Returns a snapshot of in-flight save syncs, currently running games, and active transfers
    /// so the window close handler or UI can determine whether it is immediately safe to exit.
    pub fn shutdown_status(&self) -> ShutdownStatusDto {
        let active_syncs = self.active_sync_count();
        let playing_pairs: Vec<(String, i64)> =
            self.playing_games.lock().unwrap().iter().cloned().collect();
        let mut playing_games = Vec::with_capacity(playing_pairs.len());
        for (pid, gid) in playing_pairs {
            let name = self
                .db
                .get_installed_game(&pid, gid)
                .ok()
                .flatten()
                .map(|g| g.name)
                .or_else(|| {
                    self.db
                        .get_active_session(&pid, gid)
                        .ok()
                        .flatten()
                        .map(|s| s.game_name)
                })
                .unwrap_or_else(|| format!("Game #{gid}"));
            playing_games.push(name);
        }
        playing_games.sort();

        let active_downloads = self
            .downloads
            .read()
            .unwrap()
            .values()
            .filter(|e| {
                matches!(
                    e.snapshot.status,
                    DownloadStatus::Queued
                        | DownloadStatus::Downloading
                        | DownloadStatus::Verifying
                )
            })
            .count();

        let active_uploads = self
            .uploads
            .read()
            .unwrap()
            .values()
            .filter(|e| {
                matches!(
                    e.snapshot.status,
                    UploadStatus::Queued | UploadStatus::Uploading | UploadStatus::Indexing
                )
            })
            .count();

        let ready_to_exit = active_syncs == 0
            && playing_games.is_empty()
            && active_downloads == 0
            && active_uploads == 0;

        ShutdownStatusDto {
            active_syncs,
            playing_games,
            active_downloads,
            active_uploads,
            ready_to_exit,
        }
    }

    /// Emits `LauncherEvent::ShutdownRequested` with the current [`ShutdownStatusDto`] and
    /// returns it.
    pub fn request_shutdown_check(&self) -> ShutdownStatusDto {
        let status = self.shutdown_status();
        self.emit(LauncherEvent::ShutdownRequested {
            status: status.clone(),
        });
        status
    }

    /// Executes the safe shutdown sequence:
    /// 1. If a game is currently running and `force_while_playing` is `false`, returns early
    ///    with `completed: false` so the caller/UI can ask the user for confirmation.
    /// 2. Marks the core as `shutting_down` so no new background auto-sync passes start.
    /// 3. Waits up to `timeout` for any in-flight save syncs (`active_syncs`) to complete.
    /// 4. Pauses any active downloads or uploads so partial `.part` files aren't written mid-exit.
    /// 5. Checkpoints and truncates the SQLite WAL (`PRAGMA wal_checkpoint(TRUNCATE)`).
    pub async fn perform_safe_shutdown(
        &self,
        timeout: Duration,
        force_while_playing: bool,
    ) -> CoreResult<ShutdownResultDto> {
        let initial = self.shutdown_status();
        if !force_while_playing && !initial.playing_games.is_empty() {
            return Ok(ShutdownResultDto {
                completed: false,
                active_syncs_remaining: initial.active_syncs,
                playing_games: initial.playing_games,
                wal_checkpointed: false,
            });
        }

        self.shutting_down.store(true, Ordering::SeqCst);

        // Wait for any in-flight save sync operations to finish cleanly.
        let deadline = Instant::now() + timeout;
        while self.active_sync_count() > 0 && Instant::now() < deadline {
            let remaining = self.active_sync_count();
            self.emit(LauncherEvent::ShutdownProgress {
                stage: "waiting_for_sync".to_string(),
                active_syncs: remaining,
                message: format!("Finishing {remaining} active save sync(s) before closing…"),
            });
            let wait_for = deadline.saturating_duration_since(Instant::now());
            let notified = self.sync_idle_notify.notified();
            if self.active_sync_count() == 0 {
                break;
            }
            let _ = tokio::time::timeout(wait_for.min(Duration::from_millis(250)), notified).await;
        }

        // Pause active downloads and uploads so disk writes stop cleanly before exit.
        let dl_ids: Vec<String> = self.downloads.read().unwrap().keys().cloned().collect();
        for id in dl_ids {
            let _ = self.pause_download(&id).await;
        }
        let up_ids: Vec<String> = self.uploads.read().unwrap().keys().cloned().collect();
        for id in up_ids {
            let _ = self.pause_upload(&id).await;
        }

        // If any games are still running (when force_while_playing == true), touch their
        // active_sessions heartbeat so the next startup accurately detects them.
        let live_pairs: Vec<(String, i64)> =
            self.playing_games.lock().unwrap().iter().cloned().collect();
        let now = Utc::now();
        for (pid, gid) in &live_pairs {
            if let Ok(Some(rec)) = self.db.get_active_session(pid, *gid) {
                // Use the suspend-aware heartbeat value only. Raw wall-clock elapsed time
                // would count time the machine spent asleep as playtime.
                let _ = self
                    .db
                    .heartbeat_active_session(pid, *gid, now, rec.active_secs);
            }
        }

        if let Some(profile) = self.active_profile().await {
            let _ = self.record_activity(
                &profile.id,
                None,
                None,
                "safe_shutdown",
                "info",
                "Safe shutdown completed",
                "In-flight save syncs flushed and SQLite WAL checkpointed",
            );
        }

        let wal_checkpointed = self.db.checkpoint_wal().is_ok();
        let remaining = self.active_sync_count();
        self.emit(LauncherEvent::ShutdownProgress {
            stage: "ready".to_string(),
            active_syncs: remaining,
            message: "Safe shutdown complete".to_string(),
        });

        Ok(ShutdownResultDto {
            completed: true,
            active_syncs_remaining: remaining,
            playing_games: initial.playing_games,
            wal_checkpointed,
        })
    }

    pub async fn playtime_summary(&self, game_id: i64) -> CoreResult<PlaytimeSummary> {
        let profile = self
            .active_profile()
            .await
            .ok_or(CoreError::NoActiveProfile)?;
        Ok(self.db.playtime_summary(&profile.id, game_id)?)
    }

    pub fn detect_proton(&self) -> Vec<ProtonInstallation> {
        if let Some(cached) = self.proton_cache.read().unwrap().as_ref() {
            return cached.clone();
        }
        self.rescan_proton()
    }

    pub fn rescan_proton(&self) -> Vec<ProtonInstallation> {
        let roots = default_proton_search_roots(&self.paths.proton_dir);
        let list = detect_proton_in_roots(&roots);
        *self.proton_cache.write().unwrap() = Some(list.clone());
        list
    }

    #[allow(clippy::too_many_arguments)]
    fn record_installed_game(
        &self,
        profile_id: &str,
        game_id: i64,
        name: &str,
        slug: &str,
        install_dir: &Path,
        outcome: &DownloadOutcome,
        synced_overlay: bool,
    ) -> CoreResult<InstalledGame> {
        let discovered = discover_executables(install_dir, name);
        let executable_rel_path = discovered.into_iter().next().map(|e| e.rel_path);

        let installed = InstalledGame {
            profile_id: profile_id.to_string(),
            game_id,
            name: name.to_string(),
            slug: slug.to_string(),
            install_dir: outcome.install_dir.clone(),
            executable_rel_path,
            manifest_hash: Some(outcome.manifest_hash.clone()),
            total_size: outcome.total_bytes,
            installed_at: Utc::now(),
            last_synced_at: if synced_overlay {
                Some(Utc::now())
            } else {
                None
            },
            proton_override: None,
        };
        self.db.upsert_installed_game(&installed)?;
        self.sync_fingerprints
            .lock()
            .unwrap()
            .remove(&(profile_id.to_string(), game_id));
        Ok(installed)
    }

    fn update_download_snapshot<F>(&self, job_id: &str, mutate: F)
    where
        F: FnOnce(&mut DownloadJobSnapshot),
    {
        let updated = {
            let mut map = self.downloads.write().unwrap();
            let Some(entry) = map.get_mut(job_id) else {
                return;
            };
            mutate(&mut entry.snapshot);
            entry.snapshot.clone()
        };
        self.emit(LauncherEvent::DownloadUpdated { job: updated });
    }

    fn finalize_cancelled(&self, job_id: &str) {
        let maybe_updated = {
            let mut map = self.downloads.write().unwrap();
            let Some(entry) = map.get_mut(job_id) else {
                return;
            };
            if matches!(entry.snapshot.status, DownloadStatus::Cancelled) {
                None
            } else {
                entry.snapshot.status = DownloadStatus::Cancelled;
                entry.snapshot.bytes_per_sec = 0.0;
                Some(entry.snapshot.clone())
            }
        };
        if let Some(job) = maybe_updated {
            self.emit(LauncherEvent::DownloadUpdated { job });
        }
    }

    async fn active_client(&self) -> CoreResult<OpenSyncClient> {
        let guard = self.active.read().await;
        let active = guard.as_ref().ok_or(CoreError::NoActiveProfile)?;
        Ok(active.client.clone())
    }

    async fn active_profile_and_client(&self) -> CoreResult<(Profile, OpenSyncClient)> {
        let guard = self.active.read().await;
        let active = guard.as_ref().ok_or(CoreError::NoActiveProfile)?;
        Ok((active.profile.clone(), active.client.clone()))
    }
}

/// Moves uploaded game files into the launcher's games directory. `std::fs::rename` is used as
/// the fast path (whole directory when the destination is absent, otherwise per entry); files
/// that cannot be renamed because they live on another filesystem are copied and the source is
/// removed only after the copy has been verified. `_staged` sources additionally have their
/// parent staging root cleaned up by the upload pipeline once this returns.
fn move_game_into_install_dir(source: &Path, target: &Path, _staged: bool) -> io::Result<()> {
    move_tree(source, target)
}

fn move_tree(source: &Path, target: &Path) -> io::Result<()> {
    if source == target || !source.exists() {
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if source.is_dir() {
        // Fast path: renaming a whole directory is a constant-time operation on one FS.
        if !target.exists() && std::fs::rename(source, target).is_ok() {
            return Ok(());
        }
        std::fs::create_dir_all(target)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            let src = entry.path();
            let dst = target.join(entry.file_name());
            let kind = entry.file_type()?;
            if kind.is_dir() {
                move_tree(&src, &dst)?;
            } else if kind.is_file() || kind.is_symlink() {
                if dst.exists() || dst.is_symlink() {
                    std::fs::remove_file(&dst)?;
                }
                move_file(&src, &dst)?;
            }
        }
        // Verified removal: the source directory is only deleted after every entry moved.
        std::fs::remove_dir(source)?;
    } else {
        move_file(source, target)?;
    }
    Ok(())
}

fn move_file(source: &Path, target: &Path) -> io::Result<()> {
    match std::fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Cross-filesystem fallback: copy, verify byte count, then remove the source.
            std::fs::copy(source, target)?;
            if std::fs::metadata(source)?.len() != std::fs::metadata(target)?.len() {
                return Err(io::Error::other(format!(
                    "verified copy failed for {}",
                    source.display()
                )));
            }
            std::fs::remove_file(source)
        }
    }
}

fn safe_cache_component(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// A game slug is supplied by a remote (possibly hostile) server and is used as a
/// single directory name. Accept only one plain ASCII segment — never an absolute
/// path, a parent reference, a separator, or an embedded NUL.
fn validate_game_slug(slug: &str) -> CoreResult<()> {
    let valid = !slug.is_empty()
        && slug.len() <= 128
        && slug != "."
        && slug != ".."
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if valid {
        Ok(())
    } else {
        Err(CoreError::UnsafeGameSlug(slug.to_string()))
    }
}

/// Computes the install directory for a freshly installed game. The slug is
/// validated first and the result is checked against the canonicalized profile
/// games directory, so a malicious slug can never escape into an arbitrary path.
fn install_dir_for_slug(games_dir: &Path, profile_id: &str, slug: &str) -> CoreResult<PathBuf> {
    validate_game_slug(slug)?;
    let base = games_dir.join(profile_id);
    std::fs::create_dir_all(&base)?;
    let canonical_base = std::fs::canonicalize(&base)?;
    let candidate = canonical_base.join(slug);
    if candidate == canonical_base || !candidate.starts_with(&canonical_base) {
        return Err(CoreError::UnsafeInstallDir(candidate));
    }
    if candidate
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err(CoreError::UnsafeInstallDir(candidate));
    }
    Ok(candidate)
}

/// Canonicalizes `path` by resolving its deepest existing ancestor with `canonicalize`
/// (rejecting any symlink component along the way) and appending only plain `Normal`
/// non-existent tail components so `..`, broken symlinks, and Windows `\\?\` / macOS
/// `/private/var` prefix mismatches are all handled uniformly.
fn resolve_without_traversal_or_symlink(path: &Path) -> CoreResult<PathBuf> {
    let mut cur = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();

    loop {
        match std::fs::symlink_metadata(&cur) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(CoreError::UnsafeInstallDir(path.to_path_buf()));
                }
                let mut resolved = std::fs::canonicalize(&cur)?;
                for seg in tail.into_iter().rev() {
                    resolved.push(seg);
                }
                return Ok(resolved);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let Some(name) = cur.file_name() else {
                    return Err(CoreError::UnsafeInstallDir(path.to_path_buf()));
                };
                if name == "." || name == ".." {
                    return Err(CoreError::UnsafeInstallDir(path.to_path_buf()));
                }
                tail.push(name.to_os_string());
                let Some(parent) = cur.parent() else {
                    return Err(CoreError::UnsafeInstallDir(path.to_path_buf()));
                };
                cur = parent.to_path_buf();
            }
            Err(e) => return Err(CoreError::Io(e)),
        }
    }
}

/// Verifies that an install directory restored from SQLite is safe to write to or delete:
/// either it resolves inside the active `games_dir/<profile_id>` tree, or (when the user
/// changed `games_dir` in Settings after installing) its canonicalized parent is `<profile_id>`
/// and its leaf folder name is a valid game slug, with no symlinks or `..` traversal.
fn assert_install_dir_contained(games_dir: &Path, profile_id: &str, dir: &Path) -> CoreResult<()> {
    if dir
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(CoreError::UnsafeInstallDir(dir.to_path_buf()));
    }

    let resolved = resolve_without_traversal_or_symlink(dir)?;
    let base = games_dir.join(profile_id);
    if base.exists() {
        let canonical_base = std::fs::canonicalize(&base)?;
        if resolved != canonical_base && resolved.starts_with(&canonical_base) {
            return Ok(());
        }
    }

    // Allow legacy/remembered installs from a prior `games_dir` only if they still
    // strictly follow `.../<profile_id>/<valid_slug>`.
    let parent_ok = resolved
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        == Some(profile_id);
    let leaf_ok = resolved
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|s| validate_game_slug(s).is_ok());
    if parent_ok && leaf_ok {
        return Ok(());
    }

    Err(CoreError::UnsafeInstallDir(dir.to_path_buf()))
}

fn pfp_cache_base(profile_id: &str, user_id: i64) -> String {
    format!("{}_{}", safe_cache_component(profile_id), user_id)
}

fn ext_for_mime(content_type: &str) -> &'static str {
    match content_type.to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "bin",
    }
}

fn format_sync_report_detail(report: &SyncReport) -> String {
    if report.uploaded_files == 0 && report.deleted_paths == 0 {
        return format!(
            "Saves up to date ({} files verified)",
            report.skipped_unchanged
        );
    }
    let mut parts = Vec::new();
    if report.uploaded_files > 0 {
        parts.push(format!(
            "{} uploaded ({})",
            report.uploaded_files,
            format_bytes_brief(report.uploaded_bytes)
        ));
    }
    if report.deleted_paths > 0 {
        parts.push(format!("{} deleted", report.deleted_paths));
    }
    if report.skipped_unchanged > 0 {
        parts.push(format!("{} unchanged", report.skipped_unchanged));
    }
    parts.join(" · ")
}

fn format_bytes_brief(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.2} GB", b / GB)
    } else if b >= MB {
        format!("{:.1} MB", b / MB)
    } else if b >= KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}

fn format_duration_brief(secs: u64) -> String {
    if secs < 60 {
        return format!("{}s", secs.max(1));
    }
    let mins = secs / 60;
    let rem_s = secs % 60;
    if mins < 60 {
        if rem_s == 0 {
            format!("{mins}m")
        } else {
            format!("{mins}m {rem_s}s")
        }
    } else {
        let hrs = mins / 60;
        let rem_m = mins % 60;
        format!("{hrs}h {rem_m}m")
    }
}

#[cfg(test)]
mod path_safety_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn game_slug_allowlist_rejects_traversal_and_absolute_paths() {
        for slug in ["fogwoods", "cyber-runner-2077", "game_2"] {
            validate_game_slug(slug).unwrap();
        }
        for slug in [
            "",
            ".",
            "..",
            "/etc/passwd",
            "../escaped",
            "a/b",
            "a\\b",
            "game\0.exe",
            "Uppercase",
            "caf\u{e9}",
        ] {
            assert!(
                validate_game_slug(slug).is_err(),
                "slug {slug:?} must be rejected"
            );
        }
    }

    #[test]
    fn install_dir_for_slug_stays_under_games_directory() {
        let dir = tempdir().unwrap();
        let games_dir = dir.path().join("games");
        let install = install_dir_for_slug(&games_dir, "profile-1", "fogwoods").unwrap();
        let expected_base = std::fs::canonicalize(games_dir.join("profile-1")).unwrap();
        assert!(install.starts_with(expected_base));
        assert_eq!(install.file_name().unwrap(), "fogwoods");

        let escape = dir.path().join("escaped");
        assert!(install_dir_for_slug(&games_dir, "profile-1", escape.to_str().unwrap()).is_err());
        assert!(install_dir_for_slug(&games_dir, "profile-1", "../escaped").is_err());
        assert!(!escape.exists());
    }

    #[test]
    fn install_dir_containment_rejects_paths_outside_games_directory() {
        let dir = tempdir().unwrap();
        let games_dir = dir.path().join("games");
        let profile_dir = games_dir.join("profile-1");
        let safe = profile_dir.join("fogwoods");
        std::fs::create_dir_all(&safe).unwrap();
        assert_install_dir_contained(&games_dir, "profile-1", &safe).unwrap();

        // The profile root itself is never a valid install directory.
        assert!(assert_install_dir_contained(&games_dir, "profile-1", &profile_dir).is_err());

        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        assert!(assert_install_dir_contained(&games_dir, "profile-1", &outside).is_err());

        // A symlink inside the games tree pointing elsewhere must be rejected too.
        let link = profile_dir.join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(unix)]
        assert!(assert_install_dir_contained(&games_dir, "profile-1", &link).is_err());

        // Non-existent traversal tail under the profile dir must be rejected.
        let non_existent_escape = profile_dir.join("foo/../../escaped-new");
        assert!(
            assert_install_dir_contained(&games_dir, "profile-1", &non_existent_escape).is_err()
        );

        // Valid non-existent remembered dir (after uninstall/delete) is accepted.
        let nonexistent_valid = profile_dir.join("celeste");
        assert_install_dir_contained(&games_dir, "profile-1", &nonexistent_valid).unwrap();

        // Changing games_dir in Settings still allows managing existing `<prev>/<profile_id>/<slug>` installs.
        let other_games_dir = dir.path().join("other-games");
        let legacy_install = other_games_dir.join("profile-1").join("fogwoods");
        std::fs::create_dir_all(&legacy_install).unwrap();
        assert_install_dir_contained(&games_dir, "profile-1", &legacy_install).unwrap();
    }

    #[test]
    fn dir_fingerprint_ignores_part_files_and_tracks_changes() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.sav"), b"hello").unwrap();
        let fp1 = compute_dir_fingerprint(dir.path()).unwrap();
        assert_eq!(fp1.file_count, 1);
        assert_eq!(fp1.total_bytes, 5);

        std::fs::write(dir.path().join("tmp.sav.part"), b"partial data").unwrap();
        let fp_with_part = compute_dir_fingerprint(dir.path()).unwrap();
        assert_eq!(fp_with_part, fp1);

        std::thread::sleep(std::time::Duration::from_millis(25));
        std::fs::write(dir.path().join("a.sav"), b"world").unwrap();
        let fp_same_size = compute_dir_fingerprint(dir.path()).unwrap();
        assert_ne!(fp_same_size, fp1);
    }

    #[test]
    fn proton_cache_returns_cached_list_until_rescan() {
        let dir = tempdir().unwrap();
        let db = LauncherDb::open_in_memory().unwrap();
        let secrets = launcher_db::MemorySecretStore::new();
        let paths = LauncherPaths::under(dir.path());
        let core = LauncherCore::new(db, secrets, paths.clone());

        assert!(core.detect_proton().is_empty());

        // Add a fake Proton installation under paths.proton_dir
        let proton_root = paths.proton_dir.join("GE-Proton-Test");
        std::fs::create_dir_all(&proton_root).unwrap();
        std::fs::write(proton_root.join("proton"), b"#!/bin/sh\n").unwrap();

        // Cached detect_proton still returns the cached list until rescan_proton() is called.
        let cached = core.detect_proton();
        assert!(cached.is_empty());

        let rescanned = core.rescan_proton();
        assert!(rescanned.iter().any(|p| p.name == "GE-Proton-Test"));
        assert_eq!(core.detect_proton(), rescanned);
    }
}
