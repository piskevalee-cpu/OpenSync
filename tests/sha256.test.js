import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Sha256, hashFile } from '../client/js/sha256.js';

test('sha256 matches node crypto for standard vectors', () => {
  const vectors = [
    '',
    'abc',
    'The quick brown fox jumps over the lazy dog',
    'a'.repeat(1_000_000),
    Buffer.from([0, 1, 2, 3, 255, 254]).toString('binary'),
  ];
  for (const v of vectors) {
    const ref = createHash('sha256').update(v).digest('hex');
    const mine = new Sha256().update(v).digestHex();
    assert.equal(mine, ref, `vector mismatch for input of length ${v.length}`);
  }
});

test('sha256 chunked updates equal single update', () => {
  const s = 'chunked-streaming-test-'.repeat(1000);
  const ref = createHash('sha256').update(s).digest('hex');
  const h = new Sha256();
  for (let i = 0; i < s.length; i += 7) h.update(s.slice(i, i + 7));
  assert.equal(h.digestHex(), ref);
});

test('sha256 update accepts Uint8Array slices (binary safety)', () => {
  const raw = new Uint8Array(70_000).map((_, i) => i % 256);
  const ref = createHash('sha256').update(Buffer.from(raw)).digest('hex');
  const h = new Sha256();
  for (let i = 0; i < raw.length; i += 4096) h.update(raw.subarray(i, i + 4096));
  assert.equal(h.digestHex(), ref);
});

test('hashFile matches node crypto for a streamed fake File', async () => {
  const raw = Buffer.from('x'.repeat(300_000) + 'y'.repeat(100_000));
  const file = { stream: () => new Blob([raw]).stream(), size: raw.length };
  const mine = await hashFile(file);
  const ref = createHash('sha256').update(raw).digest('hex');
  assert.equal(mine, ref);
});

test('sha256 block boundary (64/128 bytes) exact', () => {
  for (const n of [55, 56, 63, 64, 65, 127, 128, 129, 1000]) {
    const s = 'a'.repeat(n);
    assert.equal(new Sha256().update(s).digestHex(), createHash('sha256').update(s).digest('hex'), `length ${n}`);
  }
});
