import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const CHUNK = 4 * 1024 * 1024;

let bootPromise = null;

/**
 * Boot the app once per process (dynamic imports are cached, so the storage
 * dir + DB are fixed for the lifetime of the test process). Tests within a
 * file share one server and MUST use unique usernames and returned game ids.
 */
export async function startServer() {
  if (!bootPromise) {
    bootPromise = (async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'opensync-test-'));
      process.env.OPENSYNC_STORAGE = dir;
      process.env.NODE_ENV = 'test';
      const { app } = await import('../server/index.js');
      const server = app.listen(0, '127.0.0.1');
      await new Promise((r) => server.once('listening', r));
      const base = `http://127.0.0.1:${server.address().port}`;
      let closed = false;
      return {
        base,
        dir,
        close: () =>
          new Promise((r) => {
            if (closed) return r();
            closed = true;
            server.close(() => {
              rmSync(dir, { recursive: true, force: true });
              r();
            });
          }),
      };
    })();
  }
  return bootPromise;
}

export function headers(cookie) {
  return cookie ? { cookie } : {};
}

const TEST_PFP = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export async function register(base, username, password = 'secret123', pfp = TEST_PFP) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, pfp }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { ...body, cookie };
}

export async function login(base, username, password = 'secret123') {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { ...body, cookie };
}

/** Upload a set of {path, data} files to a new game and wait until ready. Returns the game row. */
export async function createGame(base, cookie, name, files) {
  const res = await fetch(`${base}/api/games`, {
    method: 'POST',
    headers: { ...headers(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`create game failed: ${res.status} ${await res.text()}`);
  const { game } = await res.json();

  for (const { path, data } of files) {
    const buf = Buffer.from(data);
    const total = Math.max(1, Math.ceil(buf.length / CHUNK));
    for (let i = 0; i < total; i++) {
      const chunk = buf.subarray(i * CHUNK, (i + 1) * CHUNK);
      const r = await fetch(`${base}/api/games/${game.id}/files`, {
        method: 'POST',
        headers: {
          ...headers(cookie),
          'x-path': encodeURIComponent(path),
          'x-index': String(i),
          'x-total': String(total),
          'x-size': String(buf.length),
        },
        body: new Uint8Array(chunk),
      });
      if (!r.ok) throw new Error(`chunk upload failed (${path} #${i}): ${await r.text()}`);
    }
  }

  await fetch(`${base}/api/games/${game.id}/upload/complete`, { method: 'POST', headers: headers(cookie) });
  for (let i = 0; i < 60; i++) {
    const st = await (await fetch(`${base}/api/games/${game.id}/status`, { headers: headers(cookie) })).json();
    if (st.status === 'ready') return { ...game, status: st.status, total_size: st.total_size };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('game never became ready');
}

export async function getManifest(base, cookie, gameId) {
  return (await fetch(`${base}/api/games/${gameId}/manifest`, { headers: headers(cookie) })).json();
}

export async function uploadOverlayFile(base, cookie, gameId, path, data, declaredHash) {
  const buf = Buffer.from(data);
  return fetch(`${base}/api/games/${gameId}/overlay/files`, {
    method: 'POST',
    headers: {
      ...headers(cookie),
      'x-path': encodeURIComponent(path),
      'x-index': '0',
      'x-total': '1',
      'x-size': String(buf.length),
      'x-hash': declaredHash,
    },
    body: new Uint8Array(buf),
  });
}

export async function syncComplete(base, cookie, gameId, deletions) {
  return fetch(`${base}/api/games/${gameId}/sync/complete`, {
    method: 'POST',
    headers: { ...headers(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ deletions }),
  });
}
