// W5-WINDOWS: opens an unzipped desktop extension bundle the way Claude Desktop's own node would.
//
//   node tools/desktop-extension/windows-check.mjs <unzipped bundle folder>
//
// Loads @napi-rs/keyring and better-sqlite3 from the bundle's server/node_modules with this
// process's node (a native module built for another Node ABI, or a missing file, throws here) and
// runs the entry point's `--version`. Prints only fixed words. Run on a Windows runner by
// release.yml (desktop-extension-windows-check); works on any system for the bundle of that system.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import process from 'node:process';

const dir = process.argv[2];
if (dir === undefined) {
  console.error('usage: windows-check.mjs <unzipped bundle folder>');
  process.exit(2);
}
const root = resolve(dir);
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const entry = join(root, manifest.server.entry_point);
if (!existsSync(entry)) {
  console.error('desktop extension check FAILED: the entry point is missing');
  process.exit(1);
}
const requireFromBundle = createRequire(join(root, 'server', 'node_modules', 'x.js'));
try {
  const keyring = requireFromBundle('@napi-rs/keyring');
  if (typeof keyring.Entry !== 'function') throw new Error('keyring has no Entry');
  console.log('ok  @napi-rs/keyring loads');
} catch {
  console.error('desktop extension check FAILED: @napi-rs/keyring did not load');
  process.exit(1);
}
try {
  const Database = requireFromBundle('better-sqlite3');
  const db = new Database(':memory:');
  db.prepare('select 1 as one').get();
  db.close();
  console.log('ok  better-sqlite3 loads and opens a database');
} catch {
  console.error('desktop extension check FAILED: better-sqlite3 did not load');
  process.exit(1);
}
const run = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8' });
if (run.status !== 0 || !manifest.version || !run.stdout.includes(manifest.version)) {
  console.error('desktop extension check FAILED: the entry point did not print its version');
  process.exit(1);
}
console.log(`ok  the entry point prints ${manifest.version}`);
