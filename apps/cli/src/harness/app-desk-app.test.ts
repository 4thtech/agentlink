// WP-D7 (S2; plan 2026-11-12 Decision 2 "AI apps", "Translocation (M3)"): "Use the app for …" on the
// harness desk. The app form is recognised next to the npx form, a `switch` plans the exact entry
// change (written only by `commit`, which the node route calls after the owner's signed gesture),
// foreign entries are never touched, and a translocated / temporary / read-only app is never written
// (refused at plan and again right before the write). The optional launcher repoint goes with it.
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAiAppsDesk, type AiAppsDeskOptions } from './app-desk.js';
import type { DesktopApp } from './desktop-app.js';
import { appLauncherText } from './launcher.js';

const POSIX = process.platform !== 'win32';
const SENTINEL = 'other-server-private-value';
const WORK = '0x1111111111111111111111111111111111111111';
const RES = '/Applications/AgentLink.app/Contents/Resources';
const START = {
  node: `${RES}/node/bin/node`,
  cli: `${RES}/core/node_modules/@4thtech-io/agentlink/dist/agentlink.js`,
};
const OK: DesktopApp = { status: 'ok', resources: RES, start: START };
const TRANSLOCATED: DesktopApp = {
  status: 'refused',
  reason: 'translocated',
  resources: RES,
  start: START,
};

let home: string;
let logs: string[];
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-appform-')));
  logs = [];
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const other = { type: 'stdio', command: 'other', env: { API_KEY: SENTINEL } };
const npx = (agent: string) => ({
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@4thtech-io/agentlink', 'mcp', '--agent', agent],
  env: {},
});
const app = (agent: string, start = START) => ({
  type: 'stdio',
  command: start.node,
  args: [start.cli, 'mcp', '--agent', agent],
  env: {},
});
const claudeJson = (servers: Record<string, unknown>) =>
  `${JSON.stringify({ numStartups: 3, mcpServers: servers }, null, 2)}\n`;

async function writeClaude(servers: Record<string, unknown>): Promise<string> {
  const path = join(home, '.claude.json');
  await writeFile(path, claudeJson(servers), { mode: 0o600 });
  if (POSIX) await chmod(path, 0o600);
  return path;
}
const readClaude = () => readFile(join(home, '.claude.json'), 'utf8');

function desk(located: () => DesktopApp | undefined, options: Partial<AiAppsDeskOptions> = {}) {
  return createAiAppsDesk({
    home,
    env: {},
    platform: 'darwin',
    now: () => 1_800_000_000,
    desktopRunning: () => Promise.resolve(false),
    agentIdOf: (name) => Promise.resolve(name === 'work' ? WORK : undefined),
    log: (line) => logs.push(line),
    desktopApp: () => Promise.resolve(located()),
    ...options,
  });
}

describe('list', () => {
  it('names the app form and says whether the app may be used', async () => {
    await writeClaude({ other, agentlink: app('work') });
    const list = await desk(() => OK).list();
    expect(list.desktopApp).toBe('available');
    expect(list.apps[0]?.state).toEqual({ kind: 'agent', agent: 'work', form: 'app' });
    expect(JSON.stringify(list)).not.toContain(SENTINEL);
    expect((await desk(() => TRANSLOCATED).list()).desktopApp).toBe('move_first');
    // No app: nothing about it, and its form is just another program (foreign).
    const none = await desk(() => undefined).list();
    expect(none.desktopApp).toBeUndefined();
    expect(none.apps[0]?.state).toEqual({ kind: 'foreign' });
  });

  it('the npx form is still recognised (no form named)', async () => {
    await writeClaude({ agentlink: npx('work') });
    const list = await desk(() => OK).list();
    expect(list.apps[0]?.state).toEqual({ kind: 'agent', agent: 'work' });
  });
});

describe('plan {form: app}: "Use the app for Claude Code"', () => {
  it('switch: the exact old and new entry; written only after commit', async () => {
    const before = claudeJson({ other, agentlink: npx('work') });
    await writeClaude({ other, agentlink: npx('work') });
    const plan = await desk(() => OK).plan('claude-code', 'work', { form: 'app' });
    expect(plan).toMatchObject({
      status: 'change',
      kind: 'switch',
      oldEntry: npx('work'),
      newEntry: app('work'),
      oldAgent: 'work',
      newAgent: 'work',
    });
    expect(await readClaude()).toBe(before);
    if (plan.status !== 'change') throw new Error('no change');
    expect(await plan.commit(WORK)).toBe('written');
    expect(await readClaude()).toBe(claudeJson({ other, agentlink: app('work') }));
    // A backup of the npx version was kept.
    const names = await readdir(home);
    expect(names.some((n) => n.startsWith('.claude.json.agentlink-backup-'))).toBe(true);
  });

  it('already on the app: present; without form a same-agent plan is still disconnect', async () => {
    await writeClaude({ agentlink: app('work') });
    expect((await desk(() => OK).plan('claude-code', 'work', { form: 'app' })).status).toBe(
      'present',
    );
    const off = await desk(() => OK).plan('claude-code', 'work');
    expect(off).toMatchObject({ status: 'change', kind: 'disconnect', oldEntry: app('work') });
  });

  it('a move keeps the app form; connect with form app writes it', async () => {
    await writeClaude({ agentlink: app('personal') });
    const move = await desk(() => OK).plan('claude-code', 'work');
    expect(move).toMatchObject({ kind: 'move', oldEntry: app('personal'), newEntry: app('work') });
    await writeClaude({ other });
    const connect = await desk(() => OK).plan('claude-code', 'work', { form: 'app' });
    expect(connect).toMatchObject({ kind: 'connect', newEntry: app('work') });
  });

  it('a foreign entry is never touched', async () => {
    await writeClaude({ agentlink: { command: 'mine', env: { TOKEN: SENTINEL } } });
    const before = await readClaude();
    const plan = await desk(() => OK).plan('claude-code', 'work', { form: 'app' });
    expect(plan.status).toBe('conflict');
    expect(JSON.stringify(plan)).not.toContain(SENTINEL);
    expect(await readClaude()).toBe(before);
  });

  it('a translocated (or missing) app is refused before anything is planned', async () => {
    await writeClaude({ agentlink: npx('work') });
    expect(
      (await desk(() => TRANSLOCATED).plan('claude-code', 'work', { form: 'app' })).status,
    ).toBe('app_location');
    expect((await desk(() => undefined).plan('claude-code', 'work', { form: 'app' })).status).toBe(
      'app_location',
    );
    // A move of an app-form entry while the app is translocated: refused too.
    await writeClaude({ agentlink: app('personal') });
    expect((await desk(() => TRANSLOCATED).plan('claude-code', 'work')).status).toBe(
      'app_location',
    );
  });

  it('the app moved to a translocated place after the plan: nothing written', async () => {
    await writeClaude({ agentlink: npx('work') });
    const before = await readClaude();
    let located: DesktopApp = OK;
    const plan = await desk(() => located).plan('claude-code', 'work', { form: 'app' });
    if (plan.status !== 'change') throw new Error('no change');
    located = TRANSLOCATED;
    expect(await plan.commit(WORK)).toBe('app_location');
    expect(await readClaude()).toBe(before);
    // Or it now sits somewhere else: the entry would no longer be the one shown.
    located = { status: 'ok', resources: '/x', start: { node: '/x/node', cli: '/x/cli.js' } };
    expect(await plan.commit(WORK)).toBe('app_location');
    expect(await readClaude()).toBe(before);
  });

  it('the signed agent must be the folder the entry runs', async () => {
    await writeClaude({ agentlink: npx('work') });
    const plan = await desk(() => OK).plan('claude-code', 'work', { form: 'app' });
    if (plan.status !== 'change') throw new Error('no change');
    expect(await plan.commit('0x9999999999999999999999999999999999999999')).toBe('agent_mismatch');
  });

  it('Codex: the three lines switch, nothing else', async () => {
    await mkdir(join(home, '.codex'));
    const head = `[other]\nsecret = "${SENTINEL}"\n\n`;
    const npxTable =
      '[mcp_servers.agentlink]\ncommand = "npx"\nargs = ["-y", "@4thtech-io/agentlink", "mcp", "--agent", "work"]\n';
    await writeFile(join(home, '.codex', 'config.toml'), `${head}${npxTable}`, { mode: 0o600 });
    const plan = await desk(() => OK).plan('codex', 'work', { form: 'app' });
    if (plan.status !== 'change') throw new Error(`no change: ${plan.status}`);
    expect(plan.kind).toBe('switch');
    expect(await plan.commit(WORK)).toBe('written');
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toBe(
      `${head}[mcp_servers.agentlink]\ncommand = ${JSON.stringify(START.node)}\nargs = [${JSON.stringify(START.cli)}, "mcp", "--agent", "work"]\n`,
    );
  });
});

describe('the launcher (optional)', () => {
  const nodeBin = '/Users/ana/.agentlink/runtime/node/bin';
  const installerLauncher =
    [
      '#!/bin/sh',
      '# AgentLink launcher, written by https://agentlink.4thtech.io/install.sh.',
      '# Remove with: curl -fsSL https://agentlink.4thtech.io/install.sh | sh -s -- --uninstall',
      `PATH='${nodeBin}':"$PATH"`,
      'export PATH',
      'AGENTLINK_LAUNCHER=installer',
      'export AGENTLINK_LAUNCHER',
      `exec '${nodeBin}/npx' -y --prefix='/Users/ana/.agentlink' --registry=https://registry.npmjs.org/ --@4thtech-io:registry=https://registry.npmjs.org/ @4thtech-io/agentlink@latest "$@"`,
    ].join('\n') + '\n';
  const launcherPath = () => join(home, '.agentlink', 'bin', 'agentlink');
  async function writeLauncher(text: string): Promise<void> {
    await mkdir(join(home, '.agentlink', 'bin'), { recursive: true, mode: 0o700 });
    if (POSIX) {
      await chmod(join(home, '.agentlink'), 0o700);
      await chmod(join(home, '.agentlink', 'bin'), 0o755);
    }
    await writeFile(launcherPath(), text, { mode: 0o755 });
    if (POSIX) await chmod(launcherPath(), 0o755);
  }

  it("offered for the installer's launcher; asked for: shown, then written with the entry", async () => {
    await writeClaude({ agentlink: npx('work') });
    await writeLauncher(installerLauncher);
    const offer = await desk(() => OK).plan('claude-code', 'work', { form: 'app' });
    expect(offer).toMatchObject({ status: 'change', kind: 'switch', launcherOffer: true });
    expect(offer).not.toHaveProperty('launcher');
    const plan = await desk(() => OK).plan('claude-code', 'work', { form: 'app', launcher: true });
    if (plan.status !== 'change') throw new Error('no change');
    expect(plan.launcher).toEqual({
      path: '~/.agentlink/bin/agentlink',
      oldText: installerLauncher,
      newText: appLauncherText(START, 'darwin'),
    });
    expect(await readFile(launcherPath(), 'utf8')).toBe(installerLauncher);
    expect(await plan.commit(WORK)).toBe('written');
    expect(await readFile(launcherPath(), 'utf8')).toBe(appLauncherText(START, 'darwin'));
    // Still a command; its backup is not one.
    const names = await readdir(join(home, '.agentlink', 'bin'));
    const backup = names.find((n) => n.startsWith('agentlink.agentlink-backup-'));
    expect(backup).toBeDefined();
    if (POSIX) {
      const { stat } = await import('node:fs/promises');
      expect((await stat(launcherPath())).mode & 0o777).toBe(0o755);
      expect((await stat(join(home, '.agentlink', 'bin', backup as string))).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  it('the launcher could not be written: the entry is, and the result says so', async () => {
    await writeClaude({ agentlink: npx('work') });
    await writeLauncher(installerLauncher);
    const plan = await desk(() => OK).plan('claude-code', 'work', { form: 'app', launcher: true });
    if (plan.status !== 'change') throw new Error('no change');
    // Changed after the preview: the launcher write refuses it.
    await writeLauncher(`${installerLauncher}echo mine\n`);
    expect(await plan.commit(WORK)).toBe('written_launcher_unchanged');
    expect(await readClaude()).toBe(claudeJson({ agentlink: app('work') }));
    expect(await readFile(launcherPath(), 'utf8')).toBe(`${installerLauncher}echo mine\n`);
    expect(logs).toContain('agentlink command not changed');
  });

  it('a launcher edited by hand is never offered nor written', async () => {
    await writeClaude({ agentlink: npx('work') });
    await writeLauncher(`${installerLauncher}echo mine\n`);
    const offer = await desk(() => OK).plan('claude-code', 'work', { form: 'app' });
    expect(offer).not.toHaveProperty('launcherOffer');
    const asked = await desk(() => OK).plan('claude-code', 'work', {
      form: 'app',
      launcher: true,
    });
    expect(asked.status).toBe('unreadable');
    expect(await readFile(launcherPath(), 'utf8')).toBe(`${installerLauncher}echo mine\n`);
  });

  it('only with the app form', async () => {
    await writeClaude({ other });
    await writeLauncher(installerLauncher);
    expect((await desk(() => OK).plan('claude-code', 'work', { launcher: true })).status).toBe(
      'unreadable',
    );
    expect(logs.join('\n')).not.toContain(SENTINEL);
  });
});
