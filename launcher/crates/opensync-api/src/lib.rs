use bytes::Bytes;
use reqwest::header::{CONTENT_TYPE, COOKIE, HeaderMap, HeaderValue, SET_COOKIE};
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use thiserror::Error;

/// Path the server uses when a user has no custom profile picture.
pub const DEFAULT_PFP_PATH: &str = "/img/blankpfp.jpg";
/// Server cap enforced by `PUT /api/auth/me/pfp`.
pub const MAX_PFP_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("invalid server url: {0}")]
    InvalidUrl(String),
    #[error("unauthorized: session expired or invalid credentials")]
    Unauthorized,
    #[error("chunk out of order; resume required (received: {received})")]
    ResumeRequired { received: usize },
    #[error("hash mismatch rejected by server (422)")]
    HashMismatch,
    #[error("server returned {status}: {message}")]
    Http { status: u16, message: String },
    #[error("missing session cookie in auth response")]
    MissingCookie,
    #[error("invalid profile picture: {0}")]
    InvalidPfp(String),
    #[error("invalid cover image: {0}")]
    InvalidCover(String),
}

/// Returns the only two MIME types that are ever embedded in a `data:` URL and
/// injected into the frontend. The type is derived from the image's magic bytes,
/// never from a server-supplied `Content-Type` header, so a hostile server (or an
/// on-path attacker rewriting headers over plain HTTP) cannot smuggle quotes or
/// markup into an HTML `src="..."` attribute.
pub fn safe_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else {
        None
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub ok: bool,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfo {
    pub name: String,
    pub has_admin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserStats {
    #[serde(default)]
    pub uploaded: u64,
    #[serde(default)]
    pub downloaded: u64,
    #[serde(default)]
    pub synced: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub role: String,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub pfp: Option<String>,
    #[serde(default)]
    pub stats: Option<UserStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Game {
    pub id: i64,
    pub name: String,
    pub slug: String,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub system_requirements: String,
    pub status: String,
    #[serde(default)]
    pub total_size: u64,
    #[serde(default)]
    pub uploaded_by: Option<i64>,
    #[serde(default)]
    pub uploader_name: Option<String>,
    #[serde(default)]
    pub uploader_pfp: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub download_count: u64,
    #[serde(default)]
    pub has_overlay: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OverlayInfo {
    #[serde(default)]
    pub has_overlay: bool,
    #[serde(default)]
    pub files: usize,
    #[serde(default)]
    pub deletions: usize,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameDetail {
    pub game: Game,
    pub overlay: OverlayInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub path: String,
    pub hash: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameManifest {
    pub game_id: i64,
    pub files: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlayPartState {
    pub path: String,
    pub received: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlayInit {
    #[serde(rename = "chunkSize")]
    pub chunk_size: usize,
    pub files: Vec<OverlayPartState>,
}

/// Resume state returned when a game upload is initialized.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadInit {
    #[serde(rename = "chunkSize")]
    pub chunk_size: usize,
    pub files: Vec<OverlayPartState>,
}

/// Acknowledgement for a single uploaded game chunk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkAck {
    pub ok: bool,
    pub done: bool,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub received: Option<usize>,
}

/// Processing state of a game being indexed on the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameStatus {
    pub status: String,
    #[serde(default)]
    pub total_size: u64,
    #[serde(default)]
    pub progress: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncCompleteResponse {
    pub ok: bool,
    #[serde(default)]
    pub overlay: Option<OverlayInfo>,
}

#[derive(Debug, Clone)]
pub struct OpenSyncClient {
    base_url: String,
    http: Client,
    cookie: Option<String>,
    cookie_header: Option<HeaderValue>,
}

/// Normalizes a user-supplied OpenSync server URL:
/// - Trims whitespace and prepends `http://` when no scheme is provided
/// - Validates `http` or `https` scheme and presence of a host
/// - Strips URL fragments (e.g. `#/`, `#/library`), query strings, trailing `/api...` paths, and trailing `/`
pub fn normalize_server_url(raw: &str) -> ApiResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ApiError::InvalidUrl("server URL is empty".to_string()));
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };

    let mut parsed =
        url::Url::parse(&with_scheme).map_err(|e| ApiError::InvalidUrl(e.to_string()))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(ApiError::InvalidUrl(format!(
            "unsupported scheme: {}",
            parsed.scheme()
        )));
    }
    if parsed.host_str().is_none() {
        return Err(ApiError::InvalidUrl("missing host in server URL".to_string()));
    }
    // A wildcard bind address (as printed by `listening on http://0.0.0.0:3000`) is not a
    // connectable destination on every OS; rewrite it to loopback.
    if matches!(parsed.host_str(), Some("0.0.0.0") | Some("[::]") | Some("::")) {
        let _ = parsed.set_host(Some("127.0.0.1"));
    }

    parsed.set_fragment(None);
    parsed.set_query(None);

    let clean_path = {
        let path = parsed.path().trim_end_matches('/');
        if path == "/api" {
            "".to_string()
        } else if let Some(idx) = path.find("/api/") {
            path[..idx].to_string()
        } else {
            path.to_string()
        }
    };
    parsed.set_path(&clean_path);

    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

/// Validates a server-relative image path such as `/api/auth/users/7/pfp` and returns it
/// normalized. Rejects traversal segments, backslashes, NUL, query/fragment suffixes and
/// anything longer than 256 bytes so the value is safe to use as a local cache key.
pub fn sanitize_pfp_path(raw: &str) -> Option<String> {
    let path = raw.trim();
    if path.is_empty()
        || !path.starts_with('/')
        || path.len() > 256
        || path.contains('\\')
        || path.contains('\0')
        || path.contains("..")
        || path.contains('?')
        || path.contains('#')
    {
        return None;
    }
    if !path
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.'))
    {
        return None;
    }
    // Every segment must be non-empty (no double slashes).
    if path.split('/').skip(1).any(str::is_empty) {
        return None;
    }
    Some(path.to_string())
}

impl OpenSyncClient {
    /// Builds a high-throughput client tuned for LAN transfers:
    /// TCP_NODELAY, generous idle connection pool, and rustls.
    pub fn new(base_url: impl AsRef<str>, cookie: Option<String>) -> ApiResult<Self> {
        let normalized = normalize_server_url(base_url.as_ref())?;

        let http = Client::builder()
            .tcp_nodelay(true)
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .pool_max_idle_per_host(16)
            .pool_idle_timeout(Duration::from_secs(90))
            .connect_timeout(Duration::from_secs(8))
            .build()?;

        let cookie_header = cookie
            .as_deref()
            .and_then(|c| HeaderValue::from_str(c).ok());

        Ok(Self {
            base_url: normalized,
            http,
            cookie,
            cookie_header,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn cookie(&self) -> Option<&str> {
        self.cookie.as_deref()
    }

    pub fn with_cookie(&self, cookie: Option<String>) -> Self {
        let cookie_header = cookie
            .as_deref()
            .and_then(|c| HeaderValue::from_str(c).ok());
        Self {
            base_url: self.base_url.clone(),
            http: self.http.clone(),
            cookie,
            cookie_header,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    fn auth_headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(val) = &self.cookie_header {
            headers.insert(COOKIE, val.clone());
        }
        headers
    }

    pub async fn health(&self) -> ApiResult<HealthResponse> {
        let res = self
            .http
            .get(self.url("/api/health"))
            .timeout(Duration::from_secs(5))
            .send()
            .await?;
        parse_json(res).await
    }

    pub async fn info(&self) -> ApiResult<ServerInfo> {
        let res = self
            .http
            .get(self.url("/api/info"))
            .timeout(Duration::from_secs(5))
            .send()
            .await?;
        parse_json(res).await
    }

    pub async fn login(&self, username: &str, password: &str) -> ApiResult<(User, String)> {
        let res = self
            .http
            .post(self.url("/api/auth/login"))
            .json(&serde_json::json!({ "username": username, "password": password }))
            .send()
            .await?;
        extract_auth(res).await
    }

    pub async fn register(&self, username: &str, password: &str) -> ApiResult<(User, String)> {
        let res = self
            .http
            .post(self.url("/api/auth/register"))
            .json(&serde_json::json!({ "username": username, "password": password }))
            .send()
            .await?;
        extract_auth(res).await
    }

    pub async fn me(&self) -> ApiResult<User> {
        #[derive(Deserialize)]
        struct MeResp {
            user: User,
        }
        let res = self
            .http
            .get(self.url("/api/auth/me"))
            .headers(self.auth_headers())
            .send()
            .await?;
        let data: MeResp = parse_json(res).await?;
        Ok(data.user)
    }

    /// Fetches raw profile-picture bytes plus their MIME type. `None` is returned for the
    /// default avatar, a missing path, an unsafe path, or when the server has no image (404).
    pub async fn fetch_pfp(
        &self,
        pfp_path: Option<&str>,
        user_id: i64,
    ) -> ApiResult<Option<(Vec<u8>, String)>> {
        let Some(raw) = pfp_path else {
            return Ok(None);
        };
        let raw = raw.trim();
        if raw.is_empty() || raw == DEFAULT_PFP_PATH {
            return Ok(None);
        }
        let Some(path) = sanitize_pfp_path(raw) else {
            return Ok(None);
        };
        // The path is only ever used against this server, never as a local filesystem path.
        // If the server ever handed us a non-image URL, ignore it instead of caching JSON.
        if path != format!("/api/auth/users/{user_id}/pfp") {
            return Ok(None);
        }

        let res = self
            .http
            .get(self.url(&path))
            .headers(self.auth_headers())
            .send()
            .await?;
        let status = res.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if status == StatusCode::UNAUTHORIZED {
            return Err(ApiError::Unauthorized);
        }
        if !status.is_success() {
            let message = extract_error_message(status, res).await;
            return Err(ApiError::Http {
                status: status.as_u16(),
                message,
            });
        }
        let bytes = res.bytes().await?.to_vec();
        let Some(content_type) = safe_image_mime(&bytes) else {
            return Ok(None);
        };
        Ok(Some((bytes, content_type.to_string())))
    }

    /// Uploads raw JPG/PNG bytes to the active account's profile picture.
    /// Returns the server-relative path used to fetch the new image.
    pub async fn upload_pfp(&self, bytes: Vec<u8>, content_type: &str) -> ApiResult<String> {
        let ct = content_type.trim().to_ascii_lowercase();
        if ct != "image/jpeg" && ct != "image/png" {
            return Err(ApiError::InvalidPfp(
                "profile picture must be image/jpeg or image/png".to_string(),
            ));
        }
        if bytes.is_empty() {
            return Err(ApiError::InvalidPfp("profile picture is empty".to_string()));
        }
        if bytes.len() > MAX_PFP_BYTES {
            return Err(ApiError::InvalidPfp(format!(
                "profile picture too large (max {} MB)",
                MAX_PFP_BYTES / (1024 * 1024)
            )));
        }

        #[derive(Deserialize)]
        struct PfpResp {
            pfp: String,
        }
        let mut headers = self.auth_headers();
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_str(&ct).map_err(|_| ApiError::InvalidPfp(ct.clone()))?,
        );
        let res = self
            .http
            .put(self.url("/api/auth/me/pfp"))
            .headers(headers)
            .body(bytes)
            .send()
            .await?;
        let data: PfpResp = parse_json(res).await?;
        Ok(data.pfp)
    }

    /// Removes the active account's custom profile picture and returns the default path.
    pub async fn remove_pfp(&self) -> ApiResult<String> {
        #[derive(Deserialize)]
        struct PfpResp {
            pfp: String,
        }
        let res = self
            .http
            .delete(self.url("/api/auth/me/pfp"))
            .headers(self.auth_headers())
            .send()
            .await?;
        let data: PfpResp = parse_json(res).await?;
        Ok(data.pfp)
    }

    /// Permanently deletes the active account on the server (server-side guards, such as the
    /// last-admin rule, are surfaced as `ApiError::Http`).
    pub async fn delete_me(&self) -> ApiResult<()> {
        let res = self
            .http
            .delete(self.url("/api/auth/me"))
            .headers(self.auth_headers())
            .send()
            .await?;
        check_status(res).await?;
        Ok(())
    }

    pub async fn list_games(&self) -> ApiResult<Vec<Game>> {
        #[derive(Deserialize)]
        struct GamesResp {
            games: Vec<Game>,
        }
        let res = self
            .http
            .get(self.url("/api/games"))
            .headers(self.auth_headers())
            .send()
            .await?;
        let data: GamesResp = parse_json(res).await?;
        Ok(data.games)
    }

    pub async fn get_game(&self, game_id: i64) -> ApiResult<GameDetail> {
        let res = self
            .http
            .get(self.url(&format!("/api/games/{game_id}")))
            .headers(self.auth_headers())
            .send()
            .await?;
        parse_json(res).await
    }

    pub async fn get_manifest(&self, game_id: i64) -> ApiResult<GameManifest> {
        let res = self
            .http
            .get(self.url(&format!("/api/games/{game_id}/manifest")))
            .headers(self.auth_headers())
            .send()
            .await?;
        parse_json(res).await
    }

    /// Fetches the game's cover art bytes along with its MIME content type.
    pub async fn fetch_cover(&self, game_id: i64) -> ApiResult<(Vec<u8>, String)> {
        let res = self
            .http
            .get(self.url(&format!("/api/games/{game_id}/cover")))
            .headers(self.auth_headers())
            .send()
            .await?;
        let res = check_status(res).await?;
        let bytes = res.bytes().await?.to_vec();
        // Never trust the server's Content-Type. It is attacker-controlled on plain
        // HTTP connections and is interpolated into a `data:` URL by the frontend.
        // Derive one of exactly two safe literals from the bytes themselves.
        let content_type = safe_image_mime(&bytes)
            .ok_or_else(|| ApiError::InvalidCover("cover is not a PNG or JPEG image".to_string()))?
            .to_string();
        Ok((bytes, content_type))
    }

    /// Streams the game archive directly without buffering the whole body in memory.
    /// Uses OpenSync's default STORE mode (zero compression overhead) for wire-speed LAN downloads.
    pub async fn open_download_stream(&self, game_id: i64, fresh: bool) -> ApiResult<Response> {
        let path = if fresh {
            format!("/api/games/{game_id}/download?fresh=1")
        } else {
            format!("/api/games/{game_id}/download")
        };
        let res = self
            .http
            .get(self.url(&path))
            .headers(self.auth_headers())
            .send()
            .await?;
        check_status(res).await
    }

    pub async fn overlay_init(&self, game_id: i64) -> ApiResult<OverlayInit> {
        let res = self
            .http
            .get(self.url(&format!("/api/games/{game_id}/overlay/init")))
            .headers(self.auth_headers())
            .send()
            .await?;
        parse_json(res).await
    }

    pub async fn upload_overlay_chunk(
        &self,
        game_id: i64,
        rel_path: &str,
        index: usize,
        total: usize,
        declared_size: u64,
        sha256_hex: &str,
        chunk: Bytes,
    ) -> ApiResult<()> {
        let mut headers = self.auth_headers();
        let mut num_buf = itoa::Buffer::new();
        headers.insert(
            "x-path",
            HeaderValue::from_str(&urlencoding::encode(rel_path))
                .map_err(|_| ApiError::InvalidUrl(rel_path.to_string()))?,
        );
        headers.insert(
            "x-index",
            HeaderValue::from_bytes(num_buf.format(index).as_bytes()).unwrap(),
        );
        headers.insert(
            "x-total",
            HeaderValue::from_bytes(num_buf.format(total).as_bytes()).unwrap(),
        );
        headers.insert(
            "x-size",
            HeaderValue::from_bytes(num_buf.format(declared_size).as_bytes()).unwrap(),
        );
        headers.insert(
            "x-hash",
            HeaderValue::from_str(sha256_hex)
                .map_err(|_| ApiError::InvalidUrl(sha256_hex.to_string()))?,
        );

        let res = self
            .http
            .post(self.url(&format!("/api/games/{game_id}/overlay/files")))
            .headers(headers)
            .body(chunk)
            .send()
            .await?;

        let status = res.status();
        if status.is_success() {
            return Ok(());
        }
        if status == StatusCode::UNAUTHORIZED {
            return Err(ApiError::Unauthorized);
        }
        if status == StatusCode::CONFLICT {
            let v: serde_json::Value = res.json().await.unwrap_or_default();
            let received = v.get("received").and_then(|n| n.as_u64()).unwrap_or(0) as usize;
            return Err(ApiError::ResumeRequired { received });
        }
        if status == StatusCode::UNPROCESSABLE_ENTITY {
            return Err(ApiError::HashMismatch);
        }
        let message = extract_error_message(status, res).await;
        Err(ApiError::Http {
            status: status.as_u16(),
            message,
        })
    }

    /// Changes the active account's username. Server-side validation failures (empty name,
    /// case-insensitive collision) are surfaced verbatim as `ApiError::Http`.
    pub async fn update_username(&self, username: &str) -> ApiResult<User> {
        #[derive(Deserialize)]
        struct UserResp {
            user: User,
        }
        let res = self
            .http
            .patch(self.url("/api/auth/me"))
            .headers(self.auth_headers())
            .json(&serde_json::json!({ "username": username }))
            .send()
            .await?;
        let data: UserResp = parse_json(res).await?;
        Ok(data.user)
    }

    /// Creates a new game entry. The returned game starts in `processing` state.
    pub async fn create_game(
        &self,
        name: &str,
        description: &str,
        system_requirements: &str,
    ) -> ApiResult<Game> {
        #[derive(Deserialize)]
        struct GameResp {
            game: Game,
        }
        let res = self
            .http
            .post(self.url("/api/games"))
            .headers(self.auth_headers())
            .json(&serde_json::json!({
                "name": name,
                "description": description,
                "system_requirements": system_requirements,
            }))
            .send()
            .await?;
        let data: GameResp = parse_json(res).await?;
        Ok(data.game)
    }

    /// Uploads cover art for a game. Only JPEG and PNG are accepted.
    pub async fn upload_game_cover(
        &self,
        game_id: i64,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> ApiResult<String> {
        let ct = content_type.trim().to_ascii_lowercase();
        if ct != "image/jpeg" && ct != "image/png" {
            return Err(ApiError::Http {
                status: 400,
                message: "cover must be image/jpeg or image/png".to_string(),
            });
        }
        #[derive(Deserialize)]
        struct CoverResp {
            cover: String,
        }
        let mut headers = self.auth_headers();
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_str(&ct)
                .map_err(|_| ApiError::InvalidUrl(content_type.to_string()))?,
        );
        let res = self
            .http
            .post(self.url(&format!("/api/games/{game_id}/cover")))
            .headers(headers)
            .body(bytes)
            .send()
            .await?;
        let data: CoverResp = parse_json(res).await?;
        Ok(data.cover)
    }

    /// Starts a chunked game upload and retrieves the server's chunk size and resume state.
    pub async fn upload_game_init(&self, game_id: i64) -> ApiResult<UploadInit> {
        let res = self
            .http
            .post(self.url(&format!("/api/games/{game_id}/upload/init")))
            .headers(self.auth_headers())
            .json(&serde_json::json!({}))
            .send()
            .await?;
        parse_json(res).await
    }

    /// Uploads one ordered chunk of a game file. Returns `ResumeRequired` on a 409 so callers
    /// can restart from the chunk count reported by the server.
    pub async fn upload_game_chunk(
        &self,
        game_id: i64,
        rel_path: &str,
        index: usize,
        total: usize,
        declared_size: u64,
        chunk: Bytes,
    ) -> ApiResult<ChunkAck> {
        let mut headers = self.auth_headers();
        let mut num_buf = itoa::Buffer::new();
        headers.insert(
            "x-path",
            HeaderValue::from_str(&urlencoding::encode(rel_path))
                .map_err(|_| ApiError::InvalidUrl(rel_path.to_string()))?,
        );
        headers.insert(
            "x-index",
            HeaderValue::from_bytes(num_buf.format(index).as_bytes()).unwrap(),
        );
        headers.insert(
            "x-total",
            HeaderValue::from_bytes(num_buf.format(total).as_bytes()).unwrap(),
        );
        headers.insert(
            "x-size",
            HeaderValue::from_bytes(num_buf.format(declared_size).as_bytes()).unwrap(),
        );
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));

        let res = self
            .http
            .post(self.url(&format!("/api/games/{game_id}/files")))
            .headers(headers)
            .body(chunk)
            .send()
            .await?;

        let status = res.status();
        if status == StatusCode::CONFLICT {
            let v: serde_json::Value = res.json().await.unwrap_or_default();
            let received = v.get("received").and_then(|n| n.as_u64()).unwrap_or(0) as usize;
            return Err(ApiError::ResumeRequired { received });
        }
        parse_json(res).await
    }

    /// Tells the server that all chunks were sent and indexing may begin.
    pub async fn upload_game_complete(&self, game_id: i64) -> ApiResult<()> {
        let res = self
            .http
            .post(self.url(&format!("/api/games/{game_id}/upload/complete")))
            .headers(self.auth_headers())
            .send()
            .await?;
        check_status(res).await?;
        Ok(())
    }

    pub async fn get_game_status(&self, game_id: i64) -> ApiResult<GameStatus> {
        let res = self
            .http
            .get(self.url(&format!("/api/games/{game_id}/status")))
            .headers(self.auth_headers())
            .send()
            .await?;
        parse_json(res).await
    }

    pub async fn delete_game(&self, game_id: i64) -> ApiResult<()> {
        let res = self
            .http
            .delete(self.url(&format!("/api/games/{game_id}")))
            .headers(self.auth_headers())
            .send()
            .await?;
        check_status(res).await?;
        Ok(())
    }

    pub async fn sync_complete(
        &self,
        game_id: i64,
        deletions: &[String],
        force: bool,
    ) -> ApiResult<SyncCompleteResponse> {
        let res = self
            .http
            .post(self.url(&format!("/api/games/{game_id}/sync/complete")))
            .headers(self.auth_headers())
            .json(&serde_json::json!({
                "deletions": deletions,
                "force": force,
            }))
            .send()
            .await?;
        parse_json(res).await
    }
}

async fn extract_auth(res: Response) -> ApiResult<(User, String)> {
    #[derive(Deserialize)]
    struct AuthResp {
        user: User,
    }
    // Login/register failures must surface the server's real message (e.g. "invalid username
    // or password") rather than the generic session-expired `Unauthorized` variant.
    let status = res.status();
    if !status.is_success() {
        let message = extract_error_message(status, res).await;
        return Err(ApiError::Http {
            status: status.as_u16(),
            message,
        });
    }
    let cookie = res
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|s| s.split(';').next().map(str::trim))
        .filter(|s| s.contains('='))
        .map(str::to_string)
        .ok_or(ApiError::MissingCookie)?;
    let data: AuthResp = res.json().await?;
    Ok((data.user, cookie))
}

async fn check_status(res: Response) -> ApiResult<Response> {
    let status = res.status();
    if status.is_success() {
        return Ok(res);
    }
    if status == StatusCode::UNAUTHORIZED {
        return Err(ApiError::Unauthorized);
    }
    let message = extract_error_message(status, res).await;
    Err(ApiError::Http {
        status: status.as_u16(),
        message,
    })
}

async fn parse_json<T: serde::de::DeserializeOwned>(res: Response) -> ApiResult<T> {
    let res = check_status(res).await?;
    Ok(res.json().await?)
}

fn sanitize_http_error_body(status: StatusCode, text: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text)
        && let Some(msg) = v.get("error").and_then(|e| e.as_str())
    {
        return msg.to_string();
    }
    let lower = text.to_ascii_lowercase();
    if lower.contains("<!doctype") || lower.contains("<html") {
        return match status {
            StatusCode::NOT_FOUND => {
                "OpenSync API endpoint not found — check the server URL (e.g. http://127.0.0.1:3000)".to_string()
            }
            StatusCode::BAD_GATEWAY | StatusCode::SERVICE_UNAVAILABLE | StatusCode::GATEWAY_TIMEOUT => {
                "OpenSync server is unreachable or starting up".to_string()
            }
            _ => status
                .canonical_reason()
                .unwrap_or("Unexpected HTML error from server")
                .to_string(),
        };
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        status
            .canonical_reason()
            .unwrap_or("Request failed")
            .to_string()
    } else if trimmed.len() > 240 {
        format!("{}…", &trimmed[..240])
    } else {
        trimmed.to_string()
    }
}

async fn extract_error_message(status: StatusCode, res: Response) -> String {
    let text = res.text().await.unwrap_or_default();
    sanitize_http_error_body(status, &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_image_mime_only_returns_two_literals() {
        assert_eq!(
            safe_image_mime(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2]),
            Some("image/png")
        );
        assert_eq!(safe_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 1]), Some("image/jpeg"));

        // Bytes that once arrived with a hostile Content-Type must never yield a
        // MIME type containing quotes or markup.
        let hostile = b"<svg onload=alert(1)>";
        assert_eq!(safe_image_mime(hostile), None);
        assert_eq!(safe_image_mime(b""), None);
        let mime = safe_image_mime(hostile).unwrap_or("application/octet-stream");
        assert!(mime == "image/png" || mime == "image/jpeg" || mime == "application/octet-stream");
        assert!(!mime.contains('"') && !mime.contains('<'));
    }

    #[test]
    fn normalizes_hash_routes_and_bare_hosts() {
        assert_eq!(
            normalize_server_url("http://127.0.0.1:3000/#/").unwrap(),
            "http://127.0.0.1:3000"
        );
        assert_eq!(
            normalize_server_url("  http://127.0.0.1:3000/#/library?sort=name  ").unwrap(),
            "http://127.0.0.1:3000"
        );
        assert_eq!(
            normalize_server_url("127.0.0.1:3000/").unwrap(),
            "http://127.0.0.1:3000"
        );
        assert_eq!(
            normalize_server_url("http://192.168.1.42:3000/api/games").unwrap(),
            "http://192.168.1.42:3000"
        );
        assert_eq!(
            normalize_server_url("https://lan.home/opensync/#/game/1").unwrap(),
            "https://lan.home/opensync"
        );
    }

    #[test]
    fn rewrites_wildcard_bind_address_to_loopback() {
        assert_eq!(
            normalize_server_url("http://0.0.0.0:3000").unwrap(),
            "http://127.0.0.1:3000"
        );
        assert_eq!(
            normalize_server_url("0.0.0.0:3000/#/").unwrap(),
            "http://127.0.0.1:3000"
        );
    }

    #[test]
    fn rejects_empty_or_invalid_schemes() {
        assert!(normalize_server_url("   ").is_err());
        assert!(normalize_server_url("ftp://127.0.0.1:3000").is_err());
    }

    #[test]
    fn sanitizes_pfp_paths() {
        assert_eq!(
            sanitize_pfp_path(" /api/auth/users/7/pfp ").as_deref(),
            Some("/api/auth/users/7/pfp")
        );
        assert_eq!(
            sanitize_pfp_path(DEFAULT_PFP_PATH).as_deref(),
            Some(DEFAULT_PFP_PATH)
        );
        assert!(sanitize_pfp_path("/api/auth/users/../7/pfp").is_none());
        assert!(sanitize_pfp_path("C:\\users\\pfp.png").is_none());
        assert!(sanitize_pfp_path("/img/pfp.png?q=1").is_none());
        assert!(sanitize_pfp_path("api/auth/users/7/pfp").is_none());
        assert!(sanitize_pfp_path("").is_none());
    }

    #[test]
    fn sanitizes_html_error_responses() {
        let html = "<!DOCTYPE html><html><body><pre>Cannot POST /</pre></body></html>";
        let msg = sanitize_http_error_body(StatusCode::NOT_FOUND, html);
        assert!(!msg.contains("<!DOCTYPE"));
        assert!(msg.contains("OpenSync API endpoint not found"));

        let json = r#"{"error":"invalid credentials"}"#;
        assert_eq!(
            sanitize_http_error_body(StatusCode::UNAUTHORIZED, json),
            "invalid credentials"
        );
    }
}
