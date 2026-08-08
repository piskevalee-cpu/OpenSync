import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { createGame, headers, register, startServer, syncComplete, uploadOverlayFile } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

function unzip(buf) {
  const files = unzipSync(new Uint8Array(buf));
  const out = {};
  for (const [name, data] of Object.entries(files)) out[name] = strFromU8(data);
  return out;
}

test('clean download zips the live folder with original structure', async () => {
  const { cookie } = await register(srv.base, 'zip_clean');
  const game = await createGame(srv.base, cookie, 'ZipGame', [
    { path: 'root.txt', data: 'root content' },
    { path: 'sub/nested.txt', data: 'nested content' },
  ]);

  const res = await fetch(`${srv.base}/api/games/${game.id}/download`, { headers: headers(cookie) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /attachment; filename=".+\.zip"/);
  const files = unzip(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), ['root.txt', 'sub/nested.txt']);
  assert.equal(files['root.txt'], 'root content');
  assert.equal(files['sub/nested.txt'], 'nested content');
});

test('user with overlay gets reconstructed zip: clean + overlay - deletions', async () => {
  const { cookie } = await register(srv.base, 'zip_merge');
  const game = await createGame(srv.base, cookie, 'Merge', [
    { path: 'clean.bin', data: 'clean bytes' },
    { path: 'overridden.bin', data: 'old version' },
    { path: 'deleted.bin', data: 'remove me' },
  ]);

  const changed = Buffer.from('new version by user');
  await uploadOverlayFile(srv.base, cookie, game.id, 'overridden.bin', changed, createHash('sha256').update(changed).digest('hex'));
  const extra = Buffer.from('user created file');
  await uploadOverlayFile(srv.base, cookie, game.id, 'extra.bin', extra, createHash('sha256').update(extra).digest('hex'));
  await syncComplete(srv.base, cookie, game.id, ['deleted.bin']);

  const res = await fetch(`${srv.base}/api/games/${game.id}/download`, { headers: headers(cookie) });
  const files = unzip(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), ['clean.bin', 'extra.bin', 'overridden.bin']);
  assert.equal(files['clean.bin'], 'clean bytes');
  assert.equal(files['overridden.bin'], 'new version by user');
  assert.equal(files['extra.bin'], 'user created file');
});

test('different users get independent reconstructions', async () => {
  const a = await register(srv.base, 'zip_user_a');
  const b = await register(srv.base, 'zip_user_b');
  const game = await createGame(srv.base, a.cookie, 'Isolation', [{ path: 's.bin', data: 'base' }]);

  await uploadOverlayFile(srv.base, a.cookie, game.id, 's.bin', 'A version', createHash('sha256').update('A version').digest('hex'));
  await syncComplete(srv.base, a.cookie, game.id, []);

  const za = unzip(Buffer.from(await (await fetch(`${srv.base}/api/games/${game.id}/download`, { headers: headers(a.cookie) })).arrayBuffer()));
  const zb = unzip(Buffer.from(await (await fetch(`${srv.base}/api/games/${game.id}/download`, { headers: headers(b.cookie) })).arrayBuffer()));
  assert.equal(za['s.bin'], 'A version');
  assert.equal(zb['s.bin'], 'base');
});

test('download is logged and counted', async () => {
  const { cookie } = await register(srv.base, 'zip_counted');
  const game = await createGame(srv.base, cookie, 'Counted', [{ path: 'a.txt', data: 'x' }]);
  await fetch(`${srv.base}/api/games/${game.id}/download`, { headers: headers(cookie) });
  await fetch(`${srv.base}/api/games/${game.id}/download`, { headers: headers(cookie) });

  const list = await (await fetch(`${srv.base}/api/games`, { headers: headers(cookie) })).json();
  assert.equal(list.games[0].download_count, 2);
});

test('unauthenticated download is rejected', async () => {
  const res = await fetch(`${srv.base}/api/games/999999/download`);
  assert.equal(res.status, 401);
});

test('stale deletions are ignored after manifest change (re-upload)', async () => {
  const { cookie } = await register(srv.base, 'zip_stale');
  const game = await createGame(srv.base, cookie, 'StaleDel', [
    { path: 'a.txt', data: 'v1' },
    { path: 'keep.txt', data: 'keep' },
  ]);

  const done = await syncComplete(srv.base, cookie, game.id, ['a.txt']);
  assert.equal(done.status, 200);

  const before = unzip(Buffer.from(await (await fetch(`${srv.base}/api/games/${game.id}/download`, { headers: headers(cookie) })).arrayBuffer()));
  assert.equal(before['a.txt'], undefined);
  assert.equal(before['keep.txt'], 'keep');

  const buf = Buffer.from('v2');
  const up = await fetch(`${srv.base}/api/games/${game.id}/files`, {
    method: 'POST',
    headers: { ...headers(cookie), 'x-path': encodeURIComponent('a.txt'), 'x-index': '0', 'x-total': '1', 'x-size': String(buf.length) },
    body: new Uint8Array(buf),
  });
  assert.equal(up.status, 200, await up.text());

  const comp = await fetch(`${srv.base}/api/games/${game.id}/upload/complete`, { method: 'POST', headers: headers(cookie) });
  assert.equal(comp.status, 202, await comp.text());

  for (let i = 0; i < 100; i++) {
    const st = await (await fetch(`${srv.base}/api/games/${game.id}/status`, { headers: headers(cookie) })).json();
    if (st.status === 'ready') break;
    await new Promise((r) => setTimeout(r, 20));
  }

  const after = unzip(Buffer.from(await (await fetch(`${srv.base}/api/games/${game.id}/download`, { headers: headers(cookie) })).arrayBuffer()));
  assert.equal(after['a.txt'], 'v2');
  assert.equal(after['keep.txt'], 'keep');
});

test('legacy array deletions.json is treated as stale', async () => {
  const { cookie, user } = await register(srv.base, 'zip_legacy');
  const game = await createGame(srv.base, cookie, 'LegacyDel', [
    { path: 'a.txt', data: 'v1' },
    { path: 'keep.txt', data: 'keep' },
  ]);

  const changed = Buffer.from('changed by user');
  await uploadOverlayFile(srv.base, cookie, game.id, 'a.txt', changed, createHash('sha256').update(changed).digest('hex'));
  const done = await syncComplete(srv.base, cookie, game.id, ['a.txt']);
  assert.equal(done.status, 200);

  const delsPath = path.join(srv.dir, 'users', String(user.id), 'games', String(game.id), 'deletions.json');
  await writeFile(delsPath, JSON.stringify(['a.txt']));

  const files = unzip(Buffer.from(await (await fetch(`${srv.base}/api/games/${game.id}/download`, { headers: headers(cookie) })).arrayBuffer()));
  assert.equal(files['a.txt'], 'changed by user');
  assert.equal(files['keep.txt'], 'keep');
});
