import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createGame, getManifest, headers, login, register, startServer } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

test('manifest generation: hash + size + path per file, correct order', async () => {
  const { cookie } = await register(srv.base, 'manifest_uploader');
  const fileA = 'alpha '.repeat(500);
  const fileB = 'beta data 123';
  const game = await createGame(srv.base, cookie, 'Manifest Game', [
    { path: 'game.exe', data: fileA },
    { path: 'sub/dir/file.dat', data: fileB },
  ]);

  const manifest = await getManifest(srv.base, cookie, game.id);
  assert.equal(manifest.files.length, 2);
  assert.deepEqual(manifest.files.map((f) => f.path), ['game.exe', 'sub/dir/file.dat']);
  const exe = manifest.files.find((f) => f.path === 'game.exe');
  assert.equal(exe.size, Buffer.byteLength(fileA));
  assert.equal(exe.hash, createHash('sha256').update(fileA).digest('hex'));
  const dat = manifest.files.find((f) => f.path === 'sub/dir/file.dat');
  assert.equal(dat.hash, createHash('sha256').update(fileB).digest('hex'));

  const status = await (await fetch(`${srv.base}/api/games/${game.id}/status`, { headers: headers(cookie) })).json();
  assert.equal(status.status, 'ready');
  assert.equal(status.total_size, Buffer.byteLength(fileA) + Buffer.byteLength(fileB));

  const onDisk = JSON.parse(await readFile(path.join(srv.dir, 'games', String(game.id), 'manifest.json'), 'utf8'));
  assert.equal(onDisk.files.length, 2);
});

test('empty folder produces ready game with empty manifest', async () => {
  const { cookie } = await register(srv.base, 'manifest_empty');
  const game = await createGame(srv.base, cookie, 'Empty', []);
  assert.equal(game.status, 'ready');
  const manifest = await getManifest(srv.base, cookie, game.id);
  assert.equal(manifest.files.length, 0);
});

test('game creation requires only a name (description/requirements optional)', async () => {
  const { cookie } = await register(srv.base, 'manifest_minimal');

  const created = await fetch(`${srv.base}/api/games`, {
    method: 'POST',
    headers: { ...headers(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Minimal Game' }),
  });
  assert.equal(created.status, 201);
  const { game } = await created.json();
  assert.equal(game.description, '');
  assert.equal(game.system_requirements, '');

  for (const body of [{}, { name: '   ' }, { name: '' }, { name: 42 }]) {
    const res = await fetch(`${srv.base}/api/games`, {
      method: 'POST',
      headers: { ...headers(cookie), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `body ${JSON.stringify(body)} must be rejected`);
  }
});
