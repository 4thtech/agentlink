// W4-WIZARD (W4 UX v2 layer 1): whether setup is complete, decided from real state, never from a
// "seen" flag. Setup is incomplete while there is no owner, no agent, or no AI app connected to the
// open agent. The reads are plain GETs (the first-run status, the agents list, the AI apps list, the
// contacts list); nothing here writes. An unanswered read is "unknown", never "incomplete": the app
// never sends someone into Get started because a read failed.
//
// I-5: a contact name the other side chose is never shown; only an owner-confirmed alias is.
import { formatContactName } from '@4thtech-io/ui';
import { createApiClient, type ApiClient } from '../../api/client.js';
import { LIST_PATH, parseList, type ContactRow } from '../contacts/data.js';
import { AGENTS_READ, APPS_READ, parseAgentSignal } from '../home/start-here-api.js';
import { STATUS_PATH } from '../first-run/setup-api.js';

/** The approvals waiting (Home lists them); a waiting approval is never hidden behind Get started. */
export const APPROVALS_READ = '/api/approvals';

/** What the reads said. `undefined` means "no answer", never "no". */
export interface SetupState {
  readonly owner: 'missing' | 'set_up' | undefined;
  /** An agent is open in the app. */
  readonly agent: boolean | undefined;
  /** An AI app runs the open agent. */
  readonly appConnected: boolean | undefined;
  /** The contacts (any state), or undefined when the read gave no answer. */
  readonly contacts: readonly ContactRow[] | undefined;
  /** Approvals waiting on Home (`GET /api/approvals`); undefined when the read gave no answer. */
  readonly waiting?: number | undefined;
}

export const UNKNOWN_STATE: SetupState = {
  owner: undefined,
  agent: undefined,
  appConnected: undefined,
  contacts: undefined,
};

/**
 * True only when a read said so: no owner, no agent, or no AI app connected. Unknown is never
 * incomplete (a failed read never opens Get started).
 */
export function setupIncomplete(state: SetupState): boolean {
  return state.owner === 'missing' || state.agent === false || state.appConnected === false;
}

export type CardStepId = 'connect' | 'invite' | 'check';
export const CARD_STEPS: readonly CardStepId[] = ['connect', 'invite', 'check'];

export interface CardStep {
  readonly id: CardStepId;
  readonly done: boolean;
  /** The check step: the owner-confirmed name of the contact to check, or null. */
  readonly name?: string | null;
}

export interface Progress {
  readonly steps: readonly CardStep[];
  readonly done: number;
  readonly total: number;
  readonly complete: boolean;
  /** Some step is not done and its read gave no answer. */
  readonly unknown: boolean;
}

function ownerAlias(row: ContactRow): string | null {
  return row.nameSource === 'owner' && row.name.trim() !== ''
    ? formatContactName({ alias: row.name }).text
    : null;
}

/** The Home card's three steps (A4): connect your AI app, invite someone, check a safety code. */
export function startProgress(state: SetupState): Progress {
  const rows = state.contacts?.filter((r) => r.status === 'active');
  const connect = state.owner === 'set_up' && state.agent === true && state.appConnected === true;
  const invite = rows !== undefined && rows.length > 0;
  const check = rows?.some((r) => r.label === 'safety-code-checked') === true;
  const toCheck = rows?.find((r) => r.pairing === 'complete' && r.label !== 'safety-code-checked');
  const steps: CardStep[] = [
    { id: 'connect', done: connect },
    { id: 'invite', done: invite },
    { id: 'check', done: check, name: toCheck === undefined ? null : ownerAlias(toCheck) },
  ];
  const done = steps.filter((s) => s.done).length;
  const unknown =
    (!connect &&
      (state.owner === undefined ||
        state.agent === undefined ||
        state.appConnected === undefined)) ||
    (!invite && state.contacts === undefined);
  return { steps, done, total: steps.length, complete: done === steps.length, unknown };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether an agent is open, from `GET /api/ui/agents`; undefined when the answer does not say. */
export function parseAgentOpen(agents: unknown): boolean | undefined {
  if (!isRecord(agents)) return undefined;
  // A page bound to its agent (outside the app host): that agent is open.
  if (agents['switchable'] === false) return true;
  if (agents['switchable'] !== true || !Array.isArray(agents['agents'])) return undefined;
  const current = agents['current'];
  if (current === null || current === '') return false;
  return typeof current === 'string' ? true : undefined;
}

/** The reads behind the state; each is replaceable in tests. */
export interface SetupReads {
  readonly client?: ApiClient;
}

/** Reads the real state. Never throws; an unanswered read leaves its field undefined. */
export async function readSetupState(reads: SetupReads = {}): Promise<SetupState> {
  const client = reads.client ?? createApiClient();
  const safe = <T>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined);
  const [status, agents, apps, contacts, approvals] = await Promise.all([
    safe(client.get<unknown>(STATUS_PATH)),
    safe(client.get<unknown>(AGENTS_READ)),
    safe(client.get<unknown>(APPS_READ)),
    safe(client.get<unknown>(LIST_PATH)),
    safe(client.get<unknown>(APPROVALS_READ)),
  ]);
  let owner: SetupState['owner'];
  if (status?.kind === 'ok' && isRecord(status.data)) {
    const word = status.data['owner'];
    if (word === 'missing' || word === 'set_up') owner = word;
  }
  const agentsData = agents?.kind === 'ok' ? agents.data : undefined;
  let agent = parseAgentOpen(agentsData);
  // No owner yet: there is no agent either, whatever the agents list says.
  if (owner === 'missing') agent = false;
  let appConnected: boolean | undefined;
  if (agent === false) appConnected = false;
  else if (agentsData !== undefined) {
    // "No AI app" is only ever read from a real AI apps list of the app host. Without one (a page
    // bound to the agent an AI app already runs, or a list that failed) it is unknown, never "no".
    const appsOk = apps?.kind === 'ok';
    const bound = isRecord(agentsData) && agentsData['switchable'] === false;
    const signal = parseAgentSignal(agentsData, appsOk ? apps.data : undefined);
    if (signal !== undefined && (signal.connected || (appsOk && !bound))) {
      appConnected = signal.connected;
    }
  }
  let rows: readonly ContactRow[] | undefined;
  if (contacts?.kind === 'ok') {
    const parsed = parseList(contacts.data);
    if (parsed.kind === 'ok') rows = parsed.contacts;
  } else if (owner === 'missing' || agent === false) rows = [];
  let waiting: number | undefined;
  if (approvals?.kind === 'ok' && isRecord(approvals.data)) {
    const list = approvals.data['approvals'];
    if (Array.isArray(list)) waiting = list.length;
  }
  return { owner, agent, appConnected, contacts: rows, waiting };
}
