#!/usr/bin/env node
// CI-side launch test (H1): a tampered app.asar must NOT run. Copies the built app to a temp dir,
// flips a byte in the ASAR header, (macOS) re-signs ad-hoc so the OS accepts the bundle, launches it
// with a throw-away HOME and expects a quick non-zero exit (the integrity fuse aborts the process).
//
//   node check-tampered-asar.mjs --app <AgentLink.app | AgentLink.exe> [--timeout-ms 20000]
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { capture, parseArgs } from './lib/run.mjs';
import { tamperAsarHeader } from './lib/tamper.mjs';

const args = parseArgs(process.argv.slice(2), { app: 'v', 'timeout-ms': 'v' });
if (!args.app) throw new Error('--app <AgentLink.app | AgentLink.exe> is required.');
const app = resolve(args.app);
if (!existsSync(app)) throw new Error(`Not found: ${app}`);
const timeoutMs = Number(args['timeout-ms'] ?? 20000);

const tmp = mkdtempSync(join(tmpdir(), 'agentlink-tamper-'));
try {
  let asar;
  let exe;
  if (app.endsWith('.app')) {
    const copy = join(tmp, basename(app));
    capture('ditto', [app, copy]);
    asar = join(copy, 'Contents', 'Resources', 'app.asar');
    exe = join(copy, 'Contents', 'MacOS', basename(app, '.app'));
    writeFileSync(asar, tamperAsarHeader(readFileSync(asar)));
    const r = capture('codesign', ['--force', '--sign', '-', copy]);
    if (r.code !== 0) throw new Error(`codesign failed: ${r.stderr.trim()}`);
  } else {
    const copy = join(tmp, 'app');
    cpSync(dirname(app), copy, { recursive: true });
    asar = join(copy, 'resources', 'app.asar');
    exe = join(copy, basename(app));
    writeFileSync(asar, tamperAsarHeader(readFileSync(asar)));
  }
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
  const result = await new Promise((done) => {
    const child = spawn(exe, [], { env, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: null });
    }, timeoutMs);
    child.on('error', () => (clearTimeout(timer), done({ code: 127 })));
    child.on('exit', (code, sig) => (clearTimeout(timer), done({ code: code ?? (sig ? 128 : 1) })));
  });
  if (result.code === null || result.code === 0) {
    console.error(
      `TAMPERED ASAR CHECK FAILED: the app ${result.code === 0 ? 'exited 0' : 'kept running'}.`,
    );
    process.exitCode = 1;
  } else {
    console.log(`Tampered ASAR refused (exit ${result.code}).`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
