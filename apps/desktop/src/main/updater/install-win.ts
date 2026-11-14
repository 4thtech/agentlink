// WIN-INAPP-UPDATE: "Update now" → "Restart now" on the Windows app, on the same signed manifest and
// the same trust model as the Mac (manifest.ts, download.ts, install.ts): one pinned update key, the
// allowlisted GitHub Releases hosts, the exact size and SHA-256 the signed manifest names.
//
//   preflight (the per-user install folder %LOCALAPPDATA%\Programs\AgentLink, its parent writable)
//   → download the `nsis` asset (AgentLink-<v>-win-x64-setup.exe) with fetch into
//   <app data>\updates\u-<random>\ (progress as counts; size cap = the signed size; SHA-256 checked
//   while streaming) → re-check size + SHA-256 → copy the bundled node.exe next to it (the setup
//   replaces the installed one, so the watchdog must not run from it) → wait for "Restart now" →
//   check the setup again, make it read-only, record its file identity → start the detached watchdog
//   (WIN_WATCHDOG_SOURCE) → the caller quits the app (before-quit stops the core and the helper).
//
// The watchdog (plain CommonJS for `node -e`, Node built-ins only, fixed environment, cwd the staging
// folder so no handle is held on the install folder):
//   1. waits (≤ the timeout) for the app's process to exit; if it does not, it changes nothing;
//   2. checks that the setup is still the file the app verified (same volume, file id, size and
//      modification time); otherwise it never runs it and starts the old copy again;
//   3. renames the install folder aside to a sibling (…\AgentLink.previous-u-xxxxxx). Windows refuses
//      to rename a folder while any file in it is in use, so this also waits until the core, the
//      helper and the app have really let go;
//   4. runs the setup with `/S` only (per-user, no UAC, the one install folder, no desktop shortcut
//      created or removed) and checks the setup's identity again once its image is running (a running
//      image cannot be written to); a setup that exits ≠ 0, writes no AgentLink.exe, or changed, is a
//      failure: the half-written folder goes aside, the old copy comes back and starts;
//   5. writes a fresh nonce, starts the new copy through Explorer (the person's own environment, like
//      `open` on a Mac) and waits for its health record with that nonce (health.ts); healthy → the old
//      copy is removed; not healthy → the new copy is stopped (only a pid that tasklist shows as
//      AgentLink.exe), the old copy comes back and starts.
// Every outcome but success records `failedVersion` with a fixed reason (state.ts), so the version is
// never offered in-app again and the next launch says "Couldn't update here" with the download link.
//
// No Mark of the Web is added: the app downloaded and verified the setup itself (the signed manifest's
// SHA-256 stands in for SmartScreen's reputation check while builds are unsigned), so SmartScreen does
// not stop the silent run. The phase-1 dialog path (index.ts) still marks what it opens.
//
// Residual (as on the Mac, IR-UPD-4-1 #1, 04 §2.5): a process running as this same user can change
// the staged setup between the identity check and CreateProcess, or simply replace the installed app
// in its user-writable folder. The identity checks catch a replaced or rewritten file, not a
// same-user attacker who also restores the modification time. Nothing here logs a URL or a path.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { bundleFilePaths, parseBundleHashes } from '../bundle-check.js';
import { streamToFile, hashFile, type DownloadProgress, type FetchLike } from './download.js';
import { HEALTH_FILE, PENDING_FILE, STARTING_FILE } from './health.js';
import { InstallRefusal, installCode } from './install-refusal.js';
import { UPDATES_DIR, readRecordFromAsar, sweepStaging, type InstallOutcome } from './install.js';
import type { AcceptedUpdate } from './manifest.js';
import { recheckZip } from './stage.js';
import { FAILED_FILE } from './state.js';

/** How long the new copy has to report healthy (and the app to quit) before it is rolled back. */
export const WIN_HEALTH_TIMEOUT_MS = 90_000;
/** The NSIS silent switch: the only argument the setup is ever given. */
export const INSTALLER_SILENT = '/S';
/** The copy of the bundled node.exe in the staging folder that runs the watchdog. */
export const STAGED_NODE = 'node.exe';
export const WIN_EXE = 'AgentLink.exe';
const TEMP_DIR = 'tmp';

/** A plain drive path (C:\…), normalized, no `..`: never a UNC or relative path. */
function plainWinPath(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    /^[A-Za-z]:\\/.test(p) &&
    win32.normalize(p) === p &&
    !p.endsWith('\\') &&
    !/[\0"*?<>|]/.test(p.slice(2))
  );
}

/**
 * The install folder when this copy runs from the one place the setup installs to,
 * `%LOCALAPPDATA%\Programs\AgentLink\AgentLink.exe` (any case), else null: a portable copy, another
 * folder, a network share or anything not normalized never updates itself.
 */
export function winInstallDirOf(execPath: string, localAppData: string | undefined): string | null {
  if (!plainWinPath(localAppData) || !plainWinPath(execPath)) return null;
  const expected = win32.join(localAppData, 'Programs', 'AgentLink', WIN_EXE);
  return execPath.toLowerCase() === expected.toLowerCase() ? win32.dirname(execPath) : null;
}

export interface WinTools {
  /** `%SystemRoot%\explorer.exe`: starts the app in the person's own environment. */
  readonly launcher: string;
  readonly tasklist: string;
  readonly taskkill: string;
  /** `%SystemRoot%\System32\reg.exe`: the RunOnce recovery entry (IR Fable r1 M). */
  readonly reg: string;
}

/** The fixed Windows programs, by absolute path under %SystemRoot%, or null. */
export function winTools(systemRoot: string | undefined): WinTools | null {
  if (!plainWinPath(systemRoot)) return null;
  return Object.freeze({
    launcher: win32.join(systemRoot, 'explorer.exe'),
    tasklist: win32.join(systemRoot, 'System32', 'tasklist.exe'),
    taskkill: win32.join(systemRoot, 'System32', 'taskkill.exe'),
    reg: win32.join(systemRoot, 'System32', 'reg.exe'),
  });
}

/**
 * The watchdog's whole environment: nothing inherited (no NODE_OPTIONS, no ELECTRON_*). TEMP/TMP
 * point into the staging folder (NSIS unpacks its plug-ins there).
 */
export function winWatchdogEnv(opts: {
  readonly systemRoot: string;
  readonly userProfile: string;
  readonly localAppData: string;
  readonly appData: string;
  readonly temp: string;
}): Record<string, string> {
  return {
    SystemRoot: opts.systemRoot,
    windir: opts.systemRoot,
    PATH: `${opts.systemRoot}\\System32;${opts.systemRoot}`,
    TEMP: opts.temp,
    TMP: opts.temp,
    USERPROFILE: opts.userProfile,
    LOCALAPPDATA: opts.localAppData,
    APPDATA: opts.appData,
  };
}

/** The file's identity: volume, file id, size and modification time (ns). Same form as the watchdog. */
export async function installerIdentity(path: string): Promise<string> {
  const st = await stat(path, { bigint: true });
  if (!st.isFile()) throw new InstallRefusal('download_failed');
  return [st.dev, st.ino, st.size, st.mtimeNs].join(':');
}

export interface WinSwapPlan {
  readonly pid: number;
  /** `%LOCALAPPDATA%\Programs\AgentLink`. */
  readonly installDir: string;
  /** `<stateDir>\updates\u-<random>` (the setup, node.exe, tmp\). */
  readonly stagingDir: string;
  readonly stateDir: string;
  readonly version: string;
  /** `<stagingDir>\AgentLink-<version>-win-x64-setup.exe`. */
  readonly installer: string;
  /** installerIdentity of the verified setup. */
  readonly installerId: string;
  readonly launcher: string;
  readonly timeoutMs: number;
  readonly tasklist: string;
  readonly taskkill: string;
  readonly reg: string;
  /** The signed manifest's size of the setup. */
  readonly size: number;
}

/** The watchdog's 13 positional arguments, in order. */
export function winWatchdogArgs(plan: WinSwapPlan): string[] {
  return [
    String(plan.pid),
    plan.installDir,
    plan.stagingDir,
    plan.stateDir,
    plan.version,
    plan.installer,
    plan.installerId,
    plan.launcher,
    String(plan.timeoutMs),
    plan.tasklist,
    plan.taskkill,
    plan.reg,
    String(plan.size),
  ];
}

/** HKCU RunOnce: Windows runs (and removes) this entry at the next logon of this user. */
export const RUNONCE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
export const RUNONCE_VALUE = 'AgentLinkUpdateRecovery';
/** The recovery script the watchdog writes into the staging folder before it moves anything. */
export const RECOVERY_FILE = 'recover.cjs';

/**
 * IR Fable r1 M: the recovery for a watchdog that died after it moved the install folder aside (the
 * computer shut down, the process was killed). The watchdog writes it as <staging>\recover.cjs with
 * its fixed paths in `C` and registers it in HKCU RunOnce before the rename; it removes the entry
 * once the old or the new copy is in place for good. Run at the next logon (or by hand), it puts the
 * folder it finds aside back (anything at the install path goes to `.failed-…` first), records the
 * version as failed (`interrupted`) and starts AgentLink. With no folder aside it does nothing.
 */
export const RECOVERY_BODY = `const fs = require('fs');
const cp = require('child_process');
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const renameRetry = async (from, to) => {
  for (let i = 0; i < 120; i += 1) { try { fs.renameSync(from, to); return true; } catch { await sleep(250); } }
  return false;
};
(async () => {
  if (!exists(C.aside)) return;
  if (exists(C.dir) && !(await renameRetry(C.dir, C.failedDir))) return;
  if (!(await renameRetry(C.aside, C.dir))) {
    if (!exists(C.dir) && exists(C.failedDir)) { try { fs.renameSync(C.failedDir, C.dir); } catch {} }
    return;
  }
  try { fs.rmSync(C.failedDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  try {
    fs.mkdirSync(C.state, { recursive: true });
    fs.writeFileSync(C.failed + '.tmp', JSON.stringify({ failedVersion: C.version, reason: 'interrupted' }) + '\\n', { mode: 0o600 });
    fs.renameSync(C.failed + '.tmp', C.failed);
  } catch {}
  try { fs.unlinkSync(C.pending); } catch {}
  try { const c = cp.spawn(C.launcher, [C.exe], { detached: true, stdio: 'ignore', cwd: C.staging }); c.on('error', () => {}); c.unref(); } catch {}
})();
`;

/**
 * The Windows watchdog (see the header). Exit codes and the reason recorded with `failedVersion`:
 *   0 updated (nothing recorded);
 *   2 the new copy did not answer in time → `unhealthy`, old copy back and started;
 *   3 the app did not quit, or its files stayed in use → `not_quit`; nothing changed (the old copy is
 *     started again only when the app's own process had exited);
 *   4 the install folder could not be moved aside → `swap_failed`/`not_permitted`; old copy started;
 *   5 the old copy could not be put back → `rollback_incomplete`; a runnable copy is left at the path
 *     whenever possible, the other one stays beside it;
 *   6 the setup failed (exit ≠ 0, timeout, or no AgentLink.exe) → `installer_failed`; old copy back;
 *   7 the setup was not the verified file → `installer_changed`; never run (or stopped at once);
 * Between moving the install folder aside and a final outcome, an HKCU RunOnce entry runs
 * RECOVERY_BODY at the next logon should the watchdog die (IR Fable r1 M);
 *   64 bad arguments (nothing touched, nothing recorded).
 * It writes nothing to stdout or a log.
 */
export const WIN_WATCHDOG_SOURCE = `'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const a = process.argv.slice(1);
const NUM = '(0|[1-9][0-9]{0,5})';
const VERSION = new RegExp('^' + NUM + '\\\\.' + NUM + '\\\\.' + NUM + '$');
const clean = (p) => typeof p === 'string' && path.isAbsolute(p) && path.normalize(p) === p && !p.endsWith(path.sep);
if (a.length !== 13) process.exit(64);
const pid = Number(a[0]);
const [, dir, staging, state, version, installer, installerId, launcher] = a;
const timeout = Number(a[8]);
const tasklist = a[9];
const taskkill = a[10];
const reg = a[11];
const size = Number(a[12]);
if (!Number.isSafeInteger(pid) || pid < 1) process.exit(64);
if (!clean(dir) || path.basename(dir).toLowerCase() !== 'agentlink') process.exit(64);
if (!clean(state) || !clean(staging) || path.dirname(staging) !== path.join(state, ${JSON.stringify(UPDATES_DIR)})) process.exit(64);
if (!/^u-[A-Za-z0-9]{6}$/.test(path.basename(staging))) process.exit(64);
if (!VERSION.test(version)) process.exit(64);
if (!clean(installer) || path.dirname(installer) !== staging || path.basename(installer) !== 'AgentLink-' + version + '-win-x64-setup.exe') process.exit(64);
if (!/^[0-9]+:[0-9]+:[0-9]+:[0-9]+$/.test(installerId)) process.exit(64);
if (!clean(launcher) || !clean(tasklist) || !clean(taskkill) || !clean(reg)) process.exit(64);
if (!Number.isSafeInteger(size) || size < 1 || installerId.split(':')[2] !== String(size)) process.exit(64);
if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 600000) process.exit(64);
const INSTALL_TIMEOUT = 10 * 60 * 1000;
const exe = path.join(dir, ${JSON.stringify(WIN_EXE)});
const tag = path.basename(staging);
const aside = dir + '.previous-' + tag;
const failedDir = dir + '.failed-' + tag;
const HEALTH = path.join(state, ${JSON.stringify(HEALTH_FILE)});
const STARTING = path.join(state, ${JSON.stringify(STARTING_FILE)});
const PENDING = path.join(state, ${JSON.stringify(PENDING_FILE)});
const FAILED = path.join(state, ${JSON.stringify(FAILED_FILE)});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const isFile = (p) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } };
const denied = (e) => e !== null && typeof e === 'object' && (e.code === 'EPERM' || e.code === 'EACCES');
const identity = (p) => {
  try {
    const s = fs.lstatSync(p, { bigint: true });
    return s.isFile() ? [s.dev, s.ino, s.size, s.mtimeNs].join(':') : null;
  } catch { return null; }
};
const readJson = (file, keys) => {
  try {
    const t = fs.readFileSync(file, 'utf8');
    if (t.length > 512) return null;
    const v = JSON.parse(t);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    if (Object.keys(v).sort().join(',') !== keys.join(',')) return null;
    return v;
  } catch { return null; }
};
const writeAtomic = (file, text) => {
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
};
const unlink = (f) => { try { fs.unlinkSync(f); } catch {} };
const rmQuiet = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); } catch {} };
const launch = (target) => new Promise((resolve) => {
  if (!isFile(target)) { resolve(); return; }
  let child;
  try { child = cp.spawn(launcher, [target], { stdio: 'ignore', cwd: staging, windowsHide: false }); } catch { resolve(); return; }
  const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 15000);
  child.on('error', () => { clearTimeout(timer); resolve(); });
  child.on('exit', () => { clearTimeout(timer); resolve(); });
});
const RECOVER = path.join(staging, ${JSON.stringify(RECOVERY_FILE)});
let armed = false;
// Before the install folder moves: the recovery script and its RunOnce entry (see RECOVERY_BODY).
const arm = () => {
  const C = { dir, aside, failedDir, exe, state, staging, version, launcher, failed: FAILED, pending: PENDING };
  try {
    fs.writeFileSync(RECOVER, "'use strict';\\nconst C = " + JSON.stringify(C) + ';\\n' + ${JSON.stringify(RECOVERY_BODY)}, { mode: 0o600 });
    cp.execFileSync(reg, ['add', ${JSON.stringify(RUNONCE_KEY)}, '/v', ${JSON.stringify(RUNONCE_VALUE)}, '/t', 'REG_SZ', '/d', '"' + process.execPath + '" "' + RECOVER + '"', '/f'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
    armed = true;
    return true;
  } catch { return false; }
};
// Once a copy is in place for good. Kept after rollback_incomplete (the recovery may finish it).
const disarm = () => {
  if (!armed) return;
  try { cp.execFileSync(reg, ['delete', ${JSON.stringify(RUNONCE_KEY)}, '/v', ${JSON.stringify(RUNONCE_VALUE)}, '/f'], { stdio: 'ignore', timeout: 15000, windowsHide: true }); } catch {}
  armed = false;
};
const done = (code, reason, removeStaging) => {
  if (code !== 5) disarm();
  if (reason !== null) {
    try { writeAtomic(FAILED, JSON.stringify({ failedVersion: version, reason }) + '\\n'); } catch {}
  }
  unlink(PENDING);
  if (removeStaging) {
    // The setup first (read-only); node.exe is this process and stays until the sweeper (24 h).
    try { fs.chmodSync(installer, 0o600); } catch {}
    unlink(installer);
    rmQuiet(staging);
  }
  process.exit(code);
};
// Windows refuses to rename a folder while a file in it is in use: retry until the deadline.
const renameRetry = async (from, to, ms) => {
  const deadline = Date.now() + ms;
  for (;;) {
    try { fs.renameSync(from, to); return null; } catch (e) {
      if (Date.now() >= deadline) return e;
      await sleep(250);
    }
  }
};
const runInstaller = () => new Promise((resolve) => {
  let settled = false;
  let timer = null;
  const finish = (r) => { if (!settled) { settled = true; if (timer !== null) clearTimeout(timer); resolve(r); } };
  // Right before it runs: still the verified file, of the signed size.
  if (identity(installer) !== installerId) { finish('changed'); return; }
  let child;
  try { child = cp.spawn(installer, [${JSON.stringify(INSTALLER_SILENT)}], { stdio: 'ignore', cwd: staging, windowsHide: true }); } catch { finish('failed'); return; }
  timer = setTimeout(() => { try { child.kill(); } catch {} finish('failed'); }, INSTALL_TIMEOUT);
  child.on('error', () => finish('failed'));
  child.on('exit', (code) => finish(code === 0 ? 'ok' : 'failed'));
  // Its image is running now and cannot be written to: it must still be the verified file.
  if (identity(installer) !== installerId) { try { child.kill(); } catch {} finish('changed'); }
});
// The new copy's shell, only when tasklist shows that pid as AgentLink.exe; /T stops its core too.
const stopNewCopy = async () => {
  const s = readJson(STARTING, ['pid', 'version']);
  if (s === null || s.version !== version || !Number.isSafeInteger(s.pid) || s.pid <= 4 || s.pid === process.pid) return;
  let out;
  try {
    out = cp.execFileSync(tasklist, ['/FI', 'PID eq ' + s.pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true });
  } catch { return; }
  const first = (out.split(/\\r?\\n/).find((l) => l.trim() !== '') || '').trim();
  const m = /^"([^"]*)","([0-9]+)"/.exec(first);
  if (m === null || m[1].toLowerCase() !== 'agentlink.exe' || Number(m[2]) !== s.pid) return;
  try { cp.execFileSync(taskkill, ['/PID', String(s.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000, windowsHide: true }); } catch {}
  await sleep(1000);
};
// The new (or half-written) copy goes aside, the old one back, and the old one starts.
const restore = async (code, reason) => {
  if (exists(dir)) {
    if ((await renameRetry(dir, failedDir, 15000)) !== null) { await launch(exe); done(5, 'rollback_incomplete', false); }
  }
  if ((await renameRetry(aside, dir, 15000)) !== null) {
    if (!exists(dir) && exists(failedDir)) { try { fs.renameSync(failedDir, dir); } catch {} }
    await launch(exe);
    done(5, 'rollback_incomplete', false);
  }
  disarm();
  rmQuiet(failedDir);
  await launch(exe);
  done(code, reason, true);
};
(async () => {
  for (let waited = 0; alive(pid); waited += 100) {
    if (waited >= timeout) done(3, 'not_quit', true);
    await sleep(100);
  }
  if (!isFile(exe) || exists(aside) || exists(failedDir)) { await launch(exe); done(4, 'swap_failed', true); }
  if (identity(installer) !== installerId) { await launch(exe); done(7, 'installer_changed', true); }
  if (!arm()) { await launch(exe); done(4, 'swap_failed', true); }
  const moved = await renameRetry(dir, aside, timeout);
  if (moved !== null) {
    // In use until the deadline (Windows says EBUSY, EPERM or EACCES): something did not quit.
    await launch(exe);
    if (moved.code === 'EBUSY' || denied(moved)) done(3, 'not_quit', true);
    done(4, 'swap_failed', true);
  }
  unlink(HEALTH);
  unlink(PENDING);
  const result = await runInstaller();
  if (result !== 'ok' || !isFile(exe)) {
    if (result === 'changed') await restore(7, 'installer_changed');
    await restore(6, 'installer_failed');
  }
  const nonce = process.pid.toString(36) + '-' + process.hrtime.bigint().toString(36) + '-' + Date.now().toString(36);
  try { writeAtomic(PENDING, JSON.stringify({ version, nonce })); } catch {}
  await launch(exe);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const h = readJson(HEALTH, ['nonce', 'pid', 'version']);
    if (h !== null && h.version === version && h.nonce === nonce) { disarm(); rmQuiet(aside); done(0, null, true); }
    await sleep(250);
  }
  await stopNewCopy();
  await restore(2, 'unhealthy');
})();
`;

/** Starts a process that outlives the app (stdio ignored, own process group, unref'd). */
export type WinSpawnDetached = (
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
) => void;

/** The real detached spawn (no shell, no window). */
export const spawnDetachedWin: WinSpawnDetached = (command, args, env, cwd) => {
  const child = spawn(command, [...args], {
    detached: true,
    stdio: 'ignore',
    cwd,
    env: { ...env },
    windowsHide: true,
  });
  child.on('error', () => undefined);
  child.unref();
};

export interface WinInstallDeps {
  readonly accepted: AcceptedUpdate;
  /** The app's own data folder (Electron `userData`). */
  readonly stateDir: string;
  /** `%LOCALAPPDATA%\Programs\AgentLink` (winInstallDirOf). */
  readonly installDir: string;
  readonly pid: number;
  readonly fetch: FetchLike;
  /** The installed `resources\node\node.exe` (copied into the staging folder). */
  readonly installedNode: string;
  /** The watchdog's fixed environment (winWatchdogEnv); TEMP/TMP are set to the staging folder. */
  readonly env: Readonly<Record<string, string>>;
  readonly tools: WinTools;
  readonly spawnDetached: WinSpawnDetached;
  /** `bundle-hashes.json` of the installed app (its app.asar): the staged node.exe must match it. */
  readonly readRecord: () => Promise<string | null>;
  readonly onProgress?: DownloadProgress;
  readonly onVerifying?: () => void;
  /** Resolves when the person chooses "Restart now"; the setup is checked again after it. */
  readonly confirmRestart?: () => Promise<void>;
  /** Tests only: the health and quit timeout. */
  readonly timeoutMs?: number;
}

/** The install folder must be a real folder holding AgentLink.exe, in a folder this user can change. */
async function preflightWin(installDir: string): Promise<void> {
  try {
    const st = await lstat(installDir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('not a folder');
    if (!(await lstat(join(installDir, WIN_EXE))).isFile()) throw new Error('no exe');
  } catch {
    throw new InstallRefusal('not_in_place');
  }
  try {
    await access(dirname(installDir), constants.W_OK);
  } catch {
    throw new InstallRefusal('not_writable');
  }
}

/** The whole Windows in-app install up to the restart. Never throws. */
export async function installUpdateWin(deps: WinInstallDeps): Promise<InstallOutcome> {
  const { accepted } = deps;
  let dir: string | undefined;
  try {
    const { asset } = accepted;
    const name = `AgentLink-${accepted.version}-win-x64-setup.exe`;
    if (asset.kind !== 'nsis' || asset.platform !== 'win32' || !asset.url.endsWith(`/${name}`))
      throw new InstallRefusal('not_zip');
    await preflightWin(deps.installDir);
    const updatesDir = join(deps.stateDir, UPDATES_DIR);
    await mkdir(updatesDir, { recursive: true, mode: 0o700 });
    await sweepStaging(updatesDir, Date.now());
    dir = await mkdtemp(join(updatesDir, 'u-'));
    const installer = join(dir, name);
    await streamToFile(asset, deps.fetch, installer, deps.onProgress);
    deps.onVerifying?.();
    await recheckZip(installer, asset);
    // The watchdog's node: a copy of the installed one (the setup replaces that file).
    const node = join(dir, STAGED_NODE);
    await copyFile(deps.installedNode, node, constants.COPYFILE_EXCL);
    // IR Fable r1 L: the copy must be the node.exe the build recorded (bundle-hashes.json in app.asar).
    let record: string | null;
    try {
      record = await deps.readRecord();
    } catch {
      record = null;
    }
    const recorded = record === null ? null : (parseBundleHashes(record)?.node ?? null);
    if (recorded === null || (await hashFile(node)).sha256 !== recorded)
      throw new InstallRefusal('bundle_hashes');
    const temp = join(dir, TEMP_DIR);
    await mkdir(temp, { mode: 0o700 });
    if (deps.confirmRestart !== undefined) await deps.confirmRestart();
    // It waited on disk for the click: read-only, then identity, hash, identity (unchanged between).
    await chmod(installer, 0o400);
    const before = await installerIdentity(installer);
    await recheckZip(installer, asset);
    if ((await installerIdentity(installer)) !== before) throw new InstallRefusal('hash_mismatch');
    const args = winWatchdogArgs({
      pid: deps.pid,
      installDir: deps.installDir,
      stagingDir: dir,
      stateDir: deps.stateDir,
      version: accepted.version,
      installer,
      installerId: before,
      launcher: deps.tools.launcher,
      timeoutMs: deps.timeoutMs ?? WIN_HEALTH_TIMEOUT_MS,
      tasklist: deps.tools.tasklist,
      taskkill: deps.tools.taskkill,
      reg: deps.tools.reg,
      size: asset.size,
    });
    try {
      deps.spawnDetached(
        node,
        ['-e', WIN_WATCHDOG_SOURCE, '--', ...args],
        {
          ...deps.env,
          TEMP: temp,
          TMP: temp,
        },
        dir,
      );
    } catch {
      throw new InstallRefusal('swap_failed');
    }
    dir = undefined; // the watchdog owns the staging folder now
    return { kind: 'restarting', version: accepted.version };
  } catch (error) {
    return { kind: 'fallback', code: installCode(error, 'swap_failed') };
  } finally {
    if (dir !== undefined) {
      const staged = dir;
      await rm(staged, { recursive: true, force: true }).catch(async () => {
        // A read-only setup: make it writable, then try once more.
        await chmod(join(staged, `AgentLink-${accepted.version}-win-x64-setup.exe`), 0o600).catch(
          () => undefined,
        );
        await rm(staged, { recursive: true, force: true }).catch(() => undefined);
      });
    }
  }
}

/** Runs a fixed program (absolute path, no shell); resolves when it ends, never throws. */
export type RunQuiet = (command: string, args: readonly string[]) => Promise<void>;

const SIBLING = /^AgentLink\.(previous|failed)-(u-[A-Za-z0-9]{6})$/;

/**
 * At a healthy start of the Windows app (the core said `ready`; IR Fable r1 M and L): this copy is
 * in place for good, so the RunOnce recovery entry goes (unless an update of another version is still
 * pending), and left-over `AgentLink.previous-u-…` / `AgentLink.failed-u-…` folders beside the install
 * folder are removed when their staging folder is gone (no watchdog owns them any more). Never throws.
 */
export async function afterHealthyStartWin(opts: {
  readonly stateDir: string;
  readonly installDir: string;
  readonly version: string;
  readonly reg: string;
  readonly run: RunQuiet;
}): Promise<void> {
  try {
    let pendingVersion: unknown = null;
    try {
      const text = await readFile(join(opts.stateDir, PENDING_FILE), 'utf8');
      pendingVersion =
        text.length <= 512 ? (JSON.parse(text) as { version?: unknown }).version : '';
    } catch {
      pendingVersion = null;
    }
    if (pendingVersion === null || pendingVersion === opts.version)
      await opts.run(opts.reg, ['delete', RUNONCE_KEY, '/v', RUNONCE_VALUE, '/f']);
    const parent = dirname(opts.installDir);
    for (const name of await readdir(parent)) {
      const m = SIBLING.exec(name);
      if (m === null) continue;
      const p = join(parent, name);
      const st = await lstat(p).catch(() => null);
      if (st === null || st.isSymbolicLink() || !st.isDirectory()) continue;
      if (
        await lstat(join(opts.stateDir, UPDATES_DIR, m[2]!)).then(
          () => true,
          () => false,
        )
      )
        continue;
      await rm(p, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch {
    // nothing to tidy
  }
}

/** The install with the real tools, for this running copy (`process.execPath`) on Windows. */
export function installWinFromProcess(opts: {
  readonly accepted: AcceptedUpdate;
  readonly stateDir: string;
  readonly execPath: string;
  readonly pid: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: FetchLike;
  readonly onProgress?: DownloadProgress;
  readonly onVerifying?: () => void;
  readonly confirmRestart?: () => Promise<void>;
}): Promise<InstallOutcome> {
  const { env } = opts;
  const installDir = winInstallDirOf(opts.execPath, env['LOCALAPPDATA']);
  const tools = winTools(env['SystemRoot']);
  const userProfile = env['USERPROFILE'];
  const appData = env['APPDATA'];
  if (
    installDir === null ||
    tools === null ||
    !plainWinPath(userProfile) ||
    !plainWinPath(appData) ||
    !plainWinPath(env['LOCALAPPDATA']) ||
    !plainWinPath(env['SystemRoot']) ||
    // IR Fable r1 L: the data folder is a plain local path under %APPDATA%.
    !plainWinPath(opts.stateDir) ||
    !opts.stateDir.toLowerCase().startsWith(`${appData.toLowerCase()}\\`)
  )
    return Promise.resolve({ kind: 'fallback', code: 'not_in_place' });
  return installUpdateWin({
    accepted: opts.accepted,
    stateDir: opts.stateDir,
    installDir,
    pid: opts.pid,
    fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
    installedNode: bundleFilePaths(win32.join(installDir, 'resources'), 'win32').node!,
    env: winWatchdogEnv({
      systemRoot: env['SystemRoot'] as string,
      userProfile,
      localAppData: env['LOCALAPPDATA'] as string,
      appData,
      temp: '', // set to the staging folder by installUpdateWin
    }),
    tools,
    spawnDetached: spawnDetachedWin,
    readRecord: () => readRecordFromAsar(win32.join(installDir, 'resources')),
    ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
    ...(opts.onVerifying !== undefined ? { onVerifying: opts.onVerifying } : {}),
    ...(opts.confirmRestart !== undefined ? { confirmRestart: opts.confirmRestart } : {}),
  });
}
