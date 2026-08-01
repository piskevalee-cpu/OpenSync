import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGame, headers, register, startServer, uploadOverlayFile } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

test('gc: deleting a game removes every user overlay dir for it', async () => {
  const admin = await register(srv.base, 'gc_admin');
  const player = await register(srv.base, 'gc_player');
  const game = await createGame(srv.base, admin.cookie, 'GcGame', [{ path: 'a.bin', data: 'x' }]);
  const hash = createHash('sha256').update('overlay bytes').digest('hex');
  const r = await uploadOverlayFile(srv.base, player.cookie, game.id, 'a.bin', 'overlay bytes', hash);
  assert.equal(r.status, 200, await r.text());
  const overlayDir = path.join(srv.dir, 'users', String(player.user.id), 'games', String(game.id));
  assert.equal(existsSync(overlayDir), true);

  const del = await fetch(`${srv.base}/api/games/${game.id}`, { method: 'DELETE', headers: headers(admin.cookie) });
  assert.equal(del.status, 200);
  assert.equal(existsSync(overlayDir), false);
});

test('gc: gcOrphanedData removes orphan dirs and keeps real ones', async () => {
  const { gcOrphanedData } = await import('../server/gc.js');
  const player = await register(srv.base, 'gc_survivor');
  const game = await createGame(srv.base, player.cookie, 'GcKeep', [{ path: 'a.bin', data: 'x' }]);
  const hash = createHash('sha256').update('keep bytes').digest('hex');
  const r = await uploadOverlayFile(srv.base, player.cookie, game.id, 'a.bin', 'keep bytes', hash);
  assert.equal(r.status, 200, await r.text());
  const realOverlay = path.join(srv.dir, 'users', String(player.user.id), 'games', String(game.id));
  assert.equal(existsSync(realOverlay), true);

  const orphanUser = path.join(srv.dir, 'users', '999');
  const orphanGame = path.join(srv.dir, 'users', String(player.user.id), 'games', '99999');
  await mkdir(path.join(orphanUser, 'nested'), { recursive: true });
  await writeFile(path.join(orphanUser, 'nested', 'junk.bin'), 'junk');
  await mkdir(path.join(orphanGame, 'overlay'), { recursive: true });
  await writeFile(path.join(orphanGame, 'overlay', 'x.bin'), 'junk');

  const result = await gcOrphanedData();
  assert.equal(result.userDirs, 1);
  assert.equal(result.gameOverlayDirs, 1);
  assert.equal(existsSync(orphanUser), false);
  assert.equal(existsSync(orphanGame), false);
  assert.equal(existsSync(realOverlay), true);
});
