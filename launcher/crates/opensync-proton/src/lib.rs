use flate2::read::GzDecoder;
use futures_util::StreamExt;
use ring::digest::{Context as DigestContext, SHA512};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tar::Archive;
use thiserror::Error;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Error)]
pub enum ProtonError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("no proton installation found; download GE-Proton or point to a Proton folder")]
    NotInstalled,
    #[error("sha512 verification failed for {name}: expected {expected}, got {actual}")]
    ChecksumMismatch {
        name: String,
        expected: String,
        actual: String,
    },
    #[error("release missing expected archive or sha512sum asset")]
    MissingReleaseAssets,
    #[error("unsafe archive entry path in proton tarball: {0}")]
    UnsafeArchivePath(String),
    #[error("proton download cancelled")]
    Cancelled,
}

pub type ProtonResult<T> = Result<T, ProtonError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BinaryKind {
    LinuxElf,
    WindowsPe,
    ShellScript,
    /// A native macOS executable: thin 32/64-bit Mach-O or a universal ("fat") binary.
    MacOsMachO,
    /// A macOS `.app` bundle whose launcher lives under `Contents/MacOS`.
    MacOsAppBundle,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveredExecutable {
    pub rel_path: String,
    pub abs_path: PathBuf,
    pub kind: BinaryKind,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtonInstallation {
    pub name: String,
    pub root_dir: PathBuf,
    pub proton_script: PathBuf,
    pub source: ProtonSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProtonSource {
    OpenSyncManaged,
    SteamCompatTools,
    SteamCommon,
    FlatpakSteam,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeProtonRelease {
    pub tag_name: String,
    pub tarball_url: String,
    pub tarball_name: String,
    pub tarball_size: u64,
    pub sha512_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LaunchCommandSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub working_dir: PathBuf,
    pub runtime_label: String,
}

/// Returns true when `path` is a macOS application bundle containing a `Contents/MacOS` launcher.
pub fn is_macos_app_bundle(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("app"))
        && path.join("Contents/MacOS").is_dir()
}

/// Locates the native executable inside a macOS `.app` bundle, preferring a binary whose
/// name matches the bundle name.
pub fn macos_app_inner_binary(app_path: &Path) -> Option<PathBuf> {
    let macos_dir = app_path.join("Contents/MacOS");
    let bundle_name = app_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mut candidates: Vec<PathBuf> = fs::read_dir(&macos_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|p| {
            p.is_file()
                && matches!(
                    detect_binary_kind(p),
                    BinaryKind::MacOsMachO | BinaryKind::ShellScript
                )
        })
        .collect();
    candidates.sort_by_key(|p| {
        let stem = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        let name_match = if !bundle_name.is_empty()
            && (stem == bundle_name || stem.contains(&bundle_name) || bundle_name.contains(&stem))
        {
            0
        } else {
            1
        };
        (name_match, p.components().count())
    });
    candidates.into_iter().next()
}

/// Inspects the first bytes of a file to classify ELF, PE, shell scripts, and Mach-O binaries.
/// macOS `.app` bundles are classified by their `Contents/MacOS` directory instead of magic.
pub fn detect_binary_kind(path: &Path) -> BinaryKind {
    if is_macos_app_bundle(path) {
        return BinaryKind::MacOsAppBundle;
    }
    let Ok(mut f) = File::open(path) else {
        return BinaryKind::Unknown;
    };
    detect_binary_kind_from_file(&mut f)
}

fn detect_binary_kind_from_file(f: &mut File) -> BinaryKind {
    let mut magic = [0u8; 8];
    let Ok(n) = f.read(&mut magic) else {
        return BinaryKind::Unknown;
    };
    if n >= 4 && magic[..4] == [0x7f, b'E', b'L', b'F'] {
        return BinaryKind::LinuxElf;
    }
    if n >= 2 && magic[0] == b'M' && magic[1] == b'Z' {
        return BinaryKind::WindowsPe;
    }
    if n >= 2 && magic[0] == b'#' && magic[1] == b'!' {
        return BinaryKind::ShellScript;
    }
    // Mach-O magics (MH_MAGIC/MH_CIGAM, MH_MAGIC_64/MH_CIGAM_64) and the universal
    // "fat" magics (FAT_MAGIC/FAT_CIGAM and their 64-bit variants) in both byte orders.
    if n >= 4
        && matches!(
            &magic[..4],
            [0xce, 0xfa, 0xed, 0xfe]
                | [0xfe, 0xed, 0xfa, 0xce]
                | [0xcf, 0xfa, 0xed, 0xfe]
                | [0xfe, 0xed, 0xfa, 0xcf]
                | [0xbe, 0xba, 0xfe, 0xca]
                | [0xca, 0xfe, 0xba, 0xbe]
                | [0xbf, 0xba, 0xfe, 0xca]
                | [0xca, 0xfe, 0xba, 0xbf]
        )
    {
        return BinaryKind::MacOsMachO;
    }
    BinaryKind::Unknown
}

const IGNORED_EXE_SUBSTRINGS: &[&str] = &[
    "unins",
    "crashhandler",
    "unitycrashhandler",
    "vcredist",
    "dxsetup",
    "redist",
    "directx",
    "vc_redist",
    "ue4prereq",
    "ueprereq",
    "dotnetfx",
];

#[inline]
fn contains_ascii_ci(haystack: &str, needle: &str) -> bool {
    let h = haystack.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || h.len() < n.len() {
        return false;
    }
    h.windows(n.len()).any(|w| w.eq_ignore_ascii_case(n))
}

#[inline]
fn has_ignored_exe_substring(s: &str) -> bool {
    IGNORED_EXE_SUBSTRINGS
        .iter()
        .any(|bad| contains_ascii_ci(s, bad))
}

#[inline]
fn is_non_executable_file_name(name: &str) -> bool {
    if contains_ascii_ci(name, ".so.") {
        return true;
    }
    let Some(ext) = Path::new(name).extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "dat"
            | "pak"
            | "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "gif"
            | "bmp"
            | "tga"
            | "dds"
            | "ogg"
            | "wav"
            | "mp3"
            | "flac"
            | "mp4"
            | "webm"
            | "mkv"
            | "avi"
            | "txt"
            | "md"
            | "json"
            | "xml"
            | "yaml"
            | "yml"
            | "toml"
            | "ini"
            | "cfg"
            | "conf"
            | "log"
            | "csv"
            | "sav"
            | "bak"
            | "tmp"
            | "part"
            | "zip"
            | "tar"
            | "gz"
            | "7z"
            | "rar"
            | "ttf"
            | "otf"
            | "woff"
            | "woff2"
            | "dll"
            | "so"
            | "dylib"
            | "pdb"
            | "assets"
            | "ress"
            | "resource"
            | "bank"
            | "fsb"
            | "bik"
            | "bk2"
            | "usm"
            | "pck"
            | "wad"
            | "vpk"
            | "bsa"
            | "ba2"
            | "esm"
            | "esp"
            | "ico"
            | "icns"
            | "pdf"
            | "html"
            | "css"
            | "map"
            | "shader"
            | "glsl"
            | "hlsl"
            | "spv"
            | "obj"
            | "mtl"
            | "fbx"
            | "glb"
            | "gltf"
            | "cur"
            | "ani"
            | "lib"
            | "a"
            | "o"
    )
}

/// Automatically discovers and ranks launchable executables inside an installed game directory.
pub fn discover_executables(install_dir: &Path, game_name: &str) -> Vec<DiscoveredExecutable> {
    let lower_game: String = game_name
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();

    let mut candidates = Vec::new();
    let mut stack = vec![(install_dir.to_path_buf(), String::new(), 0usize)];

    while let Some((dir, prefix, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let child_depth = depth + 1;
        for entry in entries.filter_map(Result::ok) {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_symlink() {
                continue;
            }
            let file_name_os = entry.file_name();
            let Some(name) = file_name_os.to_str() else {
                continue;
            };
            if has_ignored_exe_substring(name) {
                continue;
            }

            if ft.is_dir() {
                // Skip macOS frameworks and never descend inside `.app` bundles.
                if (name.len() >= 10
                    && name.as_bytes()[name.len() - 10..].eq_ignore_ascii_case(b".framework"))
                    || (name.eq_ignore_ascii_case("contents")
                        && prefix.len() >= 4
                        && prefix.as_bytes()[prefix.len() - 4..].eq_ignore_ascii_case(b".app"))
                {
                    continue;
                }
                let abs = entry.path();
                let rel_str = if prefix.is_empty() {
                    name.to_string()
                } else {
                    format!("{prefix}/{name}")
                };
                if name.len() >= 4
                    && name.as_bytes()[name.len() - 4..].eq_ignore_ascii_case(b".app")
                    && abs.join("Contents/MacOS").is_dir()
                {
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    candidates.push(DiscoveredExecutable {
                        rel_path: rel_str,
                        abs_path: abs,
                        kind: BinaryKind::MacOsAppBundle,
                        size,
                    });
                    continue;
                }
                if child_depth < 4 {
                    stack.push((abs, rel_str, child_depth));
                }
                continue;
            }

            if !ft.is_file() || is_non_executable_file_name(name) {
                continue;
            }

            let abs = entry.path();
            let Ok(mut f) = File::open(&abs) else {
                continue;
            };
            let kind = detect_binary_kind_from_file(&mut f);
            if kind == BinaryKind::Unknown {
                continue;
            }
            let size = f.metadata().map(|m| m.len()).unwrap_or(0);
            let rel_str = if prefix.is_empty() {
                name.to_string()
            } else {
                format!("{prefix}/{name}")
            };
            candidates.push(DiscoveredExecutable {
                rel_path: rel_str,
                abs_path: abs,
                kind,
                size,
            });
        }
    }

    candidates.sort_by_cached_key(|c| {
        let depth = c.rel_path.matches('/').count();
        let stem: String = Path::new(&c.rel_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .chars()
            .filter(|ch| ch.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect();
        let name_match: u8 = if !lower_game.is_empty()
            && (stem.contains(&lower_game) || lower_game.contains(&stem))
        {
            0
        } else {
            1
        };
        #[cfg(target_os = "windows")]
        let kind_rank: u8 = match c.kind {
            BinaryKind::MacOsAppBundle | BinaryKind::MacOsMachO => 2,
            BinaryKind::WindowsPe => 0,
            BinaryKind::LinuxElf => 1,
            BinaryKind::ShellScript => 3,
            BinaryKind::Unknown => 4,
        };
        #[cfg(target_os = "macos")]
        let kind_rank: u8 = match c.kind {
            BinaryKind::MacOsAppBundle => 0,
            BinaryKind::MacOsMachO => 1,
            BinaryKind::ShellScript => 2,
            BinaryKind::WindowsPe => 3,
            BinaryKind::LinuxElf => 4,
            BinaryKind::Unknown => 5,
        };
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let kind_rank: u8 = match c.kind {
            BinaryKind::LinuxElf => 0,
            BinaryKind::WindowsPe | BinaryKind::MacOsMachO | BinaryKind::MacOsAppBundle => 1,
            BinaryKind::ShellScript => 2,
            BinaryKind::Unknown => 3,
        };
        (name_match, kind_rank, depth, u64::MAX - c.size)
    });

    candidates
}

fn user_home_dir() -> Option<PathBuf> {
    ["HOME", "USERPROFILE"]
        .into_iter()
        .filter_map(|var| std::env::var(var).ok())
        .find(|v| !v.trim().is_empty())
        .map(PathBuf::from)
}

/// Returns standard search roots for installed Proton runtimes on the current platform.
/// Linux keeps its Steam/Flatpak locations; macOS uses `~/Library/Application Support/Steam`
/// (with a compatibility fallback for Linux-style layouts) so scans never depend on
/// `$XDG_DATA_HOME`.
pub fn default_proton_search_roots(managed_dir: &Path) -> Vec<(PathBuf, ProtonSource)> {
    let mut roots = vec![(managed_dir.to_path_buf(), ProtonSource::OpenSyncManaged)];
    let Some(home) = user_home_dir() else {
        return roots;
    };

    #[cfg(target_os = "linux")]
    {
        roots.push((
            home.join(".local/share/Steam/compatibilitytools.d"),
            ProtonSource::SteamCompatTools,
        ));
        roots.push((
            home.join(".steam/root/compatibilitytools.d"),
            ProtonSource::SteamCompatTools,
        ));
        roots.push((
            home.join(".var/app/com.valvesoftware.Steam/data/Steam/compatibilitytools.d"),
            ProtonSource::FlatpakSteam,
        ));
        roots.push((
            home.join(".local/share/Steam/steamapps/common"),
            ProtonSource::SteamCommon,
        ));
        roots.push((
            home.join(".steam/steam/steamapps/common"),
            ProtonSource::SteamCommon,
        ));
        roots.push((
            home.join(".var/app/com.valvesoftware.Steam/data/Steam/steamapps/common"),
            ProtonSource::FlatpakSteam,
        ));
    }

    #[cfg(target_os = "macos")]
    {
        roots.push((
            home.join("Library/Application Support/Steam/compatibilitytools.d"),
            ProtonSource::SteamCompatTools,
        ));
        roots.push((
            home.join("Library/Application Support/Steam/steamapps/common"),
            ProtonSource::SteamCommon,
        ));
        // Also pick up Linux-style Steam layouts (e.g. migrated installs).
        roots.push((
            home.join(".local/share/Steam/compatibilitytools.d"),
            ProtonSource::SteamCompatTools,
        ));
        roots.push((
            home.join(".local/share/Steam/steamapps/common"),
            ProtonSource::SteamCommon,
        ));
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(pf) = std::env::var("ProgramFiles(x86)") {
            let pf = PathBuf::from(pf);
            roots.push((
                pf.join("Steam/compatibilitytools.d"),
                ProtonSource::SteamCompatTools,
            ));
            roots.push((pf.join("Steam/steamapps/common"), ProtonSource::SteamCommon));
        }
        let _ = &home;
    }

    roots
}

/// Scans the given roots for valid Proton installations (directories containing a `proton` executable script).
pub fn detect_proton_in_roots(roots: &[(PathBuf, ProtonSource)]) -> Vec<ProtonInstallation> {
    let mut found = Vec::new();
    let mut seen_canonical = std::collections::HashSet::new();

    for (root, source) in roots {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            let dir = entry.path();
            if !ft.is_dir() && !(ft.is_symlink() && dir.is_dir()) {
                continue;
            }
            let proton_script = dir.join("proton");
            if !proton_script.is_file() {
                continue;
            }
            let canonical = fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
            if !seen_canonical.insert(canonical) {
                continue;
            }
            let name = dir
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("Proton")
                .to_string();
            found.push(ProtonInstallation {
                name,
                root_dir: dir,
                proton_script,
                source: *source,
            });
        }
    }

    // Prioritize OpenSync-managed & GE-Proton builds, newest version name first.
    found.sort_by(|a, b| {
        let rank = |s: ProtonSource| match s {
            ProtonSource::OpenSyncManaged => 0,
            ProtonSource::SteamCompatTools => 1,
            ProtonSource::FlatpakSteam => 2,
            ProtonSource::SteamCommon => 3,
            ProtonSource::Custom => 4,
        };
        rank(a.source)
            .cmp(&rank(b.source))
            .then_with(|| b.name.cmp(&a.name))
    });

    found
}

/// Builds a native launch specification, marking known executable files executable on Unix.
fn native_command(
    exe: &DiscoveredExecutable,
    extra_args: &[String],
    working_dir: PathBuf,
) -> LaunchCommandSpec {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Never mutate permissions of an unclassified file — it may be user data that only
        // happens to be the last discovery candidate.
        if exe.kind != BinaryKind::Unknown
            && let Ok(meta) = fs::metadata(&exe.abs_path)
        {
            let mode = meta.permissions().mode();
            if mode & 0o111 == 0 {
                let _ =
                    fs::set_permissions(&exe.abs_path, fs::Permissions::from_mode(mode | 0o755));
            }
        }
    }
    LaunchCommandSpec {
        program: exe.abs_path.clone(),
        args: extra_args.to_vec(),
        env: Vec::new(),
        working_dir,
        runtime_label: "native".to_string(),
    }
}

/// Launches a macOS `.app` bundle via Launch Services. `open -W` waits until the app quits,
/// which keeps the runner's session clock and post-exit save sync in sync with the real game.
#[cfg(target_os = "macos")]
fn macos_app_command(
    exe: &DiscoveredExecutable,
    extra_args: &[String],
    working_dir: PathBuf,
) -> ProtonResult<LaunchCommandSpec> {
    let open = PathBuf::from("/usr/bin/open");
    if open.is_file() {
        let mut args = vec![
            "-W".to_string(),
            exe.abs_path.to_string_lossy().into_owned(),
        ];
        if !extra_args.is_empty() {
            args.push("--args".to_string());
            args.extend(extra_args.iter().cloned());
        }
        return Ok(LaunchCommandSpec {
            program: open,
            args,
            env: Vec::new(),
            working_dir,
            runtime_label: "macOS".to_string(),
        });
    }
    // Defensive fallback: execute the bundle's inner Mach-O binary directly.
    match macos_app_inner_binary(&exe.abs_path) {
        Some(inner) => Ok(LaunchCommandSpec {
            program: inner.clone(),
            args: extra_args.to_vec(),
            env: Vec::new(),
            working_dir: inner.parent().unwrap_or(&exe.abs_path).to_path_buf(),
            runtime_label: "native".to_string(),
        }),
        None => Err(ProtonError::NotInstalled),
    }
}

/// Windows PE launch on macOS: use a configured Wine-compatible runner when available,
/// otherwise fall back to a clean native execution attempt (no Linux Proton script).
#[cfg(target_os = "macos")]
fn macos_pe_command(
    exe: &DiscoveredExecutable,
    extra_args: &[String],
    working_dir: PathBuf,
) -> ProtonResult<LaunchCommandSpec> {
    const RUNNER_VARS: &[(&str, &str)] = &[
        ("OPENSYNC_MACOS_COMPAT_RUNNER", "compat"),
        ("OPENSYNC_MACOS_WINE", "Wine"),
        ("OPENSYNC_MACOS_WHISKY", "Whisky"),
        ("OPENSYNC_MACOS_CROSSOVER", "CrossOver"),
    ];
    let mut runner_label = "compat";
    let runner = RUNNER_VARS
        .iter()
        .find_map(|(var, label)| {
            std::env::var(var)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .map(|v| {
                    runner_label = *label;
                    PathBuf::from(v)
                })
        })
        .or_else(|| {
            find_on_path("wine").map(|p| {
                runner_label = "Wine";
                p
            })
        })
        .or_else(|| {
            find_on_path("wine64").map(|p| {
                runner_label = "Wine";
                p
            })
        })
        .or_else(|| {
            // macOS GUI apps launched from Finder/Dock do not include Homebrew in PATH.
            [
                "/opt/homebrew/bin/wine",
                "/usr/local/bin/wine",
                "/opt/homebrew/bin/wine64",
                "/usr/local/bin/wine64",
            ]
            .into_iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())
            .map(|p| {
                runner_label = "Wine";
                p
            })
        });

    let Some(runner) = runner else {
        return Ok(LaunchCommandSpec {
            program: exe.abs_path.clone(),
            args: extra_args.to_vec(),
            env: Vec::new(),
            working_dir,
            runtime_label: "native (Windows PE needs Wine/Whisky/CrossOver on macOS)".to_string(),
        });
    };

    let label = format!("{runner_label} (macOS)");
    let mut args = vec![exe.abs_path.to_string_lossy().into_owned()];
    args.extend(extra_args.iter().cloned());

    // Whisky/CrossOver are distributed as .app bundles; a directory cannot be executed directly.
    if is_macos_app_bundle(&runner) {
        if let Some(inner) = macos_app_inner_binary(&runner) {
            return Ok(LaunchCommandSpec {
                program: inner,
                args,
                env: Vec::new(),
                working_dir,
                runtime_label: label,
            });
        }
        let mut open_args = vec![
            "-W".to_string(),
            "-a".to_string(),
            runner.to_string_lossy().into_owned(),
            "--args".to_string(),
        ];
        open_args.extend(args);
        return Ok(LaunchCommandSpec {
            program: PathBuf::from("/usr/bin/open"),
            args: open_args,
            env: Vec::new(),
            working_dir,
            runtime_label: label,
        });
    }

    Ok(LaunchCommandSpec {
        program: runner,
        args,
        env: Vec::new(),
        working_dir,
        runtime_label: label,
    })
}

/// Linux/Windows path: build a Proton (or `umu-run`) launch command for a Windows PE binary.
#[cfg(any(target_os = "linux", target_os = "windows"))]
fn build_proton_pe_command(
    exe: &DiscoveredExecutable,
    prefix_dir: &Path,
    proton: &ProtonInstallation,
    extra_args: &[String],
    working_dir: PathBuf,
) -> ProtonResult<LaunchCommandSpec> {
    fs::create_dir_all(prefix_dir)?;

    // Prefer `umu-run` when available on PATH for clean Steam Linux Runtime sandboxing.
    let mut env = vec![
        (
            "STEAM_COMPAT_DATA_PATH".to_string(),
            prefix_dir.to_string_lossy().to_string(),
        ),
        (
            "STEAM_COMPAT_CLIENT_INSTALL_PATH".to_string(),
            proton
                .root_dir
                .parent()
                .unwrap_or(&proton.root_dir)
                .to_string_lossy()
                .to_string(),
        ),
        (
            "PROTONPATH".to_string(),
            proton.root_dir.to_string_lossy().to_string(),
        ),
        ("GAMEID".to_string(), "opensync-0".to_string()),
    ];

    if let Some(umu) = find_on_path("umu-run") {
        let mut args = vec![exe.abs_path.to_string_lossy().to_string()];
        args.extend(extra_args.iter().cloned());
        return Ok(LaunchCommandSpec {
            program: umu,
            args,
            env,
            working_dir,
            runtime_label: format!("{} (umu)", proton.name),
        });
    }

    let mut args = vec![
        "run".to_string(),
        exe.abs_path.to_string_lossy().to_string(),
    ];
    args.extend(extra_args.iter().cloned());
    env.push(("STEAM_COMPAT_APP_ID".to_string(), "0".to_string()));
    Ok(LaunchCommandSpec {
        program: proton.proton_script.clone(),
        args,
        env,
        working_dir,
        runtime_label: proton.name.clone(),
    })
}

/// Builds a launch command for a native executable, a macOS app bundle, or (depending on
/// the host OS) a Windows PE binary via Proton/Wine.
pub fn build_launch_command(
    exe: &DiscoveredExecutable,
    prefix_dir: &Path,
    proton: Option<&ProtonInstallation>,
    extra_args: &[String],
) -> ProtonResult<LaunchCommandSpec> {
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = prefix_dir;
        let _ = proton;
    }
    let working_dir = exe
        .abs_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();

    match exe.kind {
        BinaryKind::MacOsAppBundle => {
            #[cfg(target_os = "macos")]
            {
                macos_app_command(exe, extra_args, working_dir)
            }
            #[cfg(not(target_os = "macos"))]
            {
                Ok(native_command(exe, extra_args, working_dir))
            }
        }
        BinaryKind::MacOsMachO
        | BinaryKind::LinuxElf
        | BinaryKind::ShellScript
        | BinaryKind::Unknown => Ok(native_command(exe, extra_args, working_dir)),
        BinaryKind::WindowsPe => {
            #[cfg(target_os = "windows")]
            if proton.is_none() {
                return Ok(native_command(exe, extra_args, working_dir));
            }
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                let proton = proton.ok_or(ProtonError::NotInstalled)?;
                build_proton_pe_command(exe, prefix_dir, proton, extra_args, working_dir)
            }
            #[cfg(target_os = "macos")]
            {
                macos_pe_command(exe, extra_args, working_dir)
            }
            #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
            {
                Ok(native_command(exe, extra_args, working_dir))
            }
        }
    }
}

/// Re-roots a launch command on the host when the launcher itself runs inside a Flatpak.
///
/// Flatpak runtimes are minimal: since GNOME 49 the GNOME runtime no longer ships an
/// i386 compatibility extension, so a 32-bit Windows game launched through Proton/Wine
/// dies immediately with `/lib/ld-linux.so.2: could not open`. `flatpak-spawn --host`
/// executes the very same command in the host session, where Proton has a complete
/// 32-bit runtime (this is also why the same games work in Lutris).
///
/// The app must hold the `org.freedesktop.Flatpak` D-Bus talk permission for this to
/// work; without it the spawn fails with a clear error instead of silently dying.
pub fn wrap_launch_for_flatpak_host(spec: LaunchCommandSpec) -> LaunchCommandSpec {
    if std::env::var_os("FLATPAK_ID").is_none() {
        return spec;
    }
    let Some(spawn) = find_on_path("flatpak-spawn").or_else(|| {
        let fallback = PathBuf::from("/usr/bin/flatpak-spawn");
        fallback.is_file().then_some(fallback)
    }) else {
        return spec;
    };

    let mut args = vec![
        "--host".to_string(),
        format!("--directory={}", spec.working_dir.display()),
    ];
    for (key, value) in &spec.env {
        args.push(format!("--env={key}={value}"));
    }
    args.push(spec.program.to_string_lossy().into_owned());
    args.extend(spec.args.iter().cloned());

    LaunchCommandSpec {
        program: spawn,
        args,
        env: spec.env,
        working_dir: spec.working_dir,
        runtime_label: format!("{} (Flatpak host)", spec.runtime_label),
    }
}

fn find_on_path(bin: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(bin);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Queries GitHub Releases for the latest GloriousEggroll GE-Proton release.
pub async fn fetch_latest_ge_proton() -> ProtonResult<GeProtonRelease> {
    #[derive(Deserialize)]
    struct GhAsset {
        name: String,
        browser_download_url: String,
        size: u64,
    }
    #[derive(Deserialize)]
    struct GhRelease {
        tag_name: String,
        assets: Vec<GhAsset>,
    }

    let client = reqwest::Client::builder()
        .user_agent("opensync-launcher/0.1")
        .build()?;
    let rel: GhRelease = client
        .get("https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases/latest")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let tarball = rel
        .assets
        .iter()
        .find(|a| a.name.ends_with(".tar.gz"))
        .ok_or(ProtonError::MissingReleaseAssets)?;
    let sha512 = rel
        .assets
        .iter()
        .find(|a| a.name.ends_with(".sha512sum"))
        .map(|a| a.browser_download_url.clone());

    Ok(GeProtonRelease {
        tag_name: rel.tag_name,
        tarball_url: tarball.browser_download_url.clone(),
        tarball_name: tarball.name.clone(),
        tarball_size: tarball.size,
        sha512_url: sha512,
    })
}

/// Verifies a GE-Proton `.tar.gz` archive against its SHA-512 checksum (when provided)
/// and safely extracts it into `managed_dir`.
pub fn install_ge_proton_archive(
    tarball_path: &Path,
    expected_sha512: Option<&str>,
    managed_dir: &Path,
) -> ProtonResult<ProtonInstallation> {
    if let Some(expected) = expected_sha512 {
        let mut f = File::open(tarball_path)?;
        let mut hasher = DigestContext::new(&SHA512);
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        let actual = hex::encode(hasher.finish().as_ref());
        let clean_expected = expected
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_lowercase();
        if actual != clean_expected {
            return Err(ProtonError::ChecksumMismatch {
                name: tarball_path.display().to_string(),
                expected: clean_expected,
                actual,
            });
        }
    }

    fs::create_dir_all(managed_dir)?;
    let file = File::open(tarball_path)?;
    let gz = GzDecoder::new(file);
    let mut archive = Archive::new(gz);
    let mut top_dir: Option<PathBuf> = None;

    for entry in archive.entries()? {
        let mut entry = entry?;
        let rel = entry.path()?.into_owned();
        if rel.is_absolute()
            || rel
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(ProtonError::UnsafeArchivePath(rel.display().to_string()));
        }
        if top_dir.is_none()
            && let Some(first) = rel.components().next()
        {
            top_dir = Some(managed_dir.join(first.as_os_str()));
        }
        let out = managed_dir.join(&rel);
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        entry.unpack(&out)?;
    }

    let root = top_dir.ok_or(ProtonError::NotInstalled)?;
    let proton_script = root.join("proton");
    if !proton_script.is_file() {
        return Err(ProtonError::NotInstalled);
    }
    let name = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("GE-Proton")
        .to_string();

    Ok(ProtonInstallation {
        name,
        root_dir: root,
        proton_script,
        source: ProtonSource::OpenSyncManaged,
    })
}

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Streams a GE-Proton `.tar.gz` tarball to a temporary file inside `managed_dir`,
/// fetches the optional `.sha512sum` file, verifies SHA-512 and safely extracts via
/// [`install_ge_proton_archive`], always removing the temporary tarball on success or error.
pub async fn download_and_install_ge_proton<F>(
    tarball_url: &str,
    sha512_url: Option<&str>,
    managed_dir: &Path,
    on_progress: F,
) -> ProtonResult<ProtonInstallation>
where
    F: Fn(u64, u64) + Send + 'static,
{
    download_and_install_ge_proton_with_control(
        tarball_url,
        sha512_url,
        managed_dir,
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicU64::new(0)),
        on_progress,
        || {},
    )
    .await
}

/// Full-featured variant of [`download_and_install_ge_proton`] supporting pause, cancel,
/// bandwidth throttling, and a verification-phase callback for the Download Manager.
#[allow(clippy::too_many_arguments)]
pub async fn download_and_install_ge_proton_with_control<F, V>(
    tarball_url: &str,
    sha512_url: Option<&str>,
    managed_dir: &Path,
    paused: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    max_bytes_per_sec: Arc<AtomicU64>,
    on_progress: F,
    on_verifying: V,
) -> ProtonResult<ProtonInstallation>
where
    F: Fn(u64, u64) + Send + 'static,
    V: FnOnce() + Send + 'static,
{
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    if cancelled.load(Ordering::SeqCst) {
        return Err(ProtonError::Cancelled);
    }

    fs::create_dir_all(managed_dir)?;
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let temp_path = managed_dir.join(format!(
        ".ge-proton-download-{}-{}.tar.gz.part",
        std::process::id(),
        seq
    ));
    let _temp_guard = TempFileGuard(temp_path.clone());

    let client = reqwest::Client::builder()
        .user_agent("opensync-launcher/0.1")
        .build()?;

    let res = client.get(tarball_url).send().await?.error_for_status()?;
    let total_bytes = res.content_length().unwrap_or(0);
    on_progress(0, total_bytes);

    let file = tokio::fs::File::create(&temp_path).await?;
    let mut writer = tokio::io::BufWriter::with_capacity(256 * 1024, file);
    let mut stream = res.bytes_stream();

    let mut downloaded: u64 = 0;
    let mut bytes_in_window: u64 = 0;
    let mut window_start = Instant::now();

    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err(ProtonError::Cancelled);
        }
        while paused.load(Ordering::SeqCst) {
            if cancelled.load(Ordering::SeqCst) {
                return Err(ProtonError::Cancelled);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
            window_start = Instant::now();
            bytes_in_window = 0;
        }

        let Some(item) = stream.next().await else {
            break;
        };

        if cancelled.load(Ordering::SeqCst) {
            return Err(ProtonError::Cancelled);
        }
        while paused.load(Ordering::SeqCst) {
            if cancelled.load(Ordering::SeqCst) {
                return Err(ProtonError::Cancelled);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
            window_start = Instant::now();
            bytes_in_window = 0;
        }

        let chunk = item?;
        let len = chunk.len() as u64;
        writer.write_all(&chunk).await?;
        downloaded += len;

        let limit = max_bytes_per_sec.load(Ordering::Relaxed);
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

        on_progress(downloaded, total_bytes.max(downloaded));
    }

    writer.flush().await?;
    drop(writer);

    if cancelled.load(Ordering::SeqCst) {
        return Err(ProtonError::Cancelled);
    }

    on_verifying();

    let expected_sha512 = match sha512_url {
        Some(url) => Some(
            client
                .get(url)
                .send()
                .await?
                .error_for_status()?
                .text()
                .await?,
        ),
        None => None,
    };

    if cancelled.load(Ordering::SeqCst) {
        return Err(ProtonError::Cancelled);
    }

    let tarball_for_extract = temp_path.clone();
    let managed_for_extract = managed_dir.to_path_buf();
    let installation = tokio::task::spawn_blocking(move || {
        install_ge_proton_archive(
            &tarball_for_extract,
            expected_sha512.as_deref(),
            &managed_for_extract,
        )
    })
    .await
    .map_err(|e| {
        ProtonError::Io(std::io::Error::other(format!(
            "proton installer panicked: {e}"
        )))
    })??;

    Ok(installation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_macho_and_fat_magics() {
        let dir = tempfile::tempdir().expect("tempdir");
        for (name, magic) in [
            ("thin32_le", [0xce, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]),
            ("thin32_be", [0xfe, 0xed, 0xfa, 0xce, 0, 0, 0, 0]),
            ("thin64_le", [0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]),
            ("thin64_be", [0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0]),
            ("fat32", [0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0]),
            ("fat64", [0xbf, 0xba, 0xfe, 0xca, 0, 0, 0, 0]),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, magic).expect("write magic");
            assert_eq!(detect_binary_kind(&path), BinaryKind::MacOsMachO, "{name}");
        }
    }

    #[test]
    fn discovers_app_bundle_without_duplicate_inner_binary() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = dir.path().join("MyGame.app");
        let macos = app.join("Contents/MacOS");
        std::fs::create_dir_all(&macos).expect("create bundle");
        std::fs::write(macos.join("MyGame"), [0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])
            .expect("write launcher");

        assert!(is_macos_app_bundle(&app));
        assert_eq!(detect_binary_kind(&app), BinaryKind::MacOsAppBundle);
        assert_eq!(macos_app_inner_binary(&app), Some(macos.join("MyGame")));

        let found = discover_executables(dir.path(), "MyGame");
        assert_eq!(found.len(), 1, "unexpected candidates: {found:?}");
        assert_eq!(found[0].kind, BinaryKind::MacOsAppBundle);
        assert_eq!(found[0].rel_path, "MyGame.app");
    }

    #[test]
    fn flatpak_launch_is_rerooted_on_the_host() {
        // Simulate running inside a Flatpak (edition 2024 makes env mutation unsafe).
        let dir = tempfile::tempdir().expect("tempdir");
        let spawn = dir.path().join("flatpak-spawn");
        fs::write(&spawn, b"#!/bin/sh\n").expect("write fake flatpak-spawn");
        let old_path = std::env::var_os("PATH");
        let new_path = format!(
            "{}:{}",
            dir.path().display(),
            old_path.clone().unwrap_or_default().to_string_lossy()
        );
        unsafe {
            std::env::set_var("FLATPAK_ID", "io.opensync.launcher");
            std::env::set_var("PATH", &new_path);
        }
        let spec = LaunchCommandSpec {
            program: PathBuf::from("/usr/bin/proton"),
            args: vec!["run".into(), "/home/aki/games/HMA.exe".into()],
            env: vec![("GAMEID".into(), "opensync-0".into())],
            working_dir: PathBuf::from("/home/aki/games"),
            runtime_label: "GE-Proton".into(),
        };
        let wrapped = wrap_launch_for_flatpak_host(spec);
        unsafe {
            std::env::remove_var("FLATPAK_ID");
            match old_path {
                Some(path) => std::env::set_var("PATH", path),
                None => std::env::remove_var("PATH"),
            }
        }

        assert_eq!(wrapped.program, spawn);
        assert_eq!(wrapped.args[0], "--host");
        assert_eq!(wrapped.args[1], "--directory=/home/aki/games");
        assert!(wrapped.args.iter().any(|a| a == "--env=GAMEID=opensync-0"));
        assert!(wrapped.args.iter().any(|a| a == "/usr/bin/proton"));
        assert!(wrapped.runtime_label.contains("Flatpak host"));
    }

    #[test]
    fn native_macho_command_runs_the_binary_directly() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("game");
        std::fs::write(&path, [0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]).expect("write binary");
        let exe = DiscoveredExecutable {
            rel_path: "game".into(),
            abs_path: path.clone(),
            kind: BinaryKind::MacOsMachO,
            size: 8,
        };
        let spec = build_launch_command(&exe, dir.path(), None, &["--fullscreen".to_string()])
            .expect("native command");
        assert_eq!(spec.program, path);
        assert_eq!(spec.args, ["--fullscreen".to_string()]);
        assert_eq!(spec.runtime_label, "native");
    }

    #[test]
    fn discovery_handles_multibyte_utf8_directory_names() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Names whose byte offsets would land mid-codepoint if sliced by raw byte count.
        for name in ["Pokémon.framework", "Über.app", "ゲーム.app", "C++/redist"] {
            let path = dir.path().join(name);
            if name.contains('/') {
                std::fs::create_dir_all(&path).expect("create nested dir");
            } else {
                std::fs::create_dir(&path).expect("create dir");
            }
        }
        // Must not panic on any of the above.
        let _ = discover_executables(dir.path(), "Über");
    }
}
