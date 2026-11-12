// WP-13 (F-4 / F45; 08 §1 "Live AI-app status"): after an update, an AI app that still runs the older
// AgentLink (its live session is `outdated`) reads "Restart {app} to use the new version", in both
// layers: the agent's one line (the Simple card and the Under the hood table share `agentLine`), the
// AI app's own word, and the top bar's live line and dropdown (`liveAgentFromWire`).
import { describe, expect, it } from 'vitest';
import {
  agentLine,
  appWord,
  parseAgents,
  type AgentRow,
} from '../pages/agents/data.js';
import { LIVE_WORDS, liveAgentFromWire } from './live.js';

const NOW = 1_800_000_000;

const wire = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'default',
  label: 'Personal',
  current: true,
  available: true,
  removing: false,
  contacts: 2,
  running: true,
  state: 'ready',
  apps: [{ app: 'claude-code', state: 'ready', since: NOW - 30, outdated: true }],
  ...over,
});
const parsed = (row: Record<string, unknown>): AgentRow =>
  parseAgents({ switchable: true, generation: 1, current: 'default', label: null, agents: [row] })
    ?.agents[0] as AgentRow;

describe('the restart hint (WP-13)', () => {
  it('the words', () => {
    expect(LIVE_WORDS.restartToUpdate('Claude Code')).toBe(
      'Restart Claude Code to use the new version',
    );
    expect(LIVE_WORDS.restartApp).toBe('Restart to use the new version');
  });

  it('the Agents page reads `outdated` and says it on the agent line and the app', () => {
    const row = parsed(wire());
    expect(row.appStates?.[0]?.outdated).toBe(true);
    expect(agentLine(row, NOW)).toBe('Restart Claude Code to use the new version');
    expect(appWord(row.appStates?.[0] as never, NOW)).toBe('Restart to use the new version');
  });

  it('wins over Working and Connected, names the outdated app among several', () => {
    const row = parsed(
      wire({
        state: 'working',
        apps: [
          { app: 'claude-code', state: 'working', since: NOW - 5 },
          { app: 'codex', state: 'ready', since: NOW - 30, outdated: true },
        ],
      }),
    );
    expect(agentLine(row, NOW)).toBe('Restart Codex to use the new version');
  });

  it('never while paused or removing, nor for an app that is not running, nor without the flag', () => {
    expect(agentLine(parsed(wire({ state: 'paused' })), NOW)).toBe('Paused');
    expect(agentLine(parsed(wire({ removing: true })), NOW)).toBe('Removal not finished');
    const off = parsed(
      wire({
        state: 'offline',
        running: false,
        lastSeenAt: NOW - 60,
        apps: [{ app: 'claude-code', state: 'not_running', lastSeenAt: NOW - 60, outdated: true }],
      }),
    );
    expect(agentLine(off, NOW)).not.toContain('Restart');
    expect(off.appStates?.[0]?.outdated).toBeUndefined();
    const plain = parsed(wire({ apps: [{ app: 'claude-code', state: 'ready', since: NOW - 30 }] }));
    expect(agentLine(plain, NOW)).toBe('Connected to Claude Code');
    const odd = parsed(
      wire({ apps: [{ app: 'claude-code', state: 'ready', since: NOW - 30, outdated: 'yes' }] }),
    );
    expect(odd.appStates?.[0]?.outdated).toBeUndefined();
  });

  it('the top bar: the live line and the app word', () => {
    const a = liveAgentFromWire(wire(), NOW, () => 'Claude Code');
    expect(a?.statusText).toBe('Restart Claude Code to use the new version');
    expect(a?.state).toBe('ready');
    expect(a?.apps).toEqual([
      { app: 'Claude Code', state: 'ready', word: 'Restart to use the new version' },
    ]);
    const paused = liveAgentFromWire(wire({ state: 'paused' }), NOW, () => 'Claude Code');
    expect(paused?.statusText).toBe('Paused');
    expect(paused?.apps[0]?.word).toBe('Paused');
    const plain = liveAgentFromWire(
      wire({ apps: [{ app: 'claude-code', state: 'ready', since: NOW - 30 }] }),
      NOW,
      () => 'Claude Code',
    );
    expect(plain?.statusText).toBe('Connected to Claude Code');
  });
});
