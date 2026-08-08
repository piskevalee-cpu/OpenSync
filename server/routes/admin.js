import { Router } from 'express';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DEFAULT_PFP_URL, GAMES_ROOT, USERS_ROOT } from '../config.js';
import { getDb, now } from '../db.js';
import { requireAdmin } from '../security.js';
import { hashPassword } from '../security.js';
import { cleanUsername, MAX_USERNAME_LENGTH, normalizeUsername } from '../usernames.js';

const require = createRequire(import.meta.url);
const { ZipArchive } = require('archiver');

export const adminRouter = Router();

adminRouter.use(requireAdmin);

async function dirSize(dir) {
  let total = 0;
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (e.isFile()) {
        const { size } = await stat(path.join(e.parentPath, e.name));
        total += size;
      }
    }
  } catch {
    /* ignore */
  }
  return total;
}

adminRouter.get('/bench', async (req, res, next) => {
  try {
    const MB = 64;
    const data = Buffer.allocUnsafe(MB * 1024 * 1024);
    for (let i = 0; i < data.length; i += 4) data.writeUInt32LE((i * 2654435761) >>> 0, i);
    const run = (level) =>
      new Promise((resolve, reject) => {
        const start = process.hrtime.bigint();
        let bytes = 0;
        const archive = new ZipArchive({ zlib: { level } });
        archive.on('data', (c) => { bytes += c.length; });
        archive.on('end', () => {
          const secs = Number(process.hrtime.bigint() - start) / 1e9;
          resolve({ method: level === 0 ? 'store' : `deflate-${level}`, mbps: Math.round((MB / secs) * 10) / 10, out_mb: Math.round((bytes / 1048576) * 10) / 10 });
        });
        archive.on('error', reject);
        archive.append(data, { name: 'bench.bin' });
        archive.finalize();
      });
    res.json({ sample_mb: MB, results: await Promise.all([run(0), run(1), run(6)]) });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/stats', async (req, res, next) => {
  try {
    const database = getDb();
    const users = database.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const games = database.prepare('SELECT COUNT(*) AS n FROM games').get().n;
    const downloads = database.prepare('SELECT COUNT(*) AS n FROM downloads').get().n;
    const comments = database.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
    const storageBytes = (await dirSize(GAMES_ROOT)) + (await dirSize(USERS_ROOT));
    const recent = database
      .prepare(
        `SELECT d.created_at, g.name AS game, u.username AS user, u.pfp AS user_pfp
         FROM downloads d JOIN games g ON g.id = d.game_id JOIN users u ON u.id = d.user_id
         ORDER BY d.created_at DESC LIMIT 20`,
      )
      .all()
      .map((r) => ({ ...r, user_pfp: r.user_pfp || DEFAULT_PFP_URL }));
    res.json({ stats: { users, games, downloads, comments, storage_bytes: storageBytes, recent_downloads: recent } });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/users', (req, res) => {
  const users = getDb()
    .prepare(
      `SELECT u.id, u.username, u.role, u.created_at, u.pfp,
         (SELECT COUNT(*) FROM games g WHERE g.uploaded_by = u.id) AS games_count,
         (SELECT COUNT(*) FROM downloads d WHERE d.user_id = u.id) AS downloads_count
       FROM users u ORDER BY u.created_at ASC`,
    )
    .all()
    .map((u) => ({ ...u, pfp: u.pfp || DEFAULT_PFP_URL }));
  res.json({ users });
});

adminRouter.post('/users', (req, res) => {
  const database = getDb();
  const { username, password, role = 'user' } = req.body || {};
  if (role !== 'admin' && role !== 'user') return res.status(400).json({ error: 'role must be admin or user' });
  const cleaned = cleanUsername(username);
  if (!cleaned) {
    return res.status(400).json({ error: 'username is required' });
  }
  if (cleaned.length > MAX_USERNAME_LENGTH) {
    return res.status(400).json({ error: `username too long (max ${MAX_USERNAME_LENGTH} characters)` });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  const norm = normalizeUsername(cleaned);
  const existing = database.prepare('SELECT 1 FROM users WHERE username_norm = ?').get(norm);
  if (existing) return res.status(409).json({ error: 'username already taken' });
  let info;
  try {
    info = database
      .prepare('INSERT INTO users (username, username_norm, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(cleaned, norm, hashPassword(password), role, now());
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) return res.status(409).json({ error: 'username already taken' });
    throw err;
  }
  res.status(201).json({ user: database.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(info.lastInsertRowid) });
});

adminRouter.patch('/users/:id/role', (req, res) => {
  const database = getDb();
  const { role } = req.body || {};
  if (role !== 'admin' && role !== 'user') return res.status(400).json({ error: 'role must be admin or user' });
  const user = database.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (Number(user.id) === Number(req.user.id) && role !== 'admin') {
    return res.status(400).json({ error: 'cannot demote yourself' });
  }
  const admins = database.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  if (user.role === 'admin' && admins <= 1 && role !== 'admin') {
    return res.status(400).json({ error: 'cannot demote the last admin' });
  }
  database.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
  res.json({ ok: true, user: database.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(user.id) });
});

adminRouter.delete('/users/:id', async (req, res, next) => {
  try {
    const database = getDb();
    const user = database.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'user not found' });
    if (Number(user.id) === Number(req.user.id)) return res.status(400).json({ error: 'cannot delete yourself' });
    if (user.role === 'admin') {
      const admins = database.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
      if (admins <= 1) return res.status(400).json({ error: 'cannot delete the last admin' });
    }
    try {
      await rm(path.join(USERS_ROOT, String(user.id)), { recursive: true, force: true });
    } catch (err) {
      console.error(`[opensync] failed to remove user dir for ${user.id}:`, err);
    }
    database.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
