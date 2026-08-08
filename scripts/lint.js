import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const files = [];

function collect(dir, base) {
  for (const e of readdirSync(path.join(base, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'storage') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, base);
    else if (e.name.endsWith('.js')) files.push(p);
  }
}
collect('server', root);
collect('client', root);
collect('scripts', root);
collect('tests', root);

let failed = false;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' });
  } catch (err) {
    failed = true;
    console.error(`syntax error in ${f}:`);
    console.error(err.stderr.toString());
  }
  const src = readFileSync(path.join(root, f), 'utf8');
  const cliEntry = f === 'server/db.js' || f.startsWith('scripts/') || f === 'server/index.js';
  if (!cliEntry && /console\.(log|debug)/.test(src)) {
    console.error(`console.log/debug found in ${f} (use console.error for server errors)`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`lint ok: ${files.length} files`);
