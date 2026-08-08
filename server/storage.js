import path from 'node:path';
import { GAMES_ROOT, USERS_ROOT } from './config.js';

export function gameDir(gameId) {
  return path.join(GAMES_ROOT, String(gameId));
}

export function gameFilesDir(gameId) {
  return path.join(gameDir(gameId), 'files');
}

export function gameManifestPath(gameId) {
  return path.join(gameDir(gameId), 'manifest.json');
}

export function gameCoverPath(gameId) {
  return path.join(gameDir(gameId), 'cover.jpg');
}

export function gameUploadsDir(gameId) {
  return path.join(gameDir(gameId), 'uploads');
}

export function userGameDir(userId, gameId) {
  return path.join(USERS_ROOT, String(userId), 'games', String(gameId));
}

export function overlayDir(userId, gameId) {
  return path.join(userGameDir(userId, gameId), 'overlay');
}

export function deletionsPath(userId, gameId) {
  return path.join(userGameDir(userId, gameId), 'deletions.json');
}

export function overlayManifestPath(userId, gameId) {
  return path.join(userGameDir(userId, gameId), 'overlay_manifest.json');
}

export function userPfpPath(userId) {
  return path.join(USERS_ROOT, String(userId), 'pfp.jpg');
}

export function overlayFilePath(userId, gameId, relPath) {
  return path.join(overlayDir(userId, gameId), relPath);
}

/**
 * Validate a relative game path coming from clients.
 * Rejects absolute paths, path traversal (".."), empty, and null bytes.
 * Returns the normalized relative path (POSIX separators).
 */
export function safeRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return null;
  if (relPath.includes('\0')) return null;
  if (relPath.includes('\\')) return null;
  const norm = path.posix.normalize(relPath);
  if (norm === '.' || norm === '..' || norm.startsWith('../')) return null;
  if (path.posix.isAbsolute(norm)) return null;
  if (norm.startsWith('/')) return null;
  return norm;
}
