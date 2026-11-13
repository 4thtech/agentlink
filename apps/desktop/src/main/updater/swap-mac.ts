// UPD-4: swapping the verified AgentLink.app in, from a detached watchdog (A-autoupdate §1.2 step 7).
//
// The app cannot replace its own bundle while it runs, so it starts a small watchdog and quits. The
// watchdog is WATCHDOG_SOURCE below, run by the installed copy's bundled `node` as `node -e <source>
// -- <7 fixed arguments>` (no shell, no file written anywhere, nothing from the network in it):
//   1. waits (≤ 120 s) for the app's process to exit; if it does not, it changes nothing;
//   2. renames the installed bundle to <staging>/previous/AgentLink.app and the new one
//      (<staging>/unpacked/AgentLink.app) into its place: two rename(2) calls on one volume, no copy,
//      so the AI apps' absolute path to the bundled node stays the same;
//   3. launches it (`/usr/bin/open -n <app>`) and waits up to HEALTH_TIMEOUT_MS for the health file
//      (health.ts) naming the new version;
//   4. healthy: removes the staging folder (and the old copy). Not healthy: stops the new copy (its
//      pid from update-starting.json), puts the old bundle back, records `failedVersion` (state.ts
//      format; it is never offered again) and launches the old copy.
//
// Before any of that, preflightSwap refuses what cannot work: not an installed AgentLink.app, a folder
// this user cannot change (a standard user and an admin-installed app), or the data folder on another
// volume (a rename would fail; a copy is never attempted). Those end in the existing download link.
import { constants } from 'node:fs';
import { access, lstat, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { bundleFilePaths } from '../bundle-check.js';
import { HEALTH_FILE, STARTING_FILE } from './health.js';
import { InstallRefusal } from './install-refusal.js';
import { FAILED_FILE } from './state.js';

/** How long the new copy has to report healthy before it is rolled back. */
export const HEALTH_TIMEOUT_MS = 90_000;
/** The launcher the watchdog uses in a real install (tests pass a fake). */
export const OPEN = '/usr/bin/open';
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
  /** `<stateDir>/updates/<random>`, holding `unpacked/AgentLink.app`. */
  readonly stagingDir: string;
  readonly stateDir: string;
  readonly version: string;
  readonly launcher: string;
  readonly timeoutMs: number;
}

/** The watchdog's 7 positional arguments, in order. */
export function watchdogArgs(plan: SwapPlan): string[] {
  return [
    String(plan.pid),
    plan.currentApp,
    plan.stagingDir,
    plan.stateDir,
    plan.version,
    plan.launcher,
    String(plan.timeoutMs),
  ];
}

/**
 * The watchdog (plain CommonJS for `node -e`, Node built-ins only). Exit codes: 0 updated, 2 rolled
 * back, 3 the app did not quit (nothing changed), 4 the swap did not start (old copy relaunched),
 * 5 rollback incomplete, 64 bad arguments (nothing touched). It writes nothing to stdout or a log.
 */
export const WATCHDOG_SOURCE = `'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const a = process.argv.slice(1);
const VERSION = /^(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})(-beta\\.(0|[1-9][0-9]{0,5}))?$/;
const clean = (p) => typeof p === 'string' && path.isAbsolute(p) && path.normalize(p) === p && !p.endsWith('/');
if (a.length !== 7) process.exit(64);
const pid = Number(a[0]);
const [, app, staging, state, version, launcher] = a;
const timeout = Number(a[6]);
if (!Number.isSafeInteger(pid) || pid < 1) process.exit(64);
if (!clean(app) || path.basename(app) !== 'AgentLink.app') process.exit(64);
if (!clean(state) || !clean(staging) || path.dirname(staging) !== path.join(state, 'updates')) process.exit(64);
if (!VERSION.test(version) || !clean(launcher)) process.exit(64);
if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 600000) process.exit(64);
const staged = path.join(staging, ${JSON.stringify(UNPACKED_DIR)}, 'AgentLink.app');
const aside = path.join(staging, ${JSON.stringify(PREVIOUS_DIR)}, 'AgentLink.app');
const failedCopy = path.join(staging, 'failed', 'AgentLink.app');
const HEALTH = path.join(state, ${JSON.stringify(HEALTH_FILE)});
const STARTING = path.join(state, ${JSON.stringify(STARTING_FILE)});
const FAILED = path.join(state, ${JSON.stringify(FAILED_FILE)});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readRecord = (file) => {
  try {
    const t = fs.readFileSync(file, 'utf8');
    if (t.length > 256) return null;
    const v = JSON.parse(t);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    if (Object.keys(v).sort().join(',') !== 'pid,version') return null;
    if (v.version !== version || !Number.isSafeInteger(v.pid) || v.pid < 2) return null;
    return v;
  } catch { return null; }
};
const launch = (target) => new Promise((resolve) => {
  let child;
  try { child = cp.spawn(launcher, ['-n', target], { stdio: 'ignore', cwd: '/' }); } catch { resolve(); return; }
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 15000);
  child.on('error', () => { clearTimeout(timer); resolve(); });
  child.on('exit', () => { clearTimeout(timer); resolve(); });
});
const unlink = (f) => { try { fs.unlinkSync(f); } catch {} };
const recordFailed = () => {
  try {
    fs.mkdirSync(state, { recursive: true, mode: 0o700 });
    const tmp = FAILED + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ failedVersion: version }) + '\\n', { mode: 0o600 });
    fs.renameSync(tmp, FAILED);
  } catch {}
};
(async () => {
  for (let i = 0; alive(pid); i += 1) {
    if (i >= 1200) process.exit(3);
    await sleep(100);
  }
  try { if (!fs.lstatSync(staged).isDirectory()) throw new Error(); } catch { await launch(app); process.exit(4); }
  unlink(HEALTH);
  unlink(STARTING);
  try { fs.mkdirSync(path.dirname(aside), { recursive: true, mode: 0o700 }); } catch {}
  try { fs.renameSync(app, aside); } catch { await launch(app); process.exit(4); }
  try { fs.renameSync(staged, app); } catch {
    try { fs.renameSync(aside, app); } catch { process.exit(5); }
    await launch(app);
    process.exit(4);
  }
  await launch(app);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (readRecord(HEALTH) !== null) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
      process.exit(0);
    }
    await sleep(250);
  }
  const starting = readRecord(STARTING);
  if (starting !== null && starting.pid !== process.pid && alive(starting.pid)) {
    try { process.kill(starting.pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 50 && alive(starting.pid); i += 1) await sleep(100);
    if (alive(starting.pid)) { try { process.kill(starting.pid, 'SIGKILL'); } catch {} }
  }
  recordFailed();
  try {
    fs.mkdirSync(path.dirname(failedCopy), { recursive: true, mode: 0o700 });
    fs.renameSync(app, failedCopy);
    fs.renameSync(aside, app);
  } catch { process.exit(5); }
  await launch(app);
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
  process.exit(2);
})();
`;

/** Starts a process that outlives the app (stdio ignored, own process group, unref'd). */
export type SpawnDetached = (command: string, args: readonly string[]) => void;

/** The installed copy's bundled `node` (it keeps running after its bundle is renamed aside). */
export function bundledNode(currentApp: string): string {
  return bundleFilePaths(join(currentApp, 'Contents', 'Resources'), 'darwin').node!;
}

/** Starts the watchdog; the caller then quits the app. */
export function startWatchdog(plan: SwapPlan, spawnDetached: SpawnDetached): void {
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
    !clean(plan.launcher)
  )
    throw new InstallRefusal('swap_failed');
  try {
    spawnDetached(bundledNode(plan.currentApp), [
      '-e',
      WATCHDOG_SOURCE,
      '--',
      ...watchdogArgs(plan),
    ]);
  } catch {
    throw new InstallRefusal('swap_failed');
  }
}
