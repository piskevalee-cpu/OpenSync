import { existsSync } from 'node:fs';
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { CHUNK_SIZE } from './config.js';
import { safeRelPath } from './storage.js';

/**
 * Receive one binary chunk from req and append it to a `.part` file under rootDir.
 * Chunks must arrive sequentially. On the final chunk the part file is finalized
 * to its real destination and `validate` is invoked (if provided).
 *
 * Returns a result object:
 *  - { done: false, received }         more chunks expected
 *  - { done: true }                    file finalized
 * Throws { status, error } HTTP-style errors.
 */
export async function receiveChunk({ rootDir, relPath, index, total, declaredSize, req, validate }) {
  if (!relPath) {
    const err = new Error('invalid file path');
    err.status = 400;
    throw err;
  }
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 0 || index >= total) {
    const err = new Error('invalid chunk index/total');
    err.status = 400;
    throw err;
  }
  if (!Number.isInteger(declaredSize) || declaredSize < 0) {
    const err = new Error('invalid file size');
    err.status = 400;
    throw err;
  }

  const partPath = path.join(rootDir, `${relPath}.part`);
  await mkdir(path.dirname(partPath), { recursive: true });

  const expectedOffset = index * CHUNK_SIZE;
  const current = existsSync(partPath) ? (await stat(partPath)).size : 0;
  if (current !== expectedOffset) {
    const err = new Error('chunk out of order; re-init first');
    err.status = 409;
    err.received = Math.floor(current / CHUNK_SIZE);
    throw err;
  }

  const tmpPath = `${partPath}.tmp`;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  // appendFile preserves the already-received prefix (chunks arrive sequentially)
  await appendFile(partPath, buf);
  await rm(tmpPath, { force: true });

  const partSize = current + buf.length;
  if (index === total - 1) {
    if (partSize !== declaredSize) {
      await rm(partPath, { force: true });
      const err = new Error(`size mismatch: got ${partSize}, expected ${declaredSize}`);
      err.status = 400;
      throw err;
    }
    const finalPath = path.join(rootDir, relPath);
    await mkdir(path.dirname(finalPath), { recursive: true });
    await rename(partPath, finalPath);
    if (validate) await validate(relPath, finalPath);
    return { done: true };
  }
  return { done: false, received: Math.floor(partSize / CHUNK_SIZE) };
}

export { safeRelPath };
