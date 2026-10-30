// W4-AGENTS (W4 UX v2 "Agents"; 08 §1 "Live AI-app status" words, D-143): the live fields of the
// Agents read, the plain status words, and the fleet table's search, filter and sort.
import { describe, expect, it } from 'vitest';
import {
  agentLine,
  appChoices,
  appWord,
  dotOf,
  fleetRows,
  parseAgents,
  relativeTime,
  type AgentRow,
  type AppLive,
} from './data.js';

const NOW = 1_800_000_000;

const wire = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'default',
  label: 'Personal',
  current: false,
  available: true,
  removing: false,
  contacts: 2,
  running: false,
  apps: [],
  ...over,
});
const parsed = (rows: Record<string, unknown>[]): AgentRow[] =>
  parseAgents({ switchable: true, generation: 1, current: null, label: null, agents: rows })
    ?.agents as AgentRow[];

describe('parseAgents: the live fields (K1)', () => {
  it('reads the agent state, last seen and every AI app with its own state', () => {
    const [row] = parsed([
      wire({
        state: 'working',
        apps: [
          { app: 'claude-code', state: 'working', since: NOW - 30 },
          { app: 'codex', state: 'not_running', lastSeenAt: NOW - 300 },
          { app: 'cursor', state: 'not_set_up' },
        ],
      }),
    ]);
    expect(row?.state).toBe('working');
    expect(row?.paused).toBe(false);
    // `apps` keeps the apps that run this agent (not "not set up"), as before.
    expect(row?.apps).toEqual(['claude-code', 'codex']);
    expect(row?.appStates?.map((a) => [a.id, a.state])).toEqual([
      ['claude-code', 'working'],
      ['codex', 'not_running'],
      ['cursor', 'not_set_up'],
    ]);
    expect(row?.appStates?.[1]?.lastSeenAt).toBe(NOW - 300);
  });

  it('reads a paused agent', () => {
    const [row] = parsed([wire({ state: 'paused', lastSeenAt: NOW - 60 })]);
    expect(row?.state).toBe('paused');
    expect(row?.paused).toBe(true);
    expect(row?.lastSeenAt).toBe(NOW - 60);
  });

  it('falls back to running (an older host) and refuses unknown words', () => {
    const [a, b, c] = parsed([
      wire({ running: true, apps: ['claude-code'] }),
      wire({ name: 'b', running: false }),
      wire({ name: 'c', state: 'dancing', lastSeenAt: -5 }),
    ]);
    expect(a?.state).toBe('ready');
    expect(a?.appStates?.map((x) => x.state)).toEqual(['ready']);
    expect(b?.state).toBe('offline');
    expect(c?.state).toBe('offline');
    expect(c?.lastSeenAt).toBeUndefined();
  });
});

describe('the words (08 §1)', () => {
  const row = (over: Partial<AgentRow>): AgentRow => ({
    ...(parsed([wire()])[0] as AgentRow),
    ...over,
  });
  const app = (name: string, state: AppLive['state'], lastSeenAt?: number) => ({
    id: name.toLowerCase().replace(/ /g, '-'),
    name,
    state,
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
  });

  it('relative times', () => {
    expect(relativeTime(NOW - 10, NOW)).toBe('just now');
    expect(relativeTime(NOW - 5 * 60, NOW)).toBe('5 min ago');
    expect(relativeTime(NOW - 3 * 3600, NOW)).toBe('3 h ago');
    expect(relativeTime(NOW - 30 * 3600, NOW)).toBe('1 day ago');
    expect(relativeTime(NOW - 4 * 86400, NOW)).toBe('4 days ago');
  });

  it('an agent: Working in, Ready in (and n more), Idle, Offline · last seen, Paused', () => {
    expect(
      agentLine(row({ state: 'working', appStates: [app('Claude Code', 'working')] }), NOW),
    ).toBe('Working in Claude Code');
    expect(
      agentLine(
        row({
          state: 'ready',
          appStates: [app('Cursor', 'ready'), app('Codex', 'ready'), app('Windsurf', 'idle')],
        }),
        NOW,
      ),
    ).toBe('Ready in Cursor and 2 more');
    expect(agentLine(row({ state: 'idle', appStates: [app('Codex', 'idle')] }), NOW)).toBe('Idle');
    expect(agentLine(row({ state: 'offline', lastSeenAt: NOW - 300 }), NOW)).toBe(
      'Offline · last seen 5 min ago',
    );
    expect(agentLine(row({ state: 'offline' }), NOW)).toBe('Offline');
    expect(agentLine(row({ state: 'paused', paused: true }), NOW)).toBe('Paused');
    expect(agentLine(row({ removing: true }), NOW)).toBe('Removal not finished');
  });

  it('an AI app: Working, Ready, Idle, Not running · last seen, Not set up', () => {
    expect(appWord(app('Claude Code', 'working'), NOW)).toBe('Working');
    expect(appWord(app('Claude Code', 'ready'), NOW)).toBe('Ready');
    expect(appWord(app('Claude Code', 'idle'), NOW)).toBe('Idle');
    expect(appWord(app('Codex', 'not_running', NOW - 3600), NOW)).toBe(
      'Not running · last seen 1 h ago',
    );
    expect(appWord(app('Codex', 'not_running'), NOW)).toBe('Not running');
    expect(appWord(app('Cursor', 'not_set_up'), NOW)).toBe('Not set up');
  });

  it('the dot of the letter icon follows the state; never Working without evidence', () => {
    expect(dotOf(row({ state: 'working' }))).toBe('working');
    expect(dotOf(row({ state: 'ready' }))).toBe('ready');
    expect(dotOf(row({ state: 'idle' }))).toBe('idle');
    expect(dotOf(row({ state: 'offline' }))).toBe('off');
    expect(dotOf(row({ state: 'paused', paused: true }))).toBe('paused');
  });
});

describe('the fleet table: search, filter, sort by activity', () => {
  const rows = parsed([
    wire({
      name: 'a',
      label: 'Tali agent',
      state: 'ready',
      apps: [{ app: 'cursor', state: 'ready' }],
    }),
    wire({
      name: 'b',
      label: 'Work agent',
      state: 'working',
      apps: [{ app: 'claude-code', state: 'working' }],
    }),
    wire({ name: 'c', label: 'Research', state: 'offline', lastSeenAt: NOW - 60 }),
    wire({ name: 'd', label: 'Invoices', state: 'paused', lastSeenAt: NOW - 86400 }),
    wire({
      name: 'e',
      label: 'Old',
      state: 'offline',
      lastSeenAt: NOW - 7200,
      apps: [{ app: 'codex', state: 'not_running', lastSeenAt: NOW - 7200 }],
    }),
  ]).map((r) => ({
    ...r,
    appStates: (r.appStates ?? []).map((a) => ({
      ...a,
      name: a.id === 'claude-code' ? 'Claude Code' : a.id,
    })),
  }));
  const names = (q: Parameters<typeof fleetRows>[1]) => fleetRows(rows, q).map((r) => r.name);
  const base = { q: '', status: 'all', app: 'all', sort: 'activity' } as const;

  it('sorts by activity: working, ready, then the most recently seen', () => {
    expect(names(base)).toEqual(['b', 'a', 'c', 'e', 'd']);
  });
  it('sorts by name and by status', () => {
    expect(names({ ...base, sort: 'name' })).toEqual(['d', 'e', 'c', 'a', 'b']);
    // Status, then by name within one status.
    expect(names({ ...base, sort: 'status' })).toEqual(['b', 'a', 'e', 'c', 'd']);
  });
  it('searches the label and the AI app names, case-insensitive', () => {
    expect(names({ ...base, q: 'AGENT' })).toEqual(['b', 'a']);
    expect(names({ ...base, q: 'claude' })).toEqual(['b']);
  });
  it('filters by status and by AI app', () => {
    expect(names({ ...base, status: 'paused' })).toEqual(['d']);
    expect(names({ ...base, status: 'offline' })).toEqual(['c', 'e']);
    expect(names({ ...base, app: 'codex' })).toEqual(['e']);
  });
  it('offers each AI app once, by name', () => {
    expect(appChoices(rows)).toEqual([
      { id: 'claude-code', name: 'Claude Code' },
      { id: 'codex', name: 'codex' },
      { id: 'cursor', name: 'cursor' },
    ]);
  });
});
