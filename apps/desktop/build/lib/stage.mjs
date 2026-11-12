// Steps shared by build-mac.mjs and build-win.mjs.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assetFor, constants } from './constants.mjs';
import { fetchVerified, sha256File } from './fetch-verified.mjs';
import { checkTgzDeps, lockRegistryProblems, treeHash } from './core-lock.mjs';
import { capture, run, walk } from './run.mjs';

export const DESKTOP_DIR = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const CACHE_DIR = join(DESKTOP_DIR, '.cache');
export const OUT_DIR = join(DESKTOP_DIR, 'out');

const PLACEHOLDER_MAIN = `'use strict';
// PLACEHOLDER main (WP-D4 packaging check only): the real shell is apps/desktop/src/main (WP-D2).
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 520, height: 240, webPreferences: { sandbox: true, contextIsolation: true } });
  w.loadURL('data:text/html,' + encodeURIComponent('<h2>AgentLink packaging placeholder</h2><p>Replace with the real shell.</p>'));
});
app.on('window-all-closed', () => app.quit());
`;

/** Downloads (or reuses) the pinned Electron zip and Node archive for `platform`; both hash-checked. */
export async function fetchRuntimes(platform) {
  const dl = join(CACHE_DIR, 'downloads');
  const out = {};
  for (const kind of ['electron', 'node']) {
    const a = assetFor(kind, platform);
    out[kind] = await fetchVerified({
      url: a.url,
      sha256: a.sha256,
      dest: join(dl, a.file),
      allowedHosts: constants.allowedHosts,
    });
  }
  return out;
}

/** Extracts a .zip or .tar.gz into an empty dir. Uses the OS `tar` (bsdtar on macOS and Windows 10+). */
export function extract(archive, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  if (process.platform === 'darwin' && archive.endsWith('.zip')) {
    run('ditto', ['-x', '-k', archive, dest]); // keeps symlinks and modes in the Electron framework
  } else {
    run('tar', [archive.endsWith('.zip') ? '-xf' : '-xzf', archive, '-C', dest]);
  }
}

/**
 * Builds the ASAR payload dir: package.json + dist/ (the compiled main, apps/desktop/dist) and, when
 * present, assets used by the renderer. Falls back to a placeholder main when WP-D2's dist is absent.
 * Returns {dir, placeholder}.
 */
export function buildPayload({ workDir, version, distDir = join(DESKTOP_DIR, 'dist') }) {
  const dir = join(workDir, 'payload');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'dist', 'main'), { recursive: true });
  let placeholder = false;
  if (existsSync(join(distDir, 'main', 'main.js'))) {
    cpSync(distDir, join(dir, 'dist'), { recursive: true });
  } else {
    placeholder = true;
    writeFileSync(join(dir, 'dist', 'main', 'main.js'), PLACEHOLDER_MAIN);
  }
  const pkg = {
    name: 'agentlink-desktop',
    productName: 'AgentLink',
    version,
    main: 'dist/main/main.js',
    private: true,
  };
  const srcPkg = join(DESKTOP_DIR, 'package.json');
  if (!placeholder && existsSync(srcPkg)) {
    const t = JSON.parse(readFileSync(srcPkg, 'utf8')).type;
    if (t === 'module') pkg.type = 'module';
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  return { dir, placeholder };
}

/** Packs the payload dir into app.asar (deterministic file order from @electron/asar). */
export async function packAsar(payloadDir, asarPath) {
  const req = createRequire(new URL('../package.json', import.meta.url));
  const asar = await import(pathToFileURL(req.resolve('@electron/asar')).href);
  await asar.createPackage(payloadDir, asarPath);
}

export const REGISTRY = 'https://registry.npmjs.org/';
const CORE_LOCK_DIR = fileURLToPath(new URL('../core-lock/', import.meta.url));

/**
 * Installs the core with NOTHING resolved at build time:
 *  1. `npm ci --ignore-scripts` from the committed core-lock (the CLI's production dependencies,
 *     integrity-checked, public registry only), for the target os/cpu;
 *  2. the packed CLI tarball is unpacked on top (its dependencies must be a subset of the lock);
 *  3. fails if any installed package declares an install-time script.
 * Returns {lockSha256, treeSha256} for the inputs record. Resources/core is NOT covered by the ASAR
 * integrity fuse; see README.md.
 */
export function installCore({ tgz, dest, os, cpu }) {
  if (!existsSync(tgz)) throw new Error(`Core tarball not found: ${tgz}`);
  const lockText = readFileSync(join(CORE_LOCK_DIR, 'package-lock.json'), 'utf8');
  const registryProblems = lockRegistryProblems(JSON.parse(lockText), REGISTRY);
  if (registryProblems.length) throw new Error(`core-lock:\n${registryProblems.join('\n')}`);
  const lockPkg = JSON.parse(readFileSync(join(CORE_LOCK_DIR, 'package.json'), 'utf8'));
  const tgzPkg = JSON.parse(capture('tar', ['-xOzf', tgz, 'package/package.json']).stdout);
  const depProblems = checkTgzDeps(tgzPkg.dependencies, lockPkg.dependencies);
  if (depProblems.length) throw new Error(`Core tarball vs core-lock:\n${depProblems.join('\n')}`);

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(join(CORE_LOCK_DIR, 'package.json'), join(dest, 'package.json'));
  cpSync(join(CORE_LOCK_DIR, 'package-lock.json'), join(dest, 'package-lock.json'));
  run('npm', [
    'ci',
    '--prefix',
    dest,
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    `--registry=${REGISTRY}`,
    `--os=${os}`,
    `--cpu=${cpu}`,
  ]);
  const pkgDir = join(dest, 'node_modules', ...tgzPkg.name.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  run('tar', ['-xzf', tgz, '--strip-components=1', '-C', pkgDir]);

  const bad = [];
  for (const e of walk(join(dest, 'node_modules'))) {
    if (e.dir || (!e.path.endsWith('/package.json') && !e.path.endsWith('\\package.json')))
      continue;
    try {
      const s = JSON.parse(readFileSync(e.path, 'utf8')).scripts ?? {};
      for (const k of ['preinstall', 'install', 'postinstall'])
        if (s[k]) bad.push(`${e.path} (${k})`);
    } catch {
      /* not a package manifest */
    }
  }
  if (bad.length)
    throw new Error(
      `Installed packages declare install scripts (none may run):\n${bad.join('\n')}`,
    );
  return {
    lockSha256: createHash('sha256').update(lockText).digest('hex'),
    treeSha256: treeHash(join(dest, 'node_modules')),
  };
}

export function defaultBefore(days = 7) {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

export async function sha256Of(path) {
  return sha256File(path);
}

export function gitHeadOrNull() {
  const r = capture('git', ['rev-parse', 'HEAD'], { cwd: DESKTOP_DIR });
  return r.code === 0 ? r.stdout.trim() : null;
}
