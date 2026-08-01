import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CHUNK, headers, register, startServer } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

// Import lazily AFTER startServer() so it shares the same storage root.
const { gameFilesDir } = await import('../server/storage.js');

const { cookie } = await register(srv.base, 'folder_uploader'); // first user in file → admin

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function pseudoBytes(n, seed) {
  const buf = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) buf[i] = (i * 31 + seed) & 0xff;
  return buf;
}

async function newGame(name) {
  const res = await fetch(`${srv.base}/api/games`, {
    method: 'POST',
    headers: { ...headers(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`create ${name}: ${res.status} ${await res.text()}`);
  return (await res.json()).game;
}

/** Upload one file chunk-by-chunk exactly like the browser client (client/js/chunker.js). */
async function uploadFile(gameId, relPath, buf) {
  const total = Math.max(1, Math.ceil(buf.length / CHUNK));
  for (let i = 0; i < total; i++) {
    const res = await fetch(`${srv.base}/api/games/${gameId}/files`, {
      method: 'POST',
      headers: {
        ...headers(cookie),
        'x-path': encodeURIComponent(relPath),
        'x-index': String(i),
        'x-total': String(total),
        'x-size': String(buf.length),
      },
      body: new Uint8Array(buf.subarray(i * CHUNK, Math.min(buf.length, (i + 1) * CHUNK))),
    });
    assert.ok(res.ok, `chunk ${i + 1}/${total} of ${relPath}: ${res.status} ${await res.text()}`);
  }
}

async function complete(gameId) {
  return fetch(`${srv.base}/api/games/${gameId}/upload/complete`, { method: 'POST', headers: headers(cookie) });
}

async function waitReady(gameId) {
  for (let i = 0; i < 100; i++) {
    const st = await (await fetch(`${srv.base}/api/games/${gameId}/status`, { headers: headers(cookie) })).json();
    if (st.status === 'ready') return st;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('game never became ready');
}

test('folder upload: realistic tree is reconstructed byte-for-byte with a correct manifest', async () => {
  const tree = [
    ['bin/Game.exe', pseudoBytes(CHUNK * 2 + 12345, 7)], // 3 chunks
    ['bin/exact.bin', pseudoBytes(CHUNK, 11)], // exactly one chunk
    ['bin/empty.cfg', Buffer.alloc(0)], // 0 bytes
    ['data/level01/world.dat', Buffer.from('world data\n')],
    ['data/level01/obj/tree.model', pseudoBytes(5000, 3)],
    ['data/save/autosave.save', Buffer.from('{"slot":1}')],
    ['Mods/My Mod v1.0! (beta).pak', pseudoBytes(300000, 5)], // spaces + special chars
    ['readme.txt', Buffer.from('OpenHost test game\n')],
  ];
  const game = await newGame('Realistic Folder');

  for (const [p, b] of tree) await uploadFile(game.id, p, b);

  assert.equal((await complete(game.id)).status, 202);
  const st = await waitReady(game.id);
  const expectedTotal = tree.reduce((sum, [, b]) => sum + b.length, 0);
  assert.equal(st.total_size, expectedTotal);

  const manifest = await (await fetch(`${srv.base}/api/games/${game.id}/manifest`, { headers: headers(cookie) })).json();
  const expected = tree
    .map(([p, b]) => ({ path: p, size: b.length, hash: sha256(b) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const got = manifest.files.map(({ path: p, size, hash }) => ({ path: p, size, hash })).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(got, expected);

  const root = gameFilesDir(game.id);
  for (const [p, b] of tree) {
    assert.deepEqual(readFileSync(path.join(root, p)), b, `on-disk bytes for ${p}`);
  }
});

test('empty (0-byte) files upload and land in the manifest', async () => {
  const game = await newGame('Empty Files');
  await uploadFile(game.id, 'dir/.keep', Buffer.alloc(0));
  await uploadFile(game.id, 'save/empty.sav', Buffer.alloc(0));

  assert.equal((await complete(game.id)).status, 202);
  const st = await waitReady(game.id);
  assert.equal(st.total_size, 0);

  const manifest = await (await fetch(`${srv.base}/api/games/${game.id}/manifest`, { headers: headers(cookie) })).json();
  assert.deepEqual(manifest.files.map((f) => [f.path, f.size]).sort(), [
    ['dir/.keep', 0],
    ['save/empty.sav', 0],
  ]);
  assert.equal(manifest.files.find((f) => f.path === 'dir/.keep').hash, sha256(Buffer.alloc(0)));
});

test('upload/init reports in-progress parts only; resume completes the folder', async () => {
  const game = await newGame('Resume Folder');
  const big = pseudoBytes(CHUNK + 100, 2);

  // chunk 0 of a 2-chunk file, then a fully finalized small file
  const c0 = await fetch(`${srv.base}/api/games/${game.id}/files`, {
    method: 'POST',
    headers: { ...headers(cookie), 'x-path': encodeURIComponent('big.bin'), 'x-index': '0', 'x-total': '2', 'x-size': String(big.length) },
    body: new Uint8Array(big.subarray(0, CHUNK)),
  });
  assert.equal(c0.status, 200);
  await uploadFile(game.id, 'small.txt', Buffer.from('done'));

  const init = await (await fetch(`${srv.base}/api/games/${game.id}/upload/init`, { method: 'POST', headers: headers(cookie) })).json();
  assert.equal(init.chunkSize, CHUNK);
  assert.deepEqual(init.files, [{ path: 'big.bin', received: 1 }]);

  const c1 = await fetch(`${srv.base}/api/games/${game.id}/files`, {
    method: 'POST',
    headers: { ...headers(cookie), 'x-path': encodeURIComponent('big.bin'), 'x-index': '1', 'x-total': '2', 'x-size': String(big.length) },
    body: new Uint8Array(big.subarray(CHUNK)),
  });
  assert.equal(c1.status, 200);

  const again = await (await fetch(`${srv.base}/api/games/${game.id}/upload/init`, { method: 'POST', headers: headers(cookie) })).json();
  assert.deepEqual(again.files, [], 'no .part files should remain after finalize');

  assert.equal((await complete(game.id)).status, 202);
  await waitReady(game.id);
  assert.deepEqual(readFileSync(path.join(gameFilesDir(game.id), 'big.bin')), big);
});

test('out-of-order chunks are rejected with 409 and a resume hint', async () => {
  const game = await newGame('Order Folder');
  const data = pseudoBytes(CHUNK + 50, 9);

  const res = await fetch(`${srv.base}/api/games/${game.id}/files`, {
    method: 'POST',
    headers: { ...headers(cookie), 'x-path': encodeURIComponent('o.bin'), 'x-index': '1', 'x-total': '2', 'x-size': String(data.length) },
    body: new Uint8Array(data.subarray(CHUNK)),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.received, 0, '409 must report how many chunks were already received');

  await uploadFile(game.id, 'o.bin', data); // correct order still works
  assert.equal(readFileSync(path.join(gameFilesDir(game.id), 'o.bin')).equals(data), true);
});

test('uploads are scoped per game (same path in two games stays isolated)', async () => {
  const a = await newGame('Isolation A');
  const b = await newGame('Isolation B');
  await uploadFile(a.id, 'config.ini', Buffer.from('AAA'));
  await uploadFile(b.id, 'config.ini', Buffer.from('BBB'));

  assert.equal(readFileSync(path.join(gameFilesDir(a.id), 'config.ini'), 'utf8'), 'AAA');
  assert.equal(readFileSync(path.join(gameFilesDir(b.id), 'config.ini'), 'utf8'), 'BBB');
});

test('a non-owner cannot upload into a game', async () => {
  const game = await newGame('Owned Folder');
  const stranger = await register(srv.base, 'folder_stranger');

  const upload = await fetch(`${srv.base}/api/games/${game.id}/files`, {
    method: 'POST',
    headers: { ...headers(stranger.cookie), 'x-path': encodeURIComponent('x.bin'), 'x-index': '0', 'x-total': '1', 'x-size': '3' },
    body: new Uint8Array(Buffer.from('abc')),
  });
  assert.equal(upload.status, 403);

  const init = await fetch(`${srv.base}/api/games/${game.id}/upload/init`, { method: 'POST', headers: headers(stranger.cookie) });
  assert.equal(init.status, 403);
});

test('upload/complete is protected against double-finalize', async () => {
  const game = await newGame('Double Complete');
  await uploadFile(game.id, 'a.txt', Buffer.from('x'));

  assert.equal((await complete(game.id)).status, 202);
  await waitReady(game.id);
  const again = await complete(game.id);
  assert.equal(again.status, 409);
});
