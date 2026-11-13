#!/usr/bin/env node
// CI-side launch test (H1): launches the BUILT binary once per forbidden switch and per forbidden
// environment variable (D15-05, lib/switch-check.mjs ENV_CASES) and expects a quick non-zero exit (so
// no window ever stays up). A process still running after the timeout is killed
// and counts as a failure. Runs with a throw-away HOME, never a real profile.
//
//   node check-switch-lockdown.mjs --exe <path to the binary> [--timeout-ms 15000]
//   macOS: <AgentLink.app>/Contents/MacOS/AgentLink      Windows: AgentLink.exe
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { envCasesFor, runLockdown } from './lib/switch-check.mjs';
import { parseArgs } from './lib/run.mjs';

const args = parseArgs(process.argv.slice(2), { exe: 'v', 'timeout-ms': 'v', 'warmup-ms': 'v' });
if (!args.exe) throw new Error('--exe <binary> is required.');
const exe = resolve(args.exe);
if (!existsSync(exe)) throw new Error(`Not found: ${exe}`);
const timeoutMs = Number(args['timeout-ms'] ?? 15000);
// The first start of a fresh build can be far slower than the rest (an x64 build under Rosetta is
// translated on first launch; the OS scans a new bundle once). One warm-up launch with a forbidden
// switch and a longer limit comes first; it must still exit non-zero. Every counted check keeps the
// short limit.
const warmupMs = Number(args['warmup-ms'] ?? 180000);

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

function launch(bin, argv, extraEnv, limitMs = timeoutMs) {
  return new Promise((resolveLaunch) => {
    const child = spawn(bin, argv, { env: { ...env, ...extraEnv }, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveLaunch({ code: null, windowSeen: true }); // still alive: a window may exist
    }, limitMs);
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
  const warm = await launch(exe, ['--remote-debugging-port=9222'], {}, warmupMs);
  if (warm.code === 0 || warm.windowSeen) {
    console.error(
      `SWITCH LOCKDOWN FAILED: the warm-up launch with --remote-debugging-port=9222 ${warm.windowSeen ? `did not exit within ${warmupMs / 1000} s` : 'exited 0'}.`,
    );
    process.exitCode = 1;
  }
  const { checked, failures } = await runLockdown({
    exe,
    launch,
    envCases: envCasesFor(process.platform),
  });
  if (failures.length) {
    console.error(
      `SWITCH LOCKDOWN FAILED (${failures.length} of ${checked}):\n- ${failures.join('\n- ')}`,
    );
    process.exitCode = 1;
  } else if (!process.exitCode) {
    console.log(
      `Switch lockdown passed: all ${checked} forbidden switches and variables exit non-zero with no window.`,
    );
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
