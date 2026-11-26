use bytes::Bytes;
use crc32fast::Hasher as Crc32;
use flate2::read::DeflateDecoder;
use futures_util::StreamExt;
use memchr::memmem;
use opensync_api::{ApiError, GameManifest, OpenSyncClient};
use ring::digest::{Context as DigestContext, SHA256};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::mpsc;
use walkdir::WalkDir;

const LOCAL_FILE_HEADER_SIG: u32 = 0x0403_4b50;
const DATA_DESCRIPTOR_SIG: [u8; 4] = [0x50, 0x4b, 0x07, 0x08];
const CENTRAL_DIR_SIG: u32 = 0x0201_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;
const ZIP64_EOCD_SIG: u32 = 0x0606_4b50;

/// 1 MB write buffer per extracted file minimizes syscalls on fast NVMe/LAN transfers.
const FILE_WRITE_BUF: usize = 1024 * 1024;
/// 512 KB streaming read chunk size for zip extraction.
const STREAM_CHUNK_BUF: usize = 512 * 1024;

#[derive(Debug, Error)]
pub enum TransferError {
    #[error("api error: {0}")]
    Api(#[from] ApiError),
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("invalid archive: {0}")]
    InvalidArchive(String),
    #[error("unsafe archive entry path rejected: {0}")]
    UnsafePath(String),
    #[error("integrity check failed for {path}: expected {expected}, got {actual}")]
    HashMismatch {
        path: String,
        expected: String,
        actual: String,
    },
    #[error("missing expected file in downloaded archive: {0}")]
    MissingFile(String),
    #[error("download cancelled")]
    Cancelled,
}

pub type TransferResult<T> = Result<T, TransferError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeedSample {
    pub elapsed_ms: u64,
    pub bytes_per_sec: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferProgress {
    pub bytes_downloaded: u64,
    pub total_bytes: u64,
    pub files_extracted: usize,
    pub total_files: usize,
    pub current_file: Option<String>,
    pub bytes_per_sec: f64,
    pub paused: bool,
    pub speed_samples: Vec<SpeedSample>,
}

#[derive(Debug, Clone)]
pub struct DownloadControl {
    paused: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    max_bytes_per_sec: Arc<AtomicU64>,
    bytes_downloaded: Arc<AtomicU64>,
    files_extracted: Arc<AtomicUsize>,
    progress: Arc<Mutex<TransferProgress>>,
}

impl DownloadControl {
    pub fn new(total_bytes: u64, total_files: usize) -> Self {
        Self {
            paused: Arc::new(AtomicBool::new(false)),
            cancelled: Arc::new(AtomicBool::new(false)),
            max_bytes_per_sec: Arc::new(AtomicU64::new(0)),
            bytes_downloaded: Arc::new(AtomicU64::new(0)),
            files_extracted: Arc::new(AtomicUsize::new(0)),
            progress: Arc::new(Mutex::new(TransferProgress {
                bytes_downloaded: 0,
                total_bytes,
                files_extracted: 0,
                total_files,
                current_file: None,
                bytes_per_sec: 0.0,
                paused: false,
                speed_samples: Vec::new(),
            })),
        }
    }

    pub fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
        self.progress.lock().unwrap().paused = true;
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
        self.progress.lock().unwrap().paused = false;
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.paused.store(false, Ordering::SeqCst);
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// 0 means unlimited (maximum LAN speed).
    pub fn set_bandwidth_limit(&self, bytes_per_sec: u64) {
        self.max_bytes_per_sec
            .store(bytes_per_sec, Ordering::SeqCst);
    }

    pub fn bandwidth_limit(&self) -> u64 {
        self.max_bytes_per_sec.load(Ordering::SeqCst)
    }

    pub fn paused_flag(&self) -> Arc<AtomicBool> {
        self.paused.clone()
    }

    pub fn cancelled_flag(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }

    pub fn bandwidth_limit_flag(&self) -> Arc<AtomicU64> {
        self.max_bytes_per_sec.clone()
    }

    pub fn snapshot(&self) -> TransferProgress {
        let mut snap = self.progress.lock().unwrap().clone();
        snap.bytes_downloaded = self.bytes_downloaded.load(Ordering::Relaxed);
        snap.files_extracted = self.files_extracted.load(Ordering::Relaxed);
        snap
    }
}

/// Live progress of a chunked folder upload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadProgress {
    pub bytes_uploaded: u64,
    pub total_bytes: u64,
    pub files_uploaded: usize,
    pub total_files: usize,
    pub current_file: Option<String>,
    pub bytes_per_sec: f64,
    pub paused: bool,
    pub speed_samples: Vec<SpeedSample>,
}

#[derive(Debug)]
struct UploadRate {
    started: Instant,
    last_sample: Instant,
    bytes_since_sample: u64,
}

/// Pause/cancel/progress handle shared by all file workers of a folder upload.
#[derive(Debug, Clone)]
pub struct UploadControl {
    paused: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    bytes_uploaded: Arc<AtomicU64>,
    files_uploaded: Arc<AtomicUsize>,
    progress: Arc<Mutex<UploadProgress>>,
    rate: Arc<Mutex<UploadRate>>,
}

impl UploadControl {
    pub fn new(total_bytes: u64, total_files: usize) -> Self {
        let now = Instant::now();
        Self {
            paused: Arc::new(AtomicBool::new(false)),
            cancelled: Arc::new(AtomicBool::new(false)),
            bytes_uploaded: Arc::new(AtomicU64::new(0)),
            files_uploaded: Arc::new(AtomicUsize::new(0)),
            progress: Arc::new(Mutex::new(UploadProgress {
                bytes_uploaded: 0,
                total_bytes,
                files_uploaded: 0,
                total_files,
                current_file: None,
                bytes_per_sec: 0.0,
                paused: false,
                speed_samples: Vec::new(),
            })),
            rate: Arc::new(Mutex::new(UploadRate {
                started: now,
                last_sample: now,
                bytes_since_sample: 0,
            })),
        }
    }

    pub fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
        self.progress.lock().unwrap().paused = true;
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
        self.progress.lock().unwrap().paused = false;
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.paused.store(false, Ordering::SeqCst);
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn paused_flag(&self) -> Arc<AtomicBool> {
        self.paused.clone()
    }

    pub fn cancelled_flag(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }

    pub fn snapshot(&self) -> UploadProgress {
        let mut snap = self.progress.lock().unwrap().clone();
        snap.bytes_uploaded = self.bytes_uploaded.load(Ordering::Relaxed);
        snap.files_uploaded = self.files_uploaded.load(Ordering::Relaxed);
        snap
    }

    pub fn set_total_bytes(&self, total: u64) {
        self.progress.lock().unwrap().total_bytes = total;
    }

    pub fn set_total_files(&self, total: usize) {
        self.progress.lock().unwrap().total_files = total;
    }

    pub fn set_current_file(&self, path: Option<String>) {
        self.progress.lock().unwrap().current_file = path;
    }

    pub fn set_bytes_per_sec(&self, bytes_per_sec: f64) {
        self.progress.lock().unwrap().bytes_per_sec = bytes_per_sec;
    }

    /// Records bytes that have left the client and refreshes the rolling speed telemetry
    /// roughly every 100 ms (last 60 samples are retained for the waveform).
    pub fn add_bytes(&self, bytes: u64) {
        self.bytes_uploaded.fetch_add(bytes, Ordering::Relaxed);

        let mut rate = self.rate.lock().unwrap();
        rate.bytes_since_sample += bytes;
        let dt = rate.last_sample.elapsed();
        let sample = if dt >= Duration::from_millis(100) {
            let bps = if dt.as_secs_f64() > 0.0 {
                rate.bytes_since_sample as f64 / dt.as_secs_f64()
            } else {
                0.0
            };
            let s = SpeedSample {
                elapsed_ms: rate.started.elapsed().as_millis() as u64,
                bytes_per_sec: bps,
            };
            rate.last_sample = Instant::now();
            rate.bytes_since_sample = 0;
            Some(s)
        } else {
            None
        };
        drop(rate);

        if let Some(sample) = sample {
            let mut progress = self.progress.lock().unwrap();
            progress.bytes_per_sec = sample.bytes_per_sec;
            progress.speed_samples.push(sample);
            if progress.speed_samples.len() > 60 {
                progress.speed_samples.remove(0);
            }
        }
    }

    pub fn finish_file(&self) {
        self.files_uploaded.fetch_add(1, Ordering::Relaxed);
    }
}

/// Result of a successful chunked folder upload (never calls `upload/complete`).
#[derive(Debug, Clone)]
pub struct UploadOutcome {
    pub files: Vec<(String, u64)>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone)]
struct UploadSpec {
    path: PathBuf,
    rel: String,
    size: u64,
}

const UPLOAD_WORKERS: usize = 6;
/// Number of 4 MB chunks kept in flight per file (current + prefetched next).
const UPLOAD_BUFFER_CHUNKS: usize = 2;

fn chunk_total(size: u64, chunk_size: usize) -> usize {
    if size == 0 {
        1
    } else {
        size.div_ceil(chunk_size as u64) as usize
    }
}

fn is_hidden_entry(entry: &walkdir::DirEntry) -> bool {
    entry
        .file_name()
        .to_str()
        .is_some_and(|name| name.starts_with('.'))
}

/// Recursively uploads a folder's files in parallel, largest first, using bounded read-ahead
/// double buffering. Already-received chunks (from `upload/init`) are skipped. The caller is
/// responsible for calling `upload_game_complete` after this returns.
pub async fn upload_folder(
    client: &OpenSyncClient,
    game_id: i64,
    root: &Path,
    control: &UploadControl,
) -> TransferResult<UploadOutcome> {
    let init = client.upload_game_init(game_id).await?;
    let chunk_size = init.chunk_size.max(1);
    let received_by_path: HashMap<&str, usize> = init
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.received))
        .collect();

    let mut specs = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // tempdir roots (e.g. `/tmp/.tmpXXXX`) are hidden too — only filter descendants.
            e.depth() == 0 || !is_hidden_entry(e)
        })
    {
        let entry = entry.map_err(|e| io::Error::other(e.to_string()))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str() else {
            continue;
        };
        if name.ends_with(".part") {
            continue;
        }
        let Ok(rel_path) = entry.path().strip_prefix(root) else {
            continue;
        };
        let rel_raw = rel_path.to_string_lossy();
        if safe_rel_path(&rel_raw).is_err() {
            continue;
        }
        specs.push(UploadSpec {
            path: entry.path().to_path_buf(),
            rel: rel_raw.replace('\\', "/"),
            size: entry
                .metadata()
                .map_err(|e| io::Error::other(e.to_string()))?
                .len(),
        });
    }

    // LPT: largest files first so a single multi-chunk file cannot hold up the tail.
    specs.sort_by(|a, b| b.size.cmp(&a.size));
    control.set_total_files(specs.len());
    control.set_total_bytes(specs.iter().map(|f| f.size).sum());

    // Count resumed chunks as already transferred so progress ends at 100%.
    for spec in &specs {
        let total = chunk_total(spec.size, chunk_size);
        let done = received_by_path
            .get(spec.rel.as_str())
            .copied()
            .unwrap_or(0)
            .min(total);
        if done > 0 {
            control.add_bytes((done as u64 * chunk_size as u64).min(spec.size));
            if done >= total {
                control.finish_file();
            }
        }
    }

    let results: Vec<TransferResult<(String, u64)>> = futures_util::stream::iter(specs)
        .map(|spec| {
            let client = client.clone();
            let control = control.clone();
            let received = received_by_path
                .get(spec.rel.as_str())
                .copied()
                .unwrap_or(0);
            async move {
                upload_one_file(
                    &client,
                    game_id,
                    &spec,
                    chunk_size,
                    &control,
                    received,
                )
                .await
            }
        })
        .buffer_unordered(UPLOAD_WORKERS)
        .collect()
        .await;

    let mut files = Vec::with_capacity(results.len());
    for result in results {
        files.push(result?);
    }
    let total_bytes = files.iter().map(|(_, size)| *size).sum();
    Ok(UploadOutcome {
        files,
        total_bytes,
    })
}

async fn upload_one_file(
    client: &OpenSyncClient,
    game_id: i64,
    spec: &UploadSpec,
    chunk_size: usize,
    control: &UploadControl,
    received: usize,
) -> TransferResult<(String, u64)> {
    let total = chunk_total(spec.size, chunk_size);
    let start = received.min(total);
    control.set_current_file(Some(spec.rel.clone()));
    if start >= total {
        return Ok((spec.rel.clone(), spec.size));
    }

    let path = spec.path.clone();
    let size = spec.size;
    let cancelled = control.cancelled_flag();
    let (tx, mut rx) = mpsc::channel::<(usize, Bytes)>(UPLOAD_BUFFER_CHUNKS);
    // Disk reads run on the blocking pool while the previous chunk is in flight on reqwest's
    // persistent connection. Bounded channel = read-ahead double buffering.
    let reader = tokio::task::spawn_blocking(move || -> io::Result<()> {
        let mut file = File::open(&path)?;
        for index in start..total {
            if cancelled.load(Ordering::SeqCst) {
                break;
            }
            let offset = (index * chunk_size) as u64;
            let len = chunk_size.min(size.saturating_sub(offset) as usize);
            let mut buf = vec![0u8; len];
            file.seek(SeekFrom::Start(offset))?;
            file.read_exact(&mut buf)?;
            if tx.blocking_send((index, Bytes::from(buf))).is_err() {
                break;
            }
        }
        Ok(())
    });

    let mut result: TransferResult<()> = Ok(());
    for _ in start..total {
        loop {
            if control.is_cancelled() {
                result = Err(TransferError::Cancelled);
                break;
            }
            if !control.is_paused() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        if result.is_err() {
            break;
        }

        let Some((index, data)) = rx.recv().await else {
            result = Err(TransferError::Cancelled);
            break;
        };
        control.add_bytes(data.len() as u64);
        if let Err(err) =
            client
                .upload_game_chunk(game_id, &spec.rel, index, total, spec.size, data)
                .await
        {
            result = Err(err.into());
            break;
        }
    }

    if result.is_err() {
        reader.abort();
    }
    let _ = reader.await;
    result?;
    control.finish_file();
    Ok((spec.rel.clone(), spec.size))
}

#[derive(Debug, Clone)]
pub struct ExtractedFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct DownloadOutcome {
    pub install_dir: PathBuf,
    pub files: Vec<ExtractedFile>,
    pub total_bytes: u64,
    pub elapsed: Duration,
    pub avg_bytes_per_sec: f64,
    pub manifest_hash: String,
}

/// Validates a relative path from an archive or manifest:
/// rejects absolute paths, `..`, backslashes, and NUL bytes.
pub fn safe_rel_path(raw: &str) -> TransferResult<PathBuf> {
    if raw.is_empty() || raw.contains('\0') || raw.contains('\\') {
        return Err(TransferError::UnsafePath(raw.to_string()));
    }
    let path = Path::new(raw);
    if path.is_absolute() {
        return Err(TransferError::UnsafePath(raw.to_string()));
    }
    let mut clean = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Normal(seg) => clean.push(seg),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(TransferError::UnsafePath(raw.to_string()));
            }
        }
    }
    if clean.as_os_str().is_empty() {
        return Err(TransferError::UnsafePath(raw.to_string()));
    }
    Ok(clean)
}

/// Computes a deterministic SHA-256 fingerprint of a clean manifest's file list.
pub fn manifest_fingerprint(manifest: &GameManifest) -> String {
    let mut sorted: Vec<&opensync_api::ManifestEntry> = manifest.files.iter().collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    let mut hasher = DigestContext::new(&SHA256);
    for f in sorted {
        hasher.update(f.path.as_bytes());
        hasher.update(b"\0");
        hasher.update(f.hash.as_bytes());
        hasher.update(b"\0");
        hasher.update(&f.size.to_le_bytes());
    }
    hex::encode(hasher.finish().as_ref())
}

/// Downloads and extracts a game directly from OpenSync's streaming ZIP endpoint
/// into `target_dir` with zero temporary zip files, overlapping network I/O and disk writes,
/// and inline SHA-256 verification.
pub async fn download_and_extract_game(
    client: &OpenSyncClient,
    game_id: i64,
    target_dir: &Path,
    fresh: bool,
    verify_clean_manifest: bool,
    control: DownloadControl,
) -> TransferResult<DownloadOutcome> {
    let started = Instant::now();
    let (manifest, response) = tokio::try_join!(
        client.get_manifest(game_id),
        client.open_download_stream(game_id, fresh)
    )?;
    let expected_total: u64 = manifest.files.iter().map(|f| f.size).sum();
    let manifest_hash = manifest_fingerprint(&manifest);
    {
        let mut p = control.progress.lock().unwrap();
        p.total_bytes = expected_total;
        p.total_files = manifest.files.len();
    }

    let parent = target_dir
        .parent()
        .ok_or_else(|| io::Error::other("target_dir must have a parent"))?;
    fs::create_dir_all(parent)?;
    let staging_dir = parent.join(format!(
        ".staging-game-{}-{}",
        game_id,
        started.elapsed().as_nanos()
    ));
    if staging_dir.exists() {
        fs::remove_dir_all(&staging_dir)?;
    }
    fs::create_dir_all(&staging_dir)?;

    // Bounded channel overlaps HTTP socket reads with disk writing & SHA-256 hashing.
    let (tx, rx) = mpsc::channel::<Result<Bytes, TransferError>>(32);
    let net_control = control.clone();
    let producer = tokio::spawn(async move {
        let mut stream = response.bytes_stream();
        let mut bytes_in_window: u64 = 0;
        let mut window_start = Instant::now();
        let mut total_rx: u64 = 0;
        let mut last_sample = Instant::now();
        let mut bytes_since_sample: u64 = 0;

        loop {
            if net_control.is_cancelled() {
                let _ = tx.send(Err(TransferError::Cancelled)).await;
                return;
            }
            while net_control.is_paused() {
                if net_control.is_cancelled() {
                    let _ = tx.send(Err(TransferError::Cancelled)).await;
                    return;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
                window_start = Instant::now();
                bytes_in_window = 0;
            }

            let Some(item) = stream.next().await else {
                break;
            };

            if net_control.is_cancelled() {
                let _ = tx.send(Err(TransferError::Cancelled)).await;
                return;
            }
            while net_control.is_paused() {
                if net_control.is_cancelled() {
                    let _ = tx.send(Err(TransferError::Cancelled)).await;
                    return;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
                window_start = Instant::now();
                bytes_in_window = 0;
            }

            let chunk = match item {
                Ok(b) => b,
                Err(e) => {
                    let _ = tx.send(Err(TransferError::Api(ApiError::Network(e)))).await;
                    return;
                }
            };
            let len = chunk.len() as u64;
            total_rx += len;
            bytes_since_sample += len;

            // Optional bandwidth throttle
            let limit = net_control.max_bytes_per_sec.load(Ordering::Relaxed);
            if limit > 0 {
                bytes_in_window += len;
                let elapsed = window_start.elapsed().as_secs_f64();
                let expected = bytes_in_window as f64 / limit as f64;
                if expected > elapsed {
                    tokio::time::sleep(Duration::from_secs_f64(expected - elapsed)).await;
                }
                if window_start.elapsed() >= Duration::from_secs(1) {
                    window_start = Instant::now();
                    bytes_in_window = 0;
                }
            }

            // Rolling speed telemetry (every 100ms, kept to last 60 samples for waveform).
            // Keep the hot byte-counter lock-free so every HTTP chunk avoids mutex contention.
            net_control.bytes_downloaded.store(total_rx, Ordering::Relaxed);
            let dt = last_sample.elapsed();
            if dt >= Duration::from_millis(100) || total_rx >= expected_total {
                let bps = if dt.as_secs_f64() > 0.0 {
                    bytes_since_sample as f64 / dt.as_secs_f64()
                } else {
                    0.0
                };
                let mut p = net_control.progress.lock().unwrap();
                p.bytes_downloaded = total_rx;
                p.bytes_per_sec = bps;
                p.speed_samples.push(SpeedSample {
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    bytes_per_sec: bps,
                });
                if p.speed_samples.len() > 60 {
                    p.speed_samples.remove(0);
                }
                last_sample = Instant::now();
                bytes_since_sample = 0;
            }

            if tx.send(Ok(chunk)).await.is_err() {
                return;
            }
        }
    });

    let staging_clone = staging_dir.clone();
    let extract_control = control.clone();
    let extract_result = tokio::task::spawn_blocking(move || {
        let reader = ChannelReader::new(rx);
        extract_zip_stream(reader, &staging_clone, &extract_control)
    })
    .await
    .map_err(|e| TransferError::InvalidArchive(format!("extractor panicked: {e}")))?;

    let _ = producer.await;

    let files = match extract_result {
        Ok(f) => f,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging_dir);
            if control.is_cancelled() {
                return Err(TransferError::Cancelled);
            }
            return Err(e);
        }
    };

    if control.is_cancelled() {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(TransferError::Cancelled);
    }

    // Verify clean manifest hashes when requested (fresh download or no overlay).
    if verify_clean_manifest {
        let extracted_map: HashMap<&str, &ExtractedFile> =
            files.iter().map(|f| (f.path.as_str(), f)).collect();
        for expected in &manifest.files {
            match extracted_map.get(expected.path.as_str()) {
                None => {
                    let _ = fs::remove_dir_all(&staging_dir);
                    return Err(TransferError::MissingFile(expected.path.clone()));
                }
                Some(actual) if actual.sha256 != expected.hash => {
                    let _ = fs::remove_dir_all(&staging_dir);
                    return Err(TransferError::HashMismatch {
                        path: expected.path.clone(),
                        expected: expected.hash.clone(),
                        actual: actual.sha256.clone(),
                    });
                }
                Some(_) => {}
            }
        }
    }

    // Atomic swap into final install directory
    if target_dir.exists() {
        fs::remove_dir_all(target_dir)?;
    }
    fs::rename(&staging_dir, target_dir)?;

    let elapsed = started.elapsed();
    let total_bytes: u64 = files.iter().map(|f| f.size).sum();
    let avg_bps = if elapsed.as_secs_f64() > 0.0 {
        total_bytes as f64 / elapsed.as_secs_f64()
    } else {
        total_bytes as f64
    };

    Ok(DownloadOutcome {
        install_dir: target_dir.to_path_buf(),
        files,
        total_bytes,
        elapsed,
        avg_bytes_per_sec: avg_bps,
        manifest_hash,
    })
}

/// Bridges an async `tokio::sync::mpsc::Receiver<Result<Bytes, TransferError>>`
/// into a synchronous `std::io::Read` for zero-copy streaming ZIP extraction.
struct ChannelReader {
    rx: mpsc::Receiver<Result<Bytes, TransferError>>,
    current: Bytes,
    offset: usize,
    err: Option<TransferError>,
}

impl ChannelReader {
    fn new(rx: mpsc::Receiver<Result<Bytes, TransferError>>) -> Self {
        Self {
            rx,
            current: Bytes::new(),
            offset: 0,
            err: None,
        }
    }

    fn take_error(&mut self) -> Option<TransferError> {
        self.err.take()
    }
}

impl Read for ChannelReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if let Some(ref e) = self.err {
            return Err(io::Error::other(e.to_string()));
        }
        let mut total = 0;
        loop {
            while self.offset >= self.current.len() {
                let next = if total == 0 {
                    self.rx.blocking_recv()
                } else {
                    match self.rx.try_recv() {
                        Ok(item) => Some(item),
                        Err(_) => return Ok(total),
                    }
                };
                match next {
                    Some(Ok(chunk)) => {
                        if chunk.is_empty() {
                            continue;
                        }
                        self.current = chunk;
                        self.offset = 0;
                    }
                    Some(Err(e)) => {
                        let msg = e.to_string();
                        self.err = Some(e);
                        if total > 0 {
                            return Ok(total);
                        }
                        return Err(io::Error::other(msg));
                    }
                    None => return Ok(total),
                }
            }
            let avail = &self.current[self.offset..];
            let n = avail.len().min(buf.len() - total);
            buf[total..total + n].copy_from_slice(&avail[..n]);
            self.offset += n;
            total += n;
            if total == buf.len() {
                return Ok(total);
            }
        }
    }
}

/// Streaming ZIP extractor supporting:
/// - Method 0 (STORE) with known size (fast zero-overhead direct streaming)
/// - Method 0 (STORE) with Data Descriptor (bit 3, as emitted by Node's `archiver`)
/// - Method 8 (DEFLATE) with known size or Data Descriptor
/// Extracts directly to disk with buffered writes and inline SHA-256 calculation.
pub fn extract_zip_stream<R: Read>(
    reader: R,
    dest_root: &Path,
    control: &DownloadControl,
) -> TransferResult<Vec<ExtractedFile>> {
    const MAX_DD: usize = 24;
    let mut r = PeekableReader::new(BufReader::with_capacity(64 * 1024, reader));
    let dd_finder = memmem::Finder::new(&DATA_DESCRIPTOR_SIG);
    let mut extracted = Vec::new();
    let mut created_dirs: HashSet<PathBuf> = HashSet::new();
    let mut copy_buf = vec![0u8; STREAM_CHUNK_BUF];
    let mut dd_buf = vec![0u8; STREAM_CHUNK_BUF + MAX_DD];
    let mut name_buf = Vec::with_capacity(256);
    let mut extra_buf = Vec::with_capacity(64);
    let mut last_file_update: Option<Instant> = None;

    loop {
        if control.is_cancelled() {
            return Err(TransferError::Cancelled);
        }
        let mut sig_bytes = [0u8; 4];
        match r.read_exact_or_eof(&mut sig_bytes)? {
            false => break,
            true => {}
        }
        let sig = u32::from_le_bytes(sig_bytes);
        if sig == CENTRAL_DIR_SIG || sig == EOCD_SIG || sig == ZIP64_EOCD_SIG {
            break;
        }
        if sig != LOCAL_FILE_HEADER_SIG {
            return Err(TransferError::InvalidArchive(format!(
                "unexpected ZIP signature 0x{sig:08x}"
            )));
        }

        let mut hdr = [0u8; 26];
        r.read_exact(&mut hdr)?;
        let flags = u16::from_le_bytes([hdr[2], hdr[3]]);
        let method = u16::from_le_bytes([hdr[4], hdr[5]]);
        let expected_crc = u32::from_le_bytes([hdr[10], hdr[11], hdr[12], hdr[13]]);
        let mut comp_size = u32::from_le_bytes([hdr[14], hdr[15], hdr[16], hdr[17]]) as u64;
        let mut uncomp_size = u32::from_le_bytes([hdr[18], hdr[19], hdr[20], hdr[21]]) as u64;
        let name_len = u16::from_le_bytes([hdr[22], hdr[23]]) as usize;
        let extra_len = u16::from_le_bytes([hdr[24], hdr[25]]) as usize;

        name_buf.resize(name_len, 0);
        r.read_exact(&mut name_buf)?;
        let raw_name = std::str::from_utf8(&name_buf)
            .map_err(|_| TransferError::InvalidArchive("non-UTF8 entry name".into()))?;

        extra_buf.resize(extra_len, 0);
        r.read_exact(&mut extra_buf)?;
        // Parse ZIP64 extra field (tag 0x0001) when 32-bit sizes overflow
        let is_zip64 = parse_zip64_extra(&extra_buf, &mut uncomp_size, &mut comp_size);

        let has_data_descriptor = (flags & 0x0008) != 0;

        if raw_name.ends_with('/') {
            let trimmed = raw_name.trim_end_matches('/');
            if !trimmed.is_empty() {
                let rel = safe_rel_path(trimmed)?;
                let dir_path = dest_root.join(rel);
                if !created_dirs.contains(&dir_path) {
                    fs::create_dir_all(&dir_path)?;
                    created_dirs.insert(dir_path);
                }
            }
            if has_data_descriptor {
                skip_data_descriptor(&mut r, is_zip64)?;
            }
            continue;
        }

        let rel = safe_rel_path(raw_name)?;
        let normalized_name = rel.to_string_lossy().replace('\\', "/");
        if last_file_update
            .map(|t| t.elapsed() >= Duration::from_millis(50))
            .unwrap_or(true)
        {
            control.progress.lock().unwrap().current_file = Some(normalized_name.clone());
            last_file_update = Some(Instant::now());
        }

        let out_path = dest_root.join(&rel);
        if let Some(parent) = out_path.parent()
            && !created_dirs.contains(parent)
        {
            fs::create_dir_all(parent)?;
            created_dirs.insert(parent.to_path_buf());
        }
        let file = File::create(&out_path)?;
        if !has_data_descriptor && uncomp_size > 0 {
            // Preallocate disk space when size is known to prevent fragmentation
            let _ = file.set_len(uncomp_size);
        }
        let write_buf_cap = if !has_data_descriptor {
            (uncomp_size as usize).clamp(4096, FILE_WRITE_BUF)
        } else {
            64 * 1024
        };
        let mut writer = BufWriter::with_capacity(write_buf_cap, file);
        let mut sha = DigestContext::new(&SHA256);
        let mut crc = Crc32::new();
        let mut written: u64 = 0;

        match method {
            0 => {
                // STORE (uncompressed — OpenSync's default wire-speed mode)
                if !has_data_descriptor {
                    let mut remaining = comp_size;
                    while remaining > 0 {
                        if control.is_cancelled() {
                            return Err(TransferError::Cancelled);
                        }
                        let to_read = (remaining as usize).min(copy_buf.len());
                        let n = r.read(&mut copy_buf[..to_read])?;
                        if n == 0 {
                            return Err(TransferError::InvalidArchive(format!(
                                "unexpected EOF in STORE entry {normalized_name}"
                            )));
                        }
                        writer.write_all(&copy_buf[..n])?;
                        sha.update(&copy_buf[..n]);
                        crc.update(&copy_buf[..n]);
                        written += n as u64;
                        remaining -= n as u64;
                    }
                    let actual_crc = crc.finalize();
                    if actual_crc != expected_crc {
                        return Err(TransferError::InvalidArchive(format!(
                            "CRC mismatch in {normalized_name}: expected 0x{expected_crc:08x}, got 0x{actual_crc:08x}"
                        )));
                    }
                } else {
                    // Streaming STORE with Data Descriptor (bit 3)
                    written = extract_store_with_data_descriptor(
                        &mut r,
                        &mut writer,
                        &mut sha,
                        &mut dd_buf,
                        &dd_finder,
                        control,
                    )?;
                }
            }
            8 => {
                // DEFLATE fallback (if ?deflate=1..9 was requested)
                if !has_data_descriptor {
                    let mut limited = (&mut r).take(comp_size);
                    let mut dec = DeflateDecoder::new(&mut limited);
                    loop {
                        if control.is_cancelled() {
                            return Err(TransferError::Cancelled);
                        }
                        let n = dec.read(&mut copy_buf)?;
                        if n == 0 {
                            break;
                        }
                        writer.write_all(&copy_buf[..n])?;
                        sha.update(&copy_buf[..n]);
                        crc.update(&copy_buf[..n]);
                        written += n as u64;
                    }
                    let actual_crc = crc.finalize();
                    if actual_crc != expected_crc {
                        return Err(TransferError::InvalidArchive(format!(
                            "CRC mismatch in deflated entry {normalized_name}"
                        )));
                    }
                } else {
                    // Streaming DEFLATE stops cleanly at the final deflate block
                    let mut dec = DeflateDecoder::new(&mut r);
                    loop {
                        if control.is_cancelled() {
                            return Err(TransferError::Cancelled);
                        }
                        let n = dec.read(&mut copy_buf)?;
                        if n == 0 {
                            break;
                        }
                        writer.write_all(&copy_buf[..n])?;
                        sha.update(&copy_buf[..n]);
                        crc.update(&copy_buf[..n]);
                        written += n as u64;
                    }
                    let actual_crc = crc.finalize();
                    let (dd_crc, _dd_uncomp) = read_data_descriptor(&mut r, is_zip64)?;
                    if actual_crc != dd_crc {
                        return Err(TransferError::InvalidArchive(format!(
                            "CRC mismatch in streaming deflated entry {normalized_name}"
                        )));
                    }
                }
            }
            other => {
                return Err(TransferError::InvalidArchive(format!(
                    "unsupported ZIP compression method {other}"
                )));
            }
        }

        writer.flush()?;
        let sha256 = hex::encode(sha.finish().as_ref());
        extracted.push(ExtractedFile {
            path: normalized_name,
            size: written,
            sha256,
        });
        control.files_extracted.store(extracted.len(), Ordering::Relaxed);
    }

    Ok(extracted)
}

/// Streams a bit-3 (Data Descriptor) STORE entry by scanning for `PK\x07\x08`
/// and verifying BOTH the running CRC32 and exact byte count (32-bit or 64-bit ZIP64).
/// Because both CRC32 and length must match, raw binary payloads containing `PK\x07\x08`
/// never cause false positives.
fn extract_store_with_data_descriptor<R: Read, W: Write>(
    r: &mut PeekableReader<R>,
    writer: &mut W,
    sha: &mut DigestContext,
    dd_buf: &mut [u8],
    dd_finder: &memmem::Finder<'_>,
    control: &DownloadControl,
) -> TransferResult<u64> {
    let mut crc = Crc32::new();
    let mut written: u64 = 0;
    let mut len: usize = 0;
    // Maximum data descriptor size is 24 bytes (4 sig + 4 crc + 8 comp + 8 uncomp).
    const MAX_DD: usize = 24;

    loop {
        if control.is_cancelled() {
            return Err(TransferError::Cancelled);
        }
        while len < MAX_DD + 4 {
            let n = r.read(&mut dd_buf[len..])?;
            if n == 0 {
                break;
            }
            len += n;
        }
        if len == 0 {
            return Err(TransferError::InvalidArchive(
                "unexpected EOF waiting for ZIP data descriptor".into(),
            ));
        }

        if let Some(pos) = dd_finder.find(&dd_buf[..len]) {
            if pos > 0 {
                let data = &dd_buf[..pos];
                writer.write_all(data)?;
                sha.update(data);
                crc.update(data);
                written += pos as u64;
                dd_buf.copy_within(pos..len, 0);
                len -= pos;
            }
            // Ensure we have enough bytes to inspect both 16-byte (ZIP32) and 24-byte (ZIP64) descriptors
            while len < MAX_DD {
                let n = r.read(&mut dd_buf[len..])?;
                if n == 0 {
                    break;
                }
                len += n;
            }
            let dd = &dd_buf[..len];
            let running_crc = crc.clone().finalize();

            // Check standard 16-byte data descriptor: sig(4) + crc(4) + comp(4) + uncomp(4)
            if dd.len() >= 16 {
                let dd_crc = u32::from_le_bytes([dd[4], dd[5], dd[6], dd[7]]);
                let dd_comp = u32::from_le_bytes([dd[8], dd[9], dd[10], dd[11]]) as u64;
                let dd_uncomp = u32::from_le_bytes([dd[12], dd[13], dd[14], dd[15]]) as u64;
                if dd_crc == running_crc && dd_comp == written && dd_uncomp == written {
                    r.unread_slice(&dd_buf[16..len]);
                    return Ok(written);
                }
            }
            // Check 24-byte ZIP64 data descriptor: sig(4) + crc(4) + comp(8) + uncomp(8)
            if dd.len() >= 24 {
                let dd_crc = u32::from_le_bytes([dd[4], dd[5], dd[6], dd[7]]);
                let dd_comp = u64::from_le_bytes(dd[8..16].try_into().unwrap());
                let dd_uncomp = u64::from_le_bytes(dd[16..24].try_into().unwrap());
                if dd_crc == running_crc && dd_comp == written && dd_uncomp == written {
                    r.unread_slice(&dd_buf[24..len]);
                    return Ok(written);
                }
            }

            // False positive signature inside binary file content — emit the 4 bytes and keep scanning
            let sig_slice = &dd_buf[..4];
            writer.write_all(sig_slice)?;
            sha.update(sig_slice);
            crc.update(sig_slice);
            written += 4;
            dd_buf.copy_within(4..len, 0);
            len -= 4;
        } else {
            // Safe to flush all except the last 3 bytes (which could start a split signature)
            let safe_len = len.saturating_sub(3);
            if safe_len == 0 {
                return Err(TransferError::InvalidArchive(
                    "truncated ZIP stream before data descriptor".into(),
                ));
            }
            let data = &dd_buf[..safe_len];
            writer.write_all(data)?;
            sha.update(data);
            crc.update(data);
            written += safe_len as u64;
            dd_buf.copy_within(safe_len..len, 0);
            len -= safe_len;
        }
    }
}

fn parse_zip64_extra(extra: &[u8], uncomp_size: &mut u64, comp_size: &mut u64) -> bool {
    let mut i = 0;
    while i + 4 <= extra.len() {
        let tag = u16::from_le_bytes([extra[i], extra[i + 1]]);
        let len = u16::from_le_bytes([extra[i + 2], extra[i + 3]]) as usize;
        i += 4;
        if i + len > extra.len() {
            break;
        }
        if tag == 0x0001 {
            let mut off = i;
            if *uncomp_size == 0xFFFF_FFFF && off + 8 <= i + len {
                *uncomp_size = u64::from_le_bytes(extra[off..off + 8].try_into().unwrap());
                off += 8;
            }
            if *comp_size == 0xFFFF_FFFF && off + 8 <= i + len {
                *comp_size = u64::from_le_bytes(extra[off..off + 8].try_into().unwrap());
            }
            return true;
        }
        i += len;
    }
    false
}

fn read_data_descriptor<R: Read>(
    r: &mut PeekableReader<R>,
    is_zip64: bool,
) -> TransferResult<(u32, u64)> {
    let mut first = [0u8; 4];
    r.read_exact(&mut first)?;
    let crc = if first == DATA_DESCRIPTOR_SIG {
        let mut c = [0u8; 4];
        r.read_exact(&mut c)?;
        u32::from_le_bytes(c)
    } else {
        u32::from_le_bytes(first)
    };
    if is_zip64 {
        let mut sizes = [0u8; 16];
        r.read_exact(&mut sizes)?;
        let uncomp = u64::from_le_bytes(sizes[8..16].try_into().unwrap());
        Ok((crc, uncomp))
    } else {
        let mut sizes = [0u8; 8];
        r.read_exact(&mut sizes)?;
        let uncomp = u32::from_le_bytes(sizes[4..8].try_into().unwrap()) as u64;
        Ok((crc, uncomp))
    }
}

fn skip_data_descriptor<R: Read>(r: &mut PeekableReader<R>, is_zip64: bool) -> TransferResult<()> {
    let _ = read_data_descriptor(r, is_zip64)?;
    Ok(())
}

struct PeekableReader<R> {
    inner: R,
    stash: VecDeque<u8>,
}

impl<R: Read> PeekableReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            stash: VecDeque::new(),
        }
    }

    fn unread_slice(&mut self, bytes: &[u8]) {
        if self.stash.is_empty() {
            self.stash.extend(bytes);
        } else {
            for &b in bytes.iter().rev() {
                self.stash.push_front(b);
            }
        }
    }

    fn read_exact_or_eof(&mut self, buf: &mut [u8]) -> io::Result<bool> {
        let mut filled = 0;
        while filled < buf.len() {
            let n = self.read(&mut buf[filled..])?;
            if n == 0 {
                if filled == 0 {
                    return Ok(false);
                }
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "unexpected EOF",
                ));
            }
            filled += n;
        }
        Ok(true)
    }
}

impl<R: Read> Read for PeekableReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if !self.stash.is_empty() {
            let n = self.stash.len().min(buf.len());
            let (front, back) = self.stash.as_slices();
            let from_front = n.min(front.len());
            buf[..from_front].copy_from_slice(&front[..from_front]);
            if from_front < n {
                let rem = n - from_front;
                buf[from_front..n].copy_from_slice(&back[..rem]);
            }
            self.stash.drain(..n);
            return Ok(n);
        }
        self.inner.read(buf)
    }
}

/// Ensures our `ChannelReader` surfaces the exact underlying `TransferError` if any.
#[allow(dead_code)]
fn _channel_error_check(r: &mut ChannelReader) -> Option<TransferError> {
    r.take_error()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tempfile::tempdir;

    fn build_dd_store_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, data) in entries {
            let name_bytes = name.as_bytes();
            out.extend_from_slice(&LOCAL_FILE_HEADER_SIG.to_le_bytes());
            out.extend_from_slice(&20u16.to_le_bytes());
            out.extend_from_slice(&0x0008u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name_bytes);
            out.extend_from_slice(data);

            let mut crc = Crc32::new();
            crc.update(data);
            out.extend_from_slice(&DATA_DESCRIPTOR_SIG);
            out.extend_from_slice(&crc.finalize().to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        }
        out.extend_from_slice(&EOCD_SIG.to_le_bytes());
        out
    }

    #[test]
    fn upload_and_download_controls_reflect_atomic_counters_in_snapshots() {
        let up = UploadControl::new(1000, 2);
        up.add_bytes(256);
        up.add_bytes(128);
        up.finish_file();
        let up_snap = up.snapshot();
        assert_eq!(up_snap.bytes_uploaded, 384);
        assert_eq!(up_snap.files_uploaded, 1);

        let dl = DownloadControl::new(2048, 3);
        dl.bytes_downloaded.store(1024, Ordering::Relaxed);
        dl.files_extracted.store(2, Ordering::Relaxed);
        let dl_snap = dl.snapshot();
        assert_eq!(dl_snap.bytes_downloaded, 1024);
        assert_eq!(dl_snap.files_extracted, 2);
    }

    #[test]
    fn extract_store_with_data_descriptor_spans_multiple_buffers_and_split_signature() {
        let dir = tempdir().unwrap();
        // Payload larger than 2x STREAM_CHUNK_BUF with a decoy PK\x07\x08 straddling the first
        // STREAM_CHUNK_BUF boundary and a second entry right behind it to exercise PeekableReader.
        let mut big = vec![0x42u8; STREAM_CHUNK_BUF * 2 + 4096];
        let split_at = STREAM_CHUNK_BUF - 2;
        big[split_at..split_at + 4].copy_from_slice(&DATA_DESCRIPTOR_SIG);
        let tail = b"after-big-file".to_vec();

        let zip = build_dd_store_zip(&[("big.bin", &big), ("tail.txt", &tail)]);
        let ctrl = DownloadControl::new(zip.len() as u64, 2);
        let extracted = extract_zip_stream(Cursor::new(zip), dir.path(), &ctrl).unwrap();

        assert_eq!(extracted.len(), 2);
        assert_eq!(extracted[0].size, big.len() as u64);
        assert_eq!(
            extracted[0].sha256,
            hex::encode(ring::digest::digest(&SHA256, &big).as_ref())
        );
        assert_eq!(extracted[1].size, tail.len() as u64);
        assert_eq!(
            extracted[1].sha256,
            hex::encode(ring::digest::digest(&SHA256, &tail).as_ref())
        );
        assert_eq!(ctrl.snapshot().files_extracted, 2);
        assert_eq!(fs::read(dir.path().join("big.bin")).unwrap(), big);
        assert_eq!(fs::read(dir.path().join("tail.txt")).unwrap(), tail);
    }
}
