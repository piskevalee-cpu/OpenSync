import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { createGame, headers, register, startServer } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

let admin;
let userA;
let userB;
let game;

test('security: setup admin, users, game, comments', async () => {
  admin = await register(srv.base, 'sec_admin');
  userA = await register(srv.base, 'sec_user_a');
  userB = await register(srv.base, 'sec_user_b');
  game = await createGame(srv.base, admin.cookie, 'SecGame', [{ path: 'main.bin', data: 'payload' }]);
  assert.ok(game.id);
});

test('security: admin routes reject regular users (403) and anonymous (401)', async () => {
  const anon = {};
  const routes = [
    ['GET', '/api/admin/stats'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/bench'],
    ['POST', '/api/admin/users'],
    ['PATCH', '/api/admin/users/1/role'],
    ['DELETE', '/api/admin/users/1'],
  ];
  for (const [method, path] of routes) {
    const asUser = await fetch(`${srv.base}${path}`, { method, headers: headers(userA.cookie) });
    assert.equal(asUser.status, 403, `${method} ${path} should 403 for a regular user`);
    const anonRes = await fetch(`${srv.base}${path}`, { method, headers: anon });
    assert.equal(anonRes.status, 401, `${method} ${path} should 401 for anonymous`);
  }
});

test('security: users list and notifications require auth', async () => {
  const users = await fetch(`${srv.base}/api/users`);
  assert.equal(users.status, 401);
  const notif = await fetch(`${srv.base}/api/notifications`);
  assert.equal(notif.status, 401);
  const notifRead = await fetch(`${srv.base}/api/notifications/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ all: true }),
  });
  assert.equal(notifRead.status, 401);
});

test('security: comment replies are scoped to the same game', async () => {
  const other = await createGame(srv.base, admin.cookie, 'SecOtherGame', [{ path: 'o.bin', data: 'o' }]);
  const r = await fetch(`${srv.base}/api/games/${other.id}/comments`, {
    method: 'POST',
    headers: { ...headers(userA.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'a reply' }),
  });
  assert.equal(r.status, 201);
  const replyId = (await r.json()).comment.id;

  const cross = await fetch(`${srv.base}/api/games/${game.id}/comments`, {
    method: 'POST',
    headers: { ...headers(userA.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'cross-game reply', parent_id: replyId }),
  });
  assert.equal(cross.status, 400);

  const phantom = await fetch(`${srv.base}/api/games/${game.id}/comments`, {
    method: 'POST',
    headers: { ...headers(userA.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'phantom parent', parent_id: 999999 }),
  });
  assert.equal(phantom.status, 400);
});

test('security: admin can delete anyone\'s comment', async () => {
  const r = await fetch(`${srv.base}/api/games/${game.id}/comments`, {
    method: 'POST',
    headers: { ...headers(userB.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'deletable by admin' }),
  });
  const { comment } = await r.json();
  const asUser = await fetch(`${srv.base}/api/comments/${comment.id}`, { method: 'DELETE', headers: headers(userA.cookie) });
  assert.equal(asUser.status, 403);
  const asAdmin = await fetch(`${srv.base}/api/comments/${comment.id}`, { method: 'DELETE', headers: headers(admin.cookie) });
  assert.equal(asAdmin.status, 200);
});

test('security: notifications are per-user; foreign ids 404', async () => {
  const { user: adminMe } = await (await fetch(`${srv.base}/api/auth/me`, { headers: headers(admin.cookie) })).json();
  assert.equal(adminMe.role, 'admin');

  const list = await (await fetch(`${srv.base}/api/notifications`, { headers: headers(userA.cookie) })).json();
  for (const n of list.notifications) {
    const foreign = await fetch(`${srv.base}/api/notifications/read`, {
      method: 'POST',
      headers: { ...headers(userB.cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ id: n.id }),
    });
    assert.equal(foreign.status, 404, `user B must not read user A's notification ${n.id}`);
  }

  const { unread: before } = await (await fetch(`${srv.base}/api/notifications`, { headers: headers(userA.cookie) })).json();
  await fetch(`${srv.base}/api/notifications/read`, {
    method: 'POST',
    headers: { ...headers(userA.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ all: true }),
  });
  const { unread: afterClear } = await (await fetch(`${srv.base}/api/notifications`, { headers: headers(userA.cookie) })).json();
  assert.equal(afterClear, 0);
  assert.ok(before >= 0);
});

test('security: clearing notifications only removes the caller\'s rows', async () => {
  const clear = await fetch(`${srv.base}/api/notifications`, { method: 'DELETE', headers: headers(userA.cookie) });
  assert.equal(clear.status, 200);
  const aList = await (await fetch(`${srv.base}/api/notifications`, { headers: headers(userA.cookie) })).json();
  assert.equal(aList.notifications.length, 0, 'user A notifications must be gone');
  const bList = await (await fetch(`${srv.base}/api/notifications`, { headers: headers(userB.cookie) })).json();
  assert.ok(bList.notifications.length > 0, 'user B notifications must survive');
});

test('security: tampered and forged session cookies are rejected', async () => {
  const forged = 'opensync=forged-token-that-was-never-signed';
  const me = await fetch(`${srv.base}/api/auth/me`, { headers: headers(forged) });
  assert.equal(me.status, 401);

  const [name, val] = userA.cookie.split('=');
  const part = val.split('.');
  if (part.length === 2) {
    const tampered = `${name}=${part[0]}.${part[1].slice(0, -2)}xx`;
    const res = await fetch(`${srv.base}/api/auth/me`, { headers: headers(tampered) });
    assert.equal(res.status, 401);
  }
});

test('security: logout kills the session and the old cookie no longer works', async () => {
  const out = await fetch(`${srv.base}/api/auth/logout`, {
    method: 'POST',
    headers: { ...headers(userB.cookie), 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(out.status, 200);
  const after = await fetch(`${srv.base}/api/auth/me`, { headers: headers(userB.cookie) });
  assert.equal(after.status, 401);
});

test('security: sql-injection-looking usernames are handled safely', async () => {
  const evil = await fetch(`${srv.base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: "x' OR '1'='1", password: 'secret123', pfp: '' }),
  });
  assert.ok([400, 201].includes(evil.status), `must not 500 (got ${evil.status})`);

  const dup = await fetch(`${srv.base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: "X' or '1'='1", password: 'secret123', pfp: '' }),
  });
  assert.ok([400, 409].includes(dup.status), `duplicate variant must not 500 (got ${dup.status})`);
});

test('security: non-numeric ids are rejected without crashing', async () => {
  for (const path of [
    '/api/games/abc',
    '/api/games/abc/download',
    '/api/games/abc/manifest',
    '/api/games/abc/comments',
    '/api/auth/users/abc/pfp',
  ]) {
    const r = await fetch(`${srv.base}${path}`, { headers: headers(userA.cookie) });
    assert.ok([400, 404, 500].includes(r.status), `${path} -> ${r.status}`);
    assert.notEqual(r.status, 500, `${path} must not 500`);
  }
});

test('security: comment text must be a string (no object/array smuggling)', async () => {
  const r = await fetch(`${srv.base}/api/games/${game.id}/comments`, {
    method: 'POST',
    headers: { ...headers(userA.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ text: { evil: true } }),
  });
  assert.equal(r.status, 400);
});
