import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GAME_STATUS, USERS_ROOT } from './config.js';
import { getDb } from './db.js';
import { streamHash } from './security.js';
import { gameDir, gameFilesDir, gameManifestPath, gameUploadsDir, safeRelPath } from './storage.js';

/** In-memory hashing progress per game (reset on server restart). */
const manifestProgress = new Map();

export function getManifestProgress(gameId) {
  return manifestProgress.get(Number(gameId)) || null;
}

/**
 * Build a manifest from the live files directory of a game.
 * Result: { game_id, files: [{ path, hash, size }] } with POSIX paths,
 * files listed in deterministic (sorted) order.
 */
export async function generateManifest(gameId) {
  const filesDir = gameFilesDir(gameId);
  const files = [];

  manifestProgress.set(Number(gameId), { total: null, done: 0 });

  async function walk(dir, prefix) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, path.posix.join(prefix, entry.name));
      } else if (entry.isFile()) {
        const rel = safeRelPath(path.posix.join(prefix, entry.name));
        if (!rel) continue;
        const { size } = await stat(abs);
        files.push({ path: rel, hash: '', size });
      }
    }
  }

  await walk(filesDir, '');
  manifestProgress.set(Number(gameId), { total: files.length, done: 0 });

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const abs = path.join(filesDir, f.path);
    f.hash = await streamHash(createReadStream(abs));
    manifestProgress.set(Number(gameId), { total: files.length, done: i + 1 });
  }

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const manifest = { game_id: Number(gameId), files };
  await writeFile(gameManifestPath(gameId), JSON.stringify(manifest, null, 2));
  manifestProgress.delete(Number(gameId));
  return { manifest, totalSize };
}

/**
 * Cleanup stale upload part files + empty uploads dir. Call before generating manifest.
 */
export async function purgeUploads(gameId) {
  const dir = gameUploadsDir(gameId);
  await rm(dir, { recursive: true, force: true });
}

export async function processGame(gameId, { announce = () => {} } = {}) {
  const database = getDb();
  const game = database.prepare('SELECT id FROM games WHERE id = ?').get(gameId);
  if (!game) throw new Error('game not found');
  announce({ status: GAME_STATUS.PROCESSING });

  const { manifest, totalSize } = await generateManifest(gameId);
  await purgeUploads(gameId);

  database
    .prepare(`UPDATE games SET status = ?, total_size = ? WHERE id = ?`)
    .run(GAME_STATUS.READY, totalSize, gameId);

  announce({ status: GAME_STATUS.READY, total_size: totalSize });
  return manifest;
}

/**
 * Delete a game entirely (files, manifest, cover, uploads).
 */
export async function deleteGame(gameId) {
  await rm(gameDir(gameId), { recursive: true, force: true });
  getDb().prepare('DELETE FROM games WHERE id = ?').run(gameId);
  try {
    const userDirs = await readdir(USERS_ROOT, { withFileTypes: true });
    for (const entry of userDirs) {
      if (!/^\d+$/.test(entry.name) || !entry.isDirectory()) continue;
      await rm(path.join(USERS_ROOT, entry.name, 'games', String(gameId)), { recursive: true, force: true }).catch((err) =>
        console.error(`[opensync] failed to remove overlay dir for game ${gameId}, user ${entry.name}:`, err),
      );
    }
  } catch {
    // USERS_ROOT missing or unreadable — nothing to clean
  }
}

export async function ensureGameDirs(gameId) {
  await mkdir(gameFilesDir(gameId), { recursive: true });
  await mkdir(gameUploadsDir(gameId), { recursive: true });
}

export function loadManifest(gameId) {
  try {
    return JSON.parse(readFileSync(gameManifestPath(gameId), 'utf8'));
  } catch {
    return null;
  }
}
