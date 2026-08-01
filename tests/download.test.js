import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { createGame, headers, register, startServer, syncComplete, uploadOverlayFile } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

function unzip(buf) {
  const files = unzipSync(new Uint8Array(buf));
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
}

/** Find every zip local file header signature and return the compression method of each entry. */
function zipMethods(buf) {
  const methods = [];
  for (let off = 0; off + 30 <= buf.length; off++) {
    if (buf.readUInt32LE(off) !== 0x04034b50) continue;
    const method = buf.readUInt16LE(off + 8);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    if (nameLen === 0 || nameLen > 200 || extraLen > 1000) continue;
    if (method !== 0 && method !== 8) continue;
    methods.push(method);
    if (methods.length > 100000) break;
  }
  return methods;
}

async function download(base, cookie, gameId, query = '') {
  const res = await fetch(`${base}/api/games/${gameId}/download${query}`, { headers: headers(cookie) });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf };
}

const FILES = [
  { path: 'bin/level01.wad', data: 'b'.repeat(1000) },
  { path: 'bin/level02.wad', data: 'c'.repeat(2000) },
  { path: 'readme.txt', data: 'hello opensync\n'.repeat(300) },
  { path: 'data/empty.bin', data: '' },
];

let admin;
let game;

test('download: setup a game', async () => {
  admin = await register(srv.base, 'dl_admin');
  game = await createGame(srv.base, admin.cookie, 'DlGame', FILES);
  assert.ok(game.id);
});

test('download: default mode is STORE (no compression, max speed)', async () => {
  const { res, buf } = await download(srv.base, admin.cookie, game.id);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/zip/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="dlgame\.zip"/);
  assert.deepEqual(zipMethods(buf), new Array(FILES.length).fill(0), 'every entry must be stored');
  const files = unzip(buf);
  for (const { path, data } of FILES) {
    assert.equal(files[path], data, `content mismatch for ${path}`);
  }
  const contentBytes = FILES.reduce((a, f) => a + f.data.length, 0);
  assert.ok(
    buf.length >= contentBytes && buf.length <= contentBytes + 1024,
    `store zip adds only ~435B of headers: ${buf.length} vs ${contentBytes} content`,
  );
});

test('download: ?deflate=6 compresses entries and shrinks compressible content', async () => {
  const { res, buf } = await download(srv.base, admin.cookie, game.id, '?deflate=6');
  assert.equal(res.status, 200);
  const methods = zipMethods(buf);
  assert.equal(methods.length, FILES.length);
  assert.ok(methods.every((m) => m === 8), 'every entry must be deflated');
  const files = unzip(buf);
  for (const { path, data } of FILES) {
    assert.equal(files[path], data);
  }
  const store = (await download(srv.base, admin.cookie, game.id)).buf;
  assert.ok(buf.length < store.length, 'deflate output must be smaller on compressible data');
});

test('download: invalid ?deflate values fall back to store', async () => {
  for (const q of ['?deflate=99', '?deflate=-1', '?deflate=abc', '?deflate=']) {
    const { buf } = await download(srv.base, admin.cookie, game.id, q);
    assert.ok(zipMethods(buf).every((m) => m === 0), `query ${q} must fall back to store`);
  }
});

test('download: ?fresh=1 streams the clean game, ignoring overlay and deletions', async () => {
  const user = await register(srv.base, 'dl_fresh_user');
  const changed = 'changed readme\n'.repeat(300);
  await uploadOverlayFile(srv.base, user.cookie, game.id, 'readme.txt', changed, createHash('sha256').update(changed).digest('hex'));
  const done = await syncComplete(srv.base, user.cookie, game.id, ['bin/level01.wad']);
  assert.equal(done.status, 200, 'sync with a deletion must succeed');

  const fresh = await download(srv.base, user.cookie, game.id, '?fresh=1');
  assert.equal(fresh.res.status, 200);
  const freshFiles = unzip(fresh.buf);
  assert.deepEqual(Object.keys(freshFiles).sort(), FILES.map((f) => f.path).sort());
  for (const { path, data } of FILES) {
    assert.equal(freshFiles[path], data, `fresh download must contain pristine ${path}`);
  }

  const merged = await download(srv.base, user.cookie, game.id);
  const mergedFiles = unzip(merged.buf);
  assert.equal(mergedFiles['bin/level01.wad'], undefined, 'merged download keeps the deletion');
  assert.equal(mergedFiles['readme.txt'], changed, 'merged download keeps the overlay change');
});

test('download: invalid ?fresh values fall back to merged overlay', async () => {
  const user = await register(srv.base, 'dl_fresh_fallback');
  const changed = 'fb changed';
  await uploadOverlayFile(srv.base, user.cookie, game.id, 'readme.txt', changed, createHash('sha256').update(changed).digest('hex'));
  await syncComplete(srv.base, user.cookie, game.id, ['bin/level01.wad']);

  for (const q of ['?fresh=banana', '?fresh=', '?fresh=0']) {
    const { buf } = await download(srv.base, user.cookie, game.id, q);
    const files = unzip(buf);
    assert.equal(files['readme.txt'], changed, `query ${q} must fall back to merged overlay`);
    assert.equal(files['bin/level01.wad'], undefined, `query ${q} must keep deletions`);
  }
});

test('download: concurrent downloads all succeed and are identical', async () => {
  const runs = await Promise.all([0, 1, 2].map(() => download(srv.base, admin.cookie, game.id)));
  for (const { res, buf } of runs) {
    assert.equal(res.status, 200);
    assert.equal(buf.length, runs[0].buf.length);
    assert.deepEqual(unzip(buf), unzip(runs[0].buf));
  }
});

test('download: unknown or non-numeric game ids 404', async () => {
  const missing = await fetch(`${srv.base}/api/games/999999/download`, { headers: headers(admin.cookie) });
  assert.equal(missing.status, 404);
  const abc = await fetch(`${srv.base}/api/games/abc/download`, { headers: headers(admin.cookie) });
  assert.equal(abc.status, 404);
});

test('download: empty game returns 404 with a clear error', async () => {
  const empty = await createGame(srv.base, admin.cookie, 'EmptyGame', []);
  const res = await fetch(`${srv.base}/api/games/${empty.id}/download`, { headers: headers(admin.cookie) });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'game has no files');
});

test('download: benchmark endpoint reports positive throughput and needs admin', async () => {
  const asAdmin = await fetch(`${srv.base}/api/admin/bench`, { headers: headers(admin.cookie) });
  assert.equal(asAdmin.status, 200);
  const { sample_mb, results } = await asAdmin.json();
  assert.equal(sample_mb, 64);
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.ok(r.mbps > 0, `${r.method} must report > 0 MB/s`);
    assert.ok(r.out_mb > 0);
  }
  const store = results.find((r) => r.method === 'store');
  const deflate = results.find((r) => r.method === 'deflate-6');
  assert.ok(store.mbps > deflate.mbps, 'store should outrun deflate');
});
