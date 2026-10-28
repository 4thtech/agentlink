// U3-f (S2; 04 §2.5 "Writing AI app configs", 06 §7 "The app as a second path", 08 §1 "Entry-only
// config display"): the harness seam the CLI passes to the local app (one writer, packages/node has
// none). The list and the plan show only the `agentlink` entry; nothing else of the file reaches an
// answer, an error or a log. Fixed paths from the harness table only, realpath and no links, the
// file's identity (device and inode) pinned, the write atomic with a backup that keeps the mode;
// Claude Desktop is never written while it runs; the agent named in the entry must be the agent the
// owner signed for.
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAiAppsDesk, type AiAppsDeskOptions } from './app-desk.js';

const POSIX = process.platform !== 'win32';
const SENTINEL = 'other-server-private-value';
const WORK = '0x1111111111111111111111111111111111111111';
const PERSONAL = '0x2222222222222222222222222222222222222222';

let home: string;
let outside: string;
let logs: string[];

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-apps-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-apps-out-')));
  logs = [];
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const claudeJson = (servers: Record<string, unknown>) =>
  `${JSON.stringify({ numStartups: 3, mcpServers: servers }, null, 2)}\n`;
const other = { type: 'stdio', command: 'other', env: { API_KEY: SENTINEL } };
const ours = (agent?: string) => ({
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@4thtech-io/agentlink', 'mcp', ...(agent === undefined ? [] : ['--agent', agent])],
  env: {},
});

function desk(options: Partial<AiAppsDeskOptions> = {}) {
  return createAiAppsDesk({
    home,
    env: {},
    platform: 'darwin',
    now: () => 1_800_000_000,
    desktopRunning: () => Promise.resolve(false),
    agentIdOf: (name) =>
      Promise.resolve(name === 'work' ? WORK : name === 'personal' ? PERSONAL : undefined),
    log: (line) => logs.push(line),
    ...options,
  });
}

async function writeClaude(servers: Record<string, unknown>, mode = 0o600): Promise<string> {
  const path = join(home, '.claude.json');
  await writeFile(path, claudeJson(servers), { mode });
  if (POSIX) await chmod(path, mode);
  return path;
}

describe('list: entry-only', () => {
  it('names the agent each detected app runs; a secret elsewhere in the file reaches nothing', async () => {
    await writeClaude({ other, agentlink: ours('work') });
    await mkdir(join(home, '.codex'));
    await writeFile(join(home, '.codex', 'config.toml'), `[mcp_servers.x]\nkey = "${SENTINEL}"\n`);
    const list = await desk().list();
    expect(list.desktopRunning).toBe(false);
    expect(list.apps).toEqual([
      expect.objectContaining({
        app: 'claude-code',
        name: 'Claude Code',
        path: '~/.claude.json',
        state: { kind: 'agent', agent: 'work' },
        quitFirst: false,
      }),
      expect.objectContaining({ app: 'codex', state: { kind: 'none' } }),
    ]);
    expect(JSON.stringify(list)).not.toContain(SENTINEL);
    expect(logs.join('\n')).not.toContain(SENTINEL);
  });

  it('a foreign agentlink entry is listed as foreign with nothing of it', async () => {
    await writeClaude({ agentlink: { command: 'x', env: { TOKEN: SENTINEL } } });
    const list = await desk().list();
    expect(list.apps[0]?.state).toEqual({ kind: 'foreign' });
    expect(JSON.stringify(list)).not.toContain(SENTINEL);
  });

  it.skipIf(!POSIX)(
    'a symlinked config is refused (unreadable), even to a file in home',
    async () => {
      const real = join(outside, 'claude.json');
      await writeFile(real, claudeJson({ other, agentlink: ours('work') }), { mode: 0o600 });
      await symlink(real, join(home, '.claude.json'));
      const list = await desk().list();
      expect(list.apps[0]?.state).toEqual({ kind: 'unreadable' });
      expect(JSON.stringify(list)).not.toContain(SENTINEL);
      const plan = await desk().plan('claude-code', 'work');
      expect(plan.status).toBe('unreadable');
    },
  );

  it('marks Claude Desktop quit-first while it runs', async () => {
    await mkdir(join(home, 'Library', 'Application Support', 'Claude'), { recursive: true });
    const list = await desk({ desktopRunning: () => Promise.resolve(true) }).list();
    expect(list.desktopRunning).toBe(true);
    expect(list.apps.find((a) => a.app === 'claude-desktop')?.quitFirst).toBe(true);
  });
});

describe('plan: the exact entry change', () => {
  it('connect: adds the fixed entry; the old entry is null', async () => {
    await writeClaude({ other });
    const plan = await desk().plan('claude-code', 'work');
    expect(plan).toMatchObject({
      status: 'change',
      kind: 'connect',
      app: 'claude-code',
      name: 'Claude Code',
      path: '~/.claude.json',
      file: join(home, '.claude.json'),
      oldEntry: null,
      newEntry: ours('work'),
      oldAgent: null,
      newAgent: 'work',
    });
    expect(JSON.stringify(plan)).not.toContain(SENTINEL);
  });

  it('move: both entries; disconnect when it already runs this agent', async () => {
    await writeClaude({ other, agentlink: ours('personal') });
    expect(await desk().plan('claude-code', 'work')).toMatchObject({
      status: 'change',
      kind: 'move',
      oldEntry: ours('personal'),
      newEntry: ours('work'),
      oldAgent: 'personal',
      newAgent: 'work',
    });
    expect(await desk().plan('claude-code', 'personal')).toMatchObject({
      status: 'change',
      kind: 'disconnect',
      oldEntry: ours('personal'),
      newEntry: null,
      oldAgent: 'personal',
      newAgent: null,
    });
  });

  it('a foreign entry is a conflict; an undetected app is not_found; Claude Desktop open is quit_first', async () => {
    await writeClaude({ agentlink: { command: 'x', env: { TOKEN: SENTINEL } } });
    const conflict = await desk().plan('claude-code', 'work');
    expect(conflict).toEqual({ status: 'conflict', app: 'claude-code', name: 'Claude Code' });
    expect((await desk().plan('cursor', 'work')).status).toBe('not_found');
    await mkdir(join(home, 'Library', 'Application Support', 'Claude'), { recursive: true });
    const open = await desk({ desktopRunning: () => Promise.resolve(true) }).plan(
      'claude-desktop',
      'work',
    );
    expect(open.status).toBe('quit_first');
  });

  it('refuses an app outside the table and a name outside the rule', async () => {
    await writeClaude({});
    expect((await desk().plan('vscode', 'work')).status).toBe('not_found');
    expect((await desk().plan('claude-code', '../x')).status).toBe('not_found');
  });
});

describe('commit: the write', () => {
  it('writes atomically; the backup holds the old bytes and keeps the original mode', async () => {
    const path = await writeClaude({ other }, 0o640);
    const old = await readFile(path, 'utf8');
    const plan = await desk().plan('claude-code', 'work');
    if (plan.status !== 'change') throw new Error('expected a change');
    expect(await plan.commit(WORK)).toBe('written');
    const now = JSON.parse(await readFile(path, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(now.mcpServers).toEqual({ agentlink: ours('work'), other });
    const backups = (await readdir(home)).filter((n) => n.includes('agentlink-backup'));
    expect(backups).toHaveLength(1);
    const backup = join(home, backups[0] ?? '');
    expect(await readFile(backup, 'utf8')).toBe(old);
    if (POSIX) {
      expect((await stat(backup)).mode & 0o777).toBe(0o640);
      expect((await stat(path)).mode & 0o777).toBe(0o640);
    }
  });

  it('a mismatched agent writes nothing', async () => {
    const path = await writeClaude({ other });
    const before = await readFile(path, 'utf8');
    const plan = await desk().plan('claude-code', 'work');
    if (plan.status !== 'change') throw new Error('expected a change');
    expect(await plan.commit(PERSONAL)).toBe('agent_mismatch');
    const unknown = await desk({ agentIdOf: () => Promise.resolve(undefined) }).plan(
      'claude-code',
      'work',
    );
    if (unknown.status !== 'change') throw new Error('expected a change');
    expect(await unknown.commit(WORK)).toBe('agent_mismatch');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('a file changed after the plan, or swapped for another inode with the same bytes, is changed', async () => {
    const path = await writeClaude({ other });
    const plan = await desk().plan('claude-code', 'work');
    if (plan.status !== 'change') throw new Error('expected a change');
    await writeFile(path, claudeJson({ other, more: { command: 'y' } }));
    expect(await plan.commit(WORK)).toBe('changed');

    const same = claudeJson({ other });
    await writeFile(path, same, { mode: 0o600 });
    const pinned = await desk().plan('claude-code', 'work');
    if (pinned.status !== 'change') throw new Error('expected a change');
    const swap = join(home, 'swap.json');
    await writeFile(swap, same, { mode: 0o600 });
    await rename(swap, path);
    expect(await pinned.commit(WORK)).toBe('changed');
    expect(await readFile(path, 'utf8')).toBe(same);
  });

  it('re-checks Claude Desktop before the write', async () => {
    await mkdir(join(home, 'Library', 'Application Support', 'Claude'), { recursive: true });
    let running = false;
    const d = desk({ desktopRunning: () => Promise.resolve(running) });
    const plan = await d.plan('claude-desktop', 'work');
    if (plan.status !== 'change') throw new Error('expected a change');
    running = true;
    expect(await plan.commit(WORK)).toBe('quit_first');
    expect(await readdir(join(home, 'Library', 'Application Support', 'Claude'))).toEqual([]);
  });

  it('disconnect removes only this entry', async () => {
    const path = await writeClaude({ other, agentlink: ours('work') });
    const plan = await desk().plan('claude-code', 'work');
    if (plan.status !== 'change' || plan.kind !== 'disconnect') throw new Error('expected one');
    expect(await plan.commit(WORK)).toBe('written');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      numStartups: 3,
      mcpServers: { other },
    });
  });

  it('logs nothing from the file', async () => {
    await writeClaude({ other, agentlink: ours('personal') });
    const plan = await desk().plan('claude-code', 'work');
    if (plan.status !== 'change') throw new Error('expected a change');
    await plan.commit(WORK);
    expect(logs.join('\n')).not.toContain(SENTINEL);
  });
});
