// W4-AGENTS: the heartbeat history of this session (W4 UX v2 "per-agent detail page ... heartbeat
// history sparkline"; not persisted, Not in 0.4.6). Only what this page saw: no history before the
// first read, never a made-up bar.
import { beforeEach, describe, expect, it } from 'vitest';
import { parseAgents, type AgentsList } from './data.js';
import {
  HISTORY_MAX,
  historyOf,
  recordLive,
  resetHistoryForTests,
  stateChangesOf,
} from './history.js';

const list = (state: string, appState: string): AgentsList =>
  parseAgents({
    switchable: true,
    generation: 1,
    current: 'default',
    label: 'Personal',
    agents: [
      {
        name: 'default',
        label: 'Personal',
        current: true,
        available: true,
        removing: false,
        contacts: 0,
        running: false,
        state,
        apps: [{ app: 'claude-code', state: appState }],
      },
    ],
  }) as AgentsList;

beforeEach(() => resetHistoryForTests());

describe('the session heartbeat history', () => {
  it('is empty until a read was seen', () => {
    expect(historyOf('default', 'claude-code')).toEqual([]);
    expect(stateChangesOf('default')).toEqual([]);
  });

  it('keeps one sample per read, per AI app, at most HISTORY_MAX', () => {
    for (let i = 0; i < HISTORY_MAX + 5; i += 1) {
      recordLive(list('ready', i % 2 === 0 ? 'ready' : 'working'), 1_000 + i * 5_000);
    }
    const samples = historyOf('default', 'claude-code');
    expect(samples).toHaveLength(HISTORY_MAX);
    expect(samples[0]?.at).toBe(1_000 + 5 * 5_000);
    const last = HISTORY_MAX + 4;
    expect(samples.at(-1)?.state).toBe(last % 2 === 0 ? 'ready' : 'working');
  });

  it('records a state change of the agent once, with its time', () => {
    recordLive(list('offline', 'not_running'), 1_000);
    recordLive(list('offline', 'not_running'), 6_000);
    recordLive(list('ready', 'ready'), 11_000);
    recordLive(list('paused', 'ready'), 16_000);
    expect(stateChangesOf('default').map((c) => [c.at, c.state])).toEqual([
      [1_000, 'offline'],
      [11_000, 'ready'],
      [16_000, 'paused'],
    ]);
  });
});
