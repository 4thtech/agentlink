#!/usr/bin/env node
// REL051-G1: classroom golden-path rehearsal with the PUBLISHED npm package, on a fresh runner.
//
//   node tools/ci/golden-path-published.mjs <version|latest>
//
// Runs the student's install (installer/install.sh or installer/install.ps1 from this checkout, which
// install `@4thtech-io/agentlink@latest` through npx exactly as the one-line command does), then
// drives the installed launcher with two temporary profiles (two HOMEs: "ana" and "ben"). Each step
// is timed and written to the job summary. Nothing here touches production 4thTech services: the
// installers fetch Node.js from nodejs.org and the package from the npm registry. Step S5 starts
// `mcp` on an initialised profile, whose background inbox loop may contact the public default relays
// (third-party Nostr relays, never a 4thTech service); no message is sent.
//
// Steps:
//   S1 install            student installer, --no-start / -NoStart
//   S2 version            launcher --version equals the published version
//   S3 ui-guard           `ui` run by a program answers its fixed line (G-1)
//   S4 init               `init --harness claude-desktop` (two-step, one-time code) in both profiles
//   S5 mcp                `mcp` answers `initialize` in both profiles
//   S6 app                Linux only: `ui` in a pseudo-terminal with a capturing xdg-open; the
//                         session link serves the first page (200, CSP header)
//   S7 invite-and-message GAP: the published package has no relay override (relay URLs must be public
//                         wss:// hosts, 04 §4), so an invite, an accept and a message can only travel
//                         over the production default relays.
// Exit code 1 when any executed step failed. A step that cannot run reports `gap`, not `pass`.
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const win = process.platform === 'win32';
const requested = process.argv[2] ?? 'latest';
if (!/^[A-Za-z0-9.+_-]+$/.test(requested)) {
  console.error('unexpected version');
  process.exit(1);
}
const repo = process.cwd();
const root = mkdtempSync(join(tmpdir(), 'agentlink-golden-'));
const results = [];

const npmView = spawnSync('npm', ['view', `@4thtech-io/agentlink@${requested}`, 'version'], {
  encoding: 'utf8',
  shell: win,
});
const expected = npmView.stdout.trim().split('\n').pop()?.trim() ?? '';
const latest = spawnSync('npm', ['view', '@4thtech-io/agentlink@latest', 'version'], {
  encoding: 'utf8',
  shell: win,
});
if (latest.stdout.trim().split('\n').pop()?.trim() !== expected) {
  // The student installers always install @latest, so only latest can be rehearsed truthfully.
  console.error(
    `the student installers install @latest only; ${requested} is not the latest version`,
  );
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+/.test(expected)) {
  console.error(`could not resolve @4thtech-io/agentlink@${requested} on npm`);
  process.exit(1);
}

function profileEnv(home) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
  };
  for (const n of [
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CODEX_SANDBOX',
    'CODEX_SANDBOX_NETWORK_DISABLED',
    'GEMINI_CLI',
  ]) {
    delete env[n];
  }
  return env;
}
const homes = { ana: join(root, 'ana'), ben: join(root, 'ben') };
for (const h of Object.values(homes)) mkdirSync(h, { recursive: true });

/** Runs a command with no terminal; resolves { code, out } (stdout and stderr together). */
function run(command, args, env, timeoutMs = 240_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: 'pipe' });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ code: -1, out: String(e) }));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.stdin.end('');
  });
}

async function step(id, name, fn) {
  const t0 = Date.now();
  let status = 'pass';
  let note = '';
  try {
    const r = await fn();
    if (r?.gap) {
      status = 'gap';
      note = r.gap;
    }
  } catch (e) {
    status = 'FAIL';
    note = String(e?.message ?? e)
      .replace(/\s+/g, ' ')
      .slice(0, 300);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  results.push({ id, name, status, secs, note });
  console.log(`${status.padEnd(4)} ${id} ${name} (${secs}s) ${note}`);
}
const need = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const launcher = win
  ? join(homes.ana, 'AppData', 'Local', 'AgentLink', 'bin', 'agentlink.cmd')
  : join(homes.ana, '.agentlink', 'bin', 'agentlink');
const cli = (args, home, timeoutMs) =>
  win
    ? run('cmd.exe', ['/d', '/s', '/c', launcher, ...args], profileEnv(home), timeoutMs)
    : run(launcher, args, profileEnv(home), timeoutMs);

// A fresh runner has no usable keychain under a temporary HOME: macOS gets an unlocked one in each
// profile (the way a student's login keychain is); Linux gets one from the workflow (gnome-keyring in
// a D-Bus session); Windows has the Credential Manager.
if (process.platform === 'darwin') {
  for (const home of Object.values(homes)) {
    const kc = join(home, 'Library', 'Keychains', 'login.keychain-db');
    mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true });
    for (const args of [
      ['create-keychain', '-p', 'ci', kc],
      ['default-keychain', '-s', kc],
      ['unlock-keychain', '-p', 'ci', kc],
      ['set-keychain-settings', kc],
    ]) {
      const r = spawnSync('security', args, { env: profileEnv(home) });
      if (r.status !== 0) {
        // Only creating the keychain is fatal; the later calls can fail on a runner whose keychain
        // is already unlocked system-wide, and S4 then tells the truth about the result.
        const fatal = args[0] === 'create-keychain';
        console.error(
          `${fatal ? 'FAIL' : '::warning::'} setup: security ${args[0]} exited ${r.status}`,
        );
        if (fatal) process.exit(1);
      }
    }
  }
}

await step('S1', 'install (student installer)', async () => {
  const env = profileEnv(homes.ana);
  const r = win
    ? await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(repo, 'installer', 'install.ps1'),
          '-NoStart',
        ],
        env,
        600_000,
      )
    : await run('sh', [join(repo, 'installer', 'install.sh'), '--no-start'], env, 600_000);
  need(r.code === 0, `installer exited ${r.code}: ${r.out.slice(-200)}`);
  need(existsSync(launcher), 'installer did not write the launcher');
});

await step('S2', `launcher --version is ${expected}`, async () => {
  const r = await cli(['--version'], homes.ana, 300_000);
  need(r.code === 0 && r.out.includes(expected), `printed: ${r.out.slice(-200)}`);
});

await step('S3', 'ui without a terminal answers its fixed line', async () => {
  const r = await cli(['ui'], homes.ana);
  need(/own terminal/.test(r.out), `printed: ${r.out.slice(-200)}`);
});

// Claude Desktop does not exist on Linux; a student there uses Claude Code.
const harness = process.platform === 'linux' ? 'claude-code' : 'claude-desktop';

await step('S4', 'init in two profiles (ana, ben)', async () => {
  for (const [who, home] of Object.entries(homes)) {
    const first = await cli(['init', '--harness', harness], home);
    const code = /--confirm ([0-9a-f]{4}-[0-9a-f]{4})/.exec(first.out)?.[1];
    need(
      code !== undefined,
      `${who}: init did not ask for its one-time code: ${first.out.slice(-150)}`,
    );
    const second = await cli(['init', '--harness', harness, '--confirm', code], home);
    need(second.code === 0, `${who}: init --confirm exited ${second.code}`);
  }
});

await step('S5', 'mcp answers initialize in both profiles', async () => {
  for (const [who, home] of Object.entries(homes)) {
    const answer = await new Promise((resolve) => {
      const child = spawn(
        win ? 'cmd.exe' : launcher,
        win ? ['/d', '/s', '/c', launcher, 'mcp'] : ['mcp'],
        {
          env: profileEnv(home),
          stdio: 'pipe',
        },
      );
      let buf = '';
      const done = (v) => {
        clearTimeout(timer);
        child.kill();
        resolve(v);
      };
      const timer = setTimeout(() => done(undefined), 60_000);
      child.stdout.on('data', (d) => {
        buf += d;
        for (const line of buf.split('\n')) {
          try {
            const m = JSON.parse(line);
            if (m?.id === 1) return done(m);
          } catch {
            // an incomplete line: wait for more
          }
        }
      });
      child.on('close', () => done(undefined));
      const init = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'golden-path', version: '0' },
        },
      };
      child.stdin.write(`${JSON.stringify(init)}\n`);
    });
    need(answer?.result?.serverInfo !== undefined, `${who}: mcp did not answer initialize`);
  }
});

function get(port, host, path, cookie) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (cookie) headers.Cookie = cookie;
    const req = request({ host: '127.0.0.1', port, path, headers }, (r) => {
      let body = '';
      r.on('data', (d) => (body += d));
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

await step('S6', 'app: ui in a terminal serves its first page', async () => {
  if (process.platform !== 'linux') {
    return {
      gap: win
        ? 'no pseudo-terminal on the Windows runner; `ui` needs an interactive terminal'
        : 'macOS opens the session link with /usr/bin/open (absolute path): it cannot be captured',
    };
  }
  // The session link goes only to /usr/bin/xdg-open (never printed). The runner has no browser, so a
  // capturing stand-in takes its place on this fresh VM.
  const sink = join(root, 'opened-url.txt');
  const shim = join(root, 'xdg-open');
  writeFileSync(shim, `#!/bin/sh\nprintf '%s' "$1" > '${sink}'\n`);
  chmodSync(shim, 0o755);
  const inst = spawnSync('sudo', ['install', '-m', '755', shim, '/usr/bin/xdg-open']);
  need(inst.status === 0, 'could not install the xdg-open stand-in');
  const child = spawn('script', ['-qec', `"${launcher}" ui`, '/dev/null'], {
    env: profileEnv(homes.ben),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    let url = '';
    for (let i = 0; i < 90 && url === ''; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (existsSync(sink)) url = readFileSync(sink, 'utf8');
    }
    // eslint-disable-next-line no-control-regex
    const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-300);
    need(url !== '', `ui did not open a link: ${plain}`);
    const u = new URL(url);
    need(u.hostname === 'localhost' || u.hostname === '127.0.0.1', 'session link is not local');
    const first = await get(u.port, u.host, u.pathname + u.search);
    let final = first;
    if (first.status >= 300 && first.status < 400 && first.headers.location !== undefined) {
      const cookie = (first.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');
      final = await get(u.port, u.host, first.headers.location, cookie);
    }
    need(final.status === 200 && /<html/i.test(final.body), `first page answered ${final.status}`);
    need(final.headers['content-security-policy'] !== undefined, 'no CSP header');
  } finally {
    child.kill('SIGINT');
    spawnSync('pkill', ['-f', 'agentlink.js ui']);
  }
});

await step('S7', 'invite, accept and a message both ways', () =>
  Promise.resolve({
    gap: 'needs relays: no relay override in the published package, and only public wss:// relay hosts are accepted (04 §4), so it can only use the production default relays',
  }),
);

const rows = results.map(
  (r) => `| ${r.id} | ${r.name} | ${r.status} | ${r.secs}s | ${r.note.replace(/\|/g, '/')} |`,
);
const md = [
  `### Golden path, published @4thtech-io/agentlink ${expected} on ${process.platform}`,
  '',
  '| Step | What | Result | Time | Note |',
  '|---|---|---|---|---|',
  ...rows,
  '',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
rmSync(root, { recursive: true, force: true });
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
