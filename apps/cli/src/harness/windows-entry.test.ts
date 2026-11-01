// W5-WINDOWS: on Windows every harness entry starts with `cmd /c npx …` (npx is a .cmd file there),
// both start forms are recognised, and an entry written in the old form moves to the new one.
import { afterEach, describe, expect, it } from 'vitest';
import { explainJsonConflict, explainTomlConflict } from './conflict.js';
import { agentlinkEntry, readEntryState, removeEntry, setEntry } from './entry.js';
import { HARNESS_IDS, harnessById, startWords } from './harnesses.js';

const real = process.platform;
const setPlatform = (value: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value, configurable: true });
};
afterEach(() => setPlatform(real));

const ARGS = ['-y', '@4thtech-io/agentlink', 'mcp'];

describe('startWords', () => {
  it('wraps npx in cmd /c on win32 only', () => {
    expect(startWords(ARGS, 'win32')).toEqual(['cmd', '/c', 'npx', ...ARGS]);
    expect(startWords(ARGS, 'darwin')).toEqual(['npx', ...ARGS]);
    expect(startWords(ARGS, 'linux')).toEqual(['npx', ...ARGS]);
  });
});

describe('entries on win32', () => {
  it.each(HARNESS_IDS.filter((id) => id !== 'codex'))('%s uses cmd /c npx', (id) => {
    const def = harnessById(id);
    if (def.format.kind !== 'json') throw new Error('json harness expected');
    const entry = def.format.entry(ARGS, 'win32');
    const words = Array.isArray(entry['command'])
      ? entry['command']
      : [entry['command'], ...(entry['args'] as string[])];
    expect(words).toEqual(['cmd', '/c', 'npx', ...ARGS]);
  });

  it('Codex TOML uses cmd /c npx', () => {
    setPlatform('win32');
    const codex = harnessById('codex');
    const text = setEntry(codex, undefined, 'default');
    expect(text).toContain('command = "cmd"');
    expect(text).toContain('args = ["/c", "npx", "-y", "@4thtech-io/agentlink", "mcp"]');
    expect(readEntryState(codex, text)).toMatchObject({ kind: 'agent', agent: 'default' });
  });

  it('keeps POSIX entries unchanged elsewhere', () => {
    expect(agentlinkEntry(harnessById('claude-desktop'), 'default', 'darwin')).toEqual({
      command: 'npx',
      args: ARGS,
    });
  });
});

describe('migration of existing entries', () => {
  const file = (entry: unknown) =>
    `${JSON.stringify({ mcpServers: { agentlink: entry } }, null, 2)}\n`;
  const legacy = file({ command: 'npx', args: ARGS });
  const modern = file({ command: 'cmd', args: ['/c', 'npx', ...ARGS] });

  it('reads both forms as ours, on either system', () => {
    const desktop = harnessById('claude-desktop');
    for (const platform of ['win32', 'darwin'] as const) {
      setPlatform(platform);
      expect(readEntryState(desktop, legacy)).toMatchObject({ kind: 'agent', agent: 'default' });
      expect(readEntryState(desktop, modern)).toMatchObject({ kind: 'agent', agent: 'default' });
    }
  });

  it('a write on win32 turns the old form into cmd /c npx, keeping the rest', () => {
    setPlatform('win32');
    const desktop = harnessById('claude-desktop');
    expect(setEntry(desktop, legacy, 'default')).toBe(modern);
    expect(removeEntry(desktop, modern)).toBe(`${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
  });

  it('migrates a Codex table in the old form', () => {
    setPlatform('win32');
    const codex = harnessById('codex');
    const old = `[mcp_servers.agentlink]\ncommand = "npx"\nargs = ["-y", "@4thtech-io/agentlink", "mcp"]\n`;
    expect(readEntryState(codex, old)).toMatchObject({ kind: 'agent', agent: 'default' });
    const moved = setEntry(codex, old, 'work');
    expect(moved).toContain('command = "cmd"');
    expect(moved).toContain('"--agent", "work"');
  });

  it('foreign commands stay foreign', () => {
    const desktop = harnessById('claude-desktop');
    expect(readEntryState(desktop, file({ command: 'cmd', args: ['/c', 'evil'] }))).toEqual({
      kind: 'foreign',
    });
  });
});

describe('conflict summary with cmd /c', () => {
  const wanted = [...ARGS, '--agent', 'codex'];
  it('sees another agent behind cmd /c', () => {
    const text = JSON.stringify({
      mcpServers: {
        agentlink: { command: 'cmd', args: ['/c', 'npx', ...ARGS, '--agent', 'work'] },
      },
    });
    expect(explainJsonConflict(text, 'mcpServers', wanted)).toEqual({
      kind: 'other_agent',
      existing: 'work',
      wanted: 'codex',
    });
  });

  it('Codex TOML in the new form', () => {
    const text = `[mcp_servers.agentlink]\ncommand = "cmd"\nargs = ["/c", "npx", "-y", "@4thtech-io/agentlink", "mcp", "--agent", "old"]\n`;
    expect(explainTomlConflict(text, wanted)).toEqual({
      kind: 'other_agent',
      existing: 'old',
      wanted: 'codex',
    });
  });

  it('same agent in either form is not another agent', () => {
    const text = JSON.stringify({
      mcpServers: { agentlink: { command: 'cmd', args: ['/c', 'npx', ...wanted] } },
    });
    expect(explainJsonConflict(text, 'mcpServers', wanted)).toEqual({ kind: 'other_command' });
  });
});
