import { Router } from 'express';
import { getDb, now } from '../db.js';
import { requireAuth } from '../security.js';

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get('/', (req, res) => {
  const database = getDb();
  const notifications = database
    .prepare(
      `SELECT id, type, title, body, link, read_at, created_at
       FROM notifications WHERE user_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 50`,
    )
    .all(req.user.id);
  const unread = database
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(req.user.id).n;
  res.json({ notifications, unread });
});

notificationsRouter.delete('/', (req, res) => {
  getDb().prepare('DELETE FROM notifications WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

notificationsRouter.post('/read', (req, res) => {
  const database = getDb();
  const { id, all } = req.body || {};
  if (all) {
    database.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), req.user.id);
    return res.json({ ok: true });
  }
  if (id == null) return res.status(400).json({ error: 'id or all required' });
  const info = database
    .prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?')
    .run(now(), id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'notification not found' });
  res.json({ ok: true });
});
