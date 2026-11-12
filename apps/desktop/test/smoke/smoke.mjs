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
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const fail = (reason) => {
  console.error(`desktop smoke FAILED: ${reason}`);
  process.exitCode = 1;
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

const home = mkdtempSync(join(tmpdir(), 'agentlink-desktop-smoke-'));
// A small, explicit environment: no AI-app marker, nothing from the runner's secrets.
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
mkdirSync(env.APPDATA, { recursive: true });
mkdirSync(env.LOCALAPPDATA, { recursive: true });

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
    await sleep(2000);
    if (exited !== null) return fail(`the app exited (${exited}) after its core came up`);
    console.log('ok  the app starts, its core listens, the record names a live pid');
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

try {
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
