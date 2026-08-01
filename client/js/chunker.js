import { humanSize } from './api.js';

/**
 * Upload a File in fixed-size chunks to a chunk endpoint.
 *
 * url:       POST endpoint
 * path:      relative path of the file (x-path header)
 * file:      File object
 * chunkSize: bytes per chunk (server CHUNK_SIZE)
 * resumeFrom: number of already-received chunks to skip
 * extraHeaders: additional headers (e.g. x-hash for overlay uploads)
 * onProgress: (bytesUploaded, chunkIndex) callback
 *
 * Returns { path, uploadedBytes }.
 * A 409 (out-of-order) throws { code: 'RESUME_REQUIRED' } so the caller can re-init.
 */
export async function uploadChunks({ url, path, file, chunkSize, resumeFrom = 0, extraHeaders = {}, signal, onProgress }) {
  const total = Math.max(1, Math.ceil(file.size / chunkSize));
  let uploaded = resumeFrom * chunkSize;
  for (let i = resumeFrom; i < total; i++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const start = i * chunkSize;
    const end = Math.min(file.size, start + chunkSize);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-path': encodeURIComponent(path),
        'x-index': String(i),
        'x-total': String(total),
        'x-size': String(file.size),
        ...extraHeaders,
      },
      body: file.slice(start, end),
      signal,
    });
    if (!res.ok) {
      const err = new Error(`chunk ${i + 1}/${total} failed (${res.status})`);
      err.status = res.status;
      if (res.status === 409) err.code = 'RESUME_REQUIRED';
      throw err;
    }
    uploaded = start + file.slice(start, end).size;
    onProgress?.(uploaded, i + 1, total);
  }
  return { path, uploadedBytes: uploaded };
}
