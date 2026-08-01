import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { headers, login, register, startServer } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

// Import lazily AFTER startServer() so they share the same storage/db/secret
// as the running server (ESM import caching would otherwise fix paths first).
const { signSession } = await import('../server/security.js');
const { getDb } = await import('../server/db.js');

const admin = await register(srv.base, 'norm_admin');
assert.equal(admin.user.role, 'admin');

async function rawRegister(body) {
  return fetch(`${srv.base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('usernames are trimmed on register and login tolerates whitespace', async () => {
  const { user } = await register(srv.base, '  padded  ');
  assert.equal(user.username, 'padded');

  const padded = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: '   PADDED   ', password: 'secret123' }),
  });
  assert.equal(padded.status, 200);

  const blank = await rawRegister({ username: '   ', password: 'secret123' });
  assert.equal(blank.status, 400);
});

test('usernames are case-insensitively unique', async () => {
  await register(srv.base, 'CaseFold');
  const dup = await rawRegister({ username: 'CASEFOLD', password: 'secret123' });
  assert.equal(dup.status, 409);
});

test('Unicode normalization: composition and non-ASCII case collapse to one user', async () => {
  await register(srv.base, 'Ünïcode');
  const composed = await rawRegister({ username: 'U\u0308n\u00efcode', password: 'secret123' });
  assert.equal(composed.status, 409, 'decomposed form must collide');
  const mixedCase = await rawRegister({ username: 'üNÏCODE', password: 'secret123' });
  assert.equal(mixedCase.status, 409, 'SQLite lower() is ASCII-only; JS case-fold must catch this');

  const login = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'u\u0308nïcode', password: 'secret123' }),
  });
  assert.equal(login.status, 200, 'login with decomposed different-case form must work');
});

test('admin createUser enforces the same uniqueness rules', async () => {
  await register(srv.base, 'café');
  const dup = await fetch(`${srv.base}/api/admin/users`, {
    method: 'POST',
    headers: { ...headers(admin.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'CAFÉ', password: 'secret123' }),
  });
  assert.equal(dup.status, 409);

  const created = await fetch(`${srv.base}/api/admin/users`, {
    method: 'POST',
    headers: { ...headers(admin.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ username: '  új felhasználó  ', password: 'secret123' }),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).user.username, 'új felhasználó');
});

test('malformed cookie value is a 401, not a 500', async () => {
  const res = await fetch(`${srv.base}/api/auth/me`, { headers: { cookie: 'ohs=%zz' } });
  assert.equal(res.status, 401);
});

test('signed non-object token is a 401, not a 500', async () => {
  const token = signSession(null);
  const res = await fetch(`${srv.base}/api/auth/me`, { headers: { cookie: `ohs=${token}` } });
  assert.equal(res.status, 401);
});

test('signed token for an unknown user is rejected', async () => {
  const token = signSession({ uid: 999999, sv: 0, exp: Date.now() + 60_000 });
  const res = await fetch(`${srv.base}/api/auth/me`, { headers: { cookie: `ohs=${token}` } });
  assert.equal(res.status, 401);
});

test('expired and tampered tokens are rejected', async () => {
  const good = signSession({ uid: admin.user.id, sv: admin.user.session_version, exp: Date.now() + 60_000 });
  const ok = await fetch(`${srv.base}/api/auth/me`, { headers: { cookie: `ohs=${good}` } });
  assert.equal(ok.status, 200);

  const expired = signSession({ uid: admin.user.id, sv: admin.user.session_version, exp: Date.now() - 1000 });
  const expRes = await fetch(`${srv.base}/api/auth/me`, { headers: { cookie: `ohs=${expired}` } });
  assert.equal(expRes.status, 401);

  const tampered = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
  const tamRes = await fetch(`${srv.base}/api/auth/me`, { headers: { cookie: `ohs=${tampered}` } });
  assert.equal(tamRes.status, 401);
});

test('token with stale session_version is rejected (logout still works)', async () => {
  const oldToken = signSession({ uid: admin.user.id, sv: admin.user.session_version, exp: Date.now() + 60_000 });
  const before = await fetch(`${srv.base}/api/auth/me`, { headers: { cookie: `ohs=${oldToken}` } });
  assert.equal(before.status, 200);

  await fetch(`${srv.base}/api/auth/logout`, { method: 'POST', headers: headers(admin.cookie) });
  const after = await fetch(`${srv.base}/api/auth/me`, { headers: { cookie: `ohs=${oldToken}` } });
  assert.equal(after.status, 401);
});

test('malformed stored password hash fails login with 401, not 500', async () => {
  const db = getDb();
  db.prepare('INSERT INTO users (username, username_norm, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'badhash',
    'badhash',
    'scrypt$not-an-int$Zm9v$YmFy',
    'user',
    new Date().toISOString(),
  );
  const res = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'badhash', password: 'whatever' }),
  });
  assert.equal(res.status, 401);
});
