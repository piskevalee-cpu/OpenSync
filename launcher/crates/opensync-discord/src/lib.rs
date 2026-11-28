//! Cross-platform Discord Rich Presence for the OpenSync launcher.
//!
//! A dedicated worker thread owns the Discord IPC socket so a missing or slow
//! Discord client never blocks the Tauri runtime. The worker reconnects with a
//! backoff and only sends an activity when the state changes (plus a periodic
//! refresh, because Discord forgets a presence when its client restarts).

use discord_rich_presence::{
    DiscordIpc, DiscordIpcClient,
    activity::{Activity, Assets, Timestamps},
};
use std::error::Error;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Placeholder app ID. Set `OPENSYNC_DISCORD_CLIENT_ID` to your own application
/// ID from <https://discord.com/developers/applications> to enable presence.
pub const DEFAULT_CLIENT_ID: &str = "123456789012345678";

/// Public OpenSync logo. Discord accepts an image URL for `large_image`, so the
/// logo renders without requiring an uploaded asset in the Developer Portal.
/// Override with `OPENSYNC_DISCORD_LOGO` (URL or uploaded asset key).
pub const DEFAULT_LOGO: &str =
    "https://raw.githubusercontent.com/piskevalee-cpu/OpenSync/main/Art/opensync.png";

const RETRY_INTERVAL: Duration = Duration::from_secs(5);
const REFRESH_INTERVAL: Duration = Duration::from_secs(60);

static LOGO: OnceLock<String> = OnceLock::new();

fn logo_image() -> &'static str {
    LOGO.get_or_init(|| {
        std::env::var("OPENSYNC_DISCORD_LOGO")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_LOGO.to_string())
    })
}

/// What Discord should display right now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PresenceState {
    /// Launcher open, no game running (including the login screen).
    Idle,
    /// A game is running. `slug` maps to the `cover_<slug>` Discord asset.
    Playing { game_name: String, slug: String },
}

enum Command {
    State(PresenceState),
    Enabled(bool),
    Shutdown,
}

/// Cloneable handle to the background presence worker.
#[derive(Clone)]
pub struct DiscordPresence {
    tx: Sender<Command>,
    enabled: Arc<AtomicBool>,
}

impl DiscordPresence {
    /// Starts the worker. `enabled` controls whether presence is initially active.
    pub fn new(client_id: impl Into<String>, enabled: bool) -> Self {
        let (tx, rx) = mpsc::channel();
        let enabled = Arc::new(AtomicBool::new(enabled));
        let worker_enabled = Arc::clone(&enabled);
        let client_id = client_id.into();
        if thread::Builder::new()
            .name("opensync-discord-rpc".to_string())
            .spawn(move || worker(client_id, worker_enabled, rx))
            .is_err()
        {
            // Presence is optional: if the thread cannot start, treat it as disabled.
            enabled.store(false, Ordering::Relaxed);
        }
        Self { tx, enabled }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
        let _ = self.tx.send(Command::Enabled(enabled));
    }

    pub fn set_state(&self, state: PresenceState) {
        let _ = self.tx.send(Command::State(state));
    }

    /// Clears the Discord activity and stops the worker. Safe to call on shutdown.
    pub fn shutdown(&self) {
        let _ = self.tx.send(Command::Shutdown);
    }
}

fn worker(client_id: String, enabled: Arc<AtomicBool>, rx: Receiver<Command>) {
    let mut state = PresenceState::Idle;
    let mut client: Option<DiscordIpcClient> = None;
    let mut connected = false;
    let mut last_sent: Option<PresenceState> = None;
    let mut last_sent_at: Option<Instant> = None;
    let mut retry_at = Instant::now();

    loop {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Command::State(next)) => state = next,
            Ok(Command::Enabled(false)) => {
                clear_and_close(&mut client, &mut connected);
                last_sent = None;
            }
            Ok(Command::Enabled(true)) => {
                retry_at = Instant::now();
                last_sent = None;
            }
            Ok(Command::Shutdown) => {
                clear_and_close(&mut client, &mut connected);
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        if !enabled.load(Ordering::Relaxed) {
            continue;
        }

        if !connected {
            if Instant::now() < retry_at {
                continue;
            }
            match connect(&client_id) {
                Ok(mut fresh) => {
                    let mut applied = false;
                    if let Ok(()) = send_state(&mut fresh, &state) {
                        applied = true;
                        last_sent = Some(state.clone());
                        last_sent_at = Some(Instant::now());
                    }
                    if applied {
                        client = Some(fresh);
                        connected = true;
                    } else {
                        retry_at = Instant::now() + RETRY_INTERVAL;
                    }
                }
                Err(()) => retry_at = Instant::now() + RETRY_INTERVAL,
            }
            continue;
        }

        let changed = last_sent.as_ref() != Some(&state);
        let stale = last_sent_at
            .map(|at| at.elapsed() >= REFRESH_INTERVAL)
            .unwrap_or(true);
        if !changed && !stale {
            continue;
        }

        if let Some(active) = client.as_mut() {
            if send_state(active, &state).is_ok() {
                last_sent = Some(state.clone());
                last_sent_at = Some(Instant::now());
            } else {
                client = None;
                connected = false;
                retry_at = Instant::now() + RETRY_INTERVAL;
            }
        }
    }
}

fn connect(client_id: &str) -> Result<DiscordIpcClient, ()> {
    let mut client = DiscordIpcClient::new(client_id).map_err(|_| ())?;
    client.connect().map_err(|_| ())?;
    Ok(client)
}

fn clear_and_close(client: &mut Option<DiscordIpcClient>, connected: &mut bool) {
    if let Some(active) = client.as_mut() {
        let _ = active.clear_activity();
        let _ = active.close();
    }
    *client = None;
    *connected = false;
}

/// Discord asset keys are lower-case with separators; game slugs already follow
/// that rule server-side, but sanitize defensively for older/imported entries.
pub fn cover_asset_key(slug: &str) -> String {
    let safe: String = slug
        .chars()
        .map(|c| {
            if c.is_ascii_uppercase() {
                c.to_ascii_lowercase()
            } else if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    format!("cover_{safe}")
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn send_state(client: &mut DiscordIpcClient, state: &PresenceState) -> Result<(), Box<dyn Error>> {
    match state {
        PresenceState::Idle => client.set_activity(
            Activity::new().details("Idling").state("OpenSync").assets(
                Assets::new()
                    .large_image(logo_image())
                    .large_text("OpenSync"),
            ),
        ),
        PresenceState::Playing { game_name, slug } => {
            let cover = cover_asset_key(slug);
            client.set_activity(
                Activity::new()
                    .details(game_name)
                    .state("OpenSync")
                    .assets(
                        Assets::new()
                            .large_image(&cover)
                            .large_text(game_name)
                            .small_image(logo_image())
                            .small_text("OpenSync"),
                    )
                    .timestamps(Timestamps::new().start(now_secs())),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cover_asset_key_is_stable_and_safe() {
        assert_eq!(cover_asset_key("fogwoods"), "cover_fogwoods");
        assert_eq!(
            cover_asset_key("cyber-runner-2077"),
            "cover_cyber-runner-2077"
        );
        assert_eq!(cover_asset_key("A/B C"), "cover_a_b_c");
        assert!(cover_asset_key(&"x".repeat(100)).len() <= 64 + "cover_".len());
    }

    #[test]
    fn presence_states_compare_by_value() {
        let a = PresenceState::Playing {
            game_name: "Fogwoods".into(),
            slug: "fogwoods".into(),
        };
        let b = a.clone();
        assert_eq!(a, b);
        assert_ne!(a, PresenceState::Idle);
    }
}
