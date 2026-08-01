import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const CLIENT_DIR = path.join(ROOT, 'client');
export const SHARED_DIR = path.join(ROOT, 'shared');

export const PORT = Number(process.env.PORT || 3000);
export const HOST = process.env.HOST || '0.0.0.0';

export const STORAGE_ROOT = process.env.OPENSYNC_STORAGE || path.join(ROOT, 'storage');
export const GAMES_ROOT = path.join(STORAGE_ROOT, 'games');
export const USERS_ROOT = path.join(STORAGE_ROOT, 'users');
export const DB_PATH = path.join(STORAGE_ROOT, 'opensync.db');
export const SECRET_PATH = path.join(STORAGE_ROOT, 'server-secret');
export const SECRET = process.env.OPENSYNC_SECRET || null;

export const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
export const MAX_COMMENT_LENGTH = 5000;
export const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
export const COOKIE_NAME = 'ohs';

export const GAME_STATUS = { PROCESSING: 'processing', READY: 'ready' };
export const ROLES = { ADMIN: 'admin', USER: 'user' };
