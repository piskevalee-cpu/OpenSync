import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { headers, login, register, startServer } from './helpers.js';

// Dedicated file: needs a clean database (single process boot).
const srv = await startServer();
after(() => srv.close());

test('admin cannot demote or delete the last admin', async () => {
  const admin = await register(srv.base, 'solo_admin');
  assert.equal(admin.user.role, 'admin');

  const demote = await fetch(`${srv.base}/api/admin/users/${admin.user.id}/role`, {
    method: 'PATCH',
    headers: { ...headers(admin.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'user' }),
  });
  assert.equal(demote.status, 400);

  const del = await fetch(`${srv.base}/api/admin/users/${admin.user.id}`, { method: 'DELETE', headers: headers(admin.cookie) });
  assert.equal(del.status, 400);
});

test('admin cannot delete themselves once another admin exists', async () => {
  const first = await login(srv.base, 'solo_admin');
  const second = await register(srv.base, 'second_admin');
  await fetch(`${srv.base}/api/admin/users/${second.user.id}/role`, {
    method: 'PATCH',
    headers: { ...headers(first.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'admin' }),
  });

  const selfDel = await fetch(`${srv.base}/api/admin/users/${second.user.id}`, { method: 'DELETE', headers: headers(second.cookie) });
  assert.equal(selfDel.status, 400);

  const selfDemote = await fetch(`${srv.base}/api/admin/users/${second.user.id}/role`, {
    method: 'PATCH',
    headers: { ...headers(second.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'user' }),
  });
  assert.equal(selfDemote.status, 400);
});
