// WIN-INAPP-UPDATE: "Update now" → "Restart now" on the Windows app. The shell downloads the signed
// manifest's NSIS setup into a private staging folder, checks its size and SHA-256, copies the bundled
// node.exe next to it (the installer replaces the installed one), and on "Restart now" checks the
// setup again and starts a detached watchdog: it waits for the app to exit, moves the installed copy
// aside, runs the setup silently (/S), starts the new copy and waits for its health nonce; any failure
// puts the old copy back, starts it and records the version as failed.
//
// Everything runs in temp folders on this computer with fakes: the "setup" is a shell script, the
// launcher, tasklist and taskkill are fake scripts. No real installer or app is ever run.
import { spawn } from 'node:child_process';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSha256, encodeHex } from '@4thtech-io/crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InAppUpdater, inAppEnabled, type InstallHooks } from '../../src/main/updater/in-app.js';
import { failedReasonCode } from '../../src/main/updater/install-refusal.js';
import type { InstallOutcome } from '../../src/main/updater/install.js';
import {
  INSTALLER_SILENT,
  STAGED_NODE,
  WIN_HEALTH_TIMEOUT_MS,
  RECOVERY_FILE,
  RUNONCE_KEY,
  RUNONCE_VALUE,
  WIN_WATCHDOG_SOURCE,
  afterHealthyStartWin,
  installUpdateWin,
  installerIdentity,
  winInstallDirOf,
  winTools,
  winWatchdogArgs,
  winWatchdogEnv,
} from '../../src/main/updater/install-win.js';
import type { AcceptedUpdate, UpdateAsset } from '../../src/main/updater/manifest.js';
import { HEALTH_FILE, PENDING_FILE } from '../../src/main/updater/health.js';
import { FAILED_REASONS, loadFailedRecord } from '../../src/main/updater/state.js';
import {
  isAppUpdatePipeView,
  winDownloadUrl,
  type AppUpdateView,
} from '../../src/shared/app-update.js';

const sha = (b: Uint8Array): string => encodeHex(createSha256().update(b).digest());
const SETUP = 'AgentLink-0.5.3-win-x64-setup.exe';
const SETUP_URL = `https://github.com/4thtech/agentlink/releases/download/v0.5.3/${SETUP}`;
const LOCAL = 'C:\\Users\\ana\\AppData\\Local';
const WIN_EXEC = `${LOCAL}\\Programs\\AgentLink\\AgentLink.exe`;

const nsisAsset = (bytes: Uint8Array): UpdateAsset => ({
  platform: 'win32',
  arch: 'x64',
  kind: 'nsis',
  url: SETUP_URL,
  sha256: sha(bytes),
  size: bytes.length,
});
const accepted = (bytes: Uint8Array): AcceptedUpdate => ({
  version: '0.5.3',
  required: false,
  asset: nsisAsset(bytes),
});
const fetchBytes = (bytes: Uint8Array) => async (): Promise<Response> =>
  new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'win-upd-test-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// --- where the app is, and whether it may update itself -------------------------------------------

describe('the Windows copy that may update itself (WIN-INAPP-UPDATE)', () => {
  it('only the per-user install folder the setup uses: %LOCALAPPDATA%\\Programs\\AgentLink', () => {
    expect(winInstallDirOf(WIN_EXEC, LOCAL)).toBe(`${LOCAL}\\Programs\\AgentLink`);
    // Case does not matter on Windows.
    expect(winInstallDirOf(WIN_EXEC.toLowerCase(), LOCAL)).toBe(
      `${LOCAL}\\Programs\\AgentLink`.toLowerCase(),
    );
    for (const other of [
      'D:\\Portable\\AgentLink\\AgentLink.exe',
      `${LOCAL}\\Programs\\AgentLink\\sub\\AgentLink.exe`,
      `${LOCAL}\\Programs\\AgentLink\\electron.exe`,
      `${LOCAL}\\Programs\\AgentLink\\..\\AgentLink\\AgentLink.exe`,
      '\\\\server\\share\\AgentLink\\AgentLink.exe',
    ])
      expect(winInstallDirOf(other, LOCAL)).toBeNull();
    expect(winInstallDirOf(WIN_EXEC, undefined)).toBeNull();
    expect(winInstallDirOf(WIN_EXEC, 'relative\\Local')).toBeNull();
  });

  it('inAppEnabled: on for the packaged Windows install with the pinned key; off otherwise', () => {
    const base = {
      platform: 'win32',
      packaged: true,
      preview: false,
      execPath: WIN_EXEC,
      localAppData: LOCAL,
    };
    expect(inAppEnabled(base)).toBe(true);
    expect(inAppEnabled({ ...base, packaged: false })).toBe(false);
    expect(inAppEnabled({ ...base, preview: true })).toBe(false);
    expect(inAppEnabled({ ...base, execPath: 'D:\\x\\AgentLink.exe' })).toBe(false);
    expect(
      inAppEnabled({
        ...base,
        root: { rootPublicKey: 'PLACEHOLDER', minimumStatementSequence: 0 },
      }),
    ).toBe(false);
    expect(inAppEnabled({ ...base, platform: 'linux' })).toBe(false);
  });

  it('the fixed Windows tools come from %SystemRoot% by absolute path', () => {
    expect(winTools('C:\\Windows')).toEqual({
      launcher: 'C:\\Windows\\explorer.exe',
      tasklist: 'C:\\Windows\\System32\\tasklist.exe',
      taskkill: 'C:\\Windows\\System32\\taskkill.exe',
      reg: 'C:\\Windows\\System32\\reg.exe',
    });
    expect(winTools(undefined)).toBeNull();
    expect(winTools('Windows')).toBeNull();
    expect(winTools('C:\\Windows\\..\\Temp')).toBeNull();
  });

  it('the watchdog gets a fixed environment: no NODE_OPTIONS, no ELECTRON_*, TEMP in the staging folder', () => {
    const env = winWatchdogEnv({
      systemRoot: 'C:\\Windows',
      userProfile: 'C:\\Users\\ana',
      localAppData: LOCAL,
      appData: 'C:\\Users\\ana\\AppData\\Roaming',
      temp: 'C:\\Users\\ana\\AppData\\Roaming\\AgentLink\\updates\\u-abc123\\tmp',
    });
    expect(Object.keys(env).sort()).toEqual([
      'APPDATA',
      'LOCALAPPDATA',
      'PATH',
      'SystemRoot',
      'TEMP',
      'TMP',
      'USERPROFILE',
      'windir',
    ]);
    expect(env['PATH']).toBe('C:\\Windows\\System32;C:\\Windows');
    expect(env['TEMP']).toBe(env['TMP']);
  });
});

// --- the page on Windows ----------------------------------------------------------------------------

describe('Settings › Updates on Windows: Update now, not the download steps', () => {
  const AVAILABLE: AppUpdateView = {
    state: 'available',
    current: '0.5.2',
    latest: '0.5.3',
    download: winDownloadUrl('0.5.3'),
  };
  it('offers Update now with the Windows link; progress and Restart now follow', async () => {
    let hooks: InstallHooks | undefined;
    const bytes = new Uint8Array(8).fill(1);
    const updater = new InAppUpdater({
      enabled: true,
      currentVersion: '0.5.2',
      arch: 'x64',
      platform: 'win32',
      check: async () => accepted(bytes),
      install: (_a, h) => {
        hooks = h;
        return new Promise<InstallOutcome>(() => undefined);
      },
      onChange: () => undefined,
    });
    await updater.check();
    const view = updater.view(AVAILABLE);
    expect(view).toEqual({ ...AVAILABLE, installable: true, percent: 0 });
    expect(isAppUpdatePipeView(view)).toBe(true);
    expect(updater.install()).toBe(true);
    expect(updater.install()).toBe(false); // a second click starts nothing
    for (let i = 0; i < 100 && hooks === undefined; i += 1) await new Promise((r) => setTimeout(r));
    hooks!.onProgress(50, 100);
    expect(updater.view(AVAILABLE)).toMatchObject({ state: 'downloading', percent: 50 });
    expect(isAppUpdatePipeView(updater.view(AVAILABLE))).toBe(true);
  });

  it('after a failed update, the next launch says so: install_failed with the download link', async () => {
    const updater = new InAppUpdater({
      enabled: true,
      currentVersion: '0.5.2',
      arch: 'x64',
      platform: 'win32',
      check: async () => undefined, // the manifest refuses the failed version (failed_version)
      failedVersion: async () => '0.5.3',
      install: () => new Promise<InstallOutcome>(() => undefined),
      onChange: () => undefined,
    });
    await updater.check();
    const view = updater.view(AVAILABLE);
    expect(view).toEqual({ ...AVAILABLE, state: 'install_failed', installable: false, percent: 0 });
    expect(isAppUpdatePipeView(view)).toBe(true);
  });
});

// --- download, verify, stage, start the watchdog ------------------------------------------------------

describe('installUpdateWin: download, verify, then the watchdog (WIN-INAPP-UPDATE)', () => {
  async function setup() {
    const installDir = join(root, 'Programs', 'AgentLink');
    await mkdir(join(installDir, 'resources', 'node'), { recursive: true });
    await writeFile(join(installDir, 'AgentLink.exe'), '0.5.2');
    const node = join(installDir, 'resources', 'node', 'node.exe');
    await writeFile(node, 'node 22');
    return { installDir, node, stateDir: join(root, 'state') };
  }
  const tools = {
    launcher: '/x/explorer.exe',
    tasklist: '/x/tasklist.exe',
    taskkill: '/x/taskkill.exe',
    reg: '/x/reg.exe',
  };
  // The installed app's bundle-hashes.json (app.asar): the staged node.exe must match it.
  const record = async (): Promise<string> =>
    JSON.stringify({ v: 1, files: { node: sha(new TextEncoder().encode('node 22')) } });

  it('verifies size + SHA-256, copies node.exe, waits for Restart now, checks again, starts the watchdog', async () => {
    const s = await setup();
    const bytes = new Uint8Array(64).fill(7);
    const spawned: { cmd: string; args: readonly string[]; env: Record<string, string> }[] = [];
    const steps: string[] = [];
    let release: () => void = () => undefined;
    const done = installUpdateWin({
      accepted: accepted(bytes),
      stateDir: s.stateDir,
      installDir: s.installDir,
      pid: 4242,
      fetch: fetchBytes(bytes),
      installedNode: s.node,
      readRecord: record,
      env: { SystemRoot: 'C:\\Windows' },
      tools,
      spawnDetached: (cmd, args, env) => spawned.push({ cmd, args, env }),
      onProgress: (d, t) => steps.push(`p${String(Math.floor((d * 100) / t))}`),
      onVerifying: () => steps.push('verifying'),
      confirmRestart: () =>
        new Promise<void>((resolve) => {
          steps.push('ready');
          release = resolve;
        }),
    });
    for (let i = 0; i < 200 && !steps.includes('ready'); i += 1)
      await new Promise((r) => setTimeout(r, 5));
    expect(steps).toEqual(['p100', 'verifying', 'ready']);
    expect(spawned).toEqual([]); // nothing runs before the click
    release();
    expect(await done).toEqual({ kind: 'restarting', version: '0.5.3' });
    expect(spawned).toHaveLength(1);
    const [{ cmd, args, env }] = spawned as [(typeof spawned)[number]];
    const staging = join(s.stateDir, 'updates', (await readdir(join(s.stateDir, 'updates')))[0]!);
    // The watchdog runs from a copy of node.exe in the staging folder (the setup replaces the
    // installed one), never from the install folder.
    expect(cmd).toBe(join(staging, STAGED_NODE));
    expect(await readFile(cmd, 'utf8')).toBe('node 22');
    expect(args.slice(0, 3)).toEqual(['-e', WIN_WATCHDOG_SOURCE, '--']);
    const plan = args.slice(3);
    expect(plan).toEqual(
      winWatchdogArgs({
        pid: 4242,
        installDir: s.installDir,
        stagingDir: staging,
        stateDir: s.stateDir,
        version: '0.5.3',
        installer: join(staging, SETUP),
        installerId: await installerIdentity(join(staging, SETUP)),
        launcher: tools.launcher,
        timeoutMs: WIN_HEALTH_TIMEOUT_MS,
        tasklist: tools.tasklist,
        taskkill: tools.taskkill,
        reg: tools.reg,
        size: 64,
      }),
    );
    expect(plan).toHaveLength(13);
    expect(env['TEMP']).toBe(join(staging, 'tmp'));
    expect(env['SystemRoot']).toBe('C:\\Windows');
    expect(sha(await readFile(join(staging, SETUP)))).toBe(sha(bytes));
  });

  it('a setup changed on disk between the check and Restart now is refused; nothing runs', async () => {
    const s = await setup();
    const bytes = new Uint8Array(64).fill(7);
    const spawned: string[] = [];
    const outcome = await installUpdateWin({
      accepted: accepted(bytes),
      stateDir: s.stateDir,
      installDir: s.installDir,
      pid: 4242,
      fetch: fetchBytes(bytes),
      installedNode: s.node,
      readRecord: record,
      env: {},
      tools,
      spawnDetached: (cmd) => spawned.push(cmd),
      confirmRestart: async () => {
        const updates = join(s.stateDir, 'updates');
        const dir = join(updates, (await readdir(updates))[0]!);
        await writeFile(join(dir, SETUP), new Uint8Array(64).fill(8));
      },
    });
    expect(outcome).toEqual({ kind: 'fallback', code: 'hash_mismatch' });
    expect(spawned).toEqual([]);
    expect(await readdir(join(s.stateDir, 'updates'))).toEqual([]);
  });

  it('refuses a wrong hash, a non-NSIS asset and a copy outside its install folder, before running anything', async () => {
    const s = await setup();
    const bytes = new Uint8Array(64).fill(7);
    const base = {
      stateDir: s.stateDir,
      installDir: s.installDir,
      pid: 1,
      fetch: fetchBytes(bytes),
      installedNode: s.node,
      readRecord: record,
      env: {},
      tools,
      spawnDetached: () => {
        throw new Error('must not start');
      },
    };
    expect(
      await installUpdateWin({
        ...base,
        accepted: { ...accepted(bytes), asset: { ...nsisAsset(bytes), sha256: 'ee'.repeat(32) } },
      }),
    ).toEqual({ kind: 'fallback', code: 'hash_mismatch' });
    expect(
      await installUpdateWin({
        ...base,
        accepted: {
          ...accepted(bytes),
          asset: { ...nsisAsset(bytes), platform: 'darwin', kind: 'zip' },
        },
      }),
    ).toEqual({ kind: 'fallback', code: 'not_zip' });
    expect(
      await installUpdateWin({
        ...base,
        accepted: accepted(bytes),
        installDir: join(root, 'nope'),
      }),
    ).toEqual({ kind: 'fallback', code: 'not_in_place' });
    // IR Fable r1: a node.exe that is not the one in bundle-hashes.json (or no record) never runs.
    for (const readRecord of [
      async () => JSON.stringify({ v: 1, files: { node: 'ab'.repeat(32) } }),
      async () => null,
    ])
      expect(await installUpdateWin({ ...base, accepted: accepted(bytes), readRecord })).toEqual({
        kind: 'fallback',
        code: 'bundle_hashes',
      });
    expect(await readdir(join(s.stateDir, 'updates')).catch(() => [])).toEqual([]);
  });
});

// --- the watchdog itself (real node, fake tools) -----------------------------------------------------

describe('Windows watchdog: wait, move aside, silent setup, relaunch, health or rollback', () => {
  async function setup() {
    const programs = join(root, 'Programs');
    const installDir = join(programs, 'AgentLink');
    await mkdir(installDir, { recursive: true });
    await writeFile(join(installDir, 'AgentLink.exe'), '0.5.2');
    await writeFile(join(installDir, 'data-of-old.txt'), 'old');
    const state = join(root, 'state');
    const staging = join(state, 'updates', 'u-abc123');
    await mkdir(staging, { recursive: true });
    const tools = join(root, 'tools');
    await mkdir(tools);
    const log = join(tools, 'log');
    // The fake setup: records its arguments; FAKE_MODE ok → writes the new copy; fail → leaves a
    // half-written folder and exits 1; empty → exits 0 without writing anything.
    const installer = join(staging, SETUP);
    await writeFile(
      installer,
      `#!/bin/sh
echo "setup $*" >> "$FAKE_LOG"
case "$FAKE_MODE" in
  ok) mkdir -p "$FAKE_DIR"; printf 0.5.3 > "$FAKE_DIR/AgentLink.exe"; exit 0 ;;
  slow) mkdir -p "$FAKE_DIR"; printf partial > "$FAKE_DIR/junk"; echo $$ > "$FAKE_SETUP_PID"; sleep 30; exit 0 ;;
  fail) mkdir -p "$FAKE_DIR"; printf partial > "$FAKE_DIR/junk"; exit 1 ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    const js = join(tools, 'fake-explorer.cjs');
    await writeFile(
      js,
      `const fs = require('fs'); const path = require('path');
const exe = process.argv[2];
const v = fs.readFileSync(exe, 'utf8');
fs.appendFileSync(process.env.FAKE_LOG, 'launch ' + v + '\\n');
if (v === process.env.HEALTHY) {
  const state = process.env.FAKE_STATE;
  const p = JSON.parse(fs.readFileSync(path.join(state, ${JSON.stringify(PENDING_FILE)}), 'utf8'));
  fs.writeFileSync(path.join(state, ${JSON.stringify(HEALTH_FILE)}), JSON.stringify({ version: v, pid: process.pid, nonce: p.nonce }));
}
`,
    );
    const launcher = join(tools, 'explorer.sh');
    await writeFile(launcher, `#!/bin/sh\nexec "$FAKE_NODE" "${js}" "$@"\n`, { mode: 0o755 });
    const tasklist = join(tools, 'tasklist.sh');
    await writeFile(tasklist, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // The fake reg.exe: `add … /d <command> /f` keeps the command in runonce.txt; `delete` removes it.
    const reg = join(tools, 'reg.sh');
    const runOnce = join(tools, 'runonce.txt');
    await writeFile(
      reg,
      `#!/bin/sh\necho "reg $1 $4" >> "${join(tools, 'reg.log')}"\nif [ "$1" = add ]; then printf '%s' "$8" > "${runOnce}"; else rm -f "${runOnce}"; fi\nexit 0\n`,
      { mode: 0o755 },
    );
    const taskkill = join(tools, 'taskkill.sh');
    await writeFile(taskkill, `#!/bin/sh\necho "taskkill $*" >> "$FAKE_LOG"\nexit 0\n`, {
      mode: 0o755,
    });
    const env = {
      FAKE_LOG: log,
      FAKE_DIR: installDir,
      FAKE_STATE: state,
      FAKE_NODE: process.execPath,
      FAKE_MODE: 'ok',
      FAKE_SETUP_PID: join(tools, 'setup.pid'),
      HEALTHY: 'none',
    };
    const args = async (pid: number, timeoutMs: number): Promise<string[]> =>
      winWatchdogArgs({
        pid,
        installDir,
        stagingDir: staging,
        stateDir: state,
        version: '0.5.3',
        installer,
        installerId: await installerIdentity(installer),
        launcher,
        timeoutMs,
        tasklist,
        taskkill,
        reg,
        size: (await stat(installer)).size,
      });
    return { programs, installDir, state, staging, installer, env, args, log, runOnce, tools };
  }

  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => child.on('exit', r));
    return child.pid!;
  }
  const sleepers: number[] = [];
  afterEach(() => {
    for (const pid of sleepers.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
  });

  function run(args: readonly string[], env: Record<string, string>): Promise<number | null> {
    const child = spawn(process.execPath, ['-e', WIN_WATCHDOG_SOURCE, '--', ...args], {
      env: { ...process.env, ...env },
      stdio: 'ignore',
    });
    return new Promise((r) => child.on('exit', (code) => r(code)));
  }
  const lines = async (log: string): Promise<string[]> =>
    (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  const versionAt = (dir: string): Promise<string> => readFile(join(dir, 'AgentLink.exe'), 'utf8');

  it('success: runs the setup with /S only, starts the new copy, which answers the nonce; the old copy is removed', async () => {
    const s = await setup();
    const code = await run(await s.args(await deadPid(), 5000), { ...s.env, HEALTHY: '0.5.3' });
    expect(code).toBe(0);
    expect(INSTALLER_SILENT).toBe('/S');
    expect(await lines(s.log)).toEqual(['setup /S', 'launch 0.5.3']);
    expect(await versionAt(s.installDir)).toBe('0.5.3');
    // A fresh install: nothing of the old copy is left in the folder, and the aside copy is gone.
    await expect(stat(join(s.installDir, 'data-of-old.txt'))).rejects.toThrow();
    expect((await readdir(s.programs)).sort()).toEqual(['AgentLink']);
    await expect(stat(s.installer)).rejects.toThrow();
    expect(await loadFailedRecord(s.state)).toBeNull();
  });

  it('a setup that fails: the old copy is put back and started; the version is recorded as failed', async () => {
    const s = await setup();
    const code = await run(await s.args(await deadPid(), 5000), { ...s.env, FAKE_MODE: 'fail' });
    expect(code).toBe(6);
    expect(await versionAt(s.installDir)).toBe('0.5.2');
    expect(await readFile(join(s.installDir, 'data-of-old.txt'), 'utf8')).toBe('old');
    await expect(stat(join(s.installDir, 'junk'))).rejects.toThrow();
    expect(await lines(s.log)).toEqual(['setup /S', 'launch 0.5.2']);
    expect(await loadFailedRecord(s.state)).toEqual({
      version: '0.5.3',
      reason: 'installer_failed',
    });
    expect((await readdir(s.programs)).sort()).toEqual(['AgentLink']);
    await expect(stat(s.runOnce)).rejects.toThrow(); // the old copy is back: no recovery entry
  });

  it('a setup that exits 0 but writes no app counts as failed (old copy back)', async () => {
    const s = await setup();
    const code = await run(await s.args(await deadPid(), 5000), { ...s.env, FAKE_MODE: 'empty' });
    expect(code).toBe(6);
    expect(await versionAt(s.installDir)).toBe('0.5.2');
    expect(await loadFailedRecord(s.state)).toEqual({
      version: '0.5.3',
      reason: 'installer_failed',
    });
  });

  it('a setup changed after it was verified is never run; nothing is moved; the old copy starts', async () => {
    const s = await setup();
    const args = await s.args(await deadPid(), 5000);
    await appendFile(s.installer, '\necho tampered >> "$FAKE_LOG"\n');
    const code = await run(args, s.env);
    expect(code).toBe(7);
    expect(await lines(s.log)).toEqual(['launch 0.5.2']);
    expect(await versionAt(s.installDir)).toBe('0.5.2');
    expect(await readFile(join(s.installDir, 'data-of-old.txt'), 'utf8')).toBe('old');
    expect(await loadFailedRecord(s.state)).toEqual({
      version: '0.5.3',
      reason: 'installer_changed',
    });
  });

  it('the new copy does not answer in time: it is replaced by the old copy, which starts', async () => {
    const s = await setup();
    const code = await run(await s.args(await deadPid(), 1500), s.env);
    expect(code).toBe(2);
    expect(await versionAt(s.installDir)).toBe('0.5.2');
    expect(await readFile(join(s.installDir, 'data-of-old.txt'), 'utf8')).toBe('old');
    expect(await lines(s.log)).toEqual(['setup /S', 'launch 0.5.3', 'launch 0.5.2']);
    expect(await loadFailedRecord(s.state)).toEqual({ version: '0.5.3', reason: 'unhealthy' });
    expect((await readdir(s.programs)).sort()).toEqual(['AgentLink']);
  });

  it('the app does not quit: nothing changes, the setup never runs', async () => {
    const s = await setup();
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    });
    c.unref();
    sleepers.push(c.pid!);
    const code = await run(await s.args(c.pid!, 1000), s.env);
    expect(code).toBe(3);
    expect(await lines(s.log)).toEqual([]);
    expect(await versionAt(s.installDir)).toBe('0.5.2');
    expect(await loadFailedRecord(s.state)).toEqual({ version: '0.5.3', reason: 'not_quit' });
  });

  it('bad arguments touch nothing (exit 64)', async () => {
    const s = await setup();
    const good = await s.args(await deadPid(), 5000);
    for (const bad of [
      good.slice(0, 12),
      good.map((a, i) => (i === 12 ? '1' : a)), // not the signed size
      good.map((a, i) => (i === 1 ? join(s.programs, 'Other') : a)), // not the AgentLink folder
      good.map((a, i) => (i === 5 ? join(root, SETUP) : a)), // setup outside the staging folder
      good.map((a, i) => (i === 5 ? join(s.staging, 'evil.exe') : a)), // not the setup's name
      good.map((a, i) => (i === 4 ? '0.5.3; rm -rf /' : a)),
      good.map((a, i) => (i === 8 ? '10' : a)),
    ]) {
      expect(await run(bad, s.env)).toBe(64);
    }
    expect(await lines(s.log)).toEqual([]);
    expect(await versionAt(s.installDir)).toBe('0.5.2');
  });

  it('RunOnce recovery: set before the folder moves, removed once a copy is in place for good', async () => {
    const s = await setup();
    expect(await run(await s.args(await deadPid(), 5000), { ...s.env, HEALTHY: '0.5.3' })).toBe(0);
    expect(await lines(join(s.tools, 'reg.log'))).toEqual([
      `reg add ${RUNONCE_VALUE}`,
      `reg delete ${RUNONCE_VALUE}`,
    ]);
    await expect(stat(s.runOnce)).rejects.toThrow();
  });

  it('the watchdog dies during the setup: the RunOnce command puts the old copy back and starts it', async () => {
    const s = await setup();
    const child = spawn(
      process.execPath,
      ['-e', WIN_WATCHDOG_SOURCE, '--', ...(await s.args(await deadPid(), 5000))],
      {
        env: { ...process.env, ...s.env, FAKE_MODE: 'slow' },
        stdio: 'ignore',
      },
    );
    const setupPid = join(s.tools, 'setup.pid');
    for (
      let i = 0;
      i < 200 &&
      !(await stat(setupPid).then(
        () => true,
        () => false,
      ));
      i += 1
    )
      await new Promise((r) => setTimeout(r, 25));
    child.kill('SIGKILL'); // the computer shut down mid-update
    process.kill(Number((await readFile(setupPid, 'utf8')).trim()), 'SIGKILL');
    await new Promise((r) => child.on('exit', r));
    expect((await readdir(s.programs)).sort()).toEqual([
      'AgentLink',
      'AgentLink.previous-u-abc123',
    ]);
    // What Windows runs at the next logon: "<node>" "<staging>\recover.cjs".
    const command = await readFile(s.runOnce, 'utf8');
    const m = /^"([^"]+)" "([^"]+)"$/.exec(command);
    expect(m).not.toBeNull();
    expect(m![2]).toBe(join(s.staging, RECOVERY_FILE));
    const rec = spawn(m![1]!, [m![2]!], { env: { ...process.env, ...s.env }, stdio: 'ignore' });
    expect(await new Promise((r) => rec.on('exit', (c) => r(c)))).toBe(0);
    expect(await versionAt(s.installDir)).toBe('0.5.2');
    expect(await readFile(join(s.installDir, 'data-of-old.txt'), 'utf8')).toBe('old');
    expect((await readdir(s.programs)).sort()).toEqual(['AgentLink']);
    expect(await loadFailedRecord(s.state)).toEqual({ version: '0.5.3', reason: 'interrupted' });
    for (let i = 0; i < 200 && !(await lines(s.log)).includes('launch 0.5.2'); i += 1)
      await new Promise((r) => setTimeout(r, 25));
    expect(await lines(s.log)).toContain('launch 0.5.2');
    // Run again (nothing aside): it does nothing.
    const again = spawn(m![1]!, [m![2]!], { env: { ...process.env, ...s.env }, stdio: 'ignore' });
    expect(await new Promise((r) => again.on('exit', (c) => r(c)))).toBe(0);
    expect(await versionAt(s.installDir)).toBe('0.5.2');
  });

  it('a healthy start removes the RunOnce entry and left-over folders no watchdog owns', async () => {
    const programs = join(root, 'P2');
    const installDir = join(programs, 'AgentLink');
    const state = join(root, 'state2');
    for (const d of [
      installDir,
      join(programs, 'AgentLink.previous-u-gone01'),
      join(programs, 'AgentLink.failed-u-gone02'),
      join(programs, 'AgentLink.previous-u-busy01'),
      join(programs, 'AgentLink.other'),
      join(state, 'updates', 'u-busy01'),
    ])
      await mkdir(d, { recursive: true });
    const calls: string[][] = [];
    const tidy = (pending?: string) =>
      afterHealthyStartWin({
        stateDir: state,
        installDir,
        version: '0.5.3',
        reg: '/x/reg.exe',
        run: async (cmd, args) => {
          calls.push([cmd, ...args]);
        },
      }).then(() => pending);
    await tidy();
    expect(calls).toEqual([['/x/reg.exe', 'delete', RUNONCE_KEY, '/v', RUNONCE_VALUE, '/f']]);
    expect((await readdir(programs)).sort()).toEqual([
      'AgentLink',
      'AgentLink.other',
      'AgentLink.previous-u-busy01',
    ]);
    // IR Fable r2: also when an update of another version is pending (a copy installed by hand
    // after an interrupted update is never swapped back at the next logon).
    await writeFile(
      join(state, PENDING_FILE),
      JSON.stringify({ version: '0.5.4', nonce: 'n'.repeat(16) }),
    );
    calls.length = 0;
    await tidy();
    expect(calls).toEqual([['/x/reg.exe', 'delete', RUNONCE_KEY, '/v', RUNONCE_VALUE, '/f']]);
  });

  it('the new reasons are fixed and map to fixed refusal codes', () => {
    expect(FAILED_REASONS).toContain('installer_failed');
    expect(FAILED_REASONS).toContain('installer_changed');
    expect(failedReasonCode('installer_failed')).toBe('installer_failed');
    expect(failedReasonCode('installer_changed')).toBe('installer_changed');
    expect(failedReasonCode('interrupted')).toBe('installer_failed');
  });
});
