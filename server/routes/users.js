import { Router } from 'express';
import { getDb } from '../db.js';
import { DEFAULT_PFP_URL } from '../config.js';
import { requireAuth } from '../security.js';

export const usersRouter = Router();

usersRouter.use(requireAuth);

usersRouter.get('/', (req, res) => {
  const users = getDb()
    .prepare('SELECT id, username, pfp FROM users ORDER BY username COLLATE NOCASE')
    .all()
    .map((u) => ({ id: u.id, username: u.username, pfp: u.pfp || DEFAULT_PFP_URL }));
  res.json({ users });
});
