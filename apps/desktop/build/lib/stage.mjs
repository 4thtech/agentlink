// Steps shared by build-mac.mjs and build-win.mjs.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetFor, constants } from './constants.mjs';
import { fetchVerified, sha256File } from './fetch-verified.mjs';
import { checkTgzDeps, lockRegistryProblems, treeHash } from './core-lock.mjs';
import { sha256Hex } from './hash.mjs';
import { PREVIEW_VAR, findPreviewString } from './preview-check.mjs';
import { assertRootKeyPinned, readRootKeyJson } from './root-key-check.mjs';
import { capture, run, walk } from './run.mjs';

export const DESKTOP_DIR = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const CACHE_DIR = join(DESKTOP_DIR, '.cache');
export const OUT_DIR = join(DESKTOP_DIR, 'out');
/** The release bundle of the shell's main process (`pnpm --filter @4thtech-io/desktop bundle`). */
export const RELEASE_DIST_DIR = join(DESKTOP_DIR, 'dist-release');

/**
 * The packaged layout under Resources: ONE source, src/shared/resource-layout.json, which the
 * shell's main process (main.ts resourcePaths) reads too. Values are path segments.
 */
export const LAYOUT = JSON.parse(
  readFileSync(join(DESKTOP_DIR, 'src', 'shared', 'resource-layout.json'), 'utf8'),
);

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
 * Builds the ASAR payload dir: package.json + dist/ (the RELEASE bundle of the shell's main process,
 * apps/desktop/dist-release, built with the preview constant defined false; never plain tsc output).
 * Falls back to a placeholder main only when the bundle is absent. Returns {dir, placeholder}.
 */
export function buildPayload({ workDir, version, distDir = RELEASE_DIST_DIR }) {
  const dir = join(workDir, 'payload');
  const main = LAYOUT.asarMain; // ['dist', 'main', 'entry.js']
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ...main.slice(0, -1)), { recursive: true });
  let placeholder = false;
  if (existsSync(join(distDir, ...main.slice(1)))) {
    cpSync(distDir, join(dir, 'dist'), { recursive: true });
  } else {
    placeholder = true;
    writeFileSync(join(dir, ...main), PLACEHOLDER_MAIN);
  }
  const pkg = {
    name: 'agentlink-desktop',
    productName: 'AgentLink',
    version,
    main: main.join('/'),
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

/**
 * The release ASAR must not contain the preview variable name (Fable H1): the same scan as
 * check-preview-string.mjs, run on the real app.asar during the build so a bad bundle never ships.
 */
export async function assertNoPreviewString(asarPath) {
  const hits = findPreviewString(await asarFiles(asarPath));
  if (hits.length) throw new Error(`${PREVIEW_VAR} is in the release ASAR: ${hits.join(', ')}`);
}

/** The raw app.asar bytes and every file in it, as [{path, content}]. */
async function asarFiles(asarPath) {
  const asar = await import('@electron/asar');
  const files = [{ path: '(raw app.asar bytes)', content: readFileSync(asarPath) }];
  for (const p of asar.listPackage(asarPath, { isPack: false })) {
    const rel = p.replace(/^[\\/]/, '');
    try {
      files.push({ path: rel, content: asar.extractFile(asarPath, rel) });
    } catch {
      /* directories */
    }
  }
  return files;
}

/**
 * WP-D10 (Decision 5): the release build carries the owner's real offline root key, never the
 * placeholder (lib/root-key-check.mjs). Returns 'pinned', or 'owner-local' for an owner-only build.
 */
export async function assertPinnedRootKey(asarPath, env = process.env) {
  return assertRootKeyPinned({
    rootKeyJson: readRootKeyJson(DESKTOP_DIR),
    files: await asarFiles(asarPath),
    env,
  });
}

/** Packs the payload dir into app.asar (deterministic file order from @electron/asar). */
export async function packAsar(payloadDir, asarPath) {
  const asar = await import('@electron/asar');
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
    lockSha256: sha256Hex(lockText),
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
