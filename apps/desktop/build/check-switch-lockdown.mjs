#!/usr/bin/env node
// CI-side launch test (H1): launches the BUILT binary once per forbidden switch and expects a quick
// non-zero exit (so no window ever stays up). A process still running after the timeout is killed
// and counts as a failure. Runs with a throw-away HOME, never a real profile.
//
//   node check-switch-lockdown.mjs --exe <path to the binary> [--timeout-ms 15000]
//   macOS: <AgentLink.app>/Contents/MacOS/AgentLink      Windows: AgentLink.exe
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runLockdown } from './lib/switch-check.mjs';
import { parseArgs } from './lib/run.mjs';

const args = parseArgs(process.argv.slice(2), { exe: 'v', 'timeout-ms': 'v' });
if (!args.exe) throw new Error('--exe <binary> is required.');
const exe = resolve(args.exe);
if (!existsSync(exe)) throw new Error(`Not found: ${exe}`);
const timeoutMs = Number(args['timeout-ms'] ?? 15000);

const home = mkdtempSync(join(tmpdir(), 'agentlink-lockdown-'));
const env = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(home, 'AppData', 'Local'),
  TMPDIR: home,
  TEMP: home,
  TMP: home,
};

function launch(bin, argv) {
  return new Promise((resolveLaunch) => {
    const child = spawn(bin, argv, { env, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveLaunch({ code: null, windowSeen: true }); // still alive: a window may exist
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolveLaunch({ code: 127, windowSeen: false });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolveLaunch({ code: code ?? (signal ? 128 : 1), windowSeen: false });
    });
  });
}

try {
  const { checked, failures } = await runLockdown({ exe, launch });
  if (failures.length) {
    console.error(
      `SWITCH LOCKDOWN FAILED (${failures.length} of ${checked}):\n- ${failures.join('\n- ')}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Switch lockdown passed: all ${checked} forbidden switches exit non-zero with no window.`,
    );
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
