#!/usr/bin/env node
// W5-WINDOWS: the `windows-smoke` job of ci.yml. Runs the CLI exactly as a user has it after
// `npm install <tarball>` and checks what broke for Windows users in 0.4.x.
//
//   node tools/ci/windows-smoke.mjs <install dir>
//
// <install dir> is a folder with the packed tarball installed (node_modules/@4thtech-io/agentlink).
// Checks, in order; the first failure stops the run with a one-line reason:
//   1. `--version` prints the installed version.
//   2. `ui` run by a program (no terminal) answers its fixed "run it in your own terminal" line.
//      A real server start is not possible here: `ui` needs an interactive terminal and never prints
//      its session link (G-1, 04 §2.5), and no CI-only switch may weaken that. The server itself is
//      started and fetched by ci.yml's next step (e2e/test/cli-first-run-smoke.test.ts).
//   3. `init --harness claude-desktop` into a temporary profile (HOME and USERPROFILE point at it):
//      the first run prints a one-time code, the second confirms it. On win32 the written entry must
//      start with `cmd /c npx` (not a bare `npx`).
//   4. MCP over stdio: `mcp` answers an `initialize` request with its server info.
// Only a temporary profile is touched. Nothing here prints a key, a link or a file's content.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

function fail(reason) {
  console.error(`windows-smoke FAILED: ${reason}`);
  process.exit(1);
}

const installDir = process.argv[2];
if (installDir === undefined) fail('usage: windows-smoke.mjs <install dir>');
const win = process.platform === 'win32';
const pkgDir = join(installDir, 'node_modules', '@4thtech-io', 'agentlink');
const entryJs = join(pkgDir, 'dist', 'agentlink.js');
const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
const profile = mkdtempSync(join(tmpdir(), 'agentlink-smoke-'));

// No AI-app marker, and the profile as the home folder.
const env = { ...process.env, HOME: profile, USERPROFILE: profile };
for (const name of [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_THREAD_ID',
  'GEMINI_CLI',
  'OPENCODE',
  'OPENCODE_CLIENT',
  'CURSOR_AGENT',
  'ANTIGRAVITY_AGENT',
  'AI_AGENT',
]) {
  delete env[name];
}

/** Runs the CLI with no terminal; resolves { code, out } (stdout and stderr together). */
function run(args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entryJs, ...args], { env, stdio: 'pipe' });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.stdin.end('');
  });
}

try {
  // 1. version
  const v = await run(['--version']);
  if (v.code !== 0 || !v.out.includes(version)) fail(`--version did not print ${version}`);
  console.log(`ok  --version prints ${version}`);

  // 2. ui without a terminal
  const ui = await run(['ui']);
  if (!/own terminal/.test(ui.out)) fail('`ui` without a terminal did not give its fixed line');
  console.log('ok  ui answers its fixed line without a terminal');

  // 3. init into the temporary profile, in the two steps an AI-run command takes
  const first = await run(['init', '--harness', 'claude-desktop']);
  const code = /--confirm ([0-9a-f]{4}-[0-9a-f]{4})/.exec(first.out)?.[1];
  if (code === undefined) fail('init did not ask for its one-time code');
  const second = await run(['init', '--harness', 'claude-desktop', '--confirm', code]);
  if (second.code !== 0) fail(`init --confirm exited ${second.code}`);
  const configParts = win
    ? ['AppData', 'Roaming', 'Claude', 'claude_desktop_config.json']
    : process.platform === 'darwin'
      ? ['Library', 'Application Support', 'Claude', 'claude_desktop_config.json']
      : null;
  if (configParts !== null) {
    const config = JSON.parse(readFileSync(join(profile, ...configParts), 'utf8'));
    const entry = config?.mcpServers?.agentlink;
    const words = [entry?.command, ...(entry?.args ?? [])];
    const wanted = win ? ['cmd', '/c', 'npx'] : ['npx'];
    if (wanted.some((w, i) => words[i] !== w)) {
      fail(`the claude-desktop entry does not start with "${wanted.join(' ')}"`);
    }
    console.log(`ok  init wrote an entry that starts with "${wanted.join(' ')}"`);
  }

  // 4. MCP initialize over stdio
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'windows-smoke', version: '0' },
    },
  };
  const answer = await new Promise((resolve) => {
    const child = spawn(process.execPath, [entryJs, 'mcp'], { env, stdio: 'pipe' });
    let buffer = '';
    const done = (value) => {
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), 45_000);
    child.stdout.on('data', (d) => {
      buffer += d;
      for (const line of buffer.split('\n')) {
        try {
          const message = JSON.parse(line);
          if (message?.id === 1) return done(message);
        } catch {
          // an incomplete line: wait for more
        }
      }
    });
    child.on('close', () => done(undefined));
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
  if (answer?.result?.serverInfo === undefined) fail('mcp did not answer initialize');
  console.log('ok  mcp answers initialize over stdio');
} finally {
  rmSync(profile, { recursive: true, force: true });
}
console.log('windows-smoke passed');
