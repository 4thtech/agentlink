#!/usr/bin/env node
// WP-D5 smoke test of the BUILT app (never a real profile: HOME and USERPROFILE are a temp folder,
// no AI-app marker in the environment).
//
//   node smoke.mjs --exe <binary> --resources <Resources dir> [--timeout-ms 90000]
//   macOS: <AgentLink.app>/Contents/MacOS/AgentLink  and  <AgentLink.app>/Contents/Resources
//   Windows: AgentLink.exe  and  <install dir>\resources
//
// 1. The hardened binary starts with no flags and its core comes up: `~/.agentlink/app-host.json`
//    (written only once the core listens, mode 0600, shape from apps/cli/src/runtime/app-host-record.ts)
//    names a live pid and a port that accepts a loopback connection. Then the app is quit.
// 2. The bundled `node <core>/dist/agentlink.js mcp` answers `tools/list` over stdio.
//
// Not done here, on purpose: a Playwright `_electron` launch. The shell refuses every debugging
// switch (switches.ts, fuses), which is exactly what `_electron.launch` passes, so a window-level
// check (Welcome shown, `typeof PublicKeyCredential === 'undefined'`) needs a test seam in the shell
// (open question for WP-D2). Nothing here prints a link, token or file content.
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeHome } from './profile.mjs';

const fail = (reason) => {
  console.error(`desktop smoke FAILED: ${reason}`);
  process.exitCode = 1;
  diagnose();
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const exeArg = arg('exe');
const resourcesArg = arg('resources');
const timeoutMs = Number(arg('timeout-ms') ?? 90_000);
if (!exeArg || !resourcesArg) {
  throw new Error('usage: smoke.mjs --exe <binary> --resources <resources dir>');
}
const exe = resolve(exeArg);
const resources = resolve(resourcesArg);
if (!existsSync(exe)) throw new Error('the binary does not exist');

const win = process.platform === 'win32';
const layout = JSON.parse(
  readFileSync(new URL('../../src/shared/resource-layout.json', import.meta.url), 'utf8'),
);
const nodeBin = join(resources, ...(win ? layout.node.win32 : layout.node.posix));
// core/node_modules/@4thtech-io/agentlink/dist/agentlink.js (the host script's sibling)
const entryJs = join(resources, ...layout.hostScript.slice(0, -1), 'agentlink.js');
const hostScript = join(resources, ...layout.hostScript);

// Every throw-away profile (this one and the fd 3 controls' own) comes from profile.mjs, which
// gives each its own unlocked login keychain on macOS (CI-823).
const { home, env } = makeHome();

// The app's core log (core-log.ts logDir): the shell keeps only REDACTED stderr lines and its own
// fixed notes there.
const coreLogFile = join(
  win
    ? join(env.LOCALAPPDATA, 'AgentLink', 'logs')
    : process.platform === 'darwin'
      ? join(home, 'Library', 'Logs', 'AgentLink')
      : join(home, '.local', 'state', 'agentlink', 'logs'),
  'core.log',
);
const readCoreLog = () => {
  try {
    return readFileSync(coreLogFile, 'utf8');
  } catch {
    return '';
  }
};
// The host's fixed refusal line (apps/cli/src/desktop/host-main.ts DESKTOP_HOST_TEXT.notInApp).
const NOT_IN_APP = 'runs only inside the AgentLink app';

/**
 * On a failure: the tail of the app's core log (the shell keeps only REDACTED stderr lines there,
 * core-log.ts) and the names (never the contents) of what the core wrote under ~/.agentlink.
 */
function diagnose() {
  try {
    const lines = readFileSync(coreLogFile, 'utf8').split('\n').slice(-40);
    console.error('--- core.log (last lines, redacted by the app) ---');
    for (const line of lines) console.error(line);
  } catch {
    console.error('(no core.log)');
  }
  try {
    console.error(`~/.agentlink: ${readdirSync(join(home, '.agentlink')).sort().join(', ')}`);
  } catch {
    console.error('(no ~/.agentlink)');
  }
}

// WIN-DESK-1: what the bundled node sees on fd 3, as the file type of fstat's mode in octal (on
// Windows Node's isFIFO()/isSocket() always say false; the type is in the mode). Never a handle.
const FD3_MODE = [
  'let s;',
  "try { s = 'mode 0o' + (require('node:fs').fstatSync(3).mode & 0o170000).toString(8); }",
  "catch (e) { s = 'error ' + e.code; }",
  "process.stderr.write('fd3 ' + s + '\\n');",
].join(' ');

/** stderr lines of a finished child, cut to length (fixed lines only are expected there). */
const stderrLines = (text) =>
  String(text ?? '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(0, 10)
    .map((l) => l.slice(0, 300));

/**
 * The fd 3 mode the bundled node sees with this stdio slot (printed, octal). Async spawn: spawnSync
 * does not take 'overlapped'.
 */
function fd3Mode(ctx, label, slot) {
  const stdio =
    slot === undefined ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'ignore', 'pipe', slot];
  return new Promise((done) => {
    const child = spawn(nodeBin, ['-e', FD3_MODE], {
      env: ctx.env,
      cwd: ctx.home,
      stdio,
      windowsHide: true,
    });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', () => undefined);
    child.on('close', () => {
      clearTimeout(timer);
      const line = stderrLines(stderr).find((l) => l.startsWith('fd3 ')) ?? '(none)';
      console.log(`    ${label}: ${line}`);
      done();
    });
  });
}

/**
 * A control: the host started directly with `slot` on fd 3 must refuse (its fixed line, exit 1)
 * within 20 s. Returns null when it did, else the reason.
 */
async function controlRefused(ctx, label, slot) {
  await fd3Mode(ctx, label, slot);
  const stdio =
    slot === undefined ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'ignore', 'pipe', slot];
  const r = spawnSync(nodeBin, [hostScript], {
    env: ctx.env,
    cwd: ctx.home,
    stdio,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  const lines = stderrLines(r.stderr ?? r.output?.[2]);
  const refused = r.status === 1 && lines.some((l) => l.includes(NOT_IN_APP));
  console.log(
    `    ${label}: host exit ${r.status ?? r.signal ?? r.error?.code} → ${refused ? 'refused' : 'NOT refused'}`,
  );
  if (!refused) for (const line of lines) console.error(`      ${line}`);
  return refused ? null : `the host did not refuse fd 3 = ${label}`;
}

/**
 * The host started directly with fd 3 as the shell gives it ('overlapped'): it must NOT refuse, and
 * it must send `ready` on fd 3 (the pipe works in both directions). The link is never printed.
 * The child is then stopped and must exit.
 */
async function pipeAccepted(ctx) {
  await fd3Mode(ctx, 'the shell’s pipe (overlapped)', 'overlapped');
  return new Promise((done) => {
    const child = spawn(nodeBin, [hostScript], {
      env: ctx.env,
      cwd: ctx.home,
      stdio: ['ignore', 'ignore', 'pipe', 'overlapped'],
      windowsHide: true,
    });
    let stderr = '';
    let buffer = '';
    let ready = false;
    let exited = null;
    let stoppedReason = null;
    child.stderr.on('data', (c) => (stderr += c));
    child.stdio[3].on('data', (c) => {
      buffer += c;
      for (const line of buffer.split('\n').slice(0, -1)) {
        try {
          const message = JSON.parse(line);
          if (message.type === 'ready') ready = true;
          // CI-823: the host's fixed stop code (protocol.ts STOP_REASONS), so a failed start says
          // why (e.g. `keychain`). Only a short lowercase code is kept; nothing else from the pipe.
          if (message.type === 'stopped' && /^[a-z_]{1,32}$/.test(String(message.reason))) {
            stoppedReason = message.reason;
          }
        } catch {
          // not a message
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    });
    child.stdio[3].on('error', () => undefined);
    child.on('exit', (code) => (exited = code ?? 'signal'));
    const started = Date.now();
    const tick = setInterval(async () => {
      const refused = stderr.includes(NOT_IN_APP);
      if (!ready && !refused && exited === null && Date.now() - started < 60_000) return;
      clearInterval(tick);
      console.log(
        `    the shell’s pipe: ${ready ? '`ready` received on fd 3' : refused ? 'REFUSED' : exited !== null ? `host exited (${exited}${stoppedReason ? `, stopped: ${stoppedReason}` : ''})` : 'no `ready` within 60 s'}`,
      );
      if (!ready) for (const line of stderrLines(stderr)) console.error(`      ${line}`);
      // Stop it: close our end (the host leaves on pipe close), then kill if still there.
      child.stdio[3].destroy();
      const end = Date.now() + 20_000;
      while (exited === null && Date.now() < end) await sleep(250);
      if (exited === null) child.kill('SIGKILL');
      while (exited === null) await sleep(100);
      // The direct host's record is not the app's: the app writes its own.
      rmSync(join(ctx.home, '.agentlink', 'app-host.json'), { force: true });
      done(ready ? null : 'the host did not send `ready` on the shell’s pipe');
    }, 250);
  });
}

/** WIN-DESK-1 controls before the app starts: only the shell's pipe is accepted on fd 3. */
async function pipeControls() {
  console.log('fd 3 controls (bundled node, host started directly):');
  const failures = [];
  // Its own throw-away home, so the direct host's ~/.agentlink never reaches the fresh profile
  // appStarts() runs on.
  const ctx = makeHome();
  const dir = mkdtempSync(join(ctx.home, 'fd3-'));
  const fileFd = openSync(join(dir, 'f'), 'w');
  let nulFd = null;
  try {
    nulFd = openSync(win ? '\\\\.\\NUL' : '/dev/null', 'r+');
  } catch {
    failures.push('could not open the null device for its control');
  }
  let consoleFd = null;
  try {
    consoleFd = openSync(win ? '\\\\.\\CONOUT$' : '/dev/tty', 'r+');
  } catch {
    console.log('    a console: none on this runner (control not run)');
  }
  try {
    for (const [label, slot] of [
      ['a file', fileFd],
      ['the null device', nulFd],
      ['a console', consoleFd],
      ['nothing (absent)', undefined],
      ["'ignore'", 'ignore'],
    ]) {
      if (slot === null) continue;
      const reason = await controlRefused(ctx, label, slot);
      if (reason !== null) failures.push(reason);
    }
  } finally {
    for (const fd of [fileFd, nulFd, consoleFd]) if (fd !== null) closeSync(fd);
  }
  const accepted = await pipeAccepted(ctx);
  rmSync(ctx.home, { recursive: true, force: true });
  if (accepted !== null) failures.push(accepted);
  if (failures.length > 0) fail(failures.join('; '));
  else console.log('ok  fd 3: only the shell’s pipe is accepted, and the host answers on it');
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const canConnect = (port) =>
  new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      done(true);
    });
    socket.on('error', () => done(false));
    socket.setTimeout(3000, () => {
      socket.destroy();
      done(false);
    });
  });

async function appStarts() {
  const record = join(home, '.agentlink', 'app-host.json');
  const child = spawn(exe, [], { env, stdio: 'ignore' });
  let exited = null;
  child.on('exit', (code) => (exited = code ?? 'signal'));
  child.on('error', () => (exited = 'spawn error'));
  const deadline = Date.now() + timeoutMs;
  let port = null;
  while (Date.now() < deadline && exited === null && port === null) {
    if (existsSync(record)) {
      try {
        const parsed = JSON.parse(readFileSync(record, 'utf8'));
        if (
          Object.keys(parsed).sort().join(',') === 'handoffToken,pid,port,v' &&
          parsed.v === 1 &&
          Number.isSafeInteger(parsed.port) &&
          pidAlive(parsed.pid)
        ) {
          port = parsed.port;
        }
      } catch {
        // half-written: try again
      }
    }
    if (port === null) await sleep(500);
  }
  try {
    if (exited !== null) return fail(`the app exited (${exited}) before its core came up`);
    if (port === null) return fail(`no live app-host.json within ${timeoutMs / 1000} s`);
    if (!(await canConnect(port))) return fail('the core does not accept a loopback connection');
    // WIN-DESK-1: the shell notes `core ready` once the session link arrived over fd 3 (both
    // directions of the pipe work); one core, never refused.
    const readyBy = Date.now() + 30_000;
    while (!readCoreLog().includes('core ready') && exited === null && Date.now() < readyBy) {
      await sleep(500);
    }
    await sleep(2000);
    if (exited !== null) return fail(`the app exited (${exited}) after its core came up`);
    const log = readCoreLog();
    if (log.includes(NOT_IN_APP)) return fail('the core refused the app’s pipe');
    if (!log.includes('core ready')) return fail('core.log has no `core ready` within 30 s');
    const starts = log.match(/core started/g)?.length ?? 0;
    if (starts !== 1) return fail(`core.log has ${starts} core starts (expected 1)`);
    console.log('ok  the app starts, its core listens and is ready, the record names a live pid');
  } finally {
    child.kill('SIGTERM');
    const end = Date.now() + 20_000;
    while (exited === null && Date.now() < end) await sleep(250);
    if (exited === null) child.kill('SIGKILL');
  }
}

function mcpToolsList() {
  return new Promise((done) => {
    const child = spawn(nodeBin, [entryJs, 'mcp'], { env, stdio: 'pipe' });
    let buffer = '';
    const finish = (value) => {
      clearTimeout(timer);
      child.kill();
      done(value);
    };
    const timer = setTimeout(() => finish(undefined), 60_000);
    child.on('error', () => finish(undefined));
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n')) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 2) finish(message.result);
      }
    });
    const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'desktop-smoke', version: '0' },
      },
    });
    setTimeout(() => {
      send({ method: 'notifications/initialized' });
      send({ id: 2, method: 'tools/list', params: {} });
    }, 1500);
  });
}

/**
 * Windows only: a real account always has AppData\\Roaming, so this profile deliberately lacks it.
 * The app must say so in its fixed line and exit 66 (PROFILE_UNAVAILABLE_EXIT), not claim another
 * AgentLink is running. When Electron stops in its own native start (before the shell runs, so no
 * line can be written), it must not have started anything. Code only here; it runs on Windows.
 */
async function missingRoaming() {
  const ctx = makeHome({ noRoaming: true });
  try {
    const child = spawn(exe, [], { env: ctx.env, stdio: 'ignore' });
    let exited = null;
    child.on('exit', (code) => (exited = code ?? 'signal'));
    child.on('error', () => (exited = 'spawn error'));
    const end = Date.now() + 60_000;
    while (exited === null && Date.now() < end) await sleep(250);
    if (exited === null) {
      child.kill('SIGKILL');
      return fail('the app did not exit without AppData\\Roaming');
    }
    let log = '';
    try {
      log = readFileSync(join(ctx.env.LOCALAPPDATA, 'AgentLink', 'logs', 'core.log'), 'utf8');
    } catch {
      // no log
    }
    const hex = typeof exited === 'number' ? `0x${(exited >>> 0).toString(16)}` : String(exited);
    // Never the misleading line, never a clean exit, never a running app.
    if (log.includes('another AgentLink is running')) {
      return fail('without AppData\\Roaming the app said another AgentLink is running');
    }
    if (exited === 0) return fail('without AppData\\Roaming the app exited 0');
    if (exited === 66) {
      if (!log.includes('the AgentLink data folder is not available')) {
        return fail('without AppData\\Roaming the fixed line is missing from core.log');
      }
      console.log('ok  without AppData\\Roaming the app exits 66 with its fixed line');
      return;
    }
    // WIN-DESK-2 (run 43490849095): on windows-2022 Electron itself exits during its native start
    // (code 0xffff7003) before any shell code runs, so the shell cannot write its line. Accepted
    // when nothing of the app ran: no core.log line at all and no Roaming folder made.
    if (log === '' && !existsSync(ctx.env.APPDATA)) {
      console.log(
        `ok  without AppData\\Roaming Electron stops in its own start (exit ${hex}), before the app runs`,
      );
      return;
    }
    for (const l of log.split('\n').filter((x) => x.startsWith('--- '))) console.log(`    ${l}`);
    return fail(`without AppData\\Roaming the app exited ${hex} after it started (expected 66)`);
  } finally {
    rmSync(ctx.home, { recursive: true, force: true });
  }
}

try {
  await pipeControls();
  if (win) await missingRoaming();
  await appStarts();
  const result = await mcpToolsList();
  if (!Array.isArray(result?.tools) || result.tools.length === 0) {
    fail('the bundled node `mcp` did not answer tools/list with tools');
  } else if (!result.tools.some((t) => t.name === 'agentlink_status')) {
    fail('tools/list has no agentlink_status');
  } else {
    console.log(`ok  the bundled node answers tools/list (${result.tools.length} tools)`);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
