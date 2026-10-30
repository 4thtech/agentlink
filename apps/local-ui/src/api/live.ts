// W4-SHELL-V2 (W4 UX v2 "Live status"): the one shared live subscription to the agents and their AI
// apps. Every view that shows live state (the top bar's agent chip and dropdown, the status strip)
// listens to this one store; nothing reads the agents on its own timer.
//
// Today it polls `GET /api/ui/agents` every LIVE_POLL_MS while the tab is visible (and at once when
// it shows again or when anything announces a change); it stops when nobody listens. U1-b swaps the
// timer for K1's `GET /api/ui/events` (SSE) behind the same `subscribeLive`, so no view changes.
// Labels and app names are text only (I-5); the answer is parsed by pages/agents/data.ts.
import { createAgentsApi, type AgentsApi, type SwitchOutcome } from '../pages/agents/api.js';
import type { AgentRow, AgentsList } from '../pages/agents/data.js';
import { AGENTS_STRINGS } from '../pages/agents/strings.js';
import { announceAgentsChanged, noteSwitched } from '../pages/agents/use-agents.js';

export const LIVE_POLL_MS = 5_000;
const CHANGED = 'agentlink:agents-changed';

/** A plain status (W4 UX v2): Working (pulsing) / Ready / Idle / Not running / Not set up / Paused. */
export type LiveState = 'working' | 'ready' | 'idle' | 'off' | 'none' | 'paused' | 'removing';

export interface LiveApp {
  readonly app: string;
  readonly state: LiveState;
  /** The words next to the app: "Ready", "Not running". */
  readonly word: string;
}

export interface LiveAgent {
  readonly name: string;
  readonly label: string;
  readonly current: boolean;
  readonly state: LiveState;
  /** One line: "Ready in Claude Code", "Not running", "Not set up". */
  readonly statusText: string;
  readonly apps: readonly LiveApp[];
  readonly removing: boolean;
}

export interface LiveSnapshot {
  /** Undefined until the first answer. */
  readonly list: AgentsList | undefined;
  readonly agents: readonly LiveAgent[];
  readonly error: boolean;
}

export const LIVE_WORDS = {
  working: 'Working',
  ready: 'Ready',
  idle: 'Idle',
  off: 'Not running',
  none: 'Not set up',
  paused: 'Paused',
  removing: AGENTS_STRINGS.removalNotFinished,
  readyIn: (app: string): string => `Ready in ${app}`,
  workingIn: (app: string): string => `Working in ${app}`,
} as const;

/**
 * Today's server knows per agent whether it runs (the lease holder) and which AI apps are set up for
 * it; K1 adds per-app heartbeats (Working, Idle, last seen). Until then an app of a running agent is
 * Ready and of a stopped one Not running: never Working without evidence.
 */
export function liveAgent(row: AgentRow): LiveAgent {
  const state: LiveState = row.removing ? 'removing' : row.running ? 'ready' : 'off';
  const apps: LiveApp[] = row.apps.map((app) => ({
    app,
    state: row.running ? 'ready' : 'off',
    word: row.running ? LIVE_WORDS.ready : LIVE_WORDS.off,
  }));
  const first = row.apps[0];
  const statusText = row.removing
    ? LIVE_WORDS.removing
    : row.apps.length === 0
      ? LIVE_WORDS.none
      : row.running && first !== undefined
        ? LIVE_WORDS.readyIn(first)
        : LIVE_WORDS.off;
  return {
    name: row.name,
    label: row.label,
    current: row.current,
    state: row.apps.length === 0 && !row.removing ? 'none' : state,
    statusText,
    apps,
    removing: row.removing,
  };
}

let api: AgentsApi | undefined;
let snapshot: LiveSnapshot = { list: undefined, agents: [], error: false };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;

const visible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState !== 'hidden';

function publish(next: LiveSnapshot): void {
  snapshot = next;
  for (const l of listeners) l();
}

function schedule(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  if (listeners.size === 0 || !visible()) return;
  timer = setTimeout(() => void readNow(), LIVE_POLL_MS);
}

/** Reads the agents now (shared: one read in flight at a time). */
export async function readNow(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const client = api ?? (api = createAgentsApi());
    const result = await client.list();
    if (result.kind === 'ok') {
      publish({ list: result.list, agents: result.list.agents.map(liveAgent), error: false });
    } else {
      publish({ ...snapshot, error: true });
    }
  } finally {
    inFlight = false;
    schedule();
  }
}

const onVisibility = (): void => {
  if (visible()) void readNow();
  else schedule();
};
const onChanged = (): void => void readNow();

/** Listens to the live store; the first listener starts it, the last one stops it. */
export function subscribeLive(listener: () => void, seam?: { api?: AgentsApi }): () => void {
  if (seam?.api !== undefined) api = seam.api;
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener(CHANGED, onChanged);
    void readNow();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener(CHANGED, onChanged);
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }
  };
}

export function getLive(): LiveSnapshot {
  return snapshot;
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
  return outcome;
}

/** Test seam: stop and forget everything. */
export function resetLiveForTests(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  listeners.clear();
  inFlight = false;
  api = undefined;
  snapshot = { list: undefined, agents: [], error: false };
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener(CHANGED, onChanged);
  }
}
