import { Router } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDb, now } from '../db.js';
import { ROLES, USERS_ROOT } from '../config.js';
import { clearSessionCookie, createSessionCookie, hashPassword, requireAuth, revokeSessions, verifyPassword } from '../security.js';
import { userPfpPath } from '../storage.js';
import { cleanUsername, normalizeUsername } from '../usernames.js';

export const authRouter = Router();

const MAX_PFP = 8 * 1024 * 1024;

function parsePfpDataUrl(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0 || buf.length > MAX_PFP) return null;
  const pngMagic = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpgMagic = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (m[1] === 'image/png' && !pngMagic) return null;
  if (m[1] === 'image/jpeg' && !jpgMagic) return null;
  return { buf, isPng: m[1] === 'image/png' };
}

async function setPfp(req, res) {
  const database = getDb();
  const contentType = req.headers['content-type'];
  if (contentType !== 'image/jpeg' && contentType !== 'image/png') {
    return res.status(400).json({ error: 'pfp must be image/jpeg or image/png' });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_PFP) return res.status(413).json({ error: 'pfp too large (max 8 MB)' });
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  const isPng = contentType === 'image/png';
  const file = userPfpPath(req.user.id).replace(/\.(jpg|png)$/, isPng ? '.png' : '.jpg');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buf);
  database.prepare('UPDATE users SET pfp = ? WHERE id = ?').run('/api/auth/me/pfp', req.user.id);
  res.json({ ok: true, pfp: '/api/auth/me/pfp' });
}

authRouter.post('/register', async (req, res) => {
  const database = getDb();
  const { username, password, pfp } = req.body || {};
  const cleaned = cleanUsername(username);
  if (!cleaned) {
    return res.status(400).json({ error: 'username is required' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  const norm = normalizeUsername(cleaned);
  const existing = database.prepare('SELECT 1 FROM users WHERE username_norm = ?').get(norm);
  if (existing) return res.status(409).json({ error: 'username already taken' });
  const parsed = parsePfpDataUrl(pfp);
  if (!parsed) {
    return res.status(400).json({ error: 'profile picture is required (jpeg or png, max 8 MB)' });
  }

  const count = database.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const role = count === 0 ? ROLES.ADMIN : ROLES.USER;
  let info;
  try {
    info = database
      .prepare('INSERT INTO users (username, username_norm, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(cleaned, norm, hashPassword(password), role, now());
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) return res.status(409).json({ error: 'username already taken' });
    throw err;
  }
  try {
    const file = userPfpPath(info.lastInsertRowid).replace(/\.(jpg|png)$/, parsed.isPng ? '.png' : '.jpg');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, parsed.buf);
    database.prepare('UPDATE users SET pfp = ? WHERE id = ?').run('/api/auth/me/pfp', info.lastInsertRowid);
  } catch (err) {
    database.prepare('DELETE FROM users WHERE id = ?').run(info.lastInsertRowid);
    throw err;
  }
  const user = database.prepare('SELECT id, username, role, created_at, pfp, session_version FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.setHeader('Set-Cookie', createSessionCookie(user));
  res.status(201).json({ user });
});

authRouter.post('/login', (req, res) => {
  const database = getDb();
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username and password required' });
  }
  const user = database.prepare('SELECT * FROM users WHERE username_norm = ?').get(normalizeUsername(username) || '');
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid username or password' });
  }
  const safe = { id: user.id, username: user.username, role: user.role, created_at: user.created_at, pfp: user.pfp, session_version: user.session_version };
  res.setHeader('Set-Cookie', createSessionCookie(user));
  res.json({ user: safe });
});

authRouter.post('/logout', (req, res) => {
  if (req.user) revokeSessions(req.user.id);
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not authenticated' });
  const database = getDb();
  const row = database.prepare('SELECT id, username, role, created_at, pfp, session_version FROM users WHERE id = ?').get(req.user.id);
  const stats = {
    uploaded: database.prepare('SELECT COUNT(*) AS n FROM games WHERE uploaded_by = ?').get(req.user.id).n,
    downloaded: database.prepare('SELECT COUNT(*) AS n FROM downloads WHERE user_id = ?').get(req.user.id).n,
    synced: database.prepare('SELECT COUNT(DISTINCT game_id) AS n FROM syncs WHERE user_id = ?').get(req.user.id).n,
  };
  res.json({ user: { id: row.id, username: row.username, role: row.role, created_at: row.created_at, pfp: row.pfp, stats } });
});

authRouter.post('/me/pfp', requireAuth, async (req, res, next) => {
  try {
    await setPfp(req, res);
  } catch (err) {
    next(err);
  }
});

authRouter.put('/me/pfp', requireAuth, async (req, res, next) => {
  try {
    await setPfp(req, res);
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me/pfp', (req, res) => {
  const id = req.user?.id;
  let file = id ? userPfpPath(id) : '';
  if (file && !existsSync(file)) {
    const png = file.replace(/\.(jpg|png)$/, '.png');
    file = existsSync(png) ? png : file;
  }
  if (!file || !existsSync(file)) return res.status(404).end();
  res.type(path.extname(file) === '.png' ? 'image/png' : 'image/jpeg');
  createReadStream(file).pipe(res);
});

authRouter.get('/users/:id/pfp', (req, res) => {
  let file = userPfpPath(req.params.id);
  if (file && !existsSync(file)) {
    const png = file.replace(/\.(jpg|png)$/, '.png');
    file = existsSync(png) ? png : file;
  }
  if (!file || !existsSync(file)) return res.status(404).end();
  res.type(path.extname(file) === '.png' ? 'image/png' : 'image/jpeg');
  createReadStream(file).pipe(res);
});

authRouter.delete('/me', requireAuth, async (req, res, next) => {
  try {
    const database = getDb();
    if (req.user.role === 'admin') {
      const admins = database.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
      if (admins <= 1) return res.status(400).json({ error: 'cannot delete the last admin' });
    }
    try {
      await rm(path.join(USERS_ROOT, String(req.user.id)), { recursive: true, force: true });
    } catch (err) {
      console.error(`[opensync] failed to remove user dir for ${req.user.id}:`, err);
    }
    database.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
