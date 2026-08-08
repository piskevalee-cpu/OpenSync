import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { headers, login, register, startServer } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

const ADMIN = 'root';

test('bootstrap admin: first registered user becomes admin', async () => {
  const { user } = await register(srv.base, ADMIN);
  assert.equal(user.role, 'admin');
});

test('subsequent users are normal users; admin can promote them', async () => {
  const admin = await login(srv.base, ADMIN);
  const user = await register(srv.base, 'player1');
  assert.equal(user.user.role, 'user');

  const denied = await fetch(`${srv.base}/api/admin/users`, { headers: headers(user.cookie) });
  assert.equal(denied.status, 403);

  const promoted = await fetch(`${srv.base}/api/admin/users/${user.user.id}/role`, {
    method: 'PATCH',
    headers: { ...headers(admin.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'admin' }),
  });
  assert.equal(promoted.status, 200);
  assert.equal((await promoted.json()).user.role, 'admin');
});

test('session persists across requests and logout invalidates it', async () => {
  const { cookie } = await register(srv.base, 'persist_me');
  const res1 = await fetch(`${srv.base}/api/auth/me`, { headers: headers(cookie) });
  assert.equal(res1.status, 200);
  await fetch(`${srv.base}/api/auth/logout`, { method: 'POST', headers: headers(cookie) });
  const res2 = await fetch(`${srv.base}/api/auth/me`, { headers: headers(cookie) });
  assert.equal(res2.status, 401);
});

test('login rejects bad credentials and accepts good ones', async () => {
  await register(srv.base, 'login_user', 'correct-horse');
  const bad = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'login_user', password: 'wrong' }),
  });
  assert.equal(bad.status, 401);
  const good = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'login_user', password: 'correct-horse' }),
  });
  assert.equal(good.status, 200);
  assert.equal((await good.json()).user.role, 'user');
});

test('registration validation: short password, duplicate username', async () => {
  const short = await fetch(`${srv.base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'valid_name', password: 'abc' }),
  });
  assert.equal(short.status, 400);

  await register(srv.base, 'taken_name');
  const dup = await fetch(`${srv.base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'TAKEN_NAME', password: 'secret123' }),
  });
  assert.equal(dup.status, 409);
});

test('registration: pfp is optional and the blank avatar is the default', async () => {
  const res = await fetch(`${srv.base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'no_pfp_user', password: 'secret123' }),
  });
  assert.equal(res.status, 201);
  const { user } = await res.json();
  assert.equal(user.pfp, '/img/blankpfp.jpg');
  assert.equal(existsSync(path.join(srv.dir, 'users', String(user.id))), false, 'no user storage dir is created without a pfp');

  const img = await fetch(`${srv.base}/img/blankpfp.jpg`);
  assert.equal(img.status, 200, 'default avatar asset must be served');
  assert.match(img.headers.get('content-type'), /image\/jpeg/);

  const me = await login(srv.base, 'no_pfp_user');
  assert.equal(me.user.pfp, '/img/blankpfp.jpg');

  const list = await fetch(`${srv.base}/api/users`, { headers: headers(me.cookie) });
  const listed = (await list.json()).users.find((u) => u.username === 'no_pfp_user');
  assert.equal(listed.pfp, '/img/blankpfp.jpg');
});

test('registration: explicitly provided but invalid pfp is still rejected', async () => {
  const res = await fetch(`${srv.base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bad_pfp_user', password: 'secret123', pfp: 'data:image/png;base64,%%%not-valid%%%' }),
  });
  assert.equal(res.status, 400);
});

test('protected routes require auth', async () => {
  const res = await fetch(`${srv.base}/api/games`);
  assert.equal(res.status, 401);
});

test('admin can create users and delete non-admin users', async () => {
  const admin = await login(srv.base, ADMIN);
  const created = await fetch(`${srv.base}/api/admin/users`, {
    method: 'POST',
    headers: { ...headers(admin.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'created_user', password: 'secret123' }),
  });
  assert.equal(created.status, 201);
  const id = (await created.json()).user.id;
  const del = await fetch(`${srv.base}/api/admin/users/${id}`, { method: 'DELETE', headers: headers(admin.cookie) });
  assert.equal(del.status, 200);
});

test('admin delete removes the user storage dir', async () => {
  const admin = await login(srv.base, ADMIN);
  const victim = await register(srv.base, 'dir_victim');
  const uid = victim.user.id;
  assert.equal(existsSync(path.join(srv.dir, 'users', String(uid))), true);
  const del = await fetch(`${srv.base}/api/admin/users/${uid}`, { method: 'DELETE', headers: headers(admin.cookie) });
  assert.equal(del.status, 200);
  assert.equal(existsSync(path.join(srv.dir, 'users', String(uid))), false);
});
