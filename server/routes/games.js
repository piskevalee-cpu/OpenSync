import { Router } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CHUNK_SIZE } from '../config.js';
import { getDb, now, uniqueSlug } from '../db.js';
import { deleteGame, ensureGameDirs, getManifestProgress, processGame } from '../manifest.js';
import { loadOverlayInfo } from '../overlay.js';
import { requireAuth } from '../security.js';
import { gameCoverPath, gameFilesDir, gameUploadsDir, safeRelPath } from '../storage.js';

export const gamesRouter = Router();

gamesRouter.use(requireAuth);

const MAX_COVER = 8 * 1024 * 1024;
const AUTO_COMPLETE_DELAY = 2000;
const pendingAutoComplete = new Map();
const reuploadedReady = new Set();

function toPublicGame(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    cover: row.cover,
    description: row.description,
    system_requirements: row.system_requirements,
    status: row.status,
    total_size: row.total_size,
    uploaded_by: row.uploaded_by,
    uploader_name: row.uploader_name,
    uploader_pfp: row.uploader_pfp,
    created_at: row.created_at,
    download_count: row.download_count,
  };
}

const GAME_SELECT = `
  SELECT g.*, u.username AS uploader_name,
    CASE WHEN u.pfp IS NOT NULL THEN '/api/auth/users/' || u.id || '/pfp'
         WHEN u.id IS NOT NULL THEN '/img/blankpfp.jpg' END AS uploader_pfp,
    (SELECT COUNT(*) FROM downloads d WHERE d.game_id = g.id) AS download_count
  FROM games g LEFT JOIN users u ON u.id = g.uploaded_by
`;

function canManage(game, user) {
  return user.role === 'admin' || game.uploaded_by === user.id;
}

function getGame(id) {
  const row = getDb().prepare(`${GAME_SELECT} WHERE g.id = ?`).get(id);
  return row ? toPublicGame(row) : null;
}

gamesRouter.get('/', (req, res) => {
  const rows = getDb().prepare(`${GAME_SELECT} ORDER BY g.created_at DESC`).all();
  res.json({ games: rows.map(toPublicGame) });
});

gamesRouter.get('/:id', async (req, res, next) => {
  try {
    const game = getGame(req.params.id);
    if (!game) return res.status(404).json({ error: 'game not found' });
    const comments = getDb()
      .prepare(
        `SELECT c.id, c.text, c.created_at, c.user_id, c.parent_id,
          COALESCE(u.username, 'deleted') AS author,
          CASE WHEN c.user_id IS NOT NULL AND u.pfp IS NOT NULL THEN '/api/auth/users/' || u.id || '/pfp'
               WHEN c.user_id IS NOT NULL THEN '/img/blankpfp.jpg' END AS author_pfp
         FROM comments c LEFT JOIN users u ON u.id = c.user_id
         WHERE c.game_id = ? ORDER BY c.created_at ASC`,
      )
      .all(req.params.id);
    const overlay = await loadOverlayInfo(req.user.id, req.params.id);
    res.json({ game, comments, overlay });
  } catch (err) {
    next(err);
  }
});

gamesRouter.post('/', async (req, res, next) => {
  try {
    const { name, description = '', system_requirements = '' } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const database = getDb();
    const info = database
      .prepare(
        `INSERT INTO games (name, slug, description, system_requirements, status, uploaded_by, created_at, last_activity_at)
         VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)`,
      )
      .run(name.trim(), uniqueSlug(name), String(description).slice(0, 10000), String(system_requirements).slice(0, 5000), req.user.id, now(), now());
    await ensureGameDirs(info.lastInsertRowid);
    database
      .prepare(
        `INSERT INTO notifications (user_id, type, title, body, link, created_at)
         SELECT u.id, 'game_added', ?, ?, ?, ?
         FROM users u WHERE u.id != ?`,
      )
      .run(`new game: ${name.trim()}`, 'a new game was added to the library', `#/game/${info.lastInsertRowid}`, now(), req.user.id);
    res.status(201).json({ game: getGame(info.lastInsertRowid) });
  } catch (err) {
    next(err);
  }
});

gamesRouter.post('/:id/cover', async (req, res, next) => {
  try {
    const database = getDb();
    const game = database.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
    if (!game) return res.status(404).json({ error: 'game not found' });
    if (!canManage(game, req.user)) return res.status(403).json({ error: 'not allowed' });
    const contentType = req.headers['content-type'];
    if (contentType !== 'image/jpeg' && contentType !== 'image/png') {
      return res.status(400).json({ error: 'cover must be image/jpeg or image/png' });
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_COVER) return res.status(413).json({ error: 'cover too large (max 8 MB)' });
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    const isPng = contentType === 'image/png';
    const file = gameCoverPath(game.id).replace(/\.(jpg|png)$/, isPng ? '.png' : '.jpg');
    await writeFile(file, buf);
    database.prepare('UPDATE games SET cover = ? WHERE id = ?').run(`/api/games/${game.id}/cover`, game.id);
    res.json({ ok: true, cover: `/api/games/${game.id}/cover` });
  } catch (err) {
    next(err);
  }
});

gamesRouter.get('/:id/cover', (req, res) => {
  const game = getDb().prepare('SELECT cover FROM games WHERE id = ?').get(req.params.id);
  if (!game || !game.cover) return res.status(404).end();
  let file = gameCoverPath(req.params.id);
  if (!existsSync(file)) {
    const png = file.replace(/\.(jpg|png)$/, '.png');
    file = existsSync(png) ? png : file;
  }
  if (!existsSync(file)) return res.status(404).end();
  res.type(path.extname(file) === '.png' ? 'image/png' : 'image/jpeg');
  createReadStream(file).pipe(res);
});

gamesRouter.patch('/:id', async (req, res, next) => {
  try {
    const database = getDb();
    const game = database.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
    if (!game) return res.status(404).json({ error: 'game not found' });
    if (!canManage(game, req.user)) return res.status(403).json({ error: 'not allowed' });
    const { name, description, system_requirements } = req.body || {};
    database
      .prepare('UPDATE games SET name = COALESCE(?, name), description = COALESCE(?, description), system_requirements = COALESCE(?, system_requirements) WHERE id = ?')
      .run(name ? String(name).trim() : null, typeof description === 'string' ? description.slice(0, 10000) : null, typeof system_requirements === 'string' ? system_requirements.slice(0, 5000) : null, game.id);
    res.json({ game: getGame(game.id) });
  } catch (err) {
    next(err);
  }
});

gamesRouter.delete('/:id', async (req, res, next) => {
  try {
    const database = getDb();
    const game = database.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
    if (!game) return res.status(404).json({ error: 'game not found' });
    if (!canManage(game, req.user)) return res.status(403).json({ error: 'not allowed' });
    await deleteGame(game.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

gamesRouter.get('/:id/status', (req, res) => {
  const row = getDb().prepare('SELECT status, total_size FROM games WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'game not found' });
  const progress = row.status === 'processing' ? getManifestProgress(req.params.id) : null;
  res.json({ ...row, progress });
});

// ---- chunked upload ----

async function listParts(gameId) {
  const uploads = gameUploadsDir(gameId);
  const out = [];
  try {
    const entries = await readdir(uploads, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const rel = path.relative(uploads, path.join(e.parentPath, e.name)).replaceAll(path.sep, '/');
      if (rel.endsWith('.part')) {
        const { size } = await stat(path.join(e.parentPath, e.name));
        out.push({ path: rel.slice(0, -5), received: Math.floor(size / CHUNK_SIZE) });
      }
    }
  } catch {
    /* no uploads yet */
  }
  return out;
}

gamesRouter.post('/:id/upload/init', async (req, res, next) => {
  try {
    const game = getDb().prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
    if (!game) return res.status(404).json({ error: 'game not found' });
    if (!canManage(game, req.user)) return res.status(403).json({ error: 'not allowed' });
    await ensureGameDirs(game.id);
    const files = await listParts(game.id);
    res.json({ chunkSize: CHUNK_SIZE, files });
  } catch (err) {
    next(err);
  }
});

gamesRouter.post('/:id/files', async (req, res, next) => {
  try {
    const database = getDb();
    const game = database.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
    if (!game) return res.status(404).json({ error: 'game not found' });
    if (!canManage(game, req.user)) return res.status(403).json({ error: 'not allowed' });

    const relPath = safeRelPath(decodeURIComponent(req.headers['x-path'] || ''));
    const index = Number(req.headers['x-index']);
    const total = Number(req.headers['x-total']);
    const declaredSize = Number(req.headers['x-size']);
    if (!relPath) return res.status(400).json({ error: 'invalid file path' });
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 0 || index >= total) {
      return res.status(400).json({ error: 'invalid chunk index/total' });
    }
    if (!Number.isInteger(declaredSize) || declaredSize < 0) {
      return res.status(400).json({ error: 'invalid file size' });
    }

    const partPath = path.join(gameUploadsDir(game.id), `${relPath}.part`);
    await mkdir(path.dirname(partPath), { recursive: true });

    const expectedOffset = index * CHUNK_SIZE;
    const current = existsSync(partPath) ? (await stat(partPath)).size : 0;
    if (current !== expectedOffset) {
      return res.status(409).json({ error: 'chunk out of order; re-init from upload/init', received: Math.floor(current / CHUNK_SIZE) });
    }

    const chunks = [];
    let chunkBytes = 0;
    for await (const chunk of req) {
      chunkBytes += chunk.length;
      if (chunkBytes > CHUNK_SIZE) return res.status(413).json({ error: 'chunk too large' });
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    await appendFile(partPath, buf);

    database.prepare('UPDATE games SET last_activity_at = ? WHERE id = ?').run(now(), game.id);

    const partSize = current + buf.length;
    if (index === total - 1) {
      if (partSize !== declaredSize) {
        await rm(partPath, { force: true });
        return res.status(400).json({ error: `size mismatch: got ${partSize}, expected ${declaredSize}` });
      }
      const finalPath = path.join(gameFilesDir(game.id), relPath);
      await mkdir(path.dirname(finalPath), { recursive: true });
      await rename(partPath, finalPath);

      if (game.status === 'ready') reuploadedReady.add(game.id);

      database.prepare('UPDATE games SET last_activity_at = ? WHERE id = ?').run(now(), game.id);

      const uploadsDir = gameUploadsDir(game.id);
      let autoComplete = false;
      try {
        const entries = await readdir(uploadsDir, { recursive: true, withFileTypes: true });
        autoComplete = entries.length === 0;
      } catch {
        autoComplete = true;
      }

      if (autoComplete && game.status === 'processing') {
        const existing = pendingAutoComplete.get(game.id);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(async () => {
          pendingAutoComplete.delete(game.id);
          const db = getDb();
          const currentGame = db.prepare('SELECT status FROM games WHERE id = ?').get(game.id);
          if (!currentGame || currentGame.status !== 'processing') return;
          const filesDir = gameFilesDir(game.id);
          let hasFiles = false;
          try {
            const entries = await readdir(filesDir, { withFileTypes: true });
            hasFiles = entries.some((e) => e.isFile());
          } catch {
            hasFiles = false;
          }
          if (!hasFiles) return;
          processGame(game.id).catch((err) => {
            console.error(`[opensync] auto manifest generation failed for game ${game.id}:`, err);
            getDb().prepare('UPDATE games SET status = ? WHERE id = ?').run('processing', game.id);
          });
        }, AUTO_COMPLETE_DELAY);
        pendingAutoComplete.set(game.id, timer);
      }

      return res.json({ ok: true, done: true, path: relPath, autoComplete });
    }
    res.json({ ok: true, done: false, received: Math.floor(partSize / CHUNK_SIZE) });
  } catch (err) {
    next(err);
  }
});

gamesRouter.post('/:id/upload/complete', async (req, res, next) => {
  try {
    const game = getDb().prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
    if (!game) return res.status(404).json({ error: 'game not found' });
    if (!canManage(game, req.user)) return res.status(403).json({ error: 'not allowed' });
    const wasReady = game.status === 'ready';
    if (wasReady) {
      if (!reuploadedReady.has(game.id)) return res.status(409).json({ error: 'game already processed' });
      reuploadedReady.delete(game.id);
      getDb().prepare('UPDATE games SET status = ? WHERE id = ?').run('processing', game.id);
    }
    processGame(game.id).catch((err) => {
      console.error(`[opensync] manifest generation failed for game ${game.id}:`, err);
      getDb().prepare('UPDATE games SET status = ? WHERE id = ?').run(wasReady ? 'ready' : 'processing', game.id);
    });
    res.status(202).json({ status: 'processing' });
  } catch (err) {
    next(err);
  }
});
