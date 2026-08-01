import { Router } from 'express';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { CHUNK_SIZE } from '../config.js';
import { receiveChunk } from '../chunked.js';
import { getDb, now } from '../db.js';
import { loadManifest } from '../manifest.js';
import {
  clearOverlay,
  loadOverlayInfo,
  rebuildOverlayManifest,
  saveDeletions,
  validateOverlayFile,
} from '../overlay.js';
import { requireAuth } from '../security.js';
import { overlayDir, safeRelPath } from '../storage.js';

export const syncRouter = Router();

syncRouter.use(requireAuth);

async function getGameOr404(res, id) {
  const game = getDb().prepare('SELECT id, status FROM games WHERE id = ?').get(id);
  if (!game) {
    res.status(404).json({ error: 'game not found' });
    return null;
  }
  return game;
}

async function listOverlayParts(userId, gameId) {
  const root = overlayDir(userId, gameId);
  const out = [];
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const rel = path.relative(root, path.join(e.parentPath, e.name)).replaceAll(path.sep, '/');
      if (rel.endsWith('.part')) {
        const { size } = await stat(path.join(e.parentPath, e.name));
        out.push({ path: rel.slice(0, -5), received: Math.floor(size / CHUNK_SIZE) });
      }
    }
  } catch {
    /* no overlay uploads yet */
  }
  return out;
}

// Client resume state for overlay uploads.
syncRouter.get('/:id/overlay/init', async (req, res, next) => {
  try {
    if (!(await getGameOr404(res, req.params.id))) return;
    const parts = await listOverlayParts(req.user.id, req.params.id);
    res.json({ chunkSize: CHUNK_SIZE, files: parts });
  } catch (err) {
    next(err);
  }
});

// Chunk upload of an overlay file. Headers: x-path, x-index, x-total, x-size, x-hash.
syncRouter.post('/:id/overlay/files', async (req, res, next) => {
  try {
    if (!(await getGameOr404(res, req.params.id))) return;
    const relPath = safeRelPath(decodeURIComponent(req.headers['x-path'] || ''));
    if (!relPath) return res.status(400).json({ error: 'invalid file path' });
    if (relPath === 'deletions.json' || relPath === 'overlay_manifest.json') {
      return res.status(400).json({ error: 'reserved filename' });
    }
    const declaredHash = req.headers['x-hash'];
    if (typeof declaredHash !== 'string' || !/^[0-9a-f]{64}$/.test(declaredHash)) {
      return res.status(400).json({ error: 'x-hash header must be a sha256 hex digest' });
    }

    const root = overlayDir(req.user.id, req.params.id);
    const result = await receiveChunk({
      rootDir: root,
      relPath,
      index: Number(req.headers['x-index']),
      total: Number(req.headers['x-total']),
      declaredSize: Number(req.headers['x-size']),
      req,
      validate: (safePath, finalPath) => validateOverlayFile(req.user.id, req.params.id, safePath, declaredHash),
    });

    if (result.done) {
      const info = await validateOverlayFile(req.user.id, req.params.id, relPath, declaredHash);
      return res.json({ ok: true, done: true, file: info });
    }
    res.json({ ok: true, done: false, received: result.received });
  } catch (err) {
    if (err.mismatch) return res.status(err.status || 422).json({ error: 'hash mismatch', mismatch: err.mismatch });
    next(err);
  }
});

// Finalize a sync: persist deletions, re-validate all overlay files via manifest rebuild.
syncRouter.post('/:id/sync/complete', async (req, res, next) => {
  try {
    if (!(await getGameOr404(res, req.params.id))) return;
    const { deletions = [], force = false } = req.body || {};
    if (!Array.isArray(deletions)) return res.status(400).json({ error: 'deletions must be an array' });

    const clean = loadManifest(req.params.id);
    const cleanPaths = new Set((clean?.files || []).map((f) => f.path));
    const valid = [];
    for (const d of deletions) {
      const rel = safeRelPath(d);
      if (rel && cleanPaths.has(rel)) valid.push(rel);
    }

    const cleanCount = clean?.files?.length ?? 0;
    if (valid.length > Math.ceil(cleanCount / 2) && force !== true) {
      return res.status(400).json({ error: `too many deletions (${valid.length} of ${cleanCount} files); pass force: true to confirm` });
    }

    await saveDeletions(req.user.id, req.params.id, valid, clean);
    const overlayManifest = await rebuildOverlayManifest(req.user.id, req.params.id);
    getDb()
      .prepare('INSERT INTO syncs (user_id, game_id, created_at) VALUES (?, ?, ?)')
      .run(req.user.id, req.params.id, now());
    const info = await loadOverlayInfo(req.user.id, req.params.id);
    res.json({ ok: true, overlay: info, overlay_manifest: overlayManifest });
  } catch (err) {
    next(err);
  }
});

// Reset / delete my overlay for this game.
syncRouter.delete('/:id/overlay', async (req, res, next) => {
  try {
    if (!(await getGameOr404(res, req.params.id))) return;
    await clearOverlay(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

syncRouter.get('/:id/overlay', async (req, res, next) => {
  try {
    if (!(await getGameOr404(res, req.params.id))) return;
    const info = await loadOverlayInfo(req.user.id, req.params.id);
    res.json({ overlay: info });
  } catch (err) {
    next(err);
  }
});
