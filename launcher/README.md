<!-- PROJECT SHIELDS -->
<p align="center">
  <a href="https://github.com/piskevalee-cpu/OpenSync/stargazers"><img src="https://img.shields.io/github/stars/piskevalee-cpu/OpenSync.svg?style=for-the-badge" alt="Stars"></a>
  <a href="https://github.com/piskevalee-cpu/OpenSync/network/members"><img src="https://img.shields.io/github/forks/piskevalee-cpu/OpenSync.svg?style=for-the-badge" alt="Forks"></a>
  <a href="https://github.com/piskevalee-cpu/OpenSync/issues"><img src="https://img.shields.io/github/issues/piskevalee-cpu/OpenSync.svg?style=for-the-badge" alt="Issues"></a>
  <a href="https://github.com/piskevalee-cpu/OpenSync/blob/main/LICENSE"><img src="https://img.shields.io/github/license/piskevalee-cpu/OpenSync.svg?style=for-the-badge" alt="License"></a>
</p>

<!-- PROJECT LOGO -->
<br />
<div align="center" id="readme-top">
  <a href="https://github.com/piskevalee-cpu/OpenSync/tree/main/launcher">
    <img src="crates/launcher-tauri/icons/icon.png" alt="OpenSync Launcher" width="160">
  </a>

  <p align="center">
    Native desktop game cabinet and runner for self-hosted <a href="https://github.com/piskevalee-cpu/OpenSync">OpenSync</a> archives with Proton support, screen-time tracking, and automatic save sync.
    <br />
    <br />
    <a href="https://github.com/piskevalee-cpu/OpenSync/issues/new?labels=bug">Report Bug</a>
    &middot;
    <a href="https://github.com/piskevalee-cpu/OpenSync/issues/new?labels=enhancement">Request Feature</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#what-is-opensync-launcher">What is OpenSync Launcher?</a>
      <ul>
        <li><a href="#how-it-works">How it Works</a></li>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
        <li><a href="#configuration">Configuration</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a>
      <ul>
        <li><a href="#workspace-crates">Workspace Crates</a></li>
      </ul>
    </li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

<!-- WHAT IS OPENSYNC LAUNCHER -->
## What is OpenSync Launcher?

OpenSync Launcher is the companion desktop client for [OpenSync](https://github.com/piskevalee-cpu/OpenSync). It connects to one or more self-hosted OpenSync LAN instances, streams and extracts your games straight to disk, runs Linux native titles, macOS `.app` bundles / Mach-O binaries and Windows builds via Proton (or Wine on macOS), tracks session playtime, and keeps your saves automatically synced in the background.

Installed games, saved sessions, playtime history, and offline save-sync queues stay isolated per server profile, so switching between machines or different OpenSync instances on your network works seamlessly without logging out or losing progress.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## How it Works

Downloads stream directly over the LAN using OpenSync's uncompressed `STORE` mode, extracting files straight from the HTTP response body while verifying SHA-256 hashes inline with zero temporary archive files on disk.

When you launch a game, OpenSync Launcher picks native execution (including macOS `.app` bundles through `open -W`), or your selected Proton/Wine compatibility runtime, tracks active screen time with system suspend/sleep exclusion (macOS uses `caffeinate` to keep the Mac awake during a session), and triggers differential save sync as soon as the game exits — or queues it offline and flushes automatically when your OpenSync server becomes reachable again.

Key features:

* **Multi-instance profile manager** — remembers servers, session cookies, user avatars, and downloaded games across restarts, with exponential-backoff auto-reconnect
* **Wire-speed streaming downloads** — zero-temp-file ZIP extraction, path-traversal protection, inline SHA-256 verification, pause/resume/cancel, bandwidth cap, and a 60fps Download Manager waveform
* **Automatic background & post-exit save sync** — parallel `rayon` hashing against the clean manifest, concurrent 4 MB chunked overlay uploads, mass-deletion guard, offline pending queue, and periodic background flush
* **Proton auto-detection & installer** — discovers OpenSync-managed, Steam `compatibilitytools.d`, Steam `common`, and Flatpak Steam Proton builds; offers one-click SHA-512 verified GE-Proton downloads with per-game WINE prefix isolation
* **Per-game launch options** — set a custom Wine/Proton prefix (with a folder picker), quote-aware launch arguments, and environment variables that override the runtime's defaults. Options can be saved while a game is still being set up, before it is downloaded.
* **Game output logs** — stdout and stderr from each launch are captured to `logs/<game_id>.log` in the launcher data directory; the game's settings page shows them alongside its save-sync activity.
* **Native macOS support** — discovers `.app` bundles and Mach-O (thin/fat) binaries, launches bundles with `open -W`, and optionally uses a configured Wine/Whisky/CrossOver runner for Windows titles; works on both Apple Silicon and Intel Macs
* **Screen-time & controller support** — cumulative playtime tracking per game, full W3C Gamepad API + keyboard spatial navigation with bottom control hints, and OpenSync Web's dark `2:3` Steam capsule UI
* **Profile & avatar sync** — view account activity, upload or remove your profile picture, customize instance labels, and display synced avatars across the launcher

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

* [![Rust][Rust-badge]][Rust-url]
* [![Tauri][Tauri-badge]][Tauri-url]
* [![SQLite][SQLite-badge]][SQLite-url]
* [![JavaScript][JS-badge]][JS-url]

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- GETTING STARTED -->
## Getting Started

You only need a running **[OpenSync](https://github.com/piskevalee-cpu/OpenSync)** server on your LAN or `localhost`.

### Installation

Download prebuilt binaries for **`v0.4.0`** from [GitHub Releases](https://github.com/piskevalee-cpu/OpenSync/releases/tag/v0.4.0):

#### Linux AppImage (amd64)

[Download `OpenSync_Launcher_0.4.0_amd64.AppImage`](https://github.com/piskevalee-cpu/OpenSync/releases/download/v0.4.0/OpenSync_Launcher_0.4.0_amd64.AppImage), make it executable, and run:

```sh
chmod +x OpenSync_Launcher_0.4.0_amd64.AppImage
./OpenSync_Launcher_0.4.0_amd64.AppImage
```

#### Linux Flatpak (amd64)

Fetch from [v0.4.0 Releases](https://github.com/piskevalee-cpu/OpenSync/releases/download/v0.4.0/OpenSync_Launcher_0.4.0_amd64.flatpak) and install in one command:

```sh
curl -fSL https://github.com/piskevalee-cpu/OpenSync/releases/download/v0.4.0/OpenSync_Launcher_0.4.0_amd64.flatpak -o /tmp/opensync.flatpak && flatpak install --user -y /tmp/opensync.flatpak && flatpak run io.opensync.launcher
```

#### Windows (x64)

[Download `OpenSync_Launcher_0.4.0_x64.exe`](https://github.com/piskevalee-cpu/OpenSync/releases/download/v0.4.0/OpenSync_Launcher_0.4.0_x64.exe) and run directly.

#### macOS (Apple Silicon & Intel)

Download the `.dmg` for your Mac from [GitHub Releases](https://github.com/piskevalee-cpu/OpenSync/releases):

* **Apple Silicon (M1/M2/M3…)**: `OpenSync_Launcher_<version>_aarch64.dmg`
* **Intel**: `OpenSync_Launcher_<version>_x86_64.dmg`

Open the disk image and drag **OpenSync Launcher.app** into `/Applications`. A `.app.zip` is also published for each architecture if you prefer to unzip manually.

> **Note about macOS security:** the release `.dmg` files are **ad-hoc signed but not notarized**. Gatekeeper may warn that the app "can't be opened because Apple cannot check it for malicious software" or that it is "damaged". This is expected for a binary distributed outside the App Store and not notarized with Apple.

If macOS refuses to launch the app, use one of these options:

1. **Right-click → Open.** In Finder, right-click (or Control-click) **OpenSync Launcher.app** and choose **Open**, then **Open** again in the dialog. Do this once and macOS will remember it.
2. **Remove the download quarantine attribute.** Clear it from the downloaded DMG before mounting, and/or from the installed app:

   ```sh
   # Optional: clear quarantine on the downloaded .dmg (choose your architecture)
   xattr -d com.apple.quarantine ~/Downloads/OpenSync_Launcher_<version>_aarch64.dmg
   # xattr -d com.apple.quarantine ~/Downloads/OpenSync_Launcher_<version>_x86_64.dmg

   # After dragging the app to /Applications:
   xattr -d com.apple.quarantine "/Applications/OpenSync Launcher.app"
   ```

   If `xattr` prints `No such xattr: com.apple.quarantine`, the file is already clear and you can skip this step.
3. **Open Anyway.** If it is still blocked, go to **System Settings → Privacy & Security**, find the OpenSync Launcher warning under "Security", and click **Open Anyway**.

You only need to do this once per downloaded build. Notarization is planned for a future release.

### Build from Source

#### Prerequisites

* **Rust** (stable toolchain via `rustup`)
* On Windows: Visual Studio C++ Build Tools (MSVC) + WebView2 runtime
* On macOS: Xcode Command Line Tools (`xcode-select --install`) and both Rust Apple targets:
  `rustup target add aarch64-apple-darwin x86_64-apple-darwin`
* On Linux: WebKitGTK 4.1 & GTK3 development packages:
  * **openSUSE Tumbleweed**: `sudo zypper in webkitgtk3-devel gtk3-devel libsoup-devel librsvg-devel`
  * **Ubuntu / Debian**: `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev patchelf`

#### Compile & Run

```sh
git clone https://github.com/piskevalee-cpu/OpenSync.git
cd OpenSync/launcher
cargo build --release -p launcher-tauri
```

Run in development mode with `cargo run -p launcher-tauri`, or run the workspace test suite with:

```sh
cargo test --workspace --exclude launcher-tauri
```

#### macOS `.app` / `.dmg` packages

Install the Tauri CLI, then build each architecture from the Tauri crate directory:

```sh
cargo install tauri-cli --version '^2'
cd crates/launcher-tauri

# Apple Silicon
cargo tauri build --target aarch64-apple-darwin --bundles app,dmg

# Intel
cargo tauri build --target x86_64-apple-darwin --bundles app,dmg

# Optional: one universal binary containing both slices
cargo tauri build --target universal-apple-darwin --bundles app,dmg
```

Artifacts land in `target/<triple>/release/bundle/macos/` (`.app`) and
`target/<triple>/release/bundle/dmg/` (`.dmg`). The bundle uses `icons/icon.icns`,
sets `LSMinimumSystemVersion` to 10.15, and uses a transparent native titlebar with
the dark window background.

### Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `OPENSYNC_LAUNCHER_DATA` | macOS: `~/Library/Application Support/opensync-launcher`; Linux: `$XDG_DATA_HOME/opensync-launcher` or `~/.local/share/opensync-launcher`; Windows: `%APPDATA%/opensync-launcher` | App data dir (SQLite DB, `secrets.json`, prefixes, game output logs, Proton installs, cover/avatar cache). macOS never uses `$XDG_DATA_HOME`. |
| `OPENSYNC_LAUNCHER_GAMES_DIR` | `~/Games/OpenSync` | Override destination root for newly downloaded games (also editable in Settings) |
| `OPENSYNC_MACOS_COMPAT_RUNNER`, `OPENSYNC_MACOS_WINE`, `OPENSYNC_MACOS_WHISKY`, `OPENSYNC_MACOS_CROSSOVER` | unset | Optional Wine-compatible runner path for Windows games on macOS. Without one, Windows PE titles fall back to native execution. |

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- USAGE -->
## Usage

* **Connect to an OpenSync server**: enter your server URL (e.g. `http://192.168.1.42:3000` or `127.0.0.1:3000` — pasted `#/` routes and `0.0.0.0` hosts normalize automatically), instance label, and account credentials (sign in or create an account).
* **Browse & install**: hover or focus any `2:3` capsule cover to reveal the circular glass Play / Download control and rolling stats; click the card to configure launch executables, Proton runtime overrides, or run manual save syncs.
* **Downloads & runtimes**: monitor live throughput graphs, pause/resume or limit download speed in `downloads`, check/install GE-Proton builds (Linux) or point macOS at a Wine/Whisky/CrossOver runner, and set your default `Games directory` in `settings`.
* **Controller navigation**: connect any gamepad (or use Arrow keys / `Enter` / `Escape` / `I` / `[` `]`) to browse cards, inspect game details, switch tabs, and control downloads from a couch or handheld.

### Workspace Crates

| Crate | Purpose |
| --- | --- |
| `crates/launcher-db` | Bundled SQLite store (profiles, remembered state, installed games, play sessions, offline sync queue, settings) |
| `crates/opensync-api` | Async HTTP client for OpenSync endpoints (`reqwest` + `rustls`, URL normalizer, PFP & overlay endpoints) |
| `crates/opensync-transfer` | Streaming STORE/Deflate ZIP extractor, CRC32 + Data-Descriptor support, inline SHA-256 verifier, speed tracker |
| `crates/opensync-sync` | Parallel `rayon` folder scanner, clean-manifest differ, concurrent 4 MB chunked overlay uploader |
| `crates/opensync-proton` | ELF/PE/Mach-O detection, `.app` bundle discovery, Proton scanner, optional macOS Wine runners, streaming GE-Proton installer & prefix runner |
| `crates/opensync-runner` | Process launcher (including macOS `open -W` bundles), sleep-aware screen-time clock with `caffeinate` exclusion, and automatic post-exit save sync orchestration |
| `crates/launcher-core` | Stateful `LauncherCore` facade (auto-reconnect, profile switching/remembrance, PFP/cover cache, download manager, background auto-sync) |
| `crates/launcher-tauri` | Tauri v2 desktop shell (`src/commands.rs`, `src/main.rs`) and webview frontend (`ui/`) |

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ROADMAP -->
## Roadmap

**Shipped**

- [x] Multi-profile server persistence with auto-reconnect & scoped local libraries
- [x] Zero-temp-file streaming ZIP downloads with inline SHA-256 verification & 60fps waveform manager
- [x] Parallel differential post-exit & background save sync with offline pending queue
- [x] Automatic Proton discovery, per-game prefix isolation & one-click GE-Proton installer
- [x] Profile picture recognition, avatar upload/removal & account customization
- [x] W3C Gamepad + keyboard spatial navigation with live button hints
- [x] Automated Linux AppImage, Linux Flatpak, Windows `.exe`, and macOS `.app`/`.dmg` (arm64 + x86_64) CI releases
- [x] Native macOS executable discovery, `open -W` bundle launching, and sleep-excluded playtime tracking

**Next up**

- [ ] Native desktop notifications for completed downloads and background save conflicts
- [ ] Pre-launch remote save conflict prompt (keep local vs. pull newer server overlay)
- [ ] Native `.rpm` / `.deb` release packages

See the [open issues](https://github.com/piskevalee-cpu/OpenSync/issues) for a full list of proposed features (and known issues).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTRIBUTING -->
## Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also simply open an issue with the tag "enhancement".

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- LICENSE -->
## License

Distributed under the MIT License. See `LICENSE` for more information.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ACKNOWLEDGMENTS -->
## Acknowledgments

* [OpenSync Server & Web UI](https://github.com/piskevalee-cpu/OpenSync)
* [Tauri v2](https://v2.tauri.app/)
* [GloriousEggroll GE-Proton](https://github.com/GloriousEggroll/proton-ge-custom) & [umu-launcher](https://github.com/Open-Wine-Components/umu-launcher)
* [Lucide Icons](https://lucide.dev/) & [Inter font by Google Fonts](https://fonts.google.com/specimen/Inter)
* [opencode](https://opencode.ai)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
[Rust-badge]: https://img.shields.io/badge/rust-000000?style=for-the-badge&logo=rust&logoColor=white
[Rust-url]: https://www.rust-lang.org/
[Tauri-badge]: https://img.shields.io/badge/tauri-24C8D8?style=for-the-badge&logo=tauri&logoColor=white
[Tauri-url]: https://v2.tauri.app/
[SQLite-badge]: https://img.shields.io/badge/sqlite-003B57?style=for-the-badge&logo=sqlite&logoColor=white
[SQLite-url]: https://www.sqlite.org/
[JS-badge]: https://img.shields.io/badge/javascript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black
[JS-url]: https://developer.mozilla.org/docs/Web/JavaScript
