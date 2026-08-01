import { createHmac, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { COOKIE_NAME, SECRET, SECRET_PATH, SESSION_TTL } from './config.js';
import { getDb } from './db.js';
import { ROLES } from './config.js';

let secret = SECRET;

function getSecret() {
  if (secret) return secret;
  try {
    secret = readFileSync(SECRET_PATH, 'utf8').trim();
  } catch {
    secret = randomBytes(32).toString('hex');
    writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  }
  return secret;
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

export function signSession(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', getSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', getSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!payload.uid || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
  if (payload.exp < Date.now()) return null;
  return payload;
}

export function createSessionCookie(user) {
  const token = signSession({ uid: user.id, sv: user.session_version ?? 0, exp: Date.now() + SESSION_TTL });
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const N = 16384;
  const key = scryptSync(password, salt, 32, { N, r: 8, p: 1 });
  return `scrypt$${N}$${key.toString('base64')}$${salt.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  try {
    const [, N, keyB64, saltB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const key = Buffer.from(keyB64, 'base64');
    const candidate = scryptSync(password, salt, key.length, { N: Number(N), r: 8, p: 1 });
    return timingSafeEqual(candidate, key);
  } catch {
    return false;
  }
}

export function streamHash(readable, algo = 'sha256') {
  return new Promise((resolve, reject) => {
    const hash = createHash(algo);
    readable.on('data', (c) => hash.update(c));
    readable.on('end', () => resolve(hash.digest('hex')));
    readable.on('error', reject);
  });
}

export function hashBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function attachUser(req, _res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const payload = verifySession(cookies[COOKIE_NAME]);
  if (payload) {
    const database = getDb();
    const user = database.prepare('SELECT id, username, role, created_at, session_version FROM users WHERE id = ?').get(payload.uid);
    if (user && (user.session_version ?? 0) === (payload.sv ?? 0)) req.user = user;
  }
  next();
}

/** Invalidate every existing session for a user (stateless cookie logout). */
export function revokeSessions(userId) {
  getDb()
    .prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?')
    .run(userId);
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'authentication required' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'authentication required' });
  if (req.user.role !== ROLES.ADMIN) return res.status(403).json({ error: 'admin only' });
  next();
}
