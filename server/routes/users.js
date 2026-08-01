import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../security.js';

export const usersRouter = Router();

usersRouter.use(requireAuth);

usersRouter.get('/', (req, res) => {
  const users = getDb()
    .prepare('SELECT id, username, pfp FROM users ORDER BY username COLLATE NOCASE')
    .all();
  res.json({ users });
});
