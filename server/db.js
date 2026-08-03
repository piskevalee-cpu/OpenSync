import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, GAMES_ROOT, USERS_ROOT, STORAGE_ROOT } from './config.js';

export const SCHEMA_VERSION = 1;

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    cover TEXT,
    description TEXT DEFAULT '',
    system_requirements TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'processing',
    total_size INTEGER NOT NULL DEFAULT 0,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_downloads_user ON downloads(user_id);
  CREATE INDEX IF NOT EXISTS idx_downloads_game ON downloads(game_id);
  CREATE INDEX IF NOT EXISTS idx_comments_game ON comments(game_id);
  `,
  `
  ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE users ADD COLUMN username_norm TEXT;
  UPDATE users SET username_norm = lower(trim(username));
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_norm ON users(username_norm);
  `,
  `
  ALTER TABLE users ADD COLUMN pfp TEXT;
  CREATE TABLE IF NOT EXISTS syncs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_syncs_user ON syncs(user_id);
  `,
  `
  ALTER TABLE games ADD COLUMN last_activity_at TEXT;
  UPDATE games SET last_activity_at = created_at WHERE last_activity_at IS NULL;
  `,
  `
  ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT DEFAULT '',
    link TEXT DEFAULT '',
    read_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
  `,
  `
  PRAGMA foreign_keys = OFF;
  ALTER TABLE comments RENAME TO comments_old;
  CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    text TEXT NOT NULL,
    parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  INSERT INTO comments (id, game_id, user_id, text, parent_id, created_at)
    SELECT id, game_id, user_id, text, parent_id, created_at FROM comments_old;
  DROP TABLE comments_old;
  CREATE INDEX IF NOT EXISTS idx_comments_game ON comments(game_id);
  CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
  PRAGMA foreign_keys = ON;
  `,
];

let db = null;

export function ensureStorage() {
  mkdirSync(STORAGE_ROOT, { recursive: true });
  mkdirSync(GAMES_ROOT, { recursive: true });
  mkdirSync(USERS_ROOT, { recursive: true });
}

export function getDb() {
  if (!db) {
    ensureStorage();
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    migrate(db);
  }
  return db;
}

export function migrate(database = db) {
  database.exec(`CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY)`);
  const row = database.prepare('SELECT MAX(version) AS v FROM _migrations').get();
  const applied = row?.v ?? 0;
  for (let v = applied + 1; v <= MIGRATIONS.length; v += 1) {
    database.exec(MIGRATIONS[v - 1]);
    database.prepare('INSERT INTO _migrations (version) VALUES (?)').run(v);
  }
}

export function now() {
  return new Date().toISOString();
}

export function slugify(name) {
  const base = name
    .toLowerCase()
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'game';
}

export function uniqueSlug(name) {
  const database = getDb();
  const base = slugify(name);
  let slug = base;
  let i = 2;
  const exists = (s) => database.prepare('SELECT 1 FROM games WHERE slug = ?').get(s);
  while (exists(slug)) slug = `${base}-${i++}`;
  return slug;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'init' || cmd === 'migrate') {
    getDb();
    console.log(`[opensync] database ready at ${DB_PATH}`);
  } else {
    console.log('usage: node server/db.js [init|migrate]');
    process.exit(1);
  }
}
