import { Router } from 'express';
import { MAX_COMMENT_LENGTH } from '../config.js';
import { getDb, now } from '../db.js';
import { requireAuth } from '../security.js';
import { normalizeUsername } from '../usernames.js';

export const commentsRouter = Router();

commentsRouter.use(requireAuth);

const MENTION_RE = /(?:^|\s)@([^\s@.,!?;:"'()[\]{}]+)/g;

function parseMentions(text) {
  const out = [];
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text))) out.push(m[1]);
  return out;
}

function notifyMentions(database, text, gameId, authorName, excludeIds) {
  const seen = new Set(excludeIds);
  for (const token of parseMentions(text)) {
    const target = database
      .prepare('SELECT id FROM users WHERE username_norm = ?')
      .get(normalizeUsername(token) || '');
    if (!target || seen.has(target.id)) continue;
    seen.add(target.id);
    database
      .prepare(
        `INSERT INTO notifications (user_id, type, title, body, link, created_at)
         VALUES (?, 'comment_mention', ?, ?, ?, ?)`,
      )
      .run(target.id, `@${authorName} mentioned you in a comment`, `on game #${gameId}`, `#/game/${gameId}`, now());
  }
}

const COMMENT_SELECT = `
  SELECT c.id, c.text, c.created_at, c.user_id, c.parent_id,
    COALESCE(u.username, 'deleted') AS author,
    CASE WHEN c.user_id IS NOT NULL AND u.pfp IS NOT NULL THEN '/api/auth/users/' || u.id || '/pfp' END AS author_pfp
  FROM comments c LEFT JOIN users u ON u.id = c.user_id
`;

function notifyReply(database, parent, gameId, replierName) {
  if (parent.user_id === null) return;
  if (parent.user_id === undefined) return;
  database
    .prepare(
      `INSERT INTO notifications (user_id, type, title, body, link, created_at)
       VALUES (?, 'comment_reply', ?, ?, ?, ?)`,
    )
    .run(
      parent.user_id,
      'new reply on your comment',
      `${replierName} replied to your comment on ${gameId}`,
      `#/game/${gameId}`,
      now(),
    );
}

commentsRouter.post('/games/:id/comments', (req, res) => {
  const database = getDb();
  const game = database.prepare('SELECT id FROM games WHERE id = ?').get(req.params.id);
  if (!game) return res.status(404).json({ error: 'game not found' });
  const { text, parent_id } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'comment text is required' });
  }
  if (text.length > MAX_COMMENT_LENGTH) {
    return res.status(413).json({ error: `comment too long (max ${MAX_COMMENT_LENGTH} chars)` });
  }
  let parent = null;
  if (parent_id != null) {
    parent = database
      .prepare('SELECT * FROM comments WHERE id = ? AND game_id = ?')
      .get(parent_id, req.params.id);
    if (!parent) return res.status(400).json({ error: 'parent comment not found' });
  }
  const info = database
    .prepare('INSERT INTO comments (game_id, user_id, text, parent_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(req.params.id, req.user.id, text.trim(), parent ? parent.id : null, now());
  const comment = database.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(info.lastInsertRowid);
  const exclude = [];
  if (parent && parent.user_id !== req.user.id) {
    notifyReply(database, parent, req.params.id, req.user.username);
    exclude.push(parent.user_id);
  }
  notifyMentions(database, comment.text, req.params.id, req.user.username, exclude);
  res.status(201).json({ comment });
});

commentsRouter.delete('/comments/:id', (req, res) => {
  const database = getDb();
  const comment = database.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!comment) return res.status(404).json({ error: 'comment not found' });
  if (comment.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'not allowed' });
  }
  database.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
