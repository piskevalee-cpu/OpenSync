# OpenSync — Agent Instructions

## Project Overview
Self-hosted LAN platform for uploading/downloading offline games with differential save sync. Three build steps (all implemented):
1. **Upload & storage** - live folders + per-file hash manifest + SQLite metadata
2. **Auth & social** - cookie sessions, open registration, first user = admin, roles (Admin/User), comments
3. **Differential sync** - per-user overlays computed against clean manifest, client-side hashing, streaming zip reconstruction

Original product spec (Italian, planning decisions): `openhost-guide.md`.

## Stack (Verified, Do Not Rethink)
- **Node 22+ (ESM, `"type": "module"`) + Express 5**. No Go/Python.
- **SQLite via built-in `node:sqlite`** (`DatabaseSync`) — NOT better-sqlite3. `getDb()` singleton in `server/db.js`.
- **Streaming zip: archiver v8** — API changed: use `const { ZipArchive } = require('archiver')` via `createRequire`, then `new ZipArchive({...})` (NOT `archiver('zip')` and not the `Archiver` class — `_module` is only set on `ZipArchive`).
- **Passwords**: `crypto.scrypt` (`hashPassword`/`verifyPassword`). **Sessions**: HMAC-signed stateless cookies; logout works by bumping `users.session_version` (token carries `sv`).
- **Client**: Vanilla JS SPA with hash routing, no framework. **Client-side hashing via a hand-rolled streaming SHA-256** in `client/js/sha256.js` (Web Crypto has no incremental digest) — verified against node crypto vectors.
- Only runtime deps: `express`, `archiver`. Dev: `fflate` (zip unzip in tests).

## Commands
```
npm run dev        # node --watch server/index.js
npm start          # production run (PORT, HOST, OPENSYNC_STORAGE env)
npm test           # node --test tests/*.test.js (89 tests)
npm run lint       # node --check + console.log scan (scripts/lint.js)
npm run db:init    # creates storage/ dir + SQLite schema (migrations auto-apply on getDb; db:migrate is a no-op alias)
```
Env: `PORT` (default 3000), `HOST` (default 0.0.0.0), `OPENSYNC_STORAGE` (default `./storage`), `OPENSYNC_SECRET`.

## Architecture Constraints (Non-Negotiable)
- **Games stored as live folders** (`/storage/games/{game_id}/files/`) — never archives. Required for diff.
- **Manifest = JSON per game** (`/storage/games/{game_id}/manifest.json`) — `{game_id, files:[{path, hash, size}]}`.
- **SQLite only** for metadata (`users`, `games`, `downloads`, `comments`, `_migrations`).
- **Streaming zip on download** — no cached zips. Merge order: clean + overlay − deletions, sorted by path. **Compression is OFF by default (`STORE` — disk/NIC-bound, max speed)**; `?deflate=1..9` opts into deflate (any invalid value falls back to store). `res.flushHeaders()` starts the stream instantly. **`?fresh=1`** (or `?fresh=true`) streams the clean manifest ONLY — no overlay, no deletions (used by the "fresh install" choice). The game view's download button opens a mini dialog ("fresh install" vs "synced game") ONLY when the current user has a saved overlay (`has_overlay`); otherwise it downloads directly. **`GET /api/admin/bench`** (admin only) measures in-memory zip throughput (store / deflate-1 / deflate-6, 64 MB sample) — button in the admin panel, result survives the poll re-render via module-level `benchResult`.
- **Overlay storage**: `/storage/users/{user_id}/games/{game_id}/{overlay/, deletions.json, overlay_manifest.json}`
- **Diff always vs clean manifest** — never chained (prevents drift).
- **Server re-hashes every received overlay file** (`x-hash` header) — trust-but-verify; mismatch → 422 + file deleted.

## Key Implementation Details
- **Chunked upload**: fixed 4MB (`CHUNK_SIZE`), chunks MUST arrive in order — server rejects out-of-order with 409. Resume via `upload/init` (part size / chunk size). Both game files (`games.js`) and overlay files (`sync.js` via `chunked.js`) share this; keep them consistent. 0-byte files are allowed (`x-size: 0`).
- **`safeRelPath`** (`server/storage.js`) is the single gate for every client-supplied path: rejects absolute, `..`, backslash, NUL. Never bypass it.
- **Manifest generation is async**: `upload/complete` returns 202, `processGame` hashes in background; client polls `status`.
- **Path validation on deletions**: only paths present in the clean manifest are accepted as deletions. **Deletions are versioned**: `deletions.json` = `{manifest_hash, paths}` where `manifest_hash` is a sha256 fingerprint of the clean file list at sync time — if the game is re-uploaded (manifest changes), stale deletions are ignored at download time; legacy bare-array `deletions.json` is treated as stale. **Mass-deletion guard**: `sync/complete` returns 400 if deletions cover >50% of the manifest unless `force: true`; the client shows a confirmDialog (count + %) before proceeding.
- **Re-upload into a ready game**: `POST /:id/files` on a ready game marks it in a module-level `reuploadedReady` Set; `upload/complete` then flips it to `processing`, regenerates the manifest, and restores `ready` on failure. Without new uploads, `upload/complete` on a ready game still 409s ("game already processed" — `folder-upload.test.js` asserts this). The Set is process-local: after a restart, re-uploads into ready games 409 again.
- **Orphan cleanup**: `DELETE /api/auth/me` and admin `DELETE /api/admin/users/:id` both `await rm(USERS_ROOT/{uid})` (logged on failure, DB row deleted regardless). `deleteGame` also removes every user's `USERS_ROOT/{uid}/games/{gid}` overlay dir. Boot GC (`server/gc.js` `gcOrphanedData()`, fired from index.js after `getDb()`) sweeps orphan user dirs and per-user game overlay dirs (numeric-name dirs only, never throws). Covered in `tests/gc.test.js`.
- **Bootstrap admin**: first registered user gets role `admin`; last admin can't be demoted/deleted; self-demote/delete blocked (except via the new `DELETE /api/auth/me` profile self-delete, which still guards the last admin).
- **Comments**: `POST /api/games/:id/comments`, `DELETE /api/comments/:id` (comments router is mounted at `/api`). Covered in `tests/comments.test.js`.
- **Profile**: `GET /api/auth/me` returns `{ user: { id, username, role, created_at, pfp, stats: { uploaded, downloaded, synced } } }`. `POST`/`PUT /api/auth/me/pfp` (raw image body, mkdirs the user dir — users have NO storage dir until first overlay upload). `DELETE /api/auth/me` (last-admin guard, removes `USERS_ROOT/{uid}`). **Registration requires a pfp** (base64 data URL in the JSON body, jpeg/png ≤ 8 MB, magic-byte checked — `parsePfpDataUrl`). **Comments survive account deletion**: `comments.user_id` FK is `ON DELETE SET NULL` (migration v7 rebuilt the table), the author renders as `"deleted"` with no pfp (`COALESCE(u.username,'deleted')`, LEFT JOIN — both `games.js` GET and `comments.js` POST select). Migration v6 added `comments.parent_id` (recursive nested threads, any depth — Reddit-style, cascade on parent delete; server allows replying to ANY comment in the same game, client renders recursively with per-level indent + left connector, flat after depth 6) + `notifications` table (`game_added` to all other users on game creation, `comment_reply` to the parent author, `comment_mention` via `parseMentions`/`notifyMentions` in `comments.js` — matched by `username_norm`, excludes author + reply parent, one notif per unique user). `DELETE /api/notifications` clears all. Registration: username normalization via `server/usernames.js`. Covered in `tests/comments.test.js` (threads/mentions) + `tests/profile.test.js` (pfp, stats, self-delete) + `tests/auth-normalization.test.js`.
- **Username normalization**: `server/usernames.js` (`cleanUsername` = trim + NFC; `normalizeUsername` = + Unicode `toLowerCase`). Register/login/admin-create store a `username_norm` column (unique index) — so `" x "`, `X`, `x`, `U\u0308` all collapse to one account. All three code paths must use it.
- **UI**: dark theme (inspired by opencode.ai), CSS vars in `client/css/terminal.css`. Default font is **Google Inter** everywhere (`@import` from Google Fonts, `--sans`/`--mono`/`--arcade` all resolve to it), semibold 620 body / bold 730 headings & numbers. Section page titles (`> game library` etc. — `<h1 class="page-title">`) white bold 730 Inter, as are the green stat numbers (`.kpi .num` in admin, `.profile-stat .num` in profile). Nav active link is line-only (green `::after` underline with `nav-grow`, NO background box) and every route change plays `view-switch-in` on `#view` (class re-triggered in app.js `route()`). Branding: site is **OpenSync** — topbar logo is `client/img/opensync.png` (56px, also on auth screen 360px `.auth-logo`); tab favicon is `client/img/opensync-squares.png`. System requirements use a fixed optional template (`client/js/reqfields.js` — labeled OS/CPU/RAM/GPU/Storage + notes, stored as `Label: value` lines). Upload view (`client/js/views/upload.js`) shows live per-file + overall progress with bytes/s + ETA; manifest hashing progress (`server/manifest.js` in-memory tracker, exposed via `GET /games/:id/status.progress`, polled by `renderProcessing`).
- **Persistent uploads**: `views/upload.js` keeps a module-level `session` (active upload) + caches the view DOM (`viewRoot`) so the upload continues in the background and the upload form/progress survive navigation. `renderUploadBar(host)` renders a global bar into `#uploadbar` (index.html, between topbar and #view) on every route — but app.js hides it on the `#/upload` view (it has its own progress panel); cancel = abort + `api.games.remove`. Form values are only read via `name.querySelector('input').value` (wrappers are `div.field`, never have `.value`/`.files`).
- **Profile** (`client/js/views/profile.js`, route `#/profile`): stats grid (uploaded/downloaded/synced), pfp upload via `api.auth.uploadPfp`, account delete via `api.auth.deleteAccount` (confirmDialog first). Topbar shows a small pfp + logout is confirm-gated (`onLogout` uses `confirmDialog`, then `navigate('#/login')`). After pfp save, re-render topbar via `navigate('#/profile')`.
- **Admin view** (`client/js/views/admin.js`): auto-refreshes every 8s while on `#/admin` — polls stats+users, re-renders ONLY on data change (pfp/comment/download activity), preserves create-user input, self-clears the interval when leaving the route. User cells (pfp + @name + badge) use `.cell-user` flex. `POST /api/auth/login` returns `pfp` (topbar needs it immediately).
- **Topbar hidden on `#/login`** via `style.display` (the `hidden` attribute is defeated by `.topbar { display:flex }`). Comment inputs have an **@ mention picker** (`attachMentionPicker` in `game.js`): on `@` it lists LAN users (`/api/users`, cached) in a `.mention-drop` panel, ArrowUp/Down + Enter picks (Enter also `stopImmediatePropagation` so the form's own Enter handler doesn't race), Esc/blur closes.

## Testing Gotchas
- **`node:sqlite` + dynamic imports are process-cached**: the storage dir + DB are fixed at first import per process. Tests boot ONE shared server per test file (`tests/helpers.js` `startServer()` memoizes). Within a file: unique usernames, use returned `game.id` (never hardcode 1), and the first registered user in a file is the admin.
- Test files run in separate processes, so clean-DB tests (bootstrap admin, last-admin guard) live in their own file `tests/bootstrap.test.js`.

## Test Priorities (all covered in `tests/`)
1. Manifest generation accuracy (`manifest.test.js`)
2. Chunked upload resume + reconstruction (`upload.test.js`)
3. Overlay diff logic + hash validation (`overlay.test.js`)
4. Streaming zip reconstruction clean+overlay+deletions (`zip.test.js`)
5. Auth: bootstrap admin, roles, session persistence (`auth.test.js`, `bootstrap.test.js`); username normalization paths — register/login/admin-create all collapse `" x "`/`X`/`U\u0308` to one account (`auth-normalization.test.js`)
6. Streaming SHA-256 client lib vs node crypto (`sha256.test.js`)
7. Download modes + zip structure (`download.test.js`): STORE default, deflate opt-in + fallback, content fidelity, concurrency, 404s, empty games, admin bench.
8. Client folder-upload flow — webkitdirectory selection, chunked resume, reconstruction (`folder-upload.test.js`)
9. Security hardening (`security.test.js`): admin routes 403/401, auth-gated endpoints, cross-game comment parents (400), foreign notification ids (404), clear-scoping, forged/tampered cookies (401), logout invalidation, SQL-injection-ish usernames, non-numeric ids never 500, non-string comment bodies (400).
