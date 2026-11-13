#!/usr/bin/env node
// CI-side launch test (H1): a tampered app.asar must NOT run.
//  1. Control: an untampered copy of the built app must START (still running after the control
//     window), so a missing or unrunnable binary cannot pass as "refused".
//  2. Tampered: a copy with one byte of the ASAR header flipped (macOS: re-signed ad-hoc so the OS
//     accepts the bundle) must exit non-zero quickly (the integrity fuse aborts it). A spawn error
//     counts as a failure, not as a refusal.
// Both run with a throw-away HOME.
//
//   node check-tampered-asar.mjs --app <AgentLink.app | AgentLink.exe> [--timeout-ms 20000]
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { capture, parseArgs } from './lib/run.mjs';
import { tamperAsarHeader } from './lib/tamper.mjs';
import { throwAwayEnv } from './lib/throwaway-env.mjs';

const args = parseArgs(process.argv.slice(2), { app: 'v', 'timeout-ms': 'v', 'control-ms': 'v' });
if (!args.app) throw new Error('--app <AgentLink.app | AgentLink.exe> is required.');
const app = resolve(args.app);
if (!existsSync(app)) throw new Error(`Not found: ${app}`);
const timeoutMs = Number(args['timeout-ms'] ?? 20000);
const controlMs = Number(args['control-ms'] ?? 6000);

// The copies must not sit in the temporary folder the app sees: the app refuses to run from one
// (move.ts; on a CI runner the Windows refusal dialog closes at once and the control exits 0). On
// CI they go under RUNNER_TEMP, and the app's HOME and TEMP are a separate `home` folder.
const tmp = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'agentlink-tamper-'));
const home = join(tmp, 'home');
mkdirSync(home, { recursive: true });
// WIN-DESK-1c: with both AppData folders, as on a real Windows account (lib/throwaway-env.mjs).
const env = throwAwayEnv(home);

/** Copies the build to tmp/<label>; returns {exe, asar}. */
function copyBuild(label) {
  if (app.endsWith('.app')) {
    const copy = join(tmp, label, basename(app));
    capture('ditto', [app, copy]);
    return {
      exe: join(copy, 'Contents', 'MacOS', basename(app, '.app')),
      asar: join(copy, 'Contents', 'Resources', 'app.asar'),
      bundle: copy,
    };
  }
  const copy = join(tmp, label);
  cpSync(dirname(app), copy, { recursive: true });
  return { exe: join(copy, basename(app)), asar: join(copy, 'resources', 'app.asar') };
}

/** Resolves {spawnError} | {code} | {running: true} (killed after `ms` while still alive). */
function launch(exe, ms) {
  return new Promise((done) => {
    const child = spawn(exe, [], { env, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ running: true });
    }, ms);
    child.on('error', () => (clearTimeout(timer), done({ spawnError: true })));
    child.on('exit', (code, sig) => (clearTimeout(timer), done({ code: code ?? (sig ? 128 : 1) })));
  });
}

/**
 * When the control does not start: the tail of the app's own log (the shell writes one fixed line
 * when it quits at start, and keeps only REDACTED core lines; core-log.ts). Never the profile.
 */
function showAppLog() {
  const dir = app.endsWith('.app')
    ? join(home, 'Library', 'Logs', 'AgentLink')
    : join(env.LOCALAPPDATA, 'AgentLink', 'logs');
  try {
    const lines = readFileSync(join(dir, 'core.log'), 'utf8').trimEnd().split('\n').slice(-20);
    console.error('--- the app log (last lines, redacted by the app) ---');
    for (const line of lines) console.error(line);
  } catch {
    console.error('(the app wrote no log: it quit before its own start code ran)');
  }
}

/**
 * Windows: the number of AgentLink.exe processes still running. The previous step's launches can
 * take a few seconds to go away on a runner, and while one is there the app's single-instance lock
 * is taken, so the control quits at once ("another AgentLink is running", exit 0) as it should.
 */
function runningCopies() {
  const r = capture('tasklist', ['/FI', 'IMAGENAME eq AgentLink.exe', '/NH', '/FO', 'CSV']);
  return r.code === 0 ? (r.stdout.match(/^"AgentLink\.exe"/gim) ?? []).length : 0;
}

/** Waits (up to `ms`) until no AgentLink.exe runs; answers how many are left. */
async function noCopyRunning(ms) {
  if (process.platform !== 'win32') return 0;
  const end = Date.now() + ms;
  let left = runningCopies();
  while (left > 0 && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 500));
    left = runningCopies();
  }
  return left;
}

const fail = (msg) => {
  console.error(`TAMPERED ASAR CHECK FAILED: ${msg}`);
  process.exitCode = 1;
};

try {
  const control = copyBuild('control');
  const before = await noCopyRunning(60_000);
  const c = await launch(control.exe, controlMs);
  if (!c.running) {
    fail(
      `the untampered control did not start (${c.spawnError ? 'spawn error' : `exit ${c.code}`}).`,
    );
    if (before > 0) console.error(`(${before} AgentLink.exe still running before the control)`);
    showAppLog();
  } else {
    const bad = copyBuild('tampered');
    writeFileSync(bad.asar, tamperAsarHeader(readFileSync(bad.asar)));
    if (bad.bundle) {
      const r = capture('codesign', ['--force', '--sign', '-', bad.bundle]);
      if (r.code !== 0) throw new Error(`codesign failed: ${r.stderr.trim()}`);
    }
    const t = await launch(bad.exe, timeoutMs);
    if (t.spawnError) fail('the tampered app could not be started at all (spawn error).');
    else if (t.running) fail('the tampered app kept running.');
    else if (t.code === 0) fail('the tampered app exited 0.');
    else console.log(`Control started; tampered ASAR refused (exit ${t.code}).`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
