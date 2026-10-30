// W4-AGENTS (W4 UX v2 "per-agent detail page ... heartbeat history sparkline"): what this page saw
// of each agent's AI apps while it was open, from the shared live reads. Nothing is stored or sent:
// it lives in this tab's memory and is gone on reload (persisted history is not in 0.4.6). No read,
// no sample: the page never draws a bar it did not see.
import { appsOf, stateOf, type AgentState, type AgentsList, type AppState } from './data.js';

/** About five minutes of 5 s reads. */
export const HISTORY_MAX = 60;
const CHANGES_MAX = 20;

export interface AppSample {
  /** Milliseconds (the page clock). */
  readonly at: number;
  readonly state: AppState;
}
export interface StateChange {
  readonly at: number;
  readonly state: AgentState;
  /** The AI app the agent works or waits in, when it has one. */
  readonly app?: string;
}

const samples = new Map<string, AppSample[]>();
const changes = new Map<string, StateChange[]>();
let lastList: AgentsList | undefined;

const key = (agent: string, app: string): string => `${agent}\u0000${app}`;

/** Record one read (call once per answer; the same answer twice is one sample). */
export function recordLive(list: AgentsList, at: number = Date.now()): void {
  if (list === lastList) return;
  lastList = list;
  for (const row of list.agents) {
    for (const app of appsOf(row)) {
      if (app.state === 'not_set_up') continue;
      const k = key(row.name, app.id);
      const kept = samples.get(k) ?? [];
      kept.push({ at, state: app.state });
      if (kept.length > HISTORY_MAX) kept.splice(0, kept.length - HISTORY_MAX);
      samples.set(k, kept);
    }
    const state = stateOf(row);
    const seen = changes.get(row.name) ?? [];
    if (seen.at(-1)?.state !== state) {
      const live = appsOf(row).find((a) => a.state === state);
      seen.push({ at, state, ...(live === undefined ? {} : { app: live.name }) });
      if (seen.length > CHANGES_MAX) seen.splice(0, seen.length - CHANGES_MAX);
      changes.set(row.name, seen);
    }
  }
}

export function historyOf(agent: string, app: string): readonly AppSample[] {
  return samples.get(key(agent, app)) ?? [];
}

export function stateChangesOf(agent: string): readonly StateChange[] {
  return changes.get(agent) ?? [];
}

export function resetHistoryForTests(): void {
  samples.clear();
  changes.clear();
  lastList = undefined;
}
