import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadManifest } from './manifest.js';
import { streamHash } from './security.js';
import {
  deletionsPath,
  overlayDir,
  overlayFilePath,
  overlayManifestPath,
  safeRelPath,
  userGameDir,
} from './storage.js';

/**
 * Fingerprint of the clean manifest: deletions recorded under this hash only
 * apply while the manifest is byte-identical (a re-upload invalidates them).
 */
function fingerprint(manifest) {
  if (!manifest || !Array.isArray(manifest.files)) return null;
  const sortedFiles = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path));
  return createHash('sha256').update(JSON.stringify(sortedFiles)).digest('hex');
}

export function loadDeletions(userId, gameId) {
  try {
    const raw = existsSync(deletionsPath(userId, gameId)) ? readFileSync(deletionsPath(userId, gameId), 'utf8') : '[]';
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { hash: null, paths: parsed };
    if (parsed && Array.isArray(parsed.paths)) return { hash: parsed.manifest_hash ?? null, paths: parsed.paths };
    return { hash: null, paths: [] };
  } catch {
    return { hash: null, paths: [] };
  }
}

export function loadOverlayManifest(userId, gameId) {
  try {
    const raw = existsSync(overlayManifestPath(userId, gameId)) ? readFileSync(overlayManifestPath(userId, gameId), 'utf8') : 'null';
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loadOverlayInfo(userId, gameId) {
  const overlayManifest = loadOverlayManifest(userId, gameId);
  const deletions = loadDeletions(userId, gameId);
  const hasOverlay = Boolean(overlayManifest?.files.length) || deletions.paths.length > 0;

  let overlaySize = 0;
  if (overlayManifest) overlaySize = overlayManifest.files.reduce((s, f) => s + f.size, 0);

  let updatedAt = null;
  for (const p of [overlayManifestPath(userId, gameId), deletionsPath(userId, gameId)]) {
    if (existsSync(p)) {
      try {
        const { mtimeMs } = await stat(p);
        if (!updatedAt || mtimeMs > updatedAt) updatedAt = mtimeMs;
      } catch {
        /* ignore */
      }
    }
  }

  return {
    has_overlay: hasOverlay,
    files: overlayManifest ? overlayManifest.files.length : 0,
    deletions: deletions.paths.length,
    size: overlaySize,
    updated_at: updatedAt ? new Date(updatedAt).toISOString() : null,
  };
}

export async function clearOverlay(userId, gameId) {
  await rm(userGameDir(userId, gameId), { recursive: true, force: true });
}

export async function saveDeletions(userId, gameId, deletions, manifest = null) {
  const clean = [...new Set(deletions)].sort();
  const data = { manifest_hash: fingerprint(manifest), paths: clean };
  await mkdir(userGameDir(userId, gameId), { recursive: true });
  await writeFile(deletionsPath(userId, gameId), JSON.stringify(data, null, 2));
}

/**
 * Re-validate an uploaded overlay file against its declared hash.
 * Throws { status: 422, mismatch } on hash mismatch (caller cleans up the file).
 */
export async function validateOverlayFile(userId, gameId, relPath, declaredHash) {
  const finalPath = overlayFilePath(userId, gameId, relPath);
  const actualHash = await streamHash(createReadStream(finalPath));
  if (declaredHash && actualHash !== declaredHash) {
    await rm(finalPath, { force: true });
    const err = new Error('hash mismatch');
    err.status = 422;
    err.mismatch = { path: relPath, expected: declaredHash, actual: actualHash };
    throw err;
  }
  const { size } = await stat(finalPath);
  return { path: relPath, hash: actualHash, size };
}

/**
 * Rebuild overlay_manifest.json by hashing every file currently in the overlay dir.
 */
export async function rebuildOverlayManifest(userId, gameId) {
  const dir = overlayDir(userId, gameId);
  const files = [];
  async function walk(relDir) {
    let entries = [];
    try {
      entries = await readdir(path.join(dir, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isDirectory()) {
        await walk(path.posix.join(relDir, e.name));
      } else if (e.isFile()) {
        const rel = safeRelPath(path.posix.join(relDir, e.name));
        if (!rel) continue;
        const abs = path.join(dir, rel);
        const hash = await streamHash(createReadStream(abs));
        const { size } = await stat(abs);
        files.push({ path: rel, hash, size });
      }
    }
  }
  await walk('');
  const manifest = { game_id: Number(gameId), files };
  await mkdir(userGameDir(userId, gameId), { recursive: true });
  await writeFile(overlayManifestPath(userId, gameId), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Effective file set for a user: clean manifest + overlay - deletions.
 * Shared by the zip download path and sync validation.
 */
export async function effectiveFiles(userId, gameId) {
  const clean = loadManifest(gameId);
  const cleanFiles = clean ? clean.files : [];
  const cleanByPath = new Map(cleanFiles.map((f) => [f.path, f]));
  const dels = loadDeletions(userId, gameId);
  const deletions = dels.hash && dels.hash === fingerprint(clean) ? new Set(dels.paths) : new Set();
  const overlayManifest = loadOverlayManifest(userId, gameId);
  const overlayByPath = new Map((overlayManifest?.files || []).map((f) => [f.path, f]));

  const merged = [];
  for (const f of cleanFiles) {
    if (deletions.has(f.path)) continue;
    const overlay = overlayByPath.get(f.path);
    if (overlay) merged.push({ path: overlay.path, source: 'overlay', size: overlay.size, hash: overlay.hash });
    else merged.push({ path: f.path, source: 'clean', size: f.size, hash: f.hash });
  }
  for (const f of overlayManifest?.files || []) {
    if (!cleanByPath.has(f.path)) merged.push({ path: f.path, source: 'overlay', size: f.size, hash: f.hash });
  }
  merged.sort((a, b) => a.path.localeCompare(b.path));
  return { files: merged, deletions: [...deletions] };
}
