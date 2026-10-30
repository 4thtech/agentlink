// W4-LIVE-STATUS (06 §6 "AI app id"; D-143 Q-143-4): `clientInfo.name` of `initialize` is mapped
// through one fixed table to an id of the 06 §7 table, else `other`. Compared exactly, ASCII case-folded,
// at most 64 characters; the name is untrusted (I-5) and never kept.
import { AI_APP_IDS } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import { CLIENT_APP_IDS, mcpAppIdFor } from './client-app.js';

describe('mcpAppIdFor (06 §6)', () => {
  it('pins the known client names (verified against each client at build time)', () => {
    expect(CLIENT_APP_IDS).toEqual({
      'claude-code': 'claude-code',
      'claude-ai': 'claude-desktop',
      'codex-mcp-client': 'codex',
      'gemini-cli-mcp-client': 'gemini-cli',
      opencode: 'opencode',
      'cursor-vscode': 'cursor',
    });
    // Windsurf and Antigravity are not pinned until their names are checked against the clients;
    // until then they show as "Another AI app" (`other`), which is safe (the id is a display hint).
    for (const id of Object.values(CLIENT_APP_IDS)) expect(AI_APP_IDS).toContain(id);
  });

  it('maps each known name, ASCII case-folded', () => {
    expect(mcpAppIdFor('claude-code')).toBe('claude-code');
    expect(mcpAppIdFor('Claude-Code')).toBe('claude-code');
    expect(mcpAppIdFor('CODEX-MCP-CLIENT')).toBe('codex');
    expect(mcpAppIdFor('claude-ai')).toBe('claude-desktop');
  });

  it.each([
    ['an unknown name', 'my-own-client'],
    ['a near miss', 'claude-code '],
    ['a non-ASCII fold', 'claude-cOdeİ'],
    ['an inherited key', '__proto__'],
    ['an inherited key', 'constructor'],
    ['an empty name', ''],
    ['over 64 characters', 'claude-code'.padEnd(65, 'x')],
    ['not a string', 42],
    ['undefined', undefined],
    ['an object', { toLowerCase: () => 'claude-code' }],
  ])('%s is `other`', (_label, name) => {
    expect(mcpAppIdFor(name)).toBe('other');
  });
});
