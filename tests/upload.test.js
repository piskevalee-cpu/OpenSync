import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { CHUNK, createGame, headers, login, register, startServer } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

test('multi-file chunked upload reconstructs original structure', async () => {
  const { cookie } = await register(srv.base, 'upload_struct');
  const big = Buffer.from('chunky-data-'.repeat(600_000)); // ~7.8 MB → 2 chunks
  const game = await createGame(srv.base, cookie, 'Reconstruct', [
    { path: 'root.bin', data: big },
    { path: 'deep/nested/dir/asset.pak', data: 'nested file' },
  ]);

  const manifest = await (await fetch(`${srv.base}/api/games/${game.id}/manifest`, { headers: headers(cookie) })).json();
  assert.deepEqual(manifest.files.map((f) => f.path).sort(), ['deep/nested/dir/asset.pak', 'root.bin']);
  assert.equal(manifest.files.find((f) => f.path === 'root.bin').size, big.length);
});

test('chunked upload is resumable: partial part resumes from received count', async () => {
  const { cookie } = await register(srv.base, 'upload_resume');
  const data = Buffer.from('r'.repeat(CHUNK * 2 + 1000)); // 3 chunks

  const created = await fetch(`${srv.base}/api/games`, {
    method: 'POST',
    headers: { ...headers(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Resumable' }),
  });
  const { game } = await created.json();
  const { getDb } = await import('../server/db.js');
  const fresh = getDb().prepare('SELECT last_activity_at FROM games WHERE id = ?').get(game.id);
  assert.ok(fresh.last_activity_at, 'fresh game must not be immediately stale for the abandoned-upload sweeper');

  const c0 = await fetch(`${srv.base}/api/games/${game.id}/files`, {
    method: 'POST',
    headers: { ...headers(cookie), 'x-path': encodeURIComponent('big.bin'), 'x-index': '0', 'x-total': '3', 'x-size': String(data.length) },
    body: new Uint8Array(data.subarray(0, CHUNK)),
  });
  assert.equal(c0.status, 200);

  const init = await (await fetch(`${srv.base}/api/games/${game.id}/upload/init`, { method: 'POST', headers: headers(cookie) })).json();
  const part = init.files.find((f) => f.path === 'big.bin');
  assert.equal(part.received, 1);

  const dup = await fetch(`${srv.base}/api/games/${game.id}/files`, {
    method: 'POST',
    headers: { ...headers(cookie), 'x-path': encodeURIComponent('big.bin'), 'x-index': '0', 'x-total': '3', 'x-size': String(data.length) },
    body: new Uint8Array(data.subarray(0, CHUNK)),
  });
  assert.equal(dup.status, 409);

  for (const i of [1, 2]) {
    const r = await fetch(`${srv.base}/api/games/${game.id}/files`, {
      method: 'POST',
      headers: { ...headers(cookie), 'x-path': encodeURIComponent('big.bin'), 'x-index': String(i), 'x-total': '3', 'x-size': String(data.length) },
      body: new Uint8Array(data.subarray(i * CHUNK, (i + 1) * CHUNK)),
    });
    assert.equal(r.status, 200, `chunk ${i} failed`);
  }

  await fetch(`${srv.base}/api/games/${game.id}/upload/complete`, { method: 'POST', headers: headers(cookie) });
  await new Promise((r) => setTimeout(r, 250));
  const st = await (await fetch(`${srv.base}/api/games/${game.id}/status`, { headers: headers(cookie) })).json();
  assert.equal(st.status, 'ready');
  assert.equal(st.total_size, data.length);
});

test('size mismatch on final chunk rejects the file', async () => {
  const { cookie } = await register(srv.base, 'upload_mismatch');
  const created = await fetch(`${srv.base}/api/games`, {
    method: 'POST',
    headers: { ...headers(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'SizeMismatch' }),
  });
  const { game } = await created.json();
  const bad = await fetch(`${srv.base}/api/games/${game.id}/files`, {
    method: 'POST',
    headers: { ...headers(cookie), 'x-path': encodeURIComponent('f.bin'), 'x-index': '0', 'x-total': '1', 'x-size': '99999' },
    body: new Uint8Array(Buffer.from('short')),
  });
  assert.equal(bad.status, 400);
});

test('path traversal and absolute paths are rejected', async () => {
  const { cookie } = await register(srv.base, 'upload_traversal');
  const created = await fetch(`${srv.base}/api/games`, {
    method: 'POST',
    headers: { ...headers(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Traversal' }),
  });
  const { game } = await created.json();
  for (const evil of ['../escape.txt', 'a/../../escape.txt', '/etc/passwd', '..\\win.exe', '']) {
    const r = await fetch(`${srv.base}/api/games/${game.id}/files`, {
      method: 'POST',
      headers: { ...headers(cookie), 'x-path': encodeURIComponent(evil), 'x-index': '0', 'x-total': '1', 'x-size': '5' },
      body: new Uint8Array(Buffer.from('12345')),
    });
    assert.equal(r.status, 400, `path ${JSON.stringify(evil)} should be rejected`);
  }
});

test('only uploader or admin can modify a game', async () => {
  const owner = await register(srv.base, 'upload_owner');
  const stranger = await register(srv.base, 'upload_stranger');
  const admin = await login(srv.base, 'upload_struct'); // first user registered in this file = admin

  const game = await createGame(srv.base, owner.cookie, 'Owned', [{ path: 'a.txt', data: 'hi' }]);

  const patch = await fetch(`${srv.base}/api/games/${game.id}`, {
    method: 'PATCH',
    headers: { ...headers(stranger.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Hacked' }),
  });
  assert.equal(patch.status, 403);

  const ok = await fetch(`${srv.base}/api/games/${game.id}`, {
    method: 'PATCH',
    headers: { ...headers(owner.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed' }),
  });
  assert.equal(ok.status, 200);

  const del = await fetch(`${srv.base}/api/games/${game.id}`, { method: 'DELETE', headers: headers(admin.cookie) });
  assert.equal(del.status, 200);
  const gone = await fetch(`${srv.base}/api/games/${game.id}`, { headers: headers(admin.cookie) });
  assert.equal(gone.status, 404);
});
