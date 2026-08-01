import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { createGame, headers, register, startServer } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

const MAX_COMMENT_LENGTH = 5000;

let a;
let b;
let game;
let commentId;

test('comments: create, list, and validate', async () => {
  a = await register(srv.base, 'commenter_a');
  b = await register(srv.base, 'commenter_b');
  game = await createGame(srv.base, a.cookie, 'CommentGame', [{ path: 'a.bin', data: 'x' }]);

  const posted = await fetch(`${srv.base}/api/games/${game.id}/comments`, {
    method: 'POST',
    headers: { ...headers(a.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'nice game' }),
  });
  assert.equal(posted.status, 201);
  const { comment } = await posted.json();
  assert.equal(comment.author, a.user.username);
  assert.equal(comment.text, 'nice game');
  commentId = comment.id;

  const detail = await (await fetch(`${srv.base}/api/games/${game.id}`, { headers: headers(a.cookie) })).json();
  assert.equal(detail.comments.length, 1);
  assert.equal(detail.comments[0].id, comment.id);

  for (const text of ['', '   ', '\n\t ']) {
    const r = await fetch(`${srv.base}/api/games/${game.id}/comments`, {
      method: 'POST',
      headers: { ...headers(a.cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    assert.equal(r.status, 400, `blank text should be rejected: ${JSON.stringify(text)}`);
  }

  const tooLong = await fetch(`${srv.base}/api/games/${game.id}/comments`, {
    method: 'POST',
    headers: { ...headers(a.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(MAX_COMMENT_LENGTH + 1) }),
  });
  assert.equal(tooLong.status, 413);

  const anon = await fetch(`${srv.base}/api/games/${game.id}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'no auth' }),
  });
  assert.equal(anon.status, 401);
});

test('comments: only the author (or an admin) can delete', async () => {
  const denied = await fetch(`${srv.base}/api/comments/${commentId}`, { method: 'DELETE', headers: headers(b.cookie) });
  assert.equal(denied.status, 403);

  const own = await fetch(`${srv.base}/api/comments/${commentId}`, { method: 'DELETE', headers: headers(a.cookie) });
  assert.equal(own.status, 200);

  const again = await fetch(`${srv.base}/api/comments/${commentId}`, { method: 'DELETE', headers: headers(a.cookie) });
  assert.equal(again.status, 404);
});
