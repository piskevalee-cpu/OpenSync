import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => {
  const p = path.join(root, rel);
  assert.ok(existsSync(p), `expected file to exist: ${rel}`);
  return readFileSync(p, 'utf8');
};

test('Dockerfile: base image, install, storage, volume, port, user', () => {
  const d = read('Dockerfile');
  assert.ok(d.includes('FROM node:24-alpine'), 'FROM node:24-alpine');
  assert.ok(d.includes('npm ci --omit=dev'), 'npm ci --omit=dev');
  assert.ok(d.includes('OPENSYNC_STORAGE=/data'), 'OPENSYNC_STORAGE=/data');
  assert.ok(d.includes('VOLUME /data'), 'VOLUME /data');
  assert.ok(d.includes('EXPOSE 3000'), 'EXPOSE 3000');
  assert.ok(d.includes('USER node'), 'USER node');
  assert.ok(d.includes('wget') && d.includes('/api/health'), 'HEALTHCHECK wget /api/health');
  assert.ok(d.includes('server/index.js'), 'CMD server/index.js');
});

test('Dockerfile COPY sources exist on disk', () => {
  const d = read('Dockerfile');
  const copies = [...d.matchAll(/^COPY\s+(\S+)\s+/gm)].map((m) => m[1])
    .filter((src) => !src.startsWith('--'));
  assert.ok(copies.length > 0, 'at least one COPY src');
  for (const src of copies) {
    assert.ok(existsSync(path.join(root, src)), `COPY source missing: ${src}`);
  }
});

test('.dockerignore excludes non-image content', () => {
  const i = read('.dockerignore');
  assert.ok(i.includes('node_modules'), 'node_modules');
  assert.ok(i.includes('.git'), '.git');
  assert.ok(i.includes('storage'), 'storage');
  assert.ok(i.includes('tests'), 'tests');
});

test('docker-compose.yml declares service, image, port, volume, policy', () => {
  const c = read('docker-compose.yml');
  assert.ok(c.includes('ghcr.io/piskevalee-cpu/opensync'), 'ghcr image');
  assert.ok(c.includes(':3000'), 'port mapping');
  assert.ok(c.includes('/data'), '/data volume target');
  assert.ok(c.includes('unless-stopped'), 'restart policy');
});

test('.github/workflows/docker.yml runs tests and builds amd64 only', () => {
  const w = read('.github/workflows/docker.yml');
  assert.ok(w.includes('npm test'), 'npm test');
  assert.ok(w.includes('linux/amd64'), 'linux/amd64 platform');
  assert.ok(w.includes('ghcr.io'), 'ghcr.io registry');
  assert.ok(!w.includes('arm64'), 'no arm64');
  assert.ok(!w.includes('linux/arm64'), 'no linux/arm64 platform');
  assert.ok(!w.includes('platforms: linux/arm64'), 'no arm64 platforms key');
});