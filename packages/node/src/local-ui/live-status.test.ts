// W4-LIVE-STATUS (D-143; 08 §1 "Live AI-app status"): the per AI app and per agent states, built from
// the live session rows (06 §6) and the AI app config entries, and the one allowlist function that
// both `GET /api/ui/agents` and `GET /api/ui/events` use (I-5, I-7).
import { describe, expect, it } from 'vitest';
import {
  LiveStatusTracker,
  liveAgentRecord,
  liveStatus,
  LIVE_AGENT_FIELDS,
  LIVE_APP_FIELDS,
  type LiveInput,
} from './live-status.js';

const NOW = 1_800_000_000;

const input = (over: Partial<LiveInput> = {}): LiveInput => ({
  sessions: [],
  lastSeen: [],
  configured: [],
  detected: [],
  ...over,
});

describe('per AI app state (08 §1)', () => {
  it('not_set_up: detected, no entry for this agent and no live session', () => {
    const s = liveStatus(input({ detected: ['cursor'] }), NOW);
    expect(s.apps).toEqual([{ app: 'cursor', state: 'not_set_up' }]);
    expect(s.state).toBe('offline');
    expect(s.lastSeenAt).toBeUndefined();
  });

  it('not_running: an entry but no live session; lastSeenAt only when ever seen', () => {
    const s = liveStatus(
      input({
        configured: ['claude-code', 'codex'],
        detected: ['claude-code', 'codex'],
        lastSeen: [{ app: 'codex', at: NOW - 300 }],
      }),
      NOW,
    );
    expect(s.apps).toEqual([
      { app: 'claude-code', state: 'not_running' },
      { app: 'codex', state: 'not_running', since: NOW - 300, lastSeenAt: NOW - 300 },
    ]);
    expect(s.state).toBe('offline');
    expect(s.lastSeenAt).toBe(NOW - 300);
  });

  it('working: a tool call started or ended within the last 60 s', () => {
    const s = liveStatus(
      input({
        configured: ['claude-code'],
        sessions: [{ app: 'claude-code', startedAt: NOW - 900, lastToolAt: NOW - 59 }],
      }),
      NOW,
    );
    expect(s.apps[0]).toMatchObject({ app: 'claude-code', state: 'working' });
    expect(s.state).toBe('working');
  });

  it('ready: live, no tool call within 60 s, a call or start within 10 min', () => {
    const tool = liveStatus(
      input({ sessions: [{ app: 'codex', startedAt: NOW - 900, lastToolAt: NOW - 61 }] }),
      NOW,
    );
    expect(tool.apps[0]?.state).toBe('ready');
    const started = liveStatus(
      input({ sessions: [{ app: 'codex', startedAt: NOW - 600, lastToolAt: null }] }),
      NOW,
    );
    expect(started.apps[0]?.state).toBe('ready');
    expect(started.state).toBe('ready');
  });

  it('idle: live with no call and no start for more than 10 min', () => {
    const s = liveStatus(
      input({ sessions: [{ app: 'codex', startedAt: NOW - 3600, lastToolAt: NOW - 601 }] }),
      NOW,
    );
    expect(s.apps[0]?.state).toBe('idle');
    expect(s.state).toBe('idle');
    expect(s.apps[0]?.lastSeenAt).toBeUndefined();
  });

  it('several sessions of one app count once, with the most active state', () => {
    const s = liveStatus(
      input({
        configured: ['claude-code'],
        sessions: [
          { app: 'claude-code', startedAt: NOW - 3600, lastToolAt: null },
          { app: 'claude-code', startedAt: NOW - 3600, lastToolAt: NOW - 5 },
          { app: 'claude-code', startedAt: NOW - 100, lastToolAt: null },
        ],
      }),
      NOW,
    );
    expect(s.apps).toHaveLength(1);
    expect(s.apps[0]?.state).toBe('working');
  });

  it('a live session of an app outside the table is the app `other`, listed last', () => {
    const s = liveStatus(
      input({
        detected: ['windsurf'],
        sessions: [
          { app: 'other', startedAt: NOW - 10, lastToolAt: null },
          { app: 'claude-code', startedAt: NOW - 10, lastToolAt: null },
        ],
      }),
      NOW,
    );
    expect(s.apps.map((a) => a.app)).toEqual(['claude-code', 'windsurf', 'other']);
  });

  it('an unknown app id in an input is read as `other`, never echoed', () => {
    const s = liveStatus(
      input({
        sessions: [{ app: 'CANARY </x>', startedAt: NOW - 10, lastToolAt: null }],
        configured: ['CANARY-c'],
        detected: ['CANARY-d'],
        lastSeen: [{ app: 'CANARY-s', at: NOW - 1 }],
      }),
      NOW,
    );
    expect(JSON.stringify(s)).not.toContain('CANARY');
    expect(s.apps.map((a) => a.app)).toEqual(['other']);
  });
});

describe('per agent state (08 §1)', () => {
  it('the most active app decides; offline carries the newest lastSeenAt', () => {
    const live = liveStatus(
      input({
        sessions: [
          { app: 'codex', startedAt: NOW - 3600, lastToolAt: null },
          { app: 'cursor', startedAt: NOW - 30, lastToolAt: null },
        ],
      }),
      NOW,
    );
    expect(live.state).toBe('ready');
    expect(live.lastSeenAt).toBeUndefined();
    const off = liveStatus(
      input({
        lastSeen: [
          { app: 'codex', at: NOW - 900 },
          { app: 'cursor', at: NOW - 60 },
        ],
      }),
      NOW,
    );
    expect(off).toMatchObject({ state: 'offline', lastSeenAt: NOW - 60 });
  });

  it('paused wins over every live state', () => {
    const s = liveStatus(
      input({
        paused: true,
        sessions: [{ app: 'codex', startedAt: NOW - 10, lastToolAt: NOW - 1 }],
      }),
      NOW,
    );
    expect(s.state).toBe('paused');
  });
});

describe('since stays put while the state holds; a beat changes nothing', () => {
  it('a working app keeps its since across tool stamps and moves on a state change', () => {
    const tracker = new LiveStatusTracker();
    const at = (t: number, lastToolAt: number | null) =>
      tracker.status(
        'default',
        input({ sessions: [{ app: 'codex', startedAt: NOW - 100, lastToolAt }] }),
        t,
      );
    const first = at(NOW, NOW - 2);
    expect(first.apps[0]).toEqual({ app: 'codex', state: 'working', since: NOW - 2 });
    expect(at(NOW + 10, NOW + 9)).toEqual(first);
    expect(at(NOW + 30, NOW + 29)).toEqual(first);
    const ready = at(NOW + 90, NOW + 29);
    expect(ready.apps[0]).toEqual({ app: 'codex', state: 'ready', since: NOW + 89 });
  });

  it('the same rows at a later time (only beat_until moved) give the same status', () => {
    const tracker = new LiveStatusTracker();
    const rows = input({ sessions: [{ app: 'codex', startedAt: NOW - 100, lastToolAt: null }] });
    expect(tracker.status('default', rows, NOW + 15)).toEqual(tracker.status('default', rows, NOW));
  });
});

describe('liveAgentRecord: the one allowlist (08 §1 "Allowlist")', () => {
  it('keeps only name, label, current, removing, state, lastSeenAt and per app its four fields', () => {
    const record = liveAgentRecord({
      name: 'default',
      label: 'Personal',
      current: true,
      removing: false,
      state: 'ready',
      lastSeenAt: NOW,
      apps: [
        {
          app: 'codex',
          state: 'ready',
          since: NOW - 1,
          lastSeenAt: NOW,
          pid: 4242,
          sessionId: 'S',
          clientInfo: { name: 'CANARY' },
        } as never,
      ],
      agentId: '0xabc',
      path: '/Users/x/.agentlink/agents/default',
      pid: 4242,
      holder: 'H',
      contacts: 3,
    } as never);
    expect(record).toEqual({
      name: 'default',
      label: 'Personal',
      current: true,
      removing: false,
      state: 'ready',
      lastSeenAt: NOW,
      apps: [{ app: 'codex', state: 'ready', since: NOW - 1, lastSeenAt: NOW }],
    });
    expect(Object.keys(record).every((k) => LIVE_AGENT_FIELDS.includes(k as never))).toBe(true);
    expect(LIVE_AGENT_FIELDS).toEqual([
      'name',
      'label',
      'current',
      'removing',
      'state',
      'lastSeenAt',
      'apps',
    ]);
    expect(LIVE_APP_FIELDS).toEqual(['app', 'state', 'since', 'lastSeenAt']);
  });

  it('drops a state or app id outside the fixed words, and odd times', () => {
    const record = liveAgentRecord({
      name: 'work',
      label: 'Work',
      current: false,
      removing: false,
      state: 'CANARY' as never,
      lastSeenAt: -1,
      apps: [
        { app: 'CANARY', state: 'ready' },
        { app: 'codex', state: 'CANARY' as never },
        { app: 'cursor', state: 'idle', since: 1.5 },
      ],
    });
    expect(record).toEqual({
      name: 'work',
      label: 'Work',
      current: false,
      removing: false,
      state: 'offline',
      apps: [
        { app: 'other', state: 'ready' },
        { app: 'cursor', state: 'idle' },
      ],
    });
  });
});
