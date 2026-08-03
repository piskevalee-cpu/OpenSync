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
  <a href="https://github.com/piskevalee-cpu/OpenSync">
    <img src="Art/opensync.png" alt="OpenSync" width="420">
  </a>

  <p align="center">
    Self-hosted LAN platform for uploading/downloading offline games with differential save sync.
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
      <a href="#what-is-opensync">What is OpenSync?</a>
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
        <li><a href="#opensync-cli">The `opensync` CLI</a></li>
      </ul>
    </li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

<!-- WHAT IS OPENSYNC -->
## What is OpenSync?

OpenSync is a self-hosted platform for archiving offline games and sharing them with anyone on your local network. Its core feature is **differential save sync**: when games come from unofficial sources, there's usually no server tracking your progress, so deleting and redownloading a game means starting from scratch. OpenSync solves this by letting you sync your save data to your account whenever you upload or download a game.

Save syncing is scoped per user, so if multiple people share the same library over LAN, each person syncs their own progress without visibility into anyone else's. When downloading a game, you choose between a fresh install or your saved progress merged in — similar in spirit to Steam Cloud, but self-hosted and game-agnostic.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## How it Works

Games are uploaded as live folders, and every download is a **streaming zip reconstructed on the fly**, so a 60 GB game never has to be fully re-read or re-uploaded by the server.

The core of the system is **differential save sync**: the server keeps a clean manifest per game, each user has a separate save overlay, and downloads merge *clean files + overlay − deletions*. Sync your save folder once, and any device on the LAN logged into your OpenSync account can pull the merged game in seconds.

Key features:

* **Chunked, resumable uploads** — 4 MB chunks that survive browser refreshes and network drops
* **Differential save sync** — client-side hashing against the clean manifest; only changed files travel
* **Streaming zip downloads** — clean-only (`?fresh=1`) or merged with your overlay
* **Auth & social** — open registration (first user = admin), Admin/User roles, comments with threaded replies and @mentions, notifications
* **SQLite metadata** — `node:sqlite`, zero external services or config
* **Minimal footprint** — no dependencies beyond Express and archiver; vanilla JS SPA frontend

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

* [![Node][Node.js]][Node-url]
* [![Express][Express.js]][Express-url]
* ![SQLite](https://shieldcn.dev/badge/SQLite.svg?variant=branded&brand=sqlite)
* ![Claude badge](https://shieldcn.dev/badge/Built%20with%20Claude.svg?variant=branded&brand=claude)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- GETTING STARTED -->
## Getting Started

### Prerequisites

* **Node.js 22+**
* npm

### Installation

1. Clone the repo
   ```sh
   git clone https://github.com/piskevalee-cpu/OpenSync.git
   cd OpenSync
   ```
2. Install npm packages
   ```sh
   npm install
   ```
3. Initialize storage + database
   ```sh
   npm run db:init
   ```
4. Run it
   ```sh
   npm start        # production
   npm run dev      # development (auto-restart)
   ```
5. Open `http://<host>:3000` and register — **the first user is the admin**.

### Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `OPENSYNC_STORAGE` | `./storage` | Data dir (games, overlays, SQLite DB, HMAC secret) |
| `OPENSYNC_SECRET` | auto-generated | Cookie-signing secret (stored in `storage/server-secret`) |

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- USAGE EXAMPLES -->
## Usage

* **Upload a game**: pick a folder (drag-and-drop / `webkitdirectory`), watch per-file progress with ETA, and resume after interruptions. The server hashes everything into a clean manifest.
* **Sync your save**: run a sync from the game page pointing at your local game folder. Hashes are computed in your browser, only the diff is uploaded, and your overlay is stored per user on the server.
* **Download**: two choices per game — *fresh install* (clean files only) or *synced game* (your overlay merged in). Zips stream directly from disk; deflate compression is opt-in via `?deflate=1..9`.

### The `opensync` CLI

The installer registers a global `opensync` command (symlink to `scripts/cli.sh`) that manages the server as its own background service — no systemd unit, Docker, or root required. Run it in any directory:

```bash
opensync            # live dashboard (fallback: one-shot status)
```

| Command | Description |
| --- | --- |
| *(no command)* | Live dashboard: service state, LAN URLs, admin status, recent log lines. Keybindings `[s]` start, `[S]` stop, `[r]` restart, `[l]` logs, `[q]` quit. Falls back to a one-shot `status` when stdin/stdout aren't TTYs (pipeline-safe). |
| `start` | Starts the server in the background. Log goes to `storage/opensync.log`, waits ~20s for the server to answer `GET /api/health`. |
| `stop` | Stops the server (SIGTERM, then SIGKILL after ~5s if needed), removes the pid file. |
| `restart` | `stop` + `start`. |
| `status` | One-shot status report — pipeline-friendly. |
| `logs` | Tails the server log (`tail -F`). |
| `update` | `git pull --ff-only` + `npm install`, then restarts the service only if it was running. |
| `uninstall` | Stops the server, removes the `opensync` command itself (sudo prompt if needed), and asks whether to also delete all your data in `OPENSYNC_STORAGE`. |

The CLI is a self-managed **PID-file service**: state lives in `storage/opensync.pid` (pid on the first line, port on the second). A service counts as *active* only when the process is alive **and** `GET /api/health` on `127.0.0.1:<port>` returns `{"ok":true}`.

Env overrides: `OPENSYNC_DIR` (repo root, defaults to the dir the command lives in), `OPENSYNC_STORAGE` (data dir), `PORT` (default `3000`).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ROADMAP -->
## Roadmap

- [x] Upload & storage with per-file hash manifests
- [x] Auth, roles, comments, notifications
- [x] Differential save sync (per-user overlays)
- [ ] Remote (non-LAN) sync/relay mode
- [ ] Rate limiting + admin throttling controls
- [ ] Docker image
- [ ] Mobile-friendly sync flow

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

* [Choose an Open Source License](https://choosealicense.com)
* [Img Shields](https://shields.io)
* [archiver](https://www.archiverjs.com/)
* [Inter font by Google Fonts](https://fonts.google.com/specimen/Inter)
* [opencode](https://opencode.ai) and Claude Code — this project was mainly developed with these tools

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
[Node.js]: https://img.shields.io/badge/node.js-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white
[Node-url]: https://nodejs.org/
[Express.js]: https://img.shields.io/badge/express-000000?style=for-the-badge&logo=express&logoColor=white
[Express-url]: https://expressjs.com/
[SQLite]: https://img.shields.io/badge/sqlite-003B57?style=for-the-badge&logo=sqlite&logoColor=white
[SQLite-url]: https://www.sqlite.org/
