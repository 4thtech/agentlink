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
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { capture, parseArgs } from './lib/run.mjs';
import { tamperAsarHeader } from './lib/tamper.mjs';

const args = parseArgs(process.argv.slice(2), { app: 'v', 'timeout-ms': 'v', 'control-ms': 'v' });
if (!args.app) throw new Error('--app <AgentLink.app | AgentLink.exe> is required.');
const app = resolve(args.app);
if (!existsSync(app)) throw new Error(`Not found: ${app}`);
const timeoutMs = Number(args['timeout-ms'] ?? 20000);
const controlMs = Number(args['control-ms'] ?? 6000);

const tmp = mkdtempSync(join(tmpdir(), 'agentlink-tamper-'));
const env = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  HOME: tmp,
  USERPROFILE: tmp,
  APPDATA: join(tmp, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(tmp, 'AppData', 'Local'),
  TMPDIR: tmp,
  TEMP: tmp,
  TMP: tmp,
};

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

const fail = (msg) => {
  console.error(`TAMPERED ASAR CHECK FAILED: ${msg}`);
  process.exitCode = 1;
};

try {
  const control = copyBuild('control');
  const c = await launch(control.exe, controlMs);
  if (!c.running) {
    fail(
      `the untampered control did not start (${c.spawnError ? 'spawn error' : `exit ${c.code}`}).`,
    );
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
