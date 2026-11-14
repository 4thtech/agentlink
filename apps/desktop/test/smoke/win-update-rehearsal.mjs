// WIN-INAPP-UPDATE: a rehearsal of the Windows in-app update on the THROWAWAY Windows CI runner, with
// the setup this run just built and the shell's real watchdog (apps/desktop/dist, tsc output of
// src/main/updater/install-win.ts). Never run on a person's computer: it installs AgentLink into this
// user's %LOCALAPPDATA%\Programs\AgentLink and starts it. desktop.yml runs it after the smoke test.
//
//   1. the setup installs silently (/S) into the one per-user folder;
//   2. it upgrades in place silently over an installed copy; the data folders and a desktop shortcut
//      stay as they were;
//   3. while a file of the installed copy is in use, a silent run stops with exit code 2 and changes
//      nothing;
//   4. the watchdog: waits while the install folder is in use, moves it aside, runs the setup, starts
//      AgentLink through Explorer, takes the health answer (written here, as the new app would), and
//      removes the old copy;
//   5. a setup that fails (exit ≠ 0): the old copy is back, `installer_failed` is recorded;
//   6. a setup changed after it was verified: never run, `installer_changed` is recorded.
// Prints fixed words only. Usage: node win-update-rehearsal.mjs --setup <AgentLink-…-setup.exe>
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
// The shell's tsc output (desktop.yml runs `pnpm --filter @4thtech-io/desktop run build` first).
import * as win from '../../dist/main/updater/install-win.js';
import * as health from '../../dist/main/updater/health.js';
import * as state from '../../dist/main/updater/state.js';

if (process.platform !== 'win32') {
  console.log('win-update-rehearsal: Windows only, skipped.');
  process.exit(0);
}

const { values } = parseArgs({ options: { setup: { type: 'string' } } });
if (typeof values.setup !== 'string') throw new Error('--setup <setup.exe> is required.');

const env = process.env;
const LOCAL = env.LOCALAPPDATA;
const SYSTEM_ROOT = env.SystemRoot;
const installDir = join(LOCAL, 'Programs', 'AgentLink');
const exe = join(installDir, 'AgentLink.exe');
const nodeInApp = join(installDir, 'resources', 'node', 'node.exe');
const VERSION = '9.9.9';
const SETUP_NAME = `AgentLink-${VERSION}-win-x64-setup.exe`;
const tools = win.winTools(SYSTEM_ROOT);
const where = join(SYSTEM_ROOT, 'System32', 'where.exe');

const fail = (what) => {
  console.error(`win-update-rehearsal: FAILED: ${what}`);
  process.exit(1);
};
const ok = (what) => console.log(`win-update-rehearsal: ok: ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runSetup = (path) =>
  spawnSync(path, ['/S'], { stdio: 'ignore', timeout: 10 * 60_000 }).status;
const siblings = () =>
  readdirSync(join(LOCAL, 'Programs')).filter((n) => n.startsWith('AgentLink'));
const stopApp = () => {
  try {
    execFileSync(tools.taskkill, ['/IM', 'AgentLink.exe', '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // none running
  }
};

// 1. First install.
if (existsSync(installDir)) fail('the runner already has an install folder');
if (runSetup(values.setup) !== 0 || !existsSync(exe)) fail('silent first install');
ok('silent first install into %LOCALAPPDATA%\\Programs\\AgentLink');

// 2. In place, silently; the person's things stay.
const sentinels = [
  join(env.USERPROFILE, '.agentlink', 'rehearsal.txt'),
  join(env.APPDATA, 'AgentLink', 'rehearsal.txt'),
  join(env.USERPROFILE, 'Desktop', 'AgentLink.lnk'),
];
for (const s of sentinels) {
  mkdirSync(join(s, '..'), { recursive: true });
  writeFileSync(s, 'kept');
}
writeFileSync(join(installDir, 'resources', 'stale-from-old.txt'), 'old');
if (runSetup(values.setup) !== 0 || !existsSync(exe)) fail('silent in-place upgrade');
if (existsSync(join(installDir, 'resources', 'stale-from-old.txt'))) fail('old resources stayed');
const keptAll = () => sentinels.every((s) => existsSync(s) && readFileSync(s, 'utf8') === 'kept');
if (!keptAll()) fail('data folders or the desktop shortcut changed');
ok('silent in-place upgrade; data folders and desktop shortcut kept');

// 3. A file in use: the silent run stops with 2, nothing changes.
const holder = spawn(nodeInApp, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
await sleep(1000);
const busy = runSetup(values.setup);
holder.kill();
await sleep(1000);
if (busy !== 2) fail(`a silent run over a running copy exited ${String(busy)}, not 2`);
ok('a silent run over a running copy stops with exit code 2');

// The watchdog, as the app starts it: node.exe copied into the staging folder, fixed environment.
const stateDir = mkdtempSync(join(tmpdir(), 'agentlink-rehearsal-'));
async function watchdog(tag, setupFrom, opts = {}) {
  const staging = join(stateDir, 'updates', tag);
  mkdirSync(join(staging, 'tmp'), { recursive: true });
  const installer = join(staging, SETUP_NAME);
  copyFileSync(setupFrom, installer);
  const node = join(staging, 'node.exe');
  copyFileSync(process.execPath, node);
  const installerId = await win.installerIdentity(installer);
  opts.before?.(installer);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const args = win.winWatchdogArgs({
    pid: dead,
    installDir,
    stagingDir: staging,
    stateDir,
    version: VERSION,
    installer,
    installerId,
    launcher: opts.launcher ?? where,
    timeoutMs: 60_000,
    tasklist: tools.tasklist,
    taskkill: tools.taskkill,
  });
  const wdEnv = {
    ...win.winWatchdogEnv({
      systemRoot: SYSTEM_ROOT,
      userProfile: env.USERPROFILE,
      localAppData: LOCAL,
      appData: env.APPDATA,
      temp: join(staging, 'tmp'),
    }),
  };
  const child = spawn(node, ['-e', win.WIN_WATCHDOG_SOURCE, '--', ...args], {
    stdio: 'ignore',
    cwd: staging,
    env: wdEnv,
    windowsHide: true,
  });
  let answered = false;
  const answer = setInterval(() => {
    // The new app's part (health.ts): answer the pending nonce once it is there.
    if (!opts.answer || answered) return;
    try {
      const p = JSON.parse(readFileSync(join(stateDir, health.PENDING_FILE), 'utf8'));
      writeFileSync(
        join(stateDir, health.HEALTH_FILE),
        JSON.stringify({ version: VERSION, pid: 4242, nonce: p.nonce }),
      );
      answered = true;
    } catch {
      // not yet
    }
  }, 200);
  const code = await new Promise((r) => child.on('exit', (c) => r(c)));
  clearInterval(answer);
  return code;
}

// 4. Success, with the install folder held for 3 s (the watchdog waits) and the real Explorer launch.
const exeBefore = readFileSync(exe);
const hold = spawn(nodeInApp, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' });
await sleep(500);
const success = await watchdog('u-rehea1', values.setup, {
  answer: true,
  launcher: tools.launcher,
});
hold.kill();
if (success !== 0) fail(`the watchdog's update exited ${String(success)}, not 0`);
if (!existsSync(exe) || siblings().join(',') !== 'AgentLink') fail('the old copy was not removed');
if (!keptAll()) fail('data folders or the desktop shortcut changed during the update');
let started = false;
for (let i = 0; i < 60 && !started; i += 1) {
  const out = spawnSync(
    tools.tasklist,
    ['/FI', 'IMAGENAME eq AgentLink.exe', '/FO', 'CSV', '/NH'],
    {
      encoding: 'utf8',
    },
  ).stdout;
  started = /"AgentLink\.exe"/i.test(out ?? '');
  if (!started) await sleep(1000);
}
if (!started) fail('AgentLink was not started through Explorer');
ok(
  'watchdog: waited, moved aside, ran the setup silently, started AgentLink, removed the old copy',
);
stopApp();
await sleep(3000);

// 5. A setup that fails (node.exe under the setup's name: `/S` is no script, exit 1).
const failed = await watchdog('u-rehea2', process.execPath);
if (failed !== 6) fail(`a failing setup exited ${String(failed)}, not 6`);
if (!readFileSync(exe).equals(exeBefore) || siblings().join(',') !== 'AgentLink')
  fail('the old copy is not back after a failing setup');
const rec = await state.loadFailedRecord(stateDir);
if (rec?.reason !== 'installer_failed') fail('installer_failed was not recorded');
ok('a failing setup: the old copy is back, installer_failed recorded');

// 6. A setup changed after it was verified.
const changed = await watchdog('u-rehea3', values.setup, {
  before: (p) => appendFileSync(p, 'x'),
});
if (changed !== 7) fail(`a changed setup exited ${String(changed)}, not 7`);
if (!readFileSync(exe).equals(exeBefore)) fail('a changed setup touched the install');
if ((await state.loadFailedRecord(stateDir))?.reason !== 'installer_changed')
  fail('installer_changed was not recorded');
ok('a setup changed after the check is never run, installer_changed recorded');
stopApp();
console.log('win-update-rehearsal: all steps passed.');
