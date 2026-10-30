// U3-h: the Agents read (GET /api/ui/agents, U3-c) parsed defensively, and the small rules the
// switcher and the page share (b11 §29). A label is plain text from an unsigned file: it is only ever
// rendered as text, and it is never used to authorise anything (the agent name and the generation
// travel with each request).
import type { AgentDotState } from '@4thtech-io/ui';
import { appNameOf } from './app-names.js';
import { AGENTS_STRINGS as S } from './strings.js';

/** The page's path. The server serves pages under /settings (approval-server.ts APP_PAGE). */
export const AGENTS_PATH = '/settings/agents';

/** The AI apps page (card U3-i builds it); Connect links here. */
export const AGENTS_APPS_PATH = '/settings/apps';

/** W4-LIVE-STATUS (08 §1): an agent's live state; `paused` comes with W4-PAUSE. */
export type AgentState = 'paused' | 'working' | 'ready' | 'idle' | 'offline';
/** W4-LIVE-STATUS (08 §1): one AI app's state for one agent. */
export type AppState = 'not_set_up' | 'not_running' | 'working' | 'ready' | 'idle';

/** One AI app of an agent, as the Agents page shows it. */
export interface AppLive {
  /** The app's id (06 §7), or `other`. Never shown. */
  readonly id: string;
  /** Its name ("Claude Code", "Another AI app"). */
  readonly name: string;
  readonly state: AppState;
  /** Unix seconds: when the current state began. */
  readonly since?: number;
  /** Unix seconds: when a session of this app last ran the agent (while not live). */
  readonly lastSeenAt?: number;
}

export interface AgentRow {
  readonly name: string;
  readonly label: string;
  readonly current: boolean;
  readonly available: boolean;
  readonly removing: boolean;
  readonly contacts: number | null;
  readonly running: boolean;
  /** The AI apps that run this agent (not "Not set up"): ids from the read, names once mapped. */
  readonly apps: readonly string[];
  /** W4-AGENTS: the live state (always set by `parseAgents`; older hosts: from `running`). */
  readonly state?: AgentState;
  readonly paused?: boolean;
  /** Unix seconds: the newest last seen of its apps, while offline or paused. */
  readonly lastSeenAt?: number;
  /** Every AI app the read names for this agent, with its own state (incl. "Not set up"). */
  readonly appStates?: readonly AppLive[];
}

export interface AgentsList {
  /** False outside the app host: the page is bound to its agent. */
  readonly switchable: boolean;
  readonly generation?: number;
  readonly current: string | null;
  readonly label: string | null;
  readonly agents: readonly AgentRow[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * W4-LIVE-STATUS (D-143, 08 §1): an AI app that runs this agent. The read now carries
 * `{app, state, ...}` per detected app; one runs this agent unless it is `not_set_up`. A plain id
 * (the earlier form) still reads as one. The live words come with U1-b.
 */
function appIdOf(a: unknown): string[] {
  if (typeof a === 'string') return [a];
  if (isObject(a) && typeof a['app'] === 'string' && a['state'] !== 'not_set_up') return [a['app']];
  return [];
}

const AGENT_STATES: ReadonlySet<string> = new Set([
  'paused',
  'working',
  'ready',
  'idle',
  'offline',
]);
const APP_STATES: ReadonlySet<string> = new Set([
  'not_set_up',
  'not_running',
  'working',
  'ready',
  'idle',
]);
const APP_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** A unix time in seconds, or undefined. */
function seconds(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined;
}

/** W4-LIVE-STATUS: one `{app, state, since?, lastSeenAt?}`; a plain id (older hosts) as `fallback`. */
function appLiveOf(a: unknown, fallback: AppState): AppLive[] {
  if (typeof a === 'string') {
    return APP_ID.test(a) ? [{ id: a, name: appNameOf(a), state: fallback }] : [];
  }
  if (!isObject(a) || typeof a['app'] !== 'string' || !APP_ID.test(a['app'])) return [];
  const state = typeof a['state'] === 'string' && APP_STATES.has(a['state']) ? a['state'] : null;
  if (state === null) return [];
  const since = seconds(a['since']);
  const lastSeenAt = seconds(a['lastSeenAt']);
  return [
    {
      id: a['app'],
      name: appNameOf(a['app']),
      state: state as AppState,
      ...(since === undefined ? {} : { since }),
      ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    },
  ];
}

function parseRow(v: unknown): AgentRow | undefined {
  if (!isObject(v) || typeof v['name'] !== 'string' || typeof v['label'] !== 'string') {
    return undefined;
  }
  const apps = Array.isArray(v['apps']) ? v['apps'].flatMap(appIdOf) : [];
  const contacts = v['contacts'];
  const running = v['running'] === true;
  const wire = v['state'];
  // An older host sends no state: a running agent reads Ready, else Offline (never Working).
  const state: AgentState =
    typeof wire === 'string' && AGENT_STATES.has(wire)
      ? (wire as AgentState)
      : wire === undefined && running
        ? 'ready'
        : 'offline';
  const appStates = Array.isArray(v['apps'])
    ? v['apps'].flatMap((a) => appLiveOf(a, running ? 'ready' : 'not_running'))
    : [];
  const lastSeenAt = seconds(v['lastSeenAt']);
  return {
    name: v['name'],
    label: v['label'],
    current: v['current'] === true,
    available: v['available'] !== false,
    removing: v['removing'] === true,
    contacts:
      typeof contacts === 'number' && Number.isSafeInteger(contacts) && contacts >= 0
        ? contacts
        : null,
    running,
    apps,
    state,
    paused: state === 'paused',
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    appStates,
  };
}

export function parseAgents(value: unknown): AgentsList | undefined {
  if (!isObject(value)) return undefined;
  if (value['switchable'] === false) {
    return { switchable: false, current: null, label: null, agents: [] };
  }
  const generation = value['generation'];
  if (
    value['switchable'] !== true ||
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !Array.isArray(value['agents'])
  ) {
    return undefined;
  }
  return {
    switchable: true,
    generation,
    current: typeof value['current'] === 'string' ? value['current'] : null,
    label: typeof value['label'] === 'string' ? value['label'] : null,
    agents: value['agents'].map(parseRow).filter((r): r is AgentRow => r !== undefined),
  };
}

/** The open agent first, then by label; "Removal not finished" agents last. */
export function orderAgents(rows: readonly AgentRow[]): AgentRow[] {
  const rank = (r: AgentRow): number => (r.removing ? 2 : r.current ? 0 : 1);
  return [...rows].sort(
    (a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label) || a.name.localeCompare(b.name),
  );
}

/** The trigger's label: 20 characters at most. */
export function shortLabel(label: string, max = 20): string {
  const chars = [...label];
  return chars.length <= max ? label : `${chars.slice(0, max - 1).join('')}…`;
}

/** "Claude Code", "Claude Code +1", or the none case. */
export function appsText(row: AgentRow): string {
  const [first, ...rest] = row.apps;
  if (first === undefined) return S.notConnected;
  return rest.length === 0 ? first : `${first} +${rest.length}`;
}

/** Agents that serve no AI app and have no contacts; removal not finished does not count (§29.7). */
export function tidyCandidates(rows: readonly AgentRow[]): AgentRow[] {
  return rows.filter((r) => !r.removing && r.available && r.apps.length === 0 && r.contacts === 0);
}

export function stateWord(row: AgentRow): string {
  return row.running ? S.running : S.notRunning;
}

// ------------------------------------------------------------------ W4-AGENTS: live words (08 §1)

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago" (11 §5: relative, plain). */
export function relativeTime(at: number, now: number): string {
  const s = Math.max(0, now - at);
  if (s < 60) return S.justNow;
  if (s < 3600) return S.minAgo(Math.floor(s / 60));
  if (s < 86_400) return S.hAgo(Math.floor(s / 3600));
  const days = Math.floor(s / 86_400);
  return days === 1 ? S.yesterday : S.daysAgo(days);
}

/** The live state of a row (an older row without one: from `running`). */
export function stateOf(row: AgentRow): AgentState {
  return row.state ?? (row.running ? 'ready' : 'offline');
}

/** The AI apps of a row with their states (an older row: its names, Ready or Not running). */
export function appsOf(row: AgentRow): readonly AppLive[] {
  if (row.appStates !== undefined) return row.appStates;
  return row.apps.map((name) => ({
    id: name,
    name,
    state: row.running ? 'ready' : 'not_running',
  }));
}

const LIVE_RANK: Readonly<Record<AppState, number>> = {
  working: 0,
  ready: 1,
  idle: 2,
  not_running: 3,
  not_set_up: 4,
};

/** The apps that run the agent now, most active first. */
function liveApps(row: AgentRow): AppLive[] {
  return appsOf(row)
    .filter((a) => a.state === 'working' || a.state === 'ready' || a.state === 'idle')
    .sort((a, b) => LIVE_RANK[a.state] - LIVE_RANK[b.state]);
}

/**
 * The agent's one line (08 §1): "Working in {app}", "Ready in {app}" ("and {n} more"), "Idle",
 * "Offline · last seen {time}" ("Offline" when never seen), "Paused"; "Removal not finished".
 */
export function agentLine(row: AgentRow, now: number): string {
  if (row.removing) return S.removalNotFinished;
  const state = stateOf(row);
  if (state === 'paused') return S.paused;
  const live = liveApps(row);
  const [first] = live;
  if (state === 'working' && first !== undefined) return S.workingIn(first.name);
  if (state === 'ready' && first !== undefined) {
    return live.length > 1 ? S.readyInMore(first.name, live.length - 1) : S.readyIn(first.name);
  }
  if (state === 'idle') return S.idle;
  if (state === 'ready' || state === 'working') return S.ready;
  return row.lastSeenAt === undefined
    ? S.offline
    : S.offlineSeen(relativeTime(row.lastSeenAt, now));
}

/** One AI app's word: "Working", "Ready", "Idle", "Not running · last seen {time}", "Not set up". */
export function appWord(app: AppLive, now: number): string {
  switch (app.state) {
    case 'working':
      return S.working;
    case 'ready':
      return S.ready;
    case 'idle':
      return S.idle;
    case 'not_set_up':
      return S.notSetUp;
    case 'not_running':
      return app.lastSeenAt === undefined
        ? S.notRunning
        : S.notRunningSeen(relativeTime(app.lastSeenAt, now));
  }
}

/** The dot of an app row (the same shapes as the letter icon's dot). */
export function appDot(app: AppLive): AgentDotState {
  switch (app.state) {
    case 'working':
      return 'working';
    case 'ready':
      return 'ready';
    case 'idle':
      return 'idle';
    case 'not_running':
      return 'off';
    case 'not_set_up':
      return 'none';
  }
}

/** The letter icon's corner dot: decoration only, the words say the state. */
export function dotOf(row: AgentRow): AgentDotState {
  const state = stateOf(row);
  return state === 'offline' ? 'off' : state;
}

// ---------------------------------------------------------- W4-AGENTS: the fleet table (A11)

export type FleetStatus = 'all' | AgentState;
export type FleetSort = 'activity' | 'name' | 'status';
export interface FleetQuery {
  readonly q: string;
  readonly status: FleetStatus;
  /** An app id, or `all`. */
  readonly app: string;
  readonly sort: FleetSort;
}

const STATUS_RANK: Readonly<Record<AgentState, number>> = {
  working: 0,
  ready: 1,
  idle: 2,
  offline: 3,
  paused: 4,
};

const byLabel = (a: AgentRow, b: AgentRow): number =>
  a.label.localeCompare(b.label) || a.name.localeCompare(b.name);

/** The newest moment the agent was seen: now while live, else its last seen (0 when never). */
function seenAt(row: AgentRow): number {
  const s = stateOf(row);
  if (s === 'working' || s === 'ready' || s === 'idle') return Number.MAX_SAFE_INTEGER;
  return row.lastSeenAt ?? 0;
}

const runsApp = (row: AgentRow, test: (a: AppLive) => boolean): boolean =>
  appsOf(row).some((a) => a.state !== 'not_set_up' && test(a));

/** Search (label and AI app names), filter (status, AI app) and sort; "Removal not finished" last. */
export function fleetRows(rows: readonly AgentRow[], query: FleetQuery): AgentRow[] {
  const q = query.q.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (q === '' ||
        r.label.toLowerCase().includes(q) ||
        runsApp(r, (a) => a.name.toLowerCase().includes(q))) &&
      (query.status === 'all' || stateOf(r) === query.status) &&
      (query.app === 'all' || runsApp(r, (a) => a.id === query.app)),
  );
  const tail = (r: AgentRow): number => (r.removing ? 1 : 0);
  return shown.sort((a, b) => {
    const t = tail(a) - tail(b);
    if (t !== 0) return t;
    if (query.sort === 'name') return byLabel(a, b);
    const rank = STATUS_RANK[stateOf(a)] - STATUS_RANK[stateOf(b)];
    if (query.sort === 'status') return rank || byLabel(a, b);
    return rank || seenAt(b) - seenAt(a) || byLabel(a, b);
  });
}

/** Every AI app that runs one of the agents, once, by name. */
export function appChoices(rows: readonly AgentRow[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const r of rows) {
    for (const a of appsOf(r)) {
      if (a.state !== 'not_set_up' && !seen.has(a.id)) seen.set(a.id, a.name);
    }
  }
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id));
}
