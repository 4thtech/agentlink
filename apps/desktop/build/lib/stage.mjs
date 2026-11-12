// Steps shared by build-mac.mjs and build-win.mjs.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assetFor, constants } from './constants.mjs';
import { fetchVerified, sha256File } from './fetch-verified.mjs';
import { capture, run, walk } from './run.mjs';

export const DESKTOP_DIR = resolve(new URL('../..', import.meta.url).pathname);
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

/**
 * Installs the packed CLI/core tarball for the target with scripts off and a release-age cooldown.
 * Fails if any installed package declares an install-time script (policy: none are allowed).
 */
export function installCore({ tgz, dest, os, cpu, before }) {
  if (!existsSync(tgz)) throw new Error(`Core tarball not found: ${tgz}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  writeFileSync(
    join(dest, 'package.json'),
    JSON.stringify({ name: 'agentlink-core', private: true }) + '\n',
  );
  run('npm', [
    'install',
    '--prefix',
    dest,
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    `--os=${os}`,
    `--cpu=${cpu}`,
    `--before=${before}`,
    tgz,
  ]);
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
}

export function defaultBefore(days = 3) {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

export async function sha256Of(path) {
  return sha256File(path);
}

export function gitHeadOrNull() {
  const r = capture('git', ['rev-parse', 'HEAD'], { cwd: DESKTOP_DIR });
  return r.code === 0 ? r.stdout.trim() : null;
}
