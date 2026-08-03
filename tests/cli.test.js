import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bash(script, { cwd = ROOT, env = {}, input = '', timeout = 180000 } = {}) {
  const res = spawnSync('bash', ['-c', script], {
    cwd,
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
    timeout,
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', signal: res.signal };
}

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const HAVE_SCRIPT = has('script');
const HAVE_SETSID = has('setsid');
const HAVE_GIT = has('git');

/** Minimal standalone OpenSync repo: no runtime deps, so npm install is instant. */
function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'opensync-fixture-'));
  mkdirSync(path.join(dir, 'server'));
  mkdirSync(path.join(dir, 'scripts'));
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'opensync-fixture',
      version: '9.9.9',
      type: 'module',
      scripts: {
        'db:init': 'node server/db.js init',
        'db:migrate': 'node server/db.js migrate',
        'postinstall': 'mkdir -p node_modules storage && touch storage/opensync.db',
      },
      license: 'ISC',
    }),
  );
  cpSync(path.join(ROOT, 'server/db.js'), path.join(dir, 'server/db.js'));
  cpSync(path.join(ROOT, 'server/config.js'), path.join(dir, 'server/config.js'));
  writeFileSync(
    path.join(dir, 'server/index.js'),
    `import http from 'node:http';
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end('{"ok":true}');
}).listen(process.env.PORT || 3000, process.env.HOST || '0.0.0.0', () => {});
`,
  );
  cpSync(path.join(ROOT, 'scripts/cli.sh'), path.join(dir, 'scripts/cli.sh'));
  cpSync(path.join(ROOT, 'scripts/lib.sh'), path.join(dir, 'scripts/lib.sh'));
  const r = bash('git init -q -b main && git add -A && git -c user.name=test -c user.email=test@test commit -qm fixture', {
    cwd: dir,
    timeout: 30000,
  });
  assert.equal(r.status, 0, `fixture commit failed: ${r.stderr}`);
  return dir;
}

async function healthOk(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

const bannerCount = (out) => (out.match(/▄██████▄/g) || []).length;

test('can_read_tty: false without a controlling tty', () => {
  const r = bash("setsid bash -c 'source scripts/lib.sh && can_read_tty && echo YES || echo NO'");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'NO');
});

test('can_read_tty: true inside a pty', { skip: !HAVE_SCRIPT }, () => {
  const r = bash("script -qec 'source scripts/lib.sh && can_read_tty && echo CANREAD' /dev/null");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CANREAD/);
});

test('interactive: false when stdin/stdout are pipes', () => {
  const r = bash("source scripts/lib.sh && interactive && echo YES || echo NO", { input: 'x' });
  assert.equal(r.stdout.trim(), 'NO');
});

test('dashboard: intact banner (no cumulative shift), in-place redraw seqs, quits on q', { skip: !HAVE_SCRIPT }, () => {
  const r = bash("printf q | script -qec 'bash scripts/cli.sh' /dev/null", { timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /\x1b\[H/);
  assert.match(out, /\x1b\[K/);
  assert.match(out, /\x1b\[\?1049h/);
  assert.match(out, /OpenSync CLI v/);
  assert.match(out, /lan access\s+http:\/\//);
  assert.match(out, /^\s+port\s+\d+/m);
  assert.match(out, /storage\s+\S+/);
  assert.match(out, /\r?\n███    ███   ███    ███   ███    ███/);
  assert.doesNotMatch(out, /\r?\n {2,}███    ███   ███    ███/);
  assert.equal(bannerCount(out), 1);
});

/** Make a fixture dir pass cli.sh's repo_ready gate without running npm install. */
function fixtureReady(dir) {
  mkdirSync(path.join(dir, 'node_modules'));
  mkdirSync(path.join(dir, 'storage'));
  writeFileSync(path.join(dir, 'storage', 'opensync.db'), '');
}

test('install.sh: non-interactive run — defaults, banner once, server starts and stops', { skip: !(HAVE_SETSID && HAVE_GIT) }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'os-install-'));
  const fixture = makeFixture();
  const port = 31000 + (process.pid % 900);
  try {
    const r = bash("setsid bash install.sh", { env: { HOME: home, PORT: String(port), REPO_URL: fixture } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(bannerCount(r.stdout), 1, 'banner must print exactly once');
    assert.doesNotMatch(r.stdout, /where should OpenSync be installed\?/);
    assert.ok(lstatSync(path.join(home, '.local', 'bin', 'opensync')).isSymbolicLink(), 'opensync symlink');
    assert.ok(existsSync(path.join(home, 'OpenSync', 'storage', 'opensync.db')), 'db created');
    assert.ok(await healthOk(port), 'server should be ACTIVE after default install');
    const stop = bash(`env HOME=${home} PORT=${port} bash ${home}/OpenSync/scripts/cli.sh stop`);
    assert.equal(stop.status, 0, stop.stderr);
    assert.ok(!(await healthOk(port)), 'server should be stopped');
  } finally {
    bash(`env HOME=${home} PORT=${port} bash ${home}/OpenSync/scripts/cli.sh stop || true`, { timeout: 30000 });
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('install.sh: interactive prompts appear and are honored under a pty', { skip: !(HAVE_SCRIPT && HAVE_GIT) }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'os-install-'));
  const fixture = makeFixture();
  const port = 31000 + ((process.pid + 100) % 900);
  try {
    const r = bash(`printf '1\\nn\\n' | script -qec 'env HOME=${home} PORT=${port} REPO_URL=${fixture} bash install.sh' /dev/null`, {
      timeout: 240000,
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /where should OpenSync be installed\?/);
    assert.match(r.stdout, /start OpenSync now\?/);
    assert.match(r.stdout, /no problem — OpenSync is installed/);
    assert.ok(lstatSync(path.join(home, '.local', 'bin', 'opensync')).isSymbolicLink(), 'opensync symlink');
    assert.equal(bannerCount(r.stdout), 1, 'banner must print exactly once');
    assert.ok(!(await healthOk(port)), 'server must NOT start when answered n');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('dashboard: [q] stops a running server, then quits', { skip: !(HAVE_SCRIPT && HAVE_GIT) }, async () => {
  const fixture = makeFixture();
  const port = 31000 + ((process.pid + 200) % 900);
  try {
    fixtureReady(fixture);
    const start = bash(`env PORT=${port} bash ${fixture}/scripts/cli.sh start`, { timeout: 60000 });
    assert.equal(start.status, 0, start.stderr + start.stdout);
    assert.ok(await healthOk(port), 'server should be up before dashboard');
    const d = bash(`printf q | script -qec 'env PORT=${port} bash ${fixture}/scripts/cli.sh' /dev/null`, { timeout: 30000 });
    assert.equal(d.status, 0, d.stderr);
    assert.match(d.stdout, /ACTIVE/);
    assert.ok(!(await healthOk(port)), '[q] must stop the server');
  } finally {
    bash(`env PORT=${port} bash ${fixture}/scripts/cli.sh stop || true`, { timeout: 30000 });
    rmSync(fixture, { recursive: true, force: true });
  }
});
