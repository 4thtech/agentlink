// W4-SHELL-V2 / W4-SHELL-LIVE (U1-b; D-143; 08 §1 "Live AI-app status" and `GET /api/ui/events`):
// the one shared live subscription to the agents and their AI apps. Every view that shows live state
// (the top bar's agent chip and dropdown, the status strip) listens to this one store; nothing reads
// the agents on its own timer.
//
// - The first listener reads `GET /api/ui/agents` once (the list, its generation and every agent's
//   live state) and opens the events stream with `fetch` (never `EventSource`, which cannot send the
//   CSRF header): `Accept: text/event-stream`, the page's CSRF header and, when reconnecting, the last
//   `Last-Event-ID`. `snapshot` and `agents` events update the agents in place and announce
//   `agentlink:agents-changed`, so the pages that show agents re-read; a `generation` event (another
//   agent was opened) re-reads the list, so the page's generation guard sees the switch as before.
// - The stream reconnects with backoff (1 s doubling to 30 s, with jitter) and replays from
//   `Last-Event-ID`. After three failures within a minute, a refusal (404, 429 `busy`, 501) or
//   without a streamed body, it polls the agents every LIVE_POLL_MS while the tab is visible (at once
//   when it shows again) and tries the stream again every LIVE_STREAM_RETRY_MS.
// - The last listener closes it all.
// Labels and app names are text only (I-5); only the allowlisted fields of 08 §1 are read, and
// nothing from the stream is logged.
import { appNameOf, parseAppNames } from '../pages/agents/app-names.js';
import { createAgentsApi, type AgentsApi, type SwitchOutcome } from '../pages/agents/api.js';
import { parseAgents, type AgentRow, type AgentsList } from '../pages/agents/data.js';
import { AGENTS_STRINGS } from '../pages/agents/strings.js';
import { announceAgentsChanged, noteSwitched } from '../pages/agents/use-agents.js';
import { createApiClient } from './client.js';

/** 08 §1 (K1, ui-contract/live.ts). */
const EVENTS_PATH = '/api/ui/events';
const EVENTS_ACCEPT = 'text/event-stream';
const AGENTS_READ = '/api/ui/agents';
const APPS_READ = '/api/ui/apps';

export const LIVE_POLL_MS = 5_000;
/** The fallback tries the stream again this often (08 §1). */
export const LIVE_STREAM_RETRY_MS = 60_000;
const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Three failures within this window fall back to polling. */
const FAILURE_WINDOW_MS = 60_000;
const FAILURES_TO_FALL_BACK = 3;
/** Relative times ("5 min ago") are redrawn this often while one is shown. */
const AGO_TICK_MS = 30_000;
const CHANGED = 'agentlink:agents-changed';

/** A plain status (08 §1): Working (pulsing) / Ready / Idle / Not running / Not set up / Paused. */
export type LiveState = 'working' | 'ready' | 'idle' | 'off' | 'none' | 'paused' | 'removing';

export interface LiveApp {
  /** The AI app's name ("Claude Code", "Another AI app"). */
  readonly app: string;
  readonly state: LiveState;
  /** The words next to the app: "Working", "Ready", "Not running · last seen 5 min ago". */
  readonly word: string;
}

export interface LiveAgent {
  readonly name: string;
  readonly label: string;
  readonly current: boolean;
  readonly state: LiveState;
  /** One line: "Working in Claude Code", "Ready in Codex", "Offline · last seen 5 min ago". */
  readonly statusText: string;
  /** The AI apps set up for it or running it (not the ones only detected). */
  readonly apps: readonly LiveApp[];
  readonly removing: boolean;
}

export interface LiveSnapshot {
  /** Undefined until the first answer. */
  readonly list: AgentsList | undefined;
  readonly agents: readonly LiveAgent[];
  readonly error: boolean;
}

/** How the store follows the app: the stream, the polling fallback, or not at all (no listener). */
export type LiveMode = 'stream' | 'poll' | 'idle';

export const LIVE_WORDS = {
  working: 'Working',
  ready: 'Ready',
  idle: 'Idle',
  off: 'Not running',
  none: 'Not set up',
  paused: 'Paused',
  offline: 'Offline',
  removing: AGENTS_STRINGS.removalNotFinished,
  readyIn: (app: string): string => `Ready in ${app}`,
  readyInMore: (app: string, n: number): string => `Ready in ${app} and ${n} more`,
  workingIn: (app: string): string => `Working in ${app}`,
  lastSeen: (word: string, ago: string): string => `${word} · last seen ${ago}`,
} as const;

/** "just now", "5 min ago", "3 h ago", "1 day ago" (08 §1: the page computes relative times). */
export function agoText(at: number, now: number): string {
  const s = Math.max(0, now - at);
  if (s < 60) return 'just now';
  if (s < 3_600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3_600)} h ago`;
  const d = Math.floor(s / 86_400);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

// --- The allowlisted live record (08 §1), read defensively -------------------------------------

type AppWire = 'not_set_up' | 'not_running' | 'working' | 'ready' | 'idle';
type AgentWire = 'paused' | 'working' | 'ready' | 'idle' | 'offline';
interface AppRecord {
  readonly app: string;
  readonly state: AppWire;
  readonly lastSeenAt?: number;
}
interface AgentRecord {
  readonly name: string;
  readonly label: string;
  readonly current: boolean;
  readonly removing: boolean;
  readonly state: AgentWire;
  readonly lastSeenAt?: number;
  readonly apps: readonly AppRecord[];
}

const APP_STATES: ReadonlySet<string> = new Set([
  'not_set_up',
  'not_running',
  'working',
  'ready',
  'idle',
]);
const AGENT_STATES: ReadonlySet<string> = new Set([
  'paused',
  'working',
  'ready',
  'idle',
  'offline',
]);
const APP_ID = /^[a-z][a-z0-9-]{0,31}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const timeOf = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined;

function parseApp(v: unknown, running: boolean): AppRecord | undefined {
  // The earlier read form: a plain app id; Ready while the agent runs, else Not running.
  if (typeof v === 'string') {
    return APP_ID.test(v) ? { app: v, state: running ? 'ready' : 'not_running' } : undefined;
  }
  if (!isObject(v) || typeof v['app'] !== 'string' || !APP_ID.test(v['app'])) return undefined;
  const state = v['state'];
  if (typeof state !== 'string' || !APP_STATES.has(state)) return undefined;
  const lastSeenAt = timeOf(v['lastSeenAt']);
  return {
    app: v['app'],
    state: state as AppWire,
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
  };
}

function parseRecord(v: unknown): AgentRecord | undefined {
  if (!isObject(v) || typeof v['name'] !== 'string' || typeof v['label'] !== 'string') {
    return undefined;
  }
  const running = v['running'] === true;
  const apps = Array.isArray(v['apps'])
    ? v['apps'].map((a) => parseApp(a, running)).filter((a): a is AppRecord => a !== undefined)
    : [];
  const wire = v['state'];
  const live = apps.some((a) => a.state === 'working' || a.state === 'ready' || a.state === 'idle');
  const state: AgentWire =
    typeof wire === 'string' && AGENT_STATES.has(wire)
      ? (wire as AgentWire)
      : running && live
        ? 'ready'
        : 'offline';
  const lastSeenAt = timeOf(v['lastSeenAt']);
  return {
    name: v['name'],
    label: v['label'],
    current: v['current'] === true,
    removing: v['removing'] === true,
    state,
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    apps,
  };
}

function parseRecords(v: unknown): AgentRecord[] {
  return Array.isArray(v)
    ? v.map(parseRecord).filter((r): r is AgentRecord => r !== undefined)
    : [];
}

// --- Words --------------------------------------------------------------------------------------

const APP_STATE: Readonly<Record<AppWire, LiveState>> = {
  working: 'working',
  ready: 'ready',
  idle: 'idle',
  not_running: 'off',
  not_set_up: 'none',
};
const RANK: Readonly<Record<AppWire, number>> = {
  working: 0,
  ready: 1,
  idle: 2,
  not_running: 3,
  not_set_up: 4,
};

function appWord(app: AppRecord, now: number): string {
  if (app.state === 'not_running' && app.lastSeenAt !== undefined) {
    return LIVE_WORDS.lastSeen(LIVE_WORDS.off, agoText(app.lastSeenAt, now));
  }
  return LIVE_WORDS[APP_STATE[app.state]];
}

function toLive(r: AgentRecord, name: (id: string) => string, now: number): LiveAgent {
  // Only the AI apps set up for this agent or running it; the ones only detected are offered under
  // "Another AI app" with Connect.
  const shown = r.apps.filter((a) => a.state !== 'not_set_up');
  const apps: LiveApp[] = shown.map((a) => ({
    app: name(a.app),
    state: r.state === 'paused' ? 'paused' : APP_STATE[a.state],
    word: r.state === 'paused' ? LIVE_WORDS.paused : appWord(a, now),
  }));
  const live = [...shown]
    .filter((a) => a.state === 'working' || a.state === 'ready' || a.state === 'idle')
    .sort((a, b) => RANK[a.state] - RANK[b.state]);
  const first = live[0];
  let state: LiveState;
  let statusText: string;
  if (r.removing) {
    state = 'removing';
    statusText = LIVE_WORDS.removing;
  } else if (r.state === 'paused') {
    state = 'paused';
    statusText = LIVE_WORDS.paused;
  } else if (r.state === 'working' && first !== undefined) {
    state = 'working';
    statusText = LIVE_WORDS.workingIn(name(first.app));
  } else if (r.state === 'ready' && first !== undefined) {
    state = 'ready';
    statusText =
      live.length > 1
        ? LIVE_WORDS.readyInMore(name(first.app), live.length - 1)
        : LIVE_WORDS.readyIn(name(first.app));
  } else if (r.state === 'idle' && first !== undefined) {
    state = 'idle';
    statusText = LIVE_WORDS.idle;
  } else if (shown.length === 0) {
    state = 'none';
    statusText = LIVE_WORDS.none;
  } else {
    state = 'off';
    statusText =
      r.lastSeenAt === undefined
        ? LIVE_WORDS.offline
        : LIVE_WORDS.lastSeen(LIVE_WORDS.offline, agoText(r.lastSeenAt, now));
  }
  return {
    name: r.name,
    label: r.label,
    current: r.current,
    state,
    statusText,
    apps,
    removing: r.removing,
  };
}

/** A row of the earlier agents read (names, Running) as a live agent: never Working without a beat. */
export function liveAgent(row: AgentRow): LiveAgent {
  const apps: AppRecord[] = row.apps.map((app) => ({
    app,
    state: row.running ? 'ready' : 'not_running',
  }));
  const record: AgentRecord = {
    name: row.name,
    label: row.label,
    current: row.current,
    removing: row.removing,
    state: row.running && apps.length > 0 ? 'ready' : 'offline',
    apps,
  };
  return toLive(record, (app) => app, nowSeconds());
}

// --- The stream's text format (08 §1) -------------------------------------------------------------

export interface SseEvent {
  readonly id: string;
  readonly event: string;
  readonly data: unknown;
}

/** A `text/event-stream` parser: fields `id`, `event`, `data`; comments and `retry` are skipped. */
export function createSseParser(onEvent: (event: SseEvent) => void): {
  push(text: string): void;
} {
  let buffer = '';
  let id = '';
  let event = '';
  let data: string[] = [];
  const dispatch = (): void => {
    if (data.length > 0 && event !== '') {
      try {
        onEvent({ id, event, data: JSON.parse(data.join('\n')) as unknown });
      } catch {
        // Not JSON: skipped (never echoed).
      }
    }
    event = '';
    data = [];
  };
  return {
    push(text) {
      buffer += text;
      for (;;) {
        const nl = buffer.search(/\r\n|\r|\n/);
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer.startsWith('\r\n', nl) ? 2 : 1));
        if (line === '') {
          dispatch();
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'id') id = value;
        else if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
    },
  };
}

// --- The store ------------------------------------------------------------------------------------

let api: AgentsApi | undefined;
let random: () => number = Math.random;
let snapshot: LiveSnapshot = { list: undefined, agents: [], error: false };
const listeners = new Set<() => void>();
let records: AgentRecord[] = [];
let appNames: ReadonlyMap<string, string> | undefined;
let namesRead: Promise<void> | undefined;
let mode: LiveMode = 'idle';
let inFlight = false;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let agoTimer: ReturnType<typeof setInterval> | undefined;
let stream: AbortController | undefined;
let lastEventId: string | undefined;
let attempt = 0;
let failures: number[] = [];
let announcing = false;

const visible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState !== 'hidden';
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

function nameOf(id: string): string {
  return appNameOf(id, appNames);
}

function rebuild(): void {
  const now = nowSeconds();
  snapshot = {
    ...snapshot,
    agents: records.map((r) => toLive(r, nameOf, now)),
  };
  for (const l of listeners) l();
  const ago = records.some((r) => r.lastSeenAt !== undefined || r.apps.some((a) => a.lastSeenAt));
  if (ago && agoTimer === undefined && listeners.size > 0) {
    agoTimer = setInterval(rebuild, AGO_TICK_MS);
  } else if (!ago && agoTimer !== undefined) {
    clearInterval(agoTimer);
    agoTimer = undefined;
  }
}

/** The AI app names (GET /api/ui/apps) once, when an agent first has one; the fixed table else. */
function readNames(): void {
  if (namesRead !== undefined || !records.some((r) => r.apps.length > 0)) return;
  namesRead = (async () => {
    const answer = await createApiClient().get(APPS_READ);
    if (answer.kind !== 'ok') return;
    appNames = parseAppNames(answer.data);
    if (listeners.size > 0) rebuild();
  })();
}

/** Tells the pages that show agents to re-read (they listen for this one event). */
function announce(): void {
  announcing = true;
  try {
    announceAgentsChanged();
  } finally {
    announcing = false;
  }
}

/** Reads the agents now (shared: one read in flight at a time). */
export async function readNow(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const answer = await createApiClient().get(AGENTS_READ);
    const list = answer.kind === 'ok' ? parseAgents(answer.data) : undefined;
    if (list !== undefined && answer.kind === 'ok') {
      records = parseRecords((answer.data as { agents?: unknown }).agents);
      snapshot = { list, agents: snapshot.agents, error: false };
      rebuild();
      readNames();
      if (!list.switchable) stopStream();
    } else {
      snapshot = { ...snapshot, error: true };
      for (const l of listeners) l();
    }
  } finally {
    inFlight = false;
    schedulePoll();
  }
}

function schedulePoll(): void {
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  pollTimer = undefined;
  if (mode !== 'poll' || listeners.size === 0 || !visible()) return;
  pollTimer = setTimeout(() => void readNow(), LIVE_POLL_MS);
}

function upsert(next: readonly AgentRecord[], gone: readonly string[] = []): void {
  const byName = new Map(next.map((r) => [r.name, r]));
  const kept = records.filter((r) => !gone.includes(r.name)).map((r) => byName.get(r.name) ?? r);
  const known = new Set(kept.map((r) => r.name));
  records = [...kept, ...next.filter((r) => !known.has(r.name))];
}

function onStreamEvent(e: SseEvent): void {
  if (e.id !== '') lastEventId = e.id;
  if (!isObject(e.data)) return;
  const data = e.data;
  const generation = timeOf(data['generation']);
  if (e.event === 'snapshot') {
    records = parseRecords(data['agents']);
  } else if (e.event === 'agents') {
    const gone = Array.isArray(data['gone'])
      ? data['gone'].filter((n): n is string => typeof n === 'string')
      : [];
    upsert(parseRecords(data['agents']), gone);
  } else if (e.event !== 'generation') {
    return; // An event this page does not know.
  }
  attempt = 0;
  rebuild();
  readNames();
  // Another agent was opened: the list (and its generation, for the page's guard) is read again.
  const known = snapshot.list?.generation;
  if (generation !== undefined && known !== undefined && generation !== known) void readNow();
  announce();
}

function stopStream(): void {
  stream?.abort();
  stream = undefined;
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
}

function fallBack(): void {
  stopStream();
  mode = 'poll';
  void readNow();
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    if (listeners.size === 0) return;
    failures = [];
    attempt = 0;
    void openStream();
  }, LIVE_STREAM_RETRY_MS);
}

function failed(): void {
  const now = Date.now();
  failures = [...failures.filter((t) => now - t < FAILURE_WINDOW_MS), now];
  if (failures.length >= FAILURES_TO_FALL_BACK) {
    fallBack();
    return;
  }
  reconnect();
}

function reconnect(): void {
  if (listeners.size === 0) return;
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** attempt);
  attempt += 1;
  const delay = Math.round(base * (0.8 + 0.4 * random()));
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void openStream();
  }, delay);
}

async function openStream(): Promise<void> {
  if (listeners.size === 0 || snapshot.list?.switchable === false) return;
  stopStream();
  const controller = new AbortController();
  stream = controller;
  const headers = new Headers({ 'X-AgentLink-CSRF': pageToken(), Accept: EVENTS_ACCEPT });
  if (lastEventId !== undefined) headers.set('Last-Event-ID', lastEventId);
  let res: Response;
  try {
    res = await globalThis.fetch(EVENTS_PATH, {
      method: 'GET',
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch {
    if (stream === controller) failed();
    return;
  }
  if (stream !== controller) return;
  // No stream here (an older app, an approval page) or too many open: poll instead.
  if (res.status === 404 || res.status === 429 || res.status === 501) {
    fallBack();
    return;
  }
  const reader =
    res.ok && res.body !== null && typeof res.body.getReader === 'function'
      ? res.body.getReader()
      : undefined;
  if (!res.ok) {
    failed();
    return;
  }
  if (reader === undefined) {
    fallBack();
    return;
  }
  if (mode !== 'stream') {
    mode = 'stream';
    schedulePoll();
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  const decoder = new TextDecoder();
  const parser = createSseParser(onStreamEvent);
  let events = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (stream !== controller) return;
      if (done) break;
      const before = lastEventId;
      parser.push(decoder.decode(value, { stream: true }));
      if (lastEventId !== before) events = true;
    }
  } catch {
    if (stream !== controller) return;
  }
  if (stream !== controller) return;
  stream = undefined;
  // A stream ends after 30 min (08 §1): reconnect and replay. One that ended with nothing is a failure.
  if (events) {
    attempt = 0;
    reconnect();
  } else {
    failed();
  }
}

const onVisibility = (): void => {
  if (mode !== 'poll') return;
  if (visible()) void readNow();
  else schedulePoll();
};
const onChanged = (): void => {
  // Our own announcement: nothing to read. Another view's (an agent added, renamed or removed here)
  // is read at once, stream or not: the list and its generation follow without waiting for a tick.
  if (announcing) return;
  void readNow();
};

/** Listens to the live store; the first listener starts it, the last one stops it. */
export function subscribeLive(
  listener: () => void,
  seam?: { api?: AgentsApi; random?: () => number },
): () => void {
  if (seam?.api !== undefined) api = seam.api;
  if (seam?.random !== undefined) random = seam.random;
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener(CHANGED, onChanged);
    mode = 'stream';
    failures = [];
    attempt = 0;
    void readNow();
    void openStream();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopAll();
  };
}

function stopAll(): void {
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener(CHANGED, onChanged);
  stopStream();
  for (const t of [pollTimer, retryTimer]) if (t !== undefined) clearTimeout(t);
  if (agoTimer !== undefined) clearInterval(agoTimer);
  pollTimer = undefined;
  retryTimer = undefined;
  agoTimer = undefined;
  mode = 'idle';
}

export function getLive(): LiveSnapshot {
  return snapshot;
}

/** Whether the store follows the stream, polls, or is closed (for tests and the hood facts). */
export function liveMode(): LiveMode {
  return mode;
}

/** Opens another agent (no Touch ID: it only changes what you look at; no reload). */
export async function switchAgent(name: string): Promise<SwitchOutcome> {
  const list = snapshot.list;
  const generation = list?.generation;
  if (generation === undefined) return { kind: 'failed' };
  const label = list?.agents.find((a) => a.name === name)?.label;
  const client = api ?? (api = createAgentsApi());
  const outcome = await client.switchTo(name, generation);
  if (outcome.kind === 'done' && label !== undefined) {
    noteSwitched(AGENTS_STRINGS.nowShowing(label));
  }
  announceAgentsChanged();
  // The stream says so too (a `generation` event); the list is read at once either way.
  void readNow();
  return outcome;
}

/** Test seam: stop and forget everything. */
export function resetLiveForTests(): void {
  listeners.clear();
  if (typeof document !== 'undefined') stopAll();
  inFlight = false;
  api = undefined;
  random = Math.random;
  records = [];
  appNames = undefined;
  namesRead = undefined;
  lastEventId = undefined;
  attempt = 0;
  failures = [];
  snapshot = { list: undefined, agents: [], error: false };
}
