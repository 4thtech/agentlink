// U3-f (S2; 04 §2.5 "Writing AI app configs", 06 §7 "The app as a second path", 08 §1 "Entry-only
// config display"): the app's entry-only view of an AI app config and its exact replace and remove.
//
// - Only the `agentlink` member is ever read out: an entry exactly as AgentLink writes it for a
//   valid agent name is that agent's; anything else is `foreign` (a conflict with manual steps) and
//   nothing of it is returned.
// - Replacing or removing changes only that member: every other entry (and its secret) keeps its
//   exact bytes; the file must be in a form that can be rewritten exactly, else it is refused.
import { describe, expect, it } from 'vitest';
import { agentlinkEntry, readEntryState, removeEntry, setEntry } from './entry.js';
import { HarnessError } from './errors.js';
import { harnessById } from './harnesses.js';

const SENTINEL = 'other-server-private-value';
const claudeCode = harnessById('claude-code');
const desktop = harnessById('claude-desktop');
const codex = harnessById('codex');
const opencode = harnessById('opencode');

const ours = (agent?: string) => ({
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@4thtech-io/agentlink', 'mcp', ...(agent === undefined ? [] : ['--agent', agent])],
  env: {},
});

const jsonFile = (servers: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ projects: { a: 1 }, mcpServers: servers, ...extra }, null, 2)}\n`;

const other = { command: 'other-tool', env: { API_KEY: SENTINEL } };

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof HarnessError ? error.code : 'other';
  }
  return undefined;
}

describe('readEntryState (JSON)', () => {
  it('no file, no servers object and no agentlink member read as none', () => {
    expect(readEntryState(claudeCode, undefined)).toEqual({ kind: 'none' });
    expect(readEntryState(claudeCode, '{\n  "a": 1\n}\n')).toEqual({ kind: 'none' });
    expect(readEntryState(claudeCode, jsonFile({ other }))).toEqual({ kind: 'none' });
  });

  it('an entry exactly as AgentLink writes it names its agent (default has no --agent)', () => {
    expect(readEntryState(claudeCode, jsonFile({ agentlink: ours(), other }))).toEqual({
      kind: 'agent',
      agent: 'default',
      entry: ours(),
    });
    expect(readEntryState(claudeCode, jsonFile({ other, agentlink: ours('work') }))).toEqual({
      kind: 'agent',
      agent: 'work',
      entry: ours('work'),
    });
  });

  it('an entry AgentLink did not write is foreign, and nothing of it is returned', () => {
    const foreign = [
      { ...ours('work'), env: { TOKEN: SENTINEL } },
      { command: 'node', args: ['/x/agentlink.js', 'mcp'] },
      { ...ours('Not-A-Name') },
      { ...ours(), args: ['-y', '@4thtech-io/agentlink@0.3.0', 'mcp'] },
    ];
    for (const entry of foreign) {
      const state = readEntryState(claudeCode, jsonFile({ agentlink: entry, other }));
      expect(state).toEqual({ kind: 'foreign' });
      expect(JSON.stringify(state)).not.toContain(SENTINEL);
    }
  });

  it('refuses a file it cannot rewrite exactly, with a fixed code', () => {
    expect(code(() => readEntryState(claudeCode, '{ not json'))).toBe('malformed');
    expect(code(() => readEntryState(claudeCode, '{"a":1,  "mcpServers":{}}'))).toBe(
      'unsupported_format',
    );
    expect(code(() => readEntryState(claudeCode, '{\n  "mcpServers": []\n}\n'))).toBe(
      'unsupported_format',
    );
  });

  it('error text never carries file content', () => {
    try {
      readEntryState(claudeCode, `{"k": "${SENTINEL}", oops`);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(SENTINEL);
    }
  });
});

describe('setEntry and removeEntry (JSON)', () => {
  it('adds the entry first and leaves every other member byte-identical', () => {
    const before = jsonFile({ other });
    const after = setEntry(claudeCode, before, 'work');
    const parsed = JSON.parse(after) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(parsed.mcpServers)).toEqual(['agentlink', 'other']);
    expect(parsed.mcpServers['agentlink']).toEqual(ours('work'));
    expect(parsed.mcpServers['other']).toEqual(other);
    expect(after).toContain(SENTINEL);
  });

  it('moves an app between agents in place: only the agentlink member changes', () => {
    const before = jsonFile({ other, agentlink: ours('personal') });
    const after = setEntry(claudeCode, before, 'work');
    expect(after).toBe(jsonFile({ other, agentlink: ours('work') }));
  });

  it('removes only the agentlink member', () => {
    const before = jsonFile({ other, agentlink: ours('work') });
    expect(removeEntry(claudeCode, before)).toBe(jsonFile({ other }));
    expect(removeEntry(claudeCode, jsonFile({ agentlink: ours() }))).toBe(jsonFile({}));
  });

  it('creates a missing file with the entry alone', () => {
    expect(JSON.parse(setEntry(desktop, undefined, 'work'))).toEqual({
      mcpServers: { agentlink: agentlinkEntry(desktop, 'work') },
    });
  });

  it('never replaces or removes a foreign entry', () => {
    const before = jsonFile({ agentlink: { command: 'x', env: { K: SENTINEL } } });
    expect(code(() => setEntry(claudeCode, before, 'work'))).toBe('changed');
    expect(code(() => removeEntry(claudeCode, before))).toBe('changed');
  });

  it('uses the OpenCode `mcp` key and its entry form', () => {
    const text = `${JSON.stringify({ mcp: { other } }, null, 2)}\n`;
    const after = setEntry(opencode, text, 'work');
    const state = readEntryState(opencode, after);
    expect(state).toEqual({
      kind: 'agent',
      agent: 'work',
      entry: {
        type: 'local',
        command: ['npx', '-y', '@4thtech-io/agentlink', 'mcp', '--agent', 'work'],
        enabled: true,
      },
    });
    expect(removeEntry(opencode, after)).toBe(text);
  });
});

describe('Codex TOML', () => {
  const head = `model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\nenv = { KEY = "${SENTINEL}" }\n`;
  const table = (agent?: string) =>
    `[mcp_servers.agentlink]\ncommand = "npx"\nargs = ["-y", "@4thtech-io/agentlink", "mcp"${
      agent === undefined ? '' : `, "--agent", "${agent}"`
    }]\n`;

  it('reads none, an agent, or foreign', () => {
    expect(readEntryState(codex, undefined)).toEqual({ kind: 'none' });
    expect(readEntryState(codex, head)).toEqual({ kind: 'none' });
    expect(readEntryState(codex, `${head}\n${table('work')}`)).toEqual({
      kind: 'agent',
      agent: 'work',
      entry: { command: 'npx', args: ['-y', '@4thtech-io/agentlink', 'mcp', '--agent', 'work'] },
    });
    const extraKey = `${head}\n${table('work')}env = { T = "${SENTINEL}" }\n`;
    expect(readEntryState(codex, extraKey)).toEqual({ kind: 'foreign' });
    const commented = `${head}\n${table('work').replace('"npx"', '"npx" # mine')}`;
    expect(readEntryState(codex, commented)).toEqual({ kind: 'foreign' });
  });

  it('moves and removes only the agentlink table, keeping CRLF and every other line', () => {
    const before = `${head}\n${table('personal')}\n[profiles.x]\nmodel = "y"\n`;
    const moved = setEntry(codex, before, 'work');
    expect(moved).toBe(`${head}\n${table('work')}\n[profiles.x]\nmodel = "y"\n`);
    const removed = removeEntry(codex, moved);
    expect(removed).toBe(`${head}\n\n[profiles.x]\nmodel = "y"\n`);
    expect(readEntryState(codex, removed)).toEqual({ kind: 'none' });
    const crlf = before.replaceAll('\n', '\r\n');
    expect(setEntry(codex, crlf, 'work')).toBe(moved.replaceAll('\n', '\r\n'));
  });

  it('appends a new table and refuses a foreign one', () => {
    expect(readEntryState(codex, setEntry(codex, head, 'work'))).toMatchObject({
      kind: 'agent',
      agent: 'work',
    });
    const foreign = `${head}\n[mcp_servers.agentlink]\ncommand = "evil"\n`;
    expect(code(() => setEntry(codex, foreign, 'work'))).toBe('changed');
  });
});
