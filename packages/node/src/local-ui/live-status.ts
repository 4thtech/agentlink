// W4-LIVE-STATUS (D-143; 08 §1 "Live AI-app status"; proposed, owner confirms at merge): the live
// state of each agent and of each AI app that runs it, from the live MCP session rows (06 §6, read by
// agent-peek.ts) and the AI app config entries (which say only what is set up). The publisher lease
// never decides any of it.
//
// Per AI app, for each app of the 06 §7 table that is detected or has a live session for this agent:
// - `not_set_up`: no `agentlink` entry for this agent and no live session;
// - `not_running`: an entry but no live session (with `lastSeenAt` when a session was ever seen);
// - `working`: a live session with a tool call started or ended within the last 60 s;
// - `ready`: a live session, no tool call within 60 s, a tool call or start within the last 10 min;
// - `idle`: a live session with no tool call and no start for more than 10 min.
// Several sessions of one app count once, with the most active state; a session whose client is not
// in the table is the app `other` (listed last). `since` is when the current state began: derived
// from the row times, and kept by LiveStatusTracker while the state holds, so a tool call during
// `working` or a beat changes no field (the stream sends changes only).
//
// Per agent: `paused` when paused (W4-PAUSE sets it); else the most active app's state; else
// `offline`, with the newest `lastSeenAt` of its apps.
//
// `liveAgentRecord` is the one allowlist (08 §1 "Allowlist") that both `GET /api/ui/agents` and
// `GET /api/ui/events` use: per agent only name, label, current, removing, state, lastSeenAt and apps;
// per AI app only app, state, since and lastSeenAt. Never a path, pid, session or holder ID, client
// name, agent ID, key, contact, content, URL or error text (I-5, I-7).
import { AI_APP_IDS } from '@4thtech-io/types';

export type LiveAppState = 'not_set_up' | 'not_running' | 'working' | 'ready' | 'idle';
export type LiveAgentState = 'paused' | 'working' | 'ready' | 'idle' | 'offline';

/** One AI app of an agent, allowlisted. */
export interface LiveAppRecord {
  readonly app: string;
  readonly state: LiveAppState;
  /** Unix seconds: when the current state began; absent when unknown. */
  readonly since?: number;
  /** Unix seconds: when a session of this app last ran this agent; only while it is not live. */
  readonly lastSeenAt?: number;
}

/** One agent as the stream and the agents read carry it, allowlisted. */
export interface LiveAgentRecord {
  readonly name: string;
  readonly label: string;
  readonly current: boolean;
  readonly removing: boolean;
  readonly state: LiveAgentState;
  readonly lastSeenAt?: number;
  readonly apps: readonly LiveAppRecord[];
}

/** The live part of an agent (state, lastSeenAt, apps). */
export type LiveStatus = Pick<LiveAgentRecord, 'state' | 'lastSeenAt' | 'apps'>;

/** What the status is computed from (agent-peek.ts and the AI app entries). */
export interface LiveInput {
  readonly sessions: readonly {
    readonly app: string;
    readonly startedAt: number;
    readonly lastToolAt: number | null;
  }[];
  readonly lastSeen: readonly { readonly app: string; readonly at: number }[];
  /** App ids whose `agentlink` entry runs this agent. */
  readonly configured: readonly string[];
  /** App ids detected on this computer (any entry state). */
  readonly detected: readonly string[];
  /** W4-PAUSE: the agent's pause row exists. */
  readonly paused?: boolean;
}

/** 08 §1 "Allowlist". */
export const LIVE_AGENT_FIELDS = Object.freeze([
  'name',
  'label',
  'current',
  'removing',
  'state',
  'lastSeenAt',
  'apps',
] as const);
export const LIVE_APP_FIELDS = Object.freeze(['app', 'state', 'since', 'lastSeenAt'] as const);

const APP_STATES: readonly LiveAppState[] = [
  'not_set_up',
  'not_running',
  'working',
  'ready',
  'idle',
];
const AGENT_STATES: readonly LiveAgentState[] = ['paused', 'working', 'ready', 'idle', 'offline'];

/** A tool call within this many seconds is `working`. */
export const WORKING_SECONDS = 60;
/** A tool call or start within this many seconds is `ready`; older is `idle` (10 min). */
export const READY_SECONDS = 600;

const OTHER = 'other';
const ORDER: readonly string[] = [...AI_APP_IDS, OTHER];

const appId = (app: unknown): string =>
  typeof app === 'string' && (AI_APP_IDS as readonly string[]).includes(app) ? app : OTHER;

const isTime = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Higher is more active. */
const RANK: Readonly<Record<LiveAppState, number>> = {
  not_set_up: 0,
  not_running: 1,
  idle: 2,
  ready: 3,
  working: 4,
};

interface Derived {
  readonly state: LiveAppState;
  readonly since?: number;
}

/** One live session's state and the time it began, from its row times. */
function sessionState(
  session: LiveInput['sessions'][number],
  now: number,
): Derived & { readonly state: 'working' | 'ready' | 'idle' } {
  const tool = isTime(session.lastToolAt) ? session.lastToolAt : undefined;
  const start = isTime(session.startedAt) ? session.startedAt : now;
  if (tool !== undefined && now - tool < WORKING_SECONDS) return { state: 'working', since: tool };
  const last = Math.max(start, tool ?? 0);
  if (now - last <= READY_SECONDS) {
    return {
      state: 'ready',
      since: tool !== undefined && tool >= start ? tool + WORKING_SECONDS : start,
    };
  }
  return { state: 'idle', since: last + READY_SECONDS + 1 };
}

/** The status of one agent at `now`, with `since` as derived from the rows. */
export function liveStatus(input: LiveInput, now: number): LiveStatus {
  const live = new Map<string, Derived>();
  for (const session of input.sessions) {
    const app = appId(session.app);
    const derived = sessionState(session, now);
    const held = live.get(app);
    if (
      held === undefined ||
      RANK[derived.state] > RANK[held.state] ||
      (derived.state === held.state && (derived.since ?? 0) > (held.since ?? 0))
    ) {
      live.set(app, derived);
    }
  }
  const seen = new Map<string, number>();
  for (const entry of input.lastSeen) {
    if (!isTime(entry.at)) continue;
    const app = appId(entry.app);
    if ((seen.get(app) ?? -1) < entry.at) seen.set(app, entry.at);
  }
  const configured = new Set(input.configured.map(appId));
  const listed = new Set<string>([...input.detected.map(appId), ...configured, ...live.keys()]);
  const apps: LiveAppRecord[] = [];
  for (const app of ORDER) {
    if (!listed.has(app)) continue;
    const running = live.get(app);
    if (running !== undefined) {
      apps.push(freezeApp({ app, state: running.state, since: running.since }));
      continue;
    }
    const at = seen.get(app);
    if (configured.has(app)) {
      apps.push(freezeApp({ app, state: 'not_running', since: at, lastSeenAt: at }));
    } else {
      apps.push(freezeApp({ app, state: 'not_set_up' }));
    }
  }
  let best: LiveAppRecord | undefined;
  for (const app of apps) {
    if (
      RANK[app.state] >= RANK.idle &&
      (best === undefined || RANK[app.state] > RANK[best.state])
    ) {
      best = app;
    }
  }
  const newest = [...seen.values()].reduce<number | undefined>(
    (max, at) => (max === undefined || at > max ? at : max),
    undefined,
  );
  let state: LiveAgentState;
  if (input.paused === true) state = 'paused';
  else if (best !== undefined) state = best.state as LiveAgentState;
  else state = 'offline';
  const lastSeenAt = state === 'offline' || state === 'paused' ? newest : undefined;
  return Object.freeze({
    state,
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    apps: Object.freeze(apps),
  });
}

function freezeApp(record: {
  app: string;
  state: LiveAppState;
  since?: number | undefined;
  lastSeenAt?: number | undefined;
}): LiveAppRecord {
  return Object.freeze({
    app: record.app,
    state: record.state,
    ...(record.since === undefined ? {} : { since: record.since }),
    ...(record.lastSeenAt === undefined ? {} : { lastSeenAt: record.lastSeenAt }),
  });
}

/**
 * Keeps `since` while a state holds, per agent and app, so a tool call during `working` changes no
 * field. Bounded: only the agents and apps of the latest call per agent are kept, and `forget` drops
 * agents no longer listed.
 */
export class LiveStatusTracker {
  readonly #held = new Map<string, Map<string, LiveAppRecord>>();

  status(agent: string, input: LiveInput, now: number): LiveStatus {
    const fresh = liveStatus(input, now);
    const before = this.#held.get(agent);
    const apps = fresh.apps.map((app) => {
      const prev = before?.get(app.app);
      if (prev === undefined || prev.state !== app.state || prev.since === undefined) return app;
      return prev.since === app.since ? app : freezeApp({ ...app, since: prev.since });
    });
    this.#held.set(agent, new Map(apps.map((app) => [app.app, app])));
    return Object.freeze({ ...fresh, apps: Object.freeze(apps) });
  }

  /** Drops every agent not in `names`. */
  forget(names: readonly string[]): void {
    for (const name of [...this.#held.keys()]) if (!names.includes(name)) this.#held.delete(name);
  }
}

/** The one allowlist (08 §1): a new object of the allowed fields only, values checked. */
export function liveAgentRecord(view: LiveAgentRecord): LiveAgentRecord {
  const state = (AGENT_STATES as readonly unknown[]).includes(view.state) ? view.state : 'offline';
  const apps: LiveAppRecord[] = [];
  for (const app of Array.isArray(view.apps) ? view.apps : []) {
    if (!(APP_STATES as readonly unknown[]).includes(app.state)) continue;
    apps.push(
      freezeApp({
        app: appId(app.app),
        state: app.state,
        since: isTime(app.since) ? app.since : undefined,
        lastSeenAt: isTime(app.lastSeenAt) ? app.lastSeenAt : undefined,
      }),
    );
  }
  return Object.freeze({
    name: String(view.name),
    label: String(view.label),
    current: view.current === true,
    removing: view.removing === true,
    state,
    ...(isTime(view.lastSeenAt) ? { lastSeenAt: view.lastSeenAt } : {}),
    apps: Object.freeze(apps),
  });
}
