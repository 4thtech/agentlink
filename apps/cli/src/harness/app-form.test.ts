// WP-D7 (S2): the app form of the `agentlink` entry, per harness: recognised only for the app this
// computer has, written with the app's absolute bundled node + CLI (`mcp`), on Windows `node.exe`
// with no `cmd /c`; the npx form stays recognised; foreign entries and every other byte untouched.
import { describe, expect, it } from 'vitest';
import { appEntry, readEntryState, removeEntry, setEntry } from './entry.js';
import { harnessById } from './harnesses.js';

const SENTINEL = 'other-server-private-value';
const MAC = {
  node: '/Applications/AgentLink.app/Contents/Resources/node/bin/node',
  cli: '/Applications/AgentLink.app/Contents/Resources/core/node_modules/@4thtech-io/agentlink/dist/agentlink.js',
};
const RES = 'C:\\Users\\ana\\AppData\\Local\\Programs\\AgentLink\\resources';
const WIN = {
  node: `${RES}\\node\\node.exe`,
  cli: `${RES}\\core\\node_modules\\@4thtech-io\\agentlink\\dist\\agentlink.js`,
};
const OTHER_APP = { node: '/opt/Other.app/node', cli: '/opt/Other.app/agentlink.js' };

const claudeCode = harnessById('claude-code');
const desktop = harnessById('claude-desktop');
const opencode = harnessById('opencode');
const cursor = harnessById('cursor');
const codex = harnessById('codex');

const other = { type: 'stdio', command: 'other', env: { API_KEY: SENTINEL } };
const npx = (agent?: string) => ({
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@4thtech-io/agentlink', 'mcp', ...(agent === undefined ? [] : ['--agent', agent])],
  env: {},
});
const app = (start = MAC, agent?: string) => ({
  type: 'stdio',
  command: start.node,
  args: [start.cli, 'mcp', ...(agent === undefined ? [] : ['--agent', agent])],
  env: {},
});
const file = (servers: Record<string, unknown>) =>
  `${JSON.stringify({ numStartups: 3, mcpServers: servers, tail: { keep: SENTINEL } }, null, 2)}\n`;

describe('the app form per harness', () => {
  it('Claude Code, Claude Desktop, Cursor, OpenCode: absolute node, then the CLI and mcp', () => {
    expect(appEntry(claudeCode, 'work', MAC)).toEqual(app(MAC, 'work'));
    expect(appEntry(claudeCode, 'default', MAC)).toEqual(app(MAC));
    expect(appEntry(desktop, 'work', MAC)).toEqual({
      command: MAC.node,
      args: [MAC.cli, 'mcp', '--agent', 'work'],
    });
    expect(appEntry(cursor, 'work', MAC)).toEqual({
      type: 'stdio',
      command: MAC.node,
      args: [MAC.cli, 'mcp', '--agent', 'work'],
    });
    expect(appEntry(opencode, 'work', MAC)).toEqual({
      type: 'local',
      command: [MAC.node, MAC.cli, 'mcp', '--agent', 'work'],
      enabled: true,
    });
  });

  it('Windows: node.exe is the command itself (no cmd /c, no npx)', () => {
    const entry = appEntry(desktop, 'work', WIN) as { command: string; args: string[] };
    expect(entry.command).toBe(WIN.node);
    expect(entry.args).toEqual([WIN.cli, 'mcp', '--agent', 'work']);
    expect(JSON.stringify(entry)).not.toMatch(/"cmd"|"\/c"|npx/);
  });

  it('never points at the desktop host', () => {
    expect(JSON.stringify(appEntry(claudeCode, 'work', MAC))).not.toContain('desktop-host');
  });
});

describe('recognition', () => {
  it('the app form is ours only for this computer’s app; the npx form stays ours', () => {
    const text = file({ other, agentlink: app(MAC, 'work') });
    expect(readEntryState(claudeCode, text, { app: MAC })).toEqual({
      kind: 'agent',
      agent: 'work',
      entry: app(MAC, 'work'),
      form: 'app',
    });
    // Without the app (or for another program at another path) it is not ours.
    expect(readEntryState(claudeCode, text)).toEqual({ kind: 'foreign' });
    expect(readEntryState(claudeCode, text, { app: OTHER_APP })).toEqual({ kind: 'foreign' });
    expect(readEntryState(claudeCode, file({ agentlink: npx('work') }), { app: MAC })).toEqual({
      kind: 'agent',
      agent: 'work',
      entry: npx('work'),
      form: 'npx',
    });
    // Windows' `cmd /c npx` form too.
    const cmd = {
      type: 'stdio',
      command: 'cmd',
      args: ['/c', 'npx', ...npx('work').args],
      env: {},
    };
    expect(readEntryState(claudeCode, file({ agentlink: cmd }), { app: WIN })).toMatchObject({
      kind: 'agent',
      form: 'npx',
    });
  });

  it('an app-form entry with anything extra is foreign, and nothing of it is returned', () => {
    const extra = { ...app(MAC, 'work'), env: { TOKEN: SENTINEL } };
    const state = readEntryState(claudeCode, file({ agentlink: extra }), { app: MAC });
    expect(state).toEqual({ kind: 'foreign' });
    expect(JSON.stringify(state)).not.toContain(SENTINEL);
    const wrongArg = { ...app(MAC, 'work'), args: [MAC.cli, 'ui', '--agent', 'work'] };
    expect(readEntryState(claudeCode, file({ agentlink: wrongArg }), { app: MAC })).toEqual({
      kind: 'foreign',
    });
  });
});

describe('switching the form rewrites only the agentlink member', () => {
  it('npx → app, every other byte unchanged', () => {
    const before = file({ other, agentlink: npx('work') });
    const after = setEntry(claudeCode, before, 'work', { app: MAC, form: 'app' });
    expect(after).toBe(file({ other, agentlink: app(MAC, 'work') }));
    expect(after).toContain(SENTINEL);
    // A move keeps the form the entry has.
    const moved = setEntry(claudeCode, after, 'personal', { app: MAC });
    expect(moved).toBe(file({ other, agentlink: app(MAC, 'personal') }));
    // Disconnect removes the app-form entry like any of ours.
    expect(removeEntry(claudeCode, after, { app: MAC })).toBe(file({ other }));
  });

  it('a foreign entry is never touched', () => {
    const foreign = file({ agentlink: { command: 'evil', args: [] } });
    expect(() => setEntry(claudeCode, foreign, 'work', { app: MAC, form: 'app' })).toThrow();
    // An app-form entry of another app is foreign here too.
    const elsewhere = file({ agentlink: app(OTHER_APP, 'work') });
    expect(() => setEntry(claudeCode, elsewhere, 'work', { app: MAC, form: 'app' })).toThrow();
  });

  it('a new entry gets the app form when asked', () => {
    expect(setEntry(claudeCode, file({ other }), 'work', { app: MAC, form: 'app' })).toBe(
      `${JSON.stringify(
        {
          numStartups: 3,
          mcpServers: { agentlink: app(MAC, 'work'), other },
          tail: { keep: SENTINEL },
        },
        null,
        2,
      )}\n`,
    );
  });
});

describe('Codex TOML', () => {
  const head = `model = "o4"\n[other]\nsecret = "${SENTINEL}"\n`;
  const npxTable =
    '[mcp_servers.agentlink]\ncommand = "npx"\nargs = ["-y", "@4thtech-io/agentlink", "mcp", "--agent", "work"]\n';
  const appTable = `[mcp_servers.agentlink]\ncommand = ${JSON.stringify(MAC.node)}\nargs = [${JSON.stringify(MAC.cli)}, "mcp", "--agent", "work"]\n`;

  it('switches the three lines and nothing else; the app table is recognised', () => {
    const after = setEntry(codex, `${head}\n${npxTable}`, 'work', { app: MAC, form: 'app' });
    expect(after).toBe(`${head}\n${appTable}`);
    expect(readEntryState(codex, after, { app: MAC })).toEqual({
      kind: 'agent',
      agent: 'work',
      entry: { command: MAC.node, args: [MAC.cli, 'mcp', '--agent', 'work'] },
      form: 'app',
    });
    expect(readEntryState(codex, after)).toEqual({ kind: 'foreign' });
    expect(removeEntry(codex, after, { app: MAC })).toBe(`${head}\n`);
  });

  it('CRLF files keep CRLF', () => {
    const crlf = `${head}\n${npxTable}`.replace(/\n/g, '\r\n');
    const after = setEntry(codex, crlf, 'work', { app: MAC, form: 'app' });
    expect(after).toBe(`${head}\n${appTable}`.replace(/\n/g, '\r\n'));
  });
});
