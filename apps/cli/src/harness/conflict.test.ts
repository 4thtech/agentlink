// M1-UX-MULTI-AGENT: the safe summary of how an existing `agentlink` entry differs.
import { describe, expect, it } from 'vitest';
import { explainJsonConflict, explainTomlConflict } from './conflict.js';

const ARGS = ['-y', '@4thtech-io/agentlink', 'mcp', '--agent', 'codex'];
const json = (entry: unknown, key = 'mcpServers'): string =>
  JSON.stringify({ [key]: { agentlink: entry } });

describe('explainJsonConflict', () => {
  it('another agent name', () => {
    const text = json({
      command: 'npx',
      args: ['-y', '@4thtech-io/agentlink', 'mcp', '--agent', 'work'],
    });
    expect(explainJsonConflict(text, 'mcpServers', ARGS)).toEqual({
      kind: 'other_agent',
      existing: 'work',
      wanted: 'codex',
    });
  });

  it('no --agent means the default agent', () => {
    const text = json({ command: 'npx', args: ['-y', '@4thtech-io/agentlink', 'mcp'] });
    expect(explainJsonConflict(text, 'mcpServers', ARGS)).toMatchObject({ existing: 'default' });
  });

  it('OpenCode command array under mcp', () => {
    const text = json(
      { type: 'local', command: ['npx', '-y', '@4thtech-io/agentlink', 'mcp', '--agent', 'x1'] },
      'mcp',
    );
    expect(explainJsonConflict(text, 'mcp', ARGS)).toMatchObject({
      kind: 'other_agent',
      existing: 'x1',
    });
  });

  it('same agent but another way of starting: other_command', () => {
    const text = json({ command: 'agentlink', args: ['mcp', '--agent', 'codex'], env: { K: 'v' } });
    expect(explainJsonConflict(text, 'mcpServers', ARGS)).toEqual({ kind: 'other_command' });
  });

  it('a different program is other_command and nothing from it is returned', () => {
    const text = json({ command: 'node', args: ['/x/y.js', 'https://u.test/?k=secret'] });
    const result = explainJsonConflict(text, 'mcpServers', ARGS);
    expect(result).toEqual({ kind: 'other_command' });
    expect(JSON.stringify(result)).not.toMatch(/secret|u\.test/);
  });

  it('an invalid agent name in the file is never returned', () => {
    const text = json({
      command: 'npx',
      args: ['-y', '@4thtech-io/agentlink', 'mcp', '--agent', 'Bad Name\u001b[2J'],
    });
    expect(explainJsonConflict(text, 'mcpServers', ARGS)).toEqual({ kind: 'unknown' });
  });

  it.each(['', 'not json', '{}', json('str'), json({ command: 5 })])(
    'unreadable (%j): unknown',
    (text) => {
      expect(explainJsonConflict(text, 'mcpServers', ARGS)).toEqual({ kind: 'unknown' });
    },
  );
});

describe('explainTomlConflict', () => {
  it('another agent name', () => {
    const text =
      '[mcp_servers.agentlink]\ncommand = "npx"\nargs = ["-y", "@4thtech-io/agentlink", "mcp", "--agent", "old"]\n';
    expect(explainTomlConflict(text, ARGS)).toEqual({
      kind: 'other_agent',
      existing: 'old',
      wanted: 'codex',
    });
  });

  it('only the command line: other_command', () => {
    expect(explainTomlConflict('[mcp_servers.agentlink]\ncommand = "mine"\n', ARGS)).toEqual({
      kind: 'other_command',
    });
  });

  it('stops at the next table', () => {
    const text =
      '[mcp_servers.agentlink]\ncommand = "mine"\n[other]\nargs = ["mcp", "agentlink", "--agent", "zz"]\n';
    expect(explainTomlConflict(text, ARGS)).toEqual({ kind: 'other_command' });
  });

  it('no table: unknown', () => {
    expect(explainTomlConflict('a = 1\n', ARGS)).toEqual({ kind: 'unknown' });
  });
});
