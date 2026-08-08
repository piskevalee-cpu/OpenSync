import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createGame, headers, register, startServer, syncComplete, uploadOverlayFile } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let adminCookie;
let adminId;
let game;

test('profile: /me stats start at zero and pfp is set from registration', async () => {
  const admin = await register(srv.base, 'pfp_admin');
  adminCookie = admin.cookie;
  adminId = admin.user.id;
  const { user } = await (await fetch(`${srv.base}/api/auth/me`, { headers: headers(adminCookie) })).json();
  assert.equal(user.pfp, `/api/auth/users/${adminId}/pfp`);
  assert.deepEqual(user.stats, { uploaded: 0, downloaded: 0, synced: 0 });
});

test('profile: uploading a game increments stats.uploaded', async () => {
  game = await createGame(srv.base, adminCookie, 'PfpGame', [{ path: 'a.bin', data: 'x' }]);
  const { user } = await (await fetch(`${srv.base}/api/auth/me`, { headers: headers(adminCookie) })).json();
  assert.equal(user.stats.uploaded, 1);
  assert.equal(user.stats.downloaded, 0);
  assert.equal(user.stats.synced, 0);
});

test('profile: downloading the game increments stats.downloaded', async () => {
  const res = await fetch(`${srv.base}/api/games/${game.id}/download`, { headers: headers(adminCookie) });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  const { user } = await (await fetch(`${srv.base}/api/auth/me`, { headers: headers(adminCookie) })).json();
  assert.equal(user.stats.downloaded, 1);
});

test('profile: syncing an overlay increments stats.synced', async () => {
  const data = 'overlay bytes';
  const hash = createHash('sha256').update(data).digest('hex');
  const r = await uploadOverlayFile(srv.base, adminCookie, game.id, 'a.bin', data, hash);
  assert.equal(r.status, 200, await r.text());
  const done = await syncComplete(srv.base, adminCookie, game.id, []);
  assert.equal(done.status, 200);
  const { user } = await (await fetch(`${srv.base}/api/auth/me`, { headers: headers(adminCookie) })).json();
  assert.equal(user.stats.synced, 1);
});

test('profile: pfp upload and retrieval', async () => {
  const posted = await fetch(`${srv.base}/api/auth/me/pfp`, {
    method: 'POST',
    headers: { ...headers(adminCookie), 'content-type': 'image/png' },
    body: new Uint8Array(PNG),
  });
  assert.equal(posted.status, 200);
  const body = await posted.json();
  assert.equal(body.ok, true);
  assert.equal(body.pfp, `/api/auth/users/${adminId}/pfp`);

  const { user } = await (await fetch(`${srv.base}/api/auth/me`, { headers: headers(adminCookie) })).json();
  assert.equal(user.pfp, `/api/auth/users/${adminId}/pfp`);

  const img = await fetch(`${srv.base}/api/auth/me/pfp`, { headers: headers(adminCookie) });
  assert.equal(img.status, 200);
  assert.ok(img.headers.get('content-type').startsWith('image/png'));

  const bad = await fetch(`${srv.base}/api/auth/me/pfp`, {
    method: 'POST',
    headers: { ...headers(adminCookie), 'content-type': 'text/plain' },
    body: 'not an image',
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'pfp must be image/jpeg or image/png');
});

test('profile: removing the pfp resets the account to the default avatar', async () => {
  const victim = await register(srv.base, 'pfp_remove_me');
  const del = await fetch(`${srv.base}/api/auth/me/pfp`, { method: 'DELETE', headers: headers(victim.cookie) });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).pfp, '/img/blankpfp.jpg');

  const { user } = await (await fetch(`${srv.base}/api/auth/me`, { headers: headers(victim.cookie) })).json();
  assert.equal(user.pfp, '/img/blankpfp.jpg');

  const file = await fetch(`${srv.base}/api/auth/me/pfp`, { headers: headers(victim.cookie) });
  assert.equal(file.status, 404, 'stored pfp file must be gone after removal');

  const list = await fetch(`${srv.base}/api/users`, { headers: headers(victim.cookie) });
  const listed = (await list.json()).users.find((u) => u.username === 'pfp_remove_me');
  assert.equal(listed.pfp, '/img/blankpfp.jpg');
});

test('profile: pfp works even when the user has no storage dir yet', async () => {
  const fresh = await register(srv.base, 'pfp_fresh');
  const posted = await fetch(`${srv.base}/api/auth/me/pfp`, {
    method: 'POST',
    headers: { ...headers(fresh.cookie), 'content-type': 'image/jpeg' },
    body: new Uint8Array(PNG),
  });
  assert.equal(posted.status, 200, await posted.text());
  const img = await fetch(`${srv.base}/api/auth/me/pfp`, { headers: headers(fresh.cookie) });
  assert.equal(img.status, 200);
});

test('profile: last admin cannot delete their account', async () => {
  const del = await fetch(`${srv.base}/api/auth/me`, { method: 'DELETE', headers: headers(adminCookie) });
  assert.equal(del.status, 400);
  assert.equal((await del.json()).error, 'cannot delete the last admin');
});

test('profile: admin can delete their account after promoting another admin', async () => {
  const second = await register(srv.base, 'pfp_admin2');
  const promoted = await fetch(`${srv.base}/api/admin/users/${second.user.id}/role`, {
    method: 'PATCH',
    headers: { ...headers(adminCookie), 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'admin' }),
  });
  assert.equal(promoted.status, 200);

  const del = await fetch(`${srv.base}/api/auth/me`, { method: 'DELETE', headers: headers(adminCookie) });
  assert.equal(del.status, 200);
  const gone = await fetch(`${srv.base}/api/auth/me`, { headers: headers(adminCookie) });
  assert.equal(gone.status, 401);
  assert.equal(existsSync(path.join(srv.dir, 'users', String(adminId))), false);
  assert.equal(existsSync(path.join(srv.dir, 'users', String(second.user.id))), true);
});

test('profile: normal user can delete their own account', async () => {
  const user = await register(srv.base, 'pfp_user');
  assert.equal(user.user.role, 'user');
  assert.equal(existsSync(path.join(srv.dir, 'users', String(user.user.id))), true);
  const del = await fetch(`${srv.base}/api/auth/me`, { method: 'DELETE', headers: headers(user.cookie) });
  assert.equal(del.status, 200);
  const gone = await fetch(`${srv.base}/api/auth/me`, { headers: headers(user.cookie) });
  assert.equal(gone.status, 401);
  assert.equal(existsSync(path.join(srv.dir, 'users', String(user.user.id))), false);
});
