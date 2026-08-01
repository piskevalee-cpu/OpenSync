import express from 'express';
import path from 'node:path';
import { CLIENT_DIR, HOST, PORT, STORAGE_ROOT } from './config.js';
import { ensureStorage, getDb, now } from './db.js';
import { attachUser } from './security.js';
import { authRouter } from './routes/auth.js';
import { gamesRouter } from './routes/games.js';
import { downloadRouter } from './routes/download.js';
import { syncRouter } from './routes/sync.js';
import { commentsRouter } from './routes/comments.js';
import { adminRouter } from './routes/admin.js';
import { notificationsRouter } from './routes/notifications.js';
import { usersRouter } from './routes/users.js';
import { deleteGame } from './manifest.js';
import { gcOrphanedData } from './gc.js';

ensureStorage();
getDb();
gcOrphanedData()
  .then((r) => {
    if (r.userDirs || r.gameOverlayDirs) console.log(`[opensync] gc: removed ${r.userDirs} orphan user dir(s), ${r.gameOverlayDirs} orphan overlay dir(s)`);
  })
  .catch((err) => console.error('[opensync] gc failed:', err));

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));
app.use(attachUser);

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'opensync' }));

app.get('/api/info', (_req, res) => {
  const admins = getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  res.json({ name: 'opensync', has_admin: admins > 0 });
});

app.use('/api/auth', authRouter);
app.use('/api/games', gamesRouter);
app.use('/api/games', downloadRouter);
app.use('/api/games', syncRouter);
app.use('/api', commentsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/users', usersRouter);
app.use('/api/admin', adminRouter);

app.use(express.static(CLIENT_DIR, { index: 'index.html', maxAge: 0 }));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  console.error('[opensync] unhandled error:', err);
  res.status(err.status || 500).json({ error: err.message || 'internal error' });
});

if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, HOST, () => {
    console.log(`[opensync] listening on http://${HOST}:${PORT}`);
    console.log(`[opensync] storage: ${STORAGE_ROOT}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  setInterval(async () => {
    const database = getDb();
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const stale = database
      .prepare(
        `SELECT id FROM games WHERE status = 'processing' AND (last_activity_at IS NULL OR last_activity_at < ?)`
      )
      .all(cutoff);
    for (const row of stale) {
      try {
        await deleteGame(row.id);
        console.log(`[opensync] cleaned up abandoned processing game ${row.id}`);
      } catch (err) {
        console.error(`[opensync] cleanup failed for game ${row.id}:`, err);
      }
    }
  }, 5 * 60 * 1000);
}

export { app };
