// UPD-4: swapping the verified AgentLink.app in, from a detached watchdog (A-autoupdate §1.2 step 7).
//
// The app cannot replace its own bundle while it runs, so it starts a small watchdog and quits. The
// watchdog is WATCHDOG_SOURCE below, run by the installed copy's bundled `node` as `node -e <source>
// -- <8 fixed arguments>` with a fixed minimal environment and cwd `/` (no shell, no script file,
// nothing from the network in it):
//   1. waits (≤ the timeout) for the app's process to exit; if it does not, it changes nothing;
//   2. renames the installed bundle to <staging>/previous/AgentLink.app and the new one
//      (<staging>/unpacked/AgentLink.app) into its place: two rename(2) calls on one volume, no copy,
//      so the AI apps' absolute path to the bundled node stays the same;
//   3. writes a fresh nonce (update-pending.json), launches the new copy (`/usr/bin/open -n <app>`)
//      and waits up to HEALTH_TIMEOUT_MS for a health record echoing that nonce (health.ts);
//   4. healthy: removes the staging folder (and the old copy). Not healthy: stops the new copy's
//      processes as `ps` shows them, puts the old bundle back and launches it.
// Every outcome but success records `failedVersion` with a fixed reason (state.ts), so a version is
// never offered in-app again after any failure (no quit → relaunch → offer loop).
//
// Residual (IR-UPD-4-1 #1, 04 §7): the staged bundle is not re-checked between verification and the
// rename; a same-user process could change it. Today that process could equally change the installed
// bundle (preflight requires it to be writable by this user). Re-audit at UPD-9.
//
// Before any of that, preflightSwap refuses what cannot work: not an installed AgentLink.app, a folder
// this user cannot change (a standard user and an admin-installed app), or the data folder on another
// volume (a rename would fail; a copy is never attempted). Those end in the existing download link.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { bundleFilePaths } from '../bundle-check.js';
import { HEALTH_FILE, PENDING_FILE, STARTING_FILE } from './health.js';
import { InstallRefusal } from './install-refusal.js';
import { FAILED_FILE } from './state.js';

/** How long the new copy has to report healthy before it is rolled back. */
export const HEALTH_TIMEOUT_MS = 90_000;
/** The launcher the watchdog uses in a real install (tests pass a fake). */
export const OPEN = '/usr/bin/open';
/** The process lister the watchdog uses to confirm a process before it signals it. */
export const PS = '/bin/ps';
export const UNPACKED_DIR = 'unpacked';
export const PREVIOUS_DIR = 'previous';

/** `/…/AgentLink.app` for `/…/AgentLink.app/Contents/MacOS/AgentLink`, else null. */
export function appBundleOf(execPath: string): string | null {
  const m = /^(\/.+\/AgentLink\.app)\/Contents\/MacOS\/AgentLink$/.exec(execPath);
  return m === null ? null : m[1]!;
}

/**
 * Refuses a swap that cannot work, before anything is downloaded:
 * `not_in_place` (not a real AgentLink.app folder, or a translocated copy), `not_writable` (this user
 * cannot rename it out of its folder), `other_volume` (the data folder is on another disk).
 */
export async function preflightSwap(currentApp: string, updatesDir: string): Promise<void> {
  if (
    !isAbsolute(currentApp) ||
    basename(currentApp) !== 'AgentLink.app' ||
    currentApp.includes('/AppTranslocation/')
  )
    throw new InstallRefusal('not_in_place');
  let appStat;
  try {
    appStat = await lstat(currentApp);
  } catch {
    throw new InstallRefusal('not_in_place');
  }
  if (appStat.isSymbolicLink() || !appStat.isDirectory()) throw new InstallRefusal('not_in_place');
  const parent = dirname(currentApp);
  try {
    // Renaming a folder into another folder needs write access to both its parent and itself ("..").
    await access(parent, constants.W_OK);
    await access(currentApp, constants.W_OK);
  } catch {
    throw new InstallRefusal('not_writable');
  }
  const parentStat = await stat(parent);
  const uid = process.getuid?.();
  if ((parentStat.mode & 0o1000) !== 0 && uid !== undefined && appStat.uid !== uid)
    throw new InstallRefusal('not_writable');
  let updatesStat;
  try {
    updatesStat = await stat(updatesDir);
  } catch {
    throw new InstallRefusal('other_volume');
  }
  if (updatesStat.dev !== parentStat.dev) throw new InstallRefusal('other_volume');
}

export interface SwapPlan {
  /** The running app's process id (the watchdog waits for it to exit). */
  readonly pid: number;
  readonly currentApp: string;
  /** `<stateDir>/updates/u-<random>`, holding `unpacked/AgentLink.app` and `previous/`. */
  readonly stagingDir: string;
  readonly stateDir: string;
  readonly version: string;
  readonly launcher: string;
  /** How long to wait for the app to quit, and then for the new copy's health record. */
  readonly timeoutMs: number;
  /** The process lister (`/bin/ps`; tests pass a fake). */
  readonly ps: string;
}

/** The watchdog's 8 positional arguments, in order. */
export function watchdogArgs(plan: SwapPlan): string[] {
  return [
    String(plan.pid),
    plan.currentApp,
    plan.stagingDir,
    plan.stateDir,
    plan.version,
    plan.launcher,
    String(plan.timeoutMs),
    plan.ps,
  ];
}

/**
 * The watchdog (plain CommonJS for `node -e`, Node built-ins only). Exit codes and the reason it
 * records with `failedVersion` (state.ts):
 *   0 updated (nothing recorded);
 *   2 the new copy did not answer in time → `unhealthy`, old copy back and relaunched;
 *   3 the app did not quit → `not_quit`, nothing changed;
 *   4 the swap did not happen → `not_permitted` (the system refused the rename, e.g. App
 *     Management: no loop, the version is not offered in-app again) or `swap_failed`; old copy
 *     relaunched;
 *   5 the old copy could not be put back → `rollback_incomplete`; the new copy is put back at the
 *     path instead, so a runnable app is always there, and the old one stays in `previous/`;
 *   64 bad arguments (nothing touched, nothing recorded).
 * A process is signalled only when `ps` shows it runs the new bundle's executable (or is a child of
 * such a process running from inside the bundle); a pid from a file alone is never trusted. The
 * health nonce is new per swap and only needs to be unique, not secret (a same-user process can read
 * the pending file anyway). It writes nothing to stdout or a log.
 */
export const WATCHDOG_SOURCE = `'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const a = process.argv.slice(1);
const VERSION = /^(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})(-beta\\.(0|[1-9][0-9]{0,5}))?$/;
const clean = (p) => typeof p === 'string' && path.isAbsolute(p) && path.normalize(p) === p && !p.endsWith('/');
if (a.length !== 8) process.exit(64);
const pid = Number(a[0]);
const [, app, staging, state, version, launcher] = a;
const timeout = Number(a[6]);
const psProgram = a[7];
if (!Number.isSafeInteger(pid) || pid < 1) process.exit(64);
if (!clean(app) || path.basename(app) !== 'AgentLink.app') process.exit(64);
if (!clean(state) || !clean(staging) || path.dirname(staging) !== path.join(state, 'updates')) process.exit(64);
if (!VERSION.test(version) || !clean(launcher) || !clean(psProgram)) process.exit(64);
if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 600000) process.exit(64);
const exe = path.join(app, 'Contents', 'MacOS', 'AgentLink');
const staged = path.join(staging, ${JSON.stringify(UNPACKED_DIR)}, 'AgentLink.app');
const aside = path.join(staging, ${JSON.stringify(PREVIOUS_DIR)}, 'AgentLink.app');
const failedCopy = path.join(staging, 'failed', 'AgentLink.app');
const HEALTH = path.join(state, ${JSON.stringify(HEALTH_FILE)});
const STARTING = path.join(state, ${JSON.stringify(STARTING_FILE)});
const PENDING = path.join(state, ${JSON.stringify(PENDING_FILE)});
const FAILED = path.join(state, ${JSON.stringify(FAILED_FILE)});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const denied = (e) => e !== null && typeof e === 'object' && (e.code === 'EPERM' || e.code === 'EACCES');
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
const launch = (target) => new Promise((resolve) => {
  if (!exists(target)) { resolve(); return; }
  let child;
  try { child = cp.spawn(launcher, ['-n', target], { stdio: 'ignore', cwd: '/' }); } catch { resolve(); return; }
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 15000);
  child.on('error', () => { clearTimeout(timer); resolve(); });
  child.on('exit', () => { clearTimeout(timer); resolve(); });
});
const unlink = (f) => { try { fs.unlinkSync(f); } catch {} };
const done = (code, reason, removeStaging) => {
  if (reason !== null) {
    try { writeAtomic(FAILED, JSON.stringify({ failedVersion: version, reason }) + '\\n'); } catch {}
  }
  unlink(PENDING);
  if (removeStaging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch {} }
  process.exit(code);
};
// The new copy's processes, as ps shows them: its main executable, and children of those running
// from inside the bundle (its core). Never this process; never a pid that ps does not confirm.
const newCopyProcesses = () => {
  let out;
  try {
    out = cp.execFileSync(psProgram, ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024, env: { PATH: '/usr/bin:/bin' } });
  } catch { return []; }
  const rows = [];
  for (const line of out.split('\\n')) {
    const m = /^\\s*([0-9]+)\\s+([0-9]+)\\s+(.+?)\\s*$/.exec(line);
    if (m !== null) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3] });
  }
  const shells = new Set(rows.filter((r) => r.comm === exe && r.pid !== process.pid && r.pid > 1).map((r) => r.pid));
  const starting = readJson(STARTING, ['pid', 'version']);
  const claimed = starting !== null && starting.version === version ? starting.pid : null;
  return rows
    .filter((r) => r.pid !== process.pid && r.pid > 1)
    .filter((r) => shells.has(r.pid) || (shells.has(r.ppid) && r.comm.startsWith(app + '/')) || (r.pid === claimed && r.comm === exe))
    .map((r) => r.pid);
};
const stopNewCopy = async () => {
  const first = newCopyProcesses();
  for (const p of first) { try { process.kill(p, 'SIGTERM'); } catch {} }
  for (let i = 0; i < 50 && newCopyProcesses().length > 0; i += 1) await sleep(100);
  for (const p of newCopyProcesses()) { try { process.kill(p, 'SIGKILL'); } catch {} }
  await sleep(200);
  return newCopyProcesses().length === 0;
};
const moveBack = async (from) => {
  for (let i = 0; i < 3; i += 1) {
    try { fs.renameSync(from, app); return true; } catch { await sleep(200); }
  }
  return false;
};
(async () => {
  for (let waited = 0; alive(pid); waited += 100) {
    if (waited >= timeout) done(3, 'not_quit', true);
    await sleep(100);
  }
  try { if (!fs.lstatSync(staged).isDirectory()) throw new Error(); } catch { await launch(app); done(4, 'swap_failed', true); }
  unlink(HEALTH);
  unlink(PENDING);
  try { fs.mkdirSync(path.dirname(aside), { recursive: true, mode: 0o700 }); } catch {}
  try { fs.renameSync(app, aside); } catch (e) {
    await launch(app);
    done(4, denied(e) ? 'not_permitted' : 'swap_failed', true);
  }
  try { fs.renameSync(staged, app); } catch (e) {
    const reason = denied(e) ? 'not_permitted' : 'swap_failed';
    if (!(await moveBack(aside))) {
      if (!exists(app)) { try { fs.renameSync(staged, app); } catch {} }
      await launch(app);
      done(5, 'rollback_incomplete', false);
    }
    await launch(app);
    done(4, reason, true);
  }
  const nonce = process.pid.toString(36) + '-' + process.hrtime.bigint().toString(36) + '-' + Date.now().toString(36);
  try { writeAtomic(PENDING, JSON.stringify({ version, nonce })); } catch {}
  await launch(app);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const h = readJson(HEALTH, ['nonce', 'pid', 'version']);
    if (h !== null && h.version === version && h.nonce === nonce) done(0, null, true);
    await sleep(250);
  }
  const stopped = await stopNewCopy();
  try { fs.mkdirSync(path.dirname(failedCopy), { recursive: true, mode: 0o700 }); } catch {}
  try { fs.renameSync(app, failedCopy); } catch {
    // The new copy is still at the path (runnable); the old one stays in previous/.
    done(5, 'rollback_incomplete', false);
  }
  if (!(await moveBack(aside))) {
    // Never leave the path empty: put the new copy back, keep the old one in previous/.
    try { fs.renameSync(failedCopy, app); } catch {}
    await launch(app);
    done(5, 'rollback_incomplete', false);
  }
  await launch(app);
  // A copy that could not be stopped keeps its folder until the sweeper (install.ts) removes it.
  done(2, 'unhealthy', stopped);
})();
`;

/** Starts a process that outlives the app (stdio ignored, own process group, unref'd). */
export type SpawnDetached = (command: string, args: readonly string[]) => void;

/** The fixed environment of the watchdog: nothing inherited (no NODE_OPTIONS, no ELECTRON_*). */
export const WATCHDOG_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
});

type SpawnImpl = (
  command: string,
  args: string[],
  options: { detached: true; stdio: 'ignore'; cwd: string; env: Record<string, string> },
) => { unref(): void; on(event: 'error', listener: () => void): unknown };

/** A SpawnDetached on `spawnImpl` (node:child_process spawn in the app; a fake in tests). */
export function detachedSpawner(spawnImpl: SpawnImpl): SpawnDetached {
  return (command, args) => {
    const child = spawnImpl(command, [...args], {
      detached: true,
      stdio: 'ignore',
      cwd: '/',
      env: { ...WATCHDOG_ENV },
    });
    child.on('error', () => undefined);
    child.unref();
  };
}

/** The real detached spawn. */
export const spawnDetached: SpawnDetached = detachedSpawner((command, args, options) =>
  spawn(command, args, options),
);

/** The installed copy's bundled `node` (it keeps running after its bundle is renamed aside). */
export function bundledNode(currentApp: string): string {
  return bundleFilePaths(join(currentApp, 'Contents', 'Resources'), 'darwin').node!;
}

/** Starts the watchdog; the caller then quits the app. */
export function startWatchdog(plan: SwapPlan, spawnDetachedImpl: SpawnDetached): void {
  // The same argument rules as the watchdog's own (it would exit 64 after the app quit otherwise).
  const clean = (p: string): boolean => isAbsolute(p) && normalize(p) === p && !p.endsWith('/');
  if (
    !Number.isSafeInteger(plan.pid) ||
    plan.pid < 1 ||
    !clean(plan.currentApp) ||
    basename(plan.currentApp) !== 'AgentLink.app' ||
    !clean(plan.stateDir) ||
    !clean(plan.stagingDir) ||
    dirname(plan.stagingDir) !== join(plan.stateDir, 'updates') ||
    !clean(plan.launcher) ||
    !clean(plan.ps)
  )
    throw new InstallRefusal('swap_failed');
  try {
    spawnDetachedImpl(bundledNode(plan.currentApp), [
      '-e',
      WATCHDOG_SOURCE,
      '--',
      ...watchdogArgs(plan),
    ]);
  } catch {
    throw new InstallRefusal('swap_failed');
  }
}
