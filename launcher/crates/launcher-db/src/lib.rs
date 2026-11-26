use chrono::{DateTime, Utc};
use parking_lot::{Mutex, RwLock};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("profile not found: {0}")]
    ProfileNotFound(String),
}

pub type DbResult<T> = Result<T, DbError>;

/// Default directory for launcher state (SQLite database, `secrets.json`, caches, Proton
/// installs and prefixes).
///
/// Resolution order:
/// 1. `OPENSYNC_LAUNCHER_DATA` override (any platform)
/// 2. macOS: `~/Library/Application Support/opensync-launcher`
/// 3. Linux/BSD: `$XDG_DATA_HOME/opensync-launcher` or `~/.local/share/opensync-launcher`
/// 4. Windows: `%LOCALAPPDATA%/opensync-launcher`, `%APPDATA%/opensync-launcher`, or `USERPROFILE/AppData/Local/...`
///
/// macOS never relies on Linux's `$XDG_DATA_HOME` convention.
pub fn default_data_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("OPENSYNC_LAUNCHER_DATA")
        && !custom.trim().is_empty()
    {
        return PathBuf::from(custom);
    }

    let home = ["HOME", "USERPROFILE"]
        .into_iter()
        .filter_map(|var| std::env::var(var).ok())
        .find(|v| !v.trim().is_empty())
        .map(PathBuf::from);

    #[cfg(target_os = "macos")]
    if let Some(home) = home {
        return home.join("Library/Application Support/opensync-launcher");
    }

    #[cfg(target_os = "windows")]
    {
        for var in ["LOCALAPPDATA", "APPDATA"] {
            if let Ok(val) = std::env::var(var)
                && !val.trim().is_empty()
            {
                return PathBuf::from(val).join("opensync-launcher");
            }
        }
        if let Some(home) = home {
            return home.join("AppData/Local/opensync-launcher");
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME")
            && !xdg.trim().is_empty()
        {
            return PathBuf::from(xdg).join("opensync-launcher");
        }
        if let Some(home) = home {
            return home.join(".local/share/opensync-launcher");
        }
    }

    PathBuf::from("./opensync-launcher-data")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Profile {
    pub id: String,
    pub label: String,
    pub server_url: String,
    pub username: String,
    pub user_id: i64,
    pub role: String,
    pub created_at: DateTime<Utc>,
    pub last_connected_at: Option<DateTime<Utc>>,
}

/// A single user-supplied environment variable for a game launch. Stored as JSON text in
/// `game_launch_configs.env_vars` so ordering can be preserved in the UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GameEnvVar {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstalledGame {
    pub profile_id: String,
    pub game_id: i64,
    pub name: String,
    pub slug: String,
    pub install_dir: PathBuf,
    pub executable_rel_path: Option<String>,
    pub manifest_hash: Option<String>,
    pub total_size: u64,
    pub installed_at: DateTime<Utc>,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub proton_override: Option<String>,
}

/// Per-game launch configuration. Kept separate from `installed_games` so options can be
/// configured while a game is still being downloaded — or before it is downloaded at all.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct GameLaunchConfig {
    pub profile_id: String,
    pub game_id: i64,
    /// Custom Wine/Proton prefix. `None` uses the automatic per-game prefix.
    pub wine_prefix: Option<String>,
    /// Raw launch argument string (quote-aware splitting happens at launch time).
    pub launch_args: Option<String>,
    pub env_vars: Vec<GameEnvVar>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlaySession {
    pub id: i64,
    pub profile_id: String,
    pub game_id: i64,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
    pub duration_secs: u64,
    pub runtime: String,
    pub synced: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlaytimeSummary {
    pub total_secs: u64,
    pub session_count: u64,
    pub last_played_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingSync {
    pub id: i64,
    pub profile_id: String,
    pub game_id: i64,
    pub queued_at: DateTime<Utc>,
    pub reason: String,
}

/// Live game session persisted in SQLite while a game is running so a force-quit or crash
/// can be detected on the next launcher startup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActiveSessionRecord {
    pub profile_id: String,
    pub game_id: i64,
    pub game_name: String,
    pub install_dir: PathBuf,
    pub runtime: String,
    pub pid: Option<u32>,
    pub started_at: DateTime<Utc>,
    pub last_heartbeat_at: DateTime<Utc>,
    pub active_secs: u64,
}

/// Persistent activity log entry for game launches, post-close auto-syncs, manual syncs,
/// force-quit recovery detections, and safe shutdown events.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActivityLogEntry {
    pub id: i64,
    pub profile_id: String,
    pub game_id: Option<i64>,
    pub game_name: Option<String>,
    pub kind: String,
    pub level: String,
    pub title: String,
    pub detail: String,
    pub created_at: DateTime<Utc>,
}

/// Pluggable secret storage for session cookies/tokens.
/// Production uses OS keyring or 0600-restricted secret file; tests use `MemorySecretStore`.
pub trait SecretStore: Send + Sync {
    fn set(&self, profile_id: &str, cookie: &str) -> DbResult<()>;
    fn get(&self, profile_id: &str) -> DbResult<Option<String>>;
    fn delete(&self, profile_id: &str) -> DbResult<()>;
}

#[derive(Default)]
pub struct MemorySecretStore {
    inner: Mutex<HashMap<String, String>>,
}

impl MemorySecretStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

impl SecretStore for MemorySecretStore {
    fn set(&self, profile_id: &str, cookie: &str) -> DbResult<()> {
        self.inner
            .lock()
            .insert(profile_id.to_string(), cookie.to_string());
        Ok(())
    }

    fn get(&self, profile_id: &str) -> DbResult<Option<String>> {
        Ok(self.inner.lock().get(profile_id).cloned())
    }

    fn delete(&self, profile_id: &str) -> DbResult<()> {
        self.inner.lock().remove(profile_id);
        Ok(())
    }
}

/// File-backed secret store with 0600 permissions on Unix for standalone persistence across restarts.
pub struct FileSecretStore {
    path: PathBuf,
    cache: RwLock<Option<HashMap<String, String>>>,
}

impl FileSecretStore {
    pub fn new(path: impl Into<PathBuf>) -> Arc<Self> {
        Arc::new(Self {
            path: path.into(),
            cache: RwLock::new(None),
        })
    }

    fn read_map(&self) -> DbResult<HashMap<String, String>> {
        if !self.path.exists() {
            return Ok(HashMap::new());
        }
        let raw = std::fs::read_to_string(&self.path)?;
        Ok(serde_json::from_str(&raw)?)
    }

    fn write_map(&self, map: &HashMap<String, String>) -> DbResult<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_string_pretty(map)?;
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            // Create with 0600 from the start (no TOCTOU window), then fchmod the open handle
            // so a pre-existing secrets.json with loose permissions is fixed too.
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&self.path)?;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            file.write_all(data.as_bytes())?;
        }
        #[cfg(not(unix))]
        std::fs::write(&self.path, data)?;
        Ok(())
    }
}

impl SecretStore for FileSecretStore {
    fn set(&self, profile_id: &str, cookie: &str) -> DbResult<()> {
        let mut guard = self.cache.write();
        if guard.is_none() {
            *guard = Some(self.read_map()?);
        }
        let map = guard.as_mut().unwrap();
        let previous = map.insert(profile_id.to_string(), cookie.to_string());
        if let Err(err) = self.write_map(map) {
            match previous {
                Some(old) => {
                    map.insert(profile_id.to_string(), old);
                }
                None => {
                    map.remove(profile_id);
                }
            }
            return Err(err);
        }
        Ok(())
    }

    fn get(&self, profile_id: &str) -> DbResult<Option<String>> {
        {
            let guard = self.cache.read();
            if let Some(map) = guard.as_ref() {
                return Ok(map.get(profile_id).cloned());
            }
        }
        let mut guard = self.cache.write();
        if guard.is_none() {
            *guard = Some(self.read_map()?);
        }
        Ok(guard.as_ref().and_then(|map| map.get(profile_id).cloned()))
    }

    fn delete(&self, profile_id: &str) -> DbResult<()> {
        let mut guard = self.cache.write();
        if guard.is_none() {
            *guard = Some(self.read_map()?);
        }
        let map = guard.as_mut().unwrap();
        let Some(previous) = map.remove(profile_id) else {
            return Ok(());
        };
        if let Err(err) = self.write_map(map) {
            map.insert(profile_id.to_string(), previous);
            return Err(err);
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct LauncherDb {
    conn: Arc<Mutex<Connection>>,
}

impl LauncherDb {
    pub fn open(path: impl AsRef<Path>) -> DbResult<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.init_schema()?;
        Ok(db)
    }

    pub fn open_in_memory() -> DbResult<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.init_schema()?;
        Ok(db)
    }

    fn init_schema(&self) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA temp_store = MEMORY;
            PRAGMA cache_size = -32000;
            PRAGMA mmap_size = 67108864;
            PRAGMA busy_timeout = 5000;
            PRAGMA foreign_keys = ON;
            "#,
        )?;
        let schema_version: i64 = conn.query_row("PRAGMA user_version;", [], |r| r.get(0))?;
        if schema_version < 1 {
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS app_state (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS profiles (
                    id TEXT PRIMARY KEY,
                    label TEXT NOT NULL,
                    server_url TEXT NOT NULL,
                    username TEXT NOT NULL,
                    user_id INTEGER NOT NULL,
                    role TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    last_connected_at TEXT
                );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_server_user
                    ON profiles(server_url, lower(username));

                CREATE TABLE IF NOT EXISTS installed_games (
                    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                    game_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    slug TEXT NOT NULL,
                    install_dir TEXT NOT NULL,
                    executable_rel_path TEXT,
                    manifest_hash TEXT,
                    total_size INTEGER NOT NULL DEFAULT 0,
                    installed_at TEXT NOT NULL,
                    last_synced_at TEXT,
                    proton_override TEXT,
                    PRIMARY KEY (profile_id, game_id)
                );

                CREATE TABLE IF NOT EXISTS remembered_install_dirs (
                    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                    game_id INTEGER NOT NULL,
                    install_dir TEXT NOT NULL,
                    PRIMARY KEY (profile_id, game_id)
                );

                CREATE TABLE IF NOT EXISTS play_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                    game_id INTEGER NOT NULL,
                    started_at TEXT NOT NULL,
                    ended_at TEXT NOT NULL,
                    duration_secs INTEGER NOT NULL,
                    runtime TEXT NOT NULL,
                    synced INTEGER NOT NULL DEFAULT 0
                );

                CREATE INDEX IF NOT EXISTS idx_sessions_profile_game
                    ON play_sessions(profile_id, game_id);

                CREATE TABLE IF NOT EXISTS pending_syncs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                    game_id INTEGER NOT NULL,
                    queued_at TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    UNIQUE(profile_id, game_id)
                );

                CREATE TABLE IF NOT EXISTS active_sessions (
                    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                    game_id INTEGER NOT NULL,
                    game_name TEXT NOT NULL,
                    install_dir TEXT NOT NULL,
                    runtime TEXT NOT NULL DEFAULT 'native',
                    pid INTEGER,
                    started_at TEXT NOT NULL,
                    last_heartbeat_at TEXT NOT NULL,
                    active_secs INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (profile_id, game_id)
                );

                CREATE TABLE IF NOT EXISTS activity_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                    game_id INTEGER,
                    game_name TEXT,
                    kind TEXT NOT NULL,
                    level TEXT NOT NULL DEFAULT 'info',
                    title TEXT NOT NULL,
                    detail TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_activity_logs_profile_id
                    ON activity_logs(profile_id, id DESC);

                CREATE INDEX IF NOT EXISTS idx_activity_logs_profile_created
                    ON activity_logs(profile_id, created_at DESC);

                PRAGMA user_version = 1;
                "#,
            )?;
        }

        // v2: per-game launch configuration lives in its own table so it can be saved before
        // a game is installed. Existing installs skip the CREATE block above, hence the
        // separate `IF NOT EXISTS` step here.
        if schema_version < 2 {
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS game_launch_configs (
                    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                    game_id INTEGER NOT NULL,
                    wine_prefix TEXT,
                    launch_args TEXT,
                    env_vars TEXT,
                    PRIMARY KEY (profile_id, game_id)
                );
                PRAGMA user_version = 2;
                "#,
            )?;
        }
        Ok(())
    }

    pub fn upsert_profile(
        &self,
        label: &str,
        server_url: &str,
        username: &str,
        user_id: i64,
        role: &str,
    ) -> DbResult<Profile> {
        let normalized_url = server_url.trim_end_matches('/');
        let now = Utc::now();
        let now_str = now.to_rfc3339();
        let conn = self.conn.lock();

        let existing_id: Option<String> = conn
            .prepare_cached(
                "SELECT id FROM profiles WHERE server_url = ?1 AND lower(username) = lower(?2)",
            )?
            .query_row(params![normalized_url, username], |r| r.get(0))
            .optional()?;

        let id = existing_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        conn.prepare_cached(
            r#"
            INSERT INTO profiles (id, label, server_url, username, user_id, role, created_at, last_connected_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(id) DO UPDATE SET
                label = excluded.label,
                username = excluded.username,
                user_id = excluded.user_id,
                role = excluded.role,
                last_connected_at = excluded.last_connected_at
            "#,
        )?
        .execute(params![
            id,
            label,
            normalized_url,
            username,
            user_id,
            role,
            now_str,
            now_str,
        ])?;
        conn.prepare_cached(
            "SELECT id, label, server_url, username, user_id, role, created_at, last_connected_at FROM profiles WHERE id = ?1",
        )?
        .query_row(params![id], Self::row_to_profile)
        .optional()?
        .ok_or_else(|| DbError::ProfileNotFound(id))
    }

    pub fn get_profile(&self, id: &str) -> DbResult<Option<Profile>> {
        let conn = self.conn.lock();
        conn.prepare_cached(
            "SELECT id, label, server_url, username, user_id, role, created_at, last_connected_at FROM profiles WHERE id = ?1",
        )?
        .query_row(params![id], Self::row_to_profile)
        .optional()
        .map_err(Into::into)
    }

    /// Renames a saved instance's local label (display name only; server URL and account
    /// are untouched). Returns the updated profile.
    pub fn rename_profile(&self, id: &str, label: &str) -> DbResult<Profile> {
        let label = label.trim();
        if label.is_empty() {
            return Err(DbError::ProfileNotFound(id.to_string()));
        }
        let conn = self.conn.lock();
        let changed = conn
            .prepare_cached("UPDATE profiles SET label = ?1 WHERE id = ?2")?
            .execute(params![label, id])?;
        if changed == 0 {
            return Err(DbError::ProfileNotFound(id.to_string()));
        }
        conn.prepare_cached(
            "SELECT id, label, server_url, username, user_id, role, created_at, last_connected_at FROM profiles WHERE id = ?1",
        )?
        .query_row(params![id], Self::row_to_profile)
        .optional()?
        .ok_or_else(|| DbError::ProfileNotFound(id.to_string()))
    }

    /// Updates the account username persisted for a saved profile. The server is the source
    /// of truth for the value; this keeps the local copy (and its unique index) in sync.
    /// A conflicting rename may fail with `DbError::Sqlite` from the unique index.
    pub fn update_profile_username(&self, id: &str, username: &str) -> DbResult<Profile> {
        let username = username.trim();
        if username.is_empty() {
            return Err(DbError::ProfileNotFound(id.to_string()));
        }
        let conn = self.conn.lock();
        let changed = conn
            .prepare_cached("UPDATE profiles SET username = ?1 WHERE id = ?2")?
            .execute(params![username, id])?;
        if changed == 0 {
            return Err(DbError::ProfileNotFound(id.to_string()));
        }
        conn.prepare_cached(
            "SELECT id, label, server_url, username, user_id, role, created_at, last_connected_at FROM profiles WHERE id = ?1",
        )?
        .query_row(params![id], Self::row_to_profile)
        .optional()?
        .ok_or_else(|| DbError::ProfileNotFound(id.to_string()))
    }

    pub fn list_profiles(&self) -> DbResult<Vec<Profile>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT id, label, server_url, username, user_id, role, created_at, last_connected_at FROM profiles ORDER BY COALESCE(last_connected_at, created_at) DESC",
        )?;
        let rows = stmt.query_map([], Self::row_to_profile)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn touch_profile_connected(&self, id: &str) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.prepare_cached("UPDATE profiles SET last_connected_at = ?1 WHERE id = ?2")?
            .execute(params![Utc::now().to_rfc3339(), id])?;
        Ok(())
    }

    pub fn delete_profile(&self, id: &str) -> DbResult<()> {
        let conn = self.conn.lock();
        // Explicit cleanup keeps the table tidy even when foreign keys are disabled.
        conn.prepare_cached("DELETE FROM remembered_install_dirs WHERE profile_id = ?1")?
            .execute(params![id])?;
        conn.prepare_cached("DELETE FROM profiles WHERE id = ?1")?
            .execute(params![id])?;
        conn.prepare_cached(
            "DELETE FROM app_state WHERE key = 'active_profile_id' AND value = ?1",
        )?
        .execute(params![id])?;
        Ok(())
    }

    pub fn set_active_profile_id(&self, id: Option<&str>) -> DbResult<()> {
        let conn = self.conn.lock();
        match id {
            Some(pid) => {
                conn.prepare_cached(
                    "INSERT INTO app_state (key, value) VALUES ('active_profile_id', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                )?
                .execute(params![pid])?;
            }
            None => {
                conn.prepare_cached("DELETE FROM app_state WHERE key = 'active_profile_id'")?
                    .execute([])?;
            }
        }
        Ok(())
    }

    pub fn get_active_profile_id(&self) -> DbResult<Option<String>> {
        let conn = self.conn.lock();
        conn.prepare_cached("SELECT value FROM app_state WHERE key = 'active_profile_id'")?
            .query_row([], |r| r.get(0))
            .optional()
            .map_err(Into::into)
    }

    pub fn get_setting(&self, key: &str) -> DbResult<Option<String>> {
        let conn = self.conn.lock();
        conn.prepare_cached("SELECT value FROM app_state WHERE key = ?1")?
            .query_row(params![key], |r| r.get(0))
            .optional()
            .map_err(Into::into)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.prepare_cached(
            "INSERT INTO app_state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )?
        .execute(params![key, value])?;
        Ok(())
    }

    pub fn upsert_installed_game(&self, game: &InstalledGame) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.prepare_cached(
            r#"
            INSERT INTO installed_games (
                profile_id, game_id, name, slug, install_dir, executable_rel_path,
                manifest_hash, total_size, installed_at, last_synced_at, proton_override
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(profile_id, game_id) DO UPDATE SET
                name = excluded.name,
                slug = excluded.slug,
                install_dir = excluded.install_dir,
                executable_rel_path = COALESCE(excluded.executable_rel_path, installed_games.executable_rel_path),
                manifest_hash = excluded.manifest_hash,
                total_size = excluded.total_size,
                last_synced_at = COALESCE(excluded.last_synced_at, installed_games.last_synced_at),
                proton_override = COALESCE(excluded.proton_override, installed_games.proton_override)
            "#,
        )?
        .execute(params![
            game.profile_id,
            game.game_id,
            game.name,
            game.slug,
            game.install_dir.to_string_lossy().as_ref(),
            game.executable_rel_path,
            game.manifest_hash,
            game.total_size as i64,
            game.installed_at.to_rfc3339(),
            game.last_synced_at.map(|d| d.to_rfc3339()),
            game.proton_override,
        ])?;
        Ok(())
    }

    pub fn get_installed_game(
        &self,
        profile_id: &str,
        game_id: i64,
    ) -> DbResult<Option<InstalledGame>> {
        let conn = self.conn.lock();
        conn.prepare_cached(
            r#"
            SELECT profile_id, game_id, name, slug, install_dir, executable_rel_path,
                   manifest_hash, total_size, installed_at, last_synced_at, proton_override
            FROM installed_games WHERE profile_id = ?1 AND game_id = ?2
            "#,
        )?
        .query_row(params![profile_id, game_id], Self::row_to_installed)
        .optional()
        .map_err(Into::into)
    }

    pub fn list_installed_games(&self, profile_id: &str) -> DbResult<Vec<InstalledGame>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            r#"
            SELECT profile_id, game_id, name, slug, install_dir, executable_rel_path,
                   manifest_hash, total_size, installed_at, last_synced_at, proton_override
            FROM installed_games WHERE profile_id = ?1 ORDER BY installed_at DESC
            "#,
        )?;
        let rows = stmt.query_map(params![profile_id], Self::row_to_installed)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn update_game_synced_at(
        &self,
        profile_id: &str,
        game_id: i64,
        synced_at: DateTime<Utc>,
    ) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.prepare_cached(
            "UPDATE installed_games SET last_synced_at = ?1 WHERE profile_id = ?2 AND game_id = ?3",
        )?
        .execute(params![synced_at.to_rfc3339(), profile_id, game_id])?;
        Ok(())
    }

    pub fn update_game_executable(
        &self,
        profile_id: &str,
        game_id: i64,
        exe_rel_path: Option<&str>,
    ) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.prepare_cached(
            "UPDATE installed_games SET executable_rel_path = ?1 WHERE profile_id = ?2 AND game_id = ?3",
        )?
        .execute(params![exe_rel_path, profile_id, game_id])?;
        Ok(())
    }

    pub fn update_game_proton_override(
        &self,
        profile_id: &str,
        game_id: i64,
        proton_name: Option<&str>,
    ) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.prepare_cached(
            "UPDATE installed_games SET proton_override = ?1 WHERE profile_id = ?2 AND game_id = ?3",
        )?
        .execute(params![proton_name, profile_id, game_id])?;
        Ok(())
    }

    /// Persists the custom prefix, argument string and environment variables in one write so
    /// the settings panel saves atomically. Works even before the game has been installed.
    pub fn upsert_game_launch_config(&self, config: &GameLaunchConfig) -> DbResult<()> {
        let conn = self.conn.lock();
        let env_json = serde_json::to_string(&config.env_vars)?;
        conn.prepare_cached(
            r#"
            INSERT INTO game_launch_configs (
                profile_id, game_id, wine_prefix, launch_args, env_vars
            ) VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(profile_id, game_id) DO UPDATE SET
                wine_prefix = excluded.wine_prefix,
                launch_args = excluded.launch_args,
                env_vars = excluded.env_vars
            "#,
        )?
        .execute(params![
            config.profile_id,
            config.game_id,
            config.wine_prefix,
            config.launch_args,
            env_json,
        ])?;
        Ok(())
    }

    pub fn get_game_launch_config(
        &self,
        profile_id: &str,
        game_id: i64,
    ) -> DbResult<Option<GameLaunchConfig>> {
        let conn = self.conn.lock();
        conn.prepare_cached(
            r#"
            SELECT profile_id, game_id, wine_prefix, launch_args, env_vars
            FROM game_launch_configs WHERE profile_id = ?1 AND game_id = ?2
            "#,
        )?
        .query_row(params![profile_id, game_id], Self::row_to_launch_config)
        .optional()
        .map_err(Into::into)
    }

    pub fn list_game_launch_configs(&self, profile_id: &str) -> DbResult<Vec<GameLaunchConfig>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            r#"
            SELECT profile_id, game_id, wine_prefix, launch_args, env_vars
            FROM game_launch_configs WHERE profile_id = ?1
            "#,
        )?;
        let rows = stmt.query_map(params![profile_id], Self::row_to_launch_config)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn remove_installed_game(&self, profile_id: &str, game_id: i64) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.prepare_cached("DELETE FROM installed_games WHERE profile_id = ?1 AND game_id = ?2")?
            .execute(params![profile_id, game_id])?;
        Ok(())
    }

    /// Persists the directory a game was installed into so a later redownload can restore
    /// the exact same path (and its cloud saves) instead of rebuilding from the game slug.
    pub fn set_remembered_install_dir(
        &self,
        profile_id: &str,
        game_id: i64,
        install_dir: &Path,
    ) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.prepare_cached(
            r#"
            INSERT INTO remembered_install_dirs (profile_id, game_id, install_dir)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(profile_id, game_id) DO UPDATE SET install_dir = excluded.install_dir
            "#,
        )?
        .execute(params![
            profile_id,
            game_id,
            install_dir.to_string_lossy().as_ref()
        ])?;
        Ok(())
    }

    pub fn get_remembered_install_dir(
        &self,
        profile_id: &str,
        game_id: i64,
    ) -> DbResult<Option<PathBuf>> {
        let conn = self.conn.lock();
        let raw: Option<String> = conn
            .prepare_cached(
                "SELECT install_dir FROM remembered_install_dirs WHERE profile_id = ?1 AND game_id = ?2",
            )?
            .query_row(params![profile_id, game_id], |r| r.get(0))
            .optional()?;
        Ok(raw.map(PathBuf::from))
    }

    pub fn clear_remembered_install_dir(&self, profile_id: &str, game_id: i64) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.prepare_cached(
            "DELETE FROM remembered_install_dirs WHERE profile_id = ?1 AND game_id = ?2",
        )?
        .execute(params![profile_id, game_id])?;
        Ok(())
    }

    pub fn record_play_session(
        &self,
        profile_id: &str,
        game_id: i64,
        started_at: DateTime<Utc>,
        ended_at: DateTime<Utc>,
        duration_secs: u64,
        runtime: &str,
        synced: bool,
    ) -> DbResult<PlaySession> {
        let conn = self.conn.lock();
        conn.prepare_cached(
            r#"
            INSERT INTO play_sessions (profile_id, game_id, started_at, ended_at, duration_secs, runtime, synced)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
        )?
        .execute(params![
            profile_id,
            game_id,
            started_at.to_rfc3339(),
            ended_at.to_rfc3339(),
            duration_secs as i64,
            runtime,
            if synced { 1 } else { 0 },
        ])?;
        let id = conn.last_insert_rowid();
        Ok(PlaySession {
            id,
            profile_id: profile_id.to_string(),
            game_id,
            started_at,
            ended_at,
            duration_secs,
            runtime: runtime.to_string(),
            synced,
        })
    }

    pub fn mark_session_synced(&self, session_id: i64) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.prepare_cached("UPDATE play_sessions SET synced = 1 WHERE id = ?1")?
            .execute(params![session_id])?;
        Ok(())
    }

    pub fn list_play_sessions(&self, profile_id: &str, game_id: i64) -> DbResult<Vec<PlaySession>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            r#"
            SELECT id, profile_id, game_id, started_at, ended_at, duration_secs, runtime, synced
            FROM play_sessions WHERE profile_id = ?1 AND game_id = ?2 ORDER BY started_at DESC
            "#,
        )?;
        let rows = stmt.query_map(params![profile_id, game_id], |r| {
            let started: String = r.get(3)?;
            let ended: String = r.get(4)?;
            let synced_int: i64 = r.get(7)?;
            Ok(PlaySession {
                id: r.get(0)?,
                profile_id: r.get(1)?,
                game_id: r.get(2)?,
                started_at: parse_dt(&started),
                ended_at: parse_dt(&ended),
                duration_secs: r.get::<_, i64>(5)?.max(0) as u64,
                runtime: r.get(6)?,
                synced: synced_int != 0,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn playtime_summary(&self, profile_id: &str, game_id: i64) -> DbResult<PlaytimeSummary> {
        let conn = self.conn.lock();
        let (total, count, last): (i64, i64, Option<String>) = conn
            .prepare_cached(
                "SELECT COALESCE(SUM(duration_secs), 0), COUNT(*), MAX(ended_at) FROM play_sessions WHERE profile_id = ?1 AND game_id = ?2",
            )?
            .query_row(params![profile_id, game_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?;
        Ok(PlaytimeSummary {
            total_secs: total.max(0) as u64,
            session_count: count.max(0) as u64,
            last_played_at: last.as_deref().map(parse_dt),
        })
    }

    pub fn playtime_summaries_for_profile(
        &self,
        profile_id: &str,
    ) -> DbResult<HashMap<i64, PlaytimeSummary>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT game_id, COALESCE(SUM(duration_secs), 0), COUNT(*), MAX(ended_at) FROM play_sessions WHERE profile_id = ?1 GROUP BY game_id",
        )?;
        let rows = stmt.query_map(params![profile_id], |r| {
            let gid: i64 = r.get(0)?;
            let total: i64 = r.get(1)?;
            let count: i64 = r.get(2)?;
            let last: Option<String> = r.get(3)?;
            Ok((
                gid,
                PlaytimeSummary {
                    total_secs: total.max(0) as u64,
                    session_count: count.max(0) as u64,
                    last_played_at: last.as_deref().map(parse_dt),
                },
            ))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (gid, summary) = row?;
            map.insert(gid, summary);
        }
        Ok(map)
    }

    pub fn queue_pending_sync(&self, profile_id: &str, game_id: i64, reason: &str) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.prepare_cached(
            r#"
            INSERT INTO pending_syncs (profile_id, game_id, queued_at, reason)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(profile_id, game_id) DO UPDATE SET
                queued_at = excluded.queued_at,
                reason = excluded.reason
            "#,
        )?
        .execute(params![
            profile_id,
            game_id,
            Utc::now().to_rfc3339(),
            reason
        ])?;
        Ok(())
    }

    pub fn list_pending_syncs(&self, profile_id: &str) -> DbResult<Vec<PendingSync>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT id, profile_id, game_id, queued_at, reason FROM pending_syncs WHERE profile_id = ?1 ORDER BY queued_at ASC",
        )?;
        let rows = stmt.query_map(params![profile_id], |r| {
            let queued: String = r.get(3)?;
            Ok(PendingSync {
                id: r.get(0)?,
                profile_id: r.get(1)?,
                game_id: r.get(2)?,
                queued_at: parse_dt(&queued),
                reason: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn clear_pending_sync(&self, profile_id: &str, game_id: i64) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.prepare_cached("DELETE FROM pending_syncs WHERE profile_id = ?1 AND game_id = ?2")?
            .execute(params![profile_id, game_id])?;
        Ok(())
    }

    pub fn upsert_active_session(&self, rec: &ActiveSessionRecord) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.prepare_cached(
            r#"
            INSERT INTO active_sessions (
                profile_id, game_id, game_name, install_dir, runtime, pid,
                started_at, last_heartbeat_at, active_secs
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(profile_id, game_id) DO UPDATE SET
                game_name = excluded.game_name,
                install_dir = excluded.install_dir,
                runtime = excluded.runtime,
                pid = excluded.pid,
                started_at = excluded.started_at,
                last_heartbeat_at = excluded.last_heartbeat_at,
                active_secs = excluded.active_secs
            "#,
        )?
        .execute(params![
            rec.profile_id,
            rec.game_id,
            rec.game_name,
            rec.install_dir.to_string_lossy().as_ref(),
            rec.runtime,
            rec.pid.map(|p| p as i64),
            rec.started_at.to_rfc3339(),
            rec.last_heartbeat_at.to_rfc3339(),
            rec.active_secs as i64,
        ])?;
        Ok(())
    }

    pub fn heartbeat_active_session(
        &self,
        profile_id: &str,
        game_id: i64,
        heartbeat_at: DateTime<Utc>,
        active_secs: u64,
    ) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.prepare_cached(
            r#"
            UPDATE active_sessions
            SET last_heartbeat_at = ?1, active_secs = ?2
            WHERE profile_id = ?3 AND game_id = ?4
            "#,
        )?
        .execute(params![
            heartbeat_at.to_rfc3339(),
            active_secs as i64,
            profile_id,
            game_id,
        ])?;
        Ok(())
    }

    pub fn get_active_session(
        &self,
        profile_id: &str,
        game_id: i64,
    ) -> DbResult<Option<ActiveSessionRecord>> {
        let conn = self.conn.lock();
        conn.prepare_cached(
            r#"
            SELECT profile_id, game_id, game_name, install_dir, runtime, pid,
                   started_at, last_heartbeat_at, active_secs
            FROM active_sessions WHERE profile_id = ?1 AND game_id = ?2
            "#,
        )?
        .query_row(params![profile_id, game_id], Self::row_to_active_session)
        .optional()
        .map_err(Into::into)
    }

    pub fn list_active_sessions(&self, profile_id: &str) -> DbResult<Vec<ActiveSessionRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            r#"
            SELECT profile_id, game_id, game_name, install_dir, runtime, pid,
                   started_at, last_heartbeat_at, active_secs
            FROM active_sessions WHERE profile_id = ?1 ORDER BY started_at DESC
            "#,
        )?;
        let rows = stmt.query_map(params![profile_id], Self::row_to_active_session)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn clear_active_session(&self, profile_id: &str, game_id: i64) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.prepare_cached("DELETE FROM active_sessions WHERE profile_id = ?1 AND game_id = ?2")?
            .execute(params![profile_id, game_id])?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn append_activity_log(
        &self,
        profile_id: &str,
        game_id: Option<i64>,
        game_name: Option<&str>,
        kind: &str,
        level: &str,
        title: &str,
        detail: &str,
    ) -> DbResult<ActivityLogEntry> {
        let now = Utc::now();
        let conn = self.conn.lock();
        conn.prepare_cached(
            r#"
            INSERT INTO activity_logs (profile_id, game_id, game_name, kind, level, title, detail, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
        )?
        .execute(params![
            profile_id,
            game_id,
            game_name,
            kind,
            level,
            title,
            detail,
            now.to_rfc3339(),
        ])?;
        let id = conn.last_insert_rowid();
        // Keep the latest 200 log entries per profile so the table stays bounded.
        if let Ok(mut trim) = conn.prepare_cached(
            r#"
            DELETE FROM activity_logs
            WHERE profile_id = ?1
              AND id NOT IN (
                  SELECT id FROM activity_logs WHERE profile_id = ?1 ORDER BY id DESC LIMIT 200
              )
            "#,
        ) {
            let _ = trim.execute(params![profile_id]);
        }
        Ok(ActivityLogEntry {
            id,
            profile_id: profile_id.to_string(),
            game_id,
            game_name: game_name.map(|s| s.to_string()),
            kind: kind.to_string(),
            level: level.to_string(),
            title: title.to_string(),
            detail: detail.to_string(),
            created_at: now,
        })
    }

    pub fn list_activity_logs(
        &self,
        profile_id: &str,
        limit: usize,
    ) -> DbResult<Vec<ActivityLogEntry>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            r#"
            SELECT id, profile_id, game_id, game_name, kind, level, title, detail, created_at
            FROM activity_logs
            WHERE profile_id = ?1
            ORDER BY id DESC
            LIMIT ?2
            "#,
        )?;
        let rows = stmt.query_map(params![profile_id, limit.max(1) as i64], |r| {
            let created: String = r.get(8)?;
            Ok(ActivityLogEntry {
                id: r.get(0)?,
                profile_id: r.get(1)?,
                game_id: r.get(2)?,
                game_name: r.get(3)?,
                kind: r.get(4)?,
                level: r.get(5)?,
                title: r.get(6)?,
                detail: r.get(7)?,
                created_at: parse_dt(&created),
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn clear_activity_logs(&self, profile_id: &str) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.prepare_cached("DELETE FROM activity_logs WHERE profile_id = ?1")?
            .execute(params![profile_id])?;
        Ok(())
    }

    /// Flushes and truncates the SQLite Write-Ahead Log so all committed state is safely
    /// merged into the main database file before application shutdown.
    pub fn checkpoint_wal(&self) -> DbResult<()> {
        let conn = self.conn.lock();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(())
    }

    fn row_to_active_session(r: &rusqlite::Row<'_>) -> rusqlite::Result<ActiveSessionRecord> {
        let install_dir: String = r.get(3)?;
        let pid_opt: Option<i64> = r.get(5)?;
        let started: String = r.get(6)?;
        let heartbeat: String = r.get(7)?;
        let active_secs: i64 = r.get(8)?;
        Ok(ActiveSessionRecord {
            profile_id: r.get(0)?,
            game_id: r.get(1)?,
            game_name: r.get(2)?,
            install_dir: PathBuf::from(install_dir),
            runtime: r.get(4)?,
            pid: pid_opt.and_then(|v| u32::try_from(v).ok()),
            started_at: parse_dt(&started),
            last_heartbeat_at: parse_dt(&heartbeat),
            active_secs: active_secs.max(0) as u64,
        })
    }

    fn row_to_profile(r: &rusqlite::Row<'_>) -> rusqlite::Result<Profile> {
        let created: String = r.get(6)?;
        let last: Option<String> = r.get(7)?;
        Ok(Profile {
            id: r.get(0)?,
            label: r.get(1)?,
            server_url: r.get(2)?,
            username: r.get(3)?,
            user_id: r.get(4)?,
            role: r.get(5)?,
            created_at: parse_dt(&created),
            last_connected_at: last.as_deref().map(parse_dt),
        })
    }

    fn row_to_installed(r: &rusqlite::Row<'_>) -> rusqlite::Result<InstalledGame> {
        let install_dir: String = r.get(4)?;
        let installed_at: String = r.get(8)?;
        let last_synced: Option<String> = r.get(9)?;
        Ok(InstalledGame {
            profile_id: r.get(0)?,
            game_id: r.get(1)?,
            name: r.get(2)?,
            slug: r.get(3)?,
            install_dir: PathBuf::from(install_dir),
            executable_rel_path: r.get(5)?,
            manifest_hash: r.get(6)?,
            total_size: r.get::<_, i64>(7)?.max(0) as u64,
            installed_at: parse_dt(&installed_at),
            last_synced_at: last_synced.as_deref().map(parse_dt),
            proton_override: r.get(10)?,
        })
    }

    fn row_to_launch_config(r: &rusqlite::Row<'_>) -> rusqlite::Result<GameLaunchConfig> {
        Ok(GameLaunchConfig {
            profile_id: r.get(0)?,
            game_id: r.get(1)?,
            wine_prefix: r.get(2)?,
            launch_args: r.get(3)?,
            env_vars: parse_env_vars(r.get::<_, Option<String>>(4)?.as_deref()),
        })
    }
}

/// Corrupt or legacy JSON is treated as "no custom variables" rather than failing to load
/// a game into the library.
fn parse_env_vars(raw: Option<&str>) -> Vec<GameEnvVar> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    serde_json::from_str(raw).unwrap_or_default()
}

fn parse_dt(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_dir_default_uses_platform_location() {
        let dir = std::env::var("OPENSYNC_LAUNCHER_DATA").ok();
        if dir.is_some() {
            return; // An explicit override is always respected; nothing else to assert.
        }
        let resolved = default_data_dir();
        assert!(resolved.ends_with("opensync-launcher"), "{resolved:?}");

        #[cfg(target_os = "macos")]
        assert!(
            resolved
                .to_string_lossy()
                .contains("Library/Application Support"),
            "macOS data dir must not use XDG paths: {resolved:?}"
        );
    }

    #[test]
    fn file_secret_store_caches_reads_and_persists_with_0600_mode() {
        let dir = std::env::temp_dir().join(format!("opensync-secrets-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("secrets.json");

        let store = FileSecretStore::new(&path);
        assert_eq!(store.get("p1").unwrap(), None);

        store.set("p1", "cookie-1").unwrap();
        assert_eq!(store.get("p1").unwrap().as_deref(), Some("cookie-1"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        // Subsequent reads hit the in-memory cache without re-reading disk.
        std::fs::remove_file(&path).unwrap();
        assert_eq!(store.get("p1").unwrap().as_deref(), Some("cookie-1"));

        // set() and delete() update both memory and disk.
        store.set("p2", "cookie-2").unwrap();
        store.delete("p1").unwrap();
        assert_eq!(store.get("p1").unwrap(), None);
        assert_eq!(store.get("p2").unwrap().as_deref(), Some("cookie-2"));

        let reopened = FileSecretStore::new(&path);
        assert_eq!(reopened.get("p1").unwrap(), None);
        assert_eq!(reopened.get("p2").unwrap().as_deref(), Some("cookie-2"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn init_schema_sets_pragmas_and_activity_log_index() {
        let db = LauncherDb::open_in_memory().unwrap();
        let conn = db.conn.lock();
        let sync_mode: i64 = conn
            .query_row("PRAGMA synchronous;", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sync_mode, 1); // NORMAL
        let temp_store: i64 = conn
            .query_row("PRAGMA temp_store;", [], |r| r.get(0))
            .unwrap();
        assert_eq!(temp_store, 2); // MEMORY
        let cache_size: i64 = conn
            .query_row("PRAGMA cache_size;", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cache_size, -32000);
        let busy_timeout: i64 = conn
            .query_row("PRAGMA busy_timeout;", [], |r| r.get(0))
            .unwrap();
        assert_eq!(busy_timeout, 5000);

        let index_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_activity_logs_profile_created'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(index_exists, 1);
    }

    #[test]
    fn launch_config_round_trips_without_requiring_an_install() {
        let db = LauncherDb::open_in_memory().unwrap();
        let profile = db
            .upsert_profile("LAN", "http://127.0.0.1:3000", "valerio", 1, "admin")
            .unwrap();
        let config = GameLaunchConfig {
            profile_id: profile.id.clone(),
            game_id: 42,
            wine_prefix: Some("/home/user/prefixes/game".to_string()),
            launch_args: Some("-windowed --save-dir=\"my saves\"".to_string()),
            env_vars: vec![
                GameEnvVar {
                    key: "DXVK_HUD".to_string(),
                    value: "full".to_string(),
                },
                GameEnvVar {
                    key: "GAME_ARG".to_string(),
                    value: "value with spaces".to_string(),
                },
            ],
        };

        db.upsert_game_launch_config(&config).unwrap();
        let loaded = db.get_game_launch_config(&profile.id, 42).unwrap().unwrap();
        assert_eq!(loaded, config);
        assert_eq!(db.list_game_launch_configs(&profile.id).unwrap().len(), 1);
        assert!(db.get_installed_game(&profile.id, 42).unwrap().is_none());
    }

    #[test]
    fn migrates_v1_database_to_v2() {
        let dir = std::env::temp_dir().join(format!("opensync-db-migrate-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("launcher.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                r#"
                PRAGMA user_version = 1;
                CREATE TABLE installed_games (
                    profile_id TEXT NOT NULL,
                    game_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    slug TEXT NOT NULL,
                    install_dir TEXT NOT NULL,
                    executable_rel_path TEXT,
                    manifest_hash TEXT,
                    total_size INTEGER NOT NULL DEFAULT 0,
                    installed_at TEXT NOT NULL,
                    last_synced_at TEXT,
                    proton_override TEXT,
                    PRIMARY KEY (profile_id, game_id)
                );
                "#,
            )
            .unwrap();
        }

        let db = LauncherDb::open(&path).unwrap();
        let conn = db.conn.lock();
        let version: i64 = conn
            .query_row("PRAGMA user_version;", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 2);
        let table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'game_launch_configs'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(table_exists, 1);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
