import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { USERS_ROOT } from './config.js';
import { getDb } from './db.js';

export async function gcOrphanedData() {
  let entries;
  try {
    entries = await readdir(USERS_ROOT, { withFileTypes: true });
  } catch {
    return { userDirs: 0, gameOverlayDirs: 0 };
  }
  const database = getDb();
  const userIds = new Set(database.prepare('SELECT id FROM users').all().map((r) => String(r.id)));
  const gameIds = new Set(database.prepare('SELECT id FROM games').all().map((r) => String(r.id)));
  let userDirs = 0;
  let gameOverlayDirs = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue;
    const userPath = path.join(USERS_ROOT, entry.name);
    if (!userIds.has(entry.name)) {
      try {
        await rm(userPath, { recursive: true, force: true });
        userDirs++;
      } catch (err) {
        console.error(`[opensync] gc: failed to remove orphan user dir ${entry.name}:`, err);
      }
      continue;
    }
    let gameDirs;
    try {
      gameDirs = await readdir(path.join(userPath, 'games'), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const g of gameDirs) {
      if (!/^\d+$/.test(g.name) || !g.isDirectory() || gameIds.has(g.name)) continue;
      try {
        await rm(path.join(userPath, 'games', g.name), { recursive: true, force: true });
        gameOverlayDirs++;
      } catch (err) {
        console.error(`[opensync] gc: failed to remove orphan overlay dir ${entry.name}/${g.name}:`, err);
      }
    }
  }
  return { userDirs, gameOverlayDirs };
}
