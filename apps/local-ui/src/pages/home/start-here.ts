// Start here, the pure part (UX2-g, U3-j; B-11 §27.1 and §27.3 v2; owner decision 7.1).
//
// Every step is derived from real local reads, never from a click, a timer or a copy. An unread
// signal is not "done" and is reported as unknown. Seven steps are counted ("x of 7"): Protect, Name,
// Connect your AI app, Invite, Say hello, See the reply, Recovery kit. The safety code check is
// shown and ticks, but is not counted: it never holds the card and never blocks the steps after it.
// "Done" means "has happened once": it is remembered in this browser (ids only) and does not untick,
// so removing the only contact does not bring the card back. Two steps are never remembered: the
// recovery kit and Connect, which follows the open agent (a second agent with no AI app shows it
// open again).
//
// I-5: a name the other side chose never goes into the prompt the owner copies to their AI; only the
// owner-confirmed alias does. Names are returned as plain text for React to render as text.
import { formatContactName } from '@4thtech-io/ui';
import type { ContactRow } from '../contacts/data.js';
import { startHello } from './strings.js';

export type StepId = 'protect' | 'name' | 'connect' | 'invite' | 'check' | 'send' | 'reply' | 'kit';
export const STEP_IDS: readonly StepId[] = [
  'protect',
  'name',
  'connect',
  'invite',
  'check',
  'send',
  'reply',
  'kit',
];
/** The steps that count toward "x of 7" and decide when the card leaves. */
export const COUNTED: readonly StepId[] = [
  'protect',
  'name',
  'connect',
  'invite',
  'send',
  'reply',
  'kit',
];
/** Never remembered: derived again on every read. */
const NOT_REMEMBERED: readonly StepId[] = ['connect', 'kit'];

export const START_DONE_KEY = 'agentlink.startHere.done';

/** What the open agent says about itself (GET /api/ui/agents and /api/ui/apps). */
export interface AgentSignal {
  /** The agent has a label of its own (not just its folder name). */
  readonly named: boolean;
  /** An AI app's `agentlink` entry runs this agent. */
  readonly connected: boolean;
  /** The first such app's fixed name (plain text); null when none. */
  readonly appName: string | null;
  /** An AI app has run AgentLink for this agent (the lease row). */
  readonly running: boolean;
}

/** What the reads said. `undefined` means "no answer", never "no". */
export interface Signals {
  readonly protect?: boolean | undefined;
  readonly agent?: AgentSignal | undefined;
  readonly contacts?: readonly ContactRow[] | undefined;
  /** Whether any message was sent (the Messages list, Sent). */
  readonly sent?: boolean | undefined;
  /** Whether a message from a contact is stored (the Messages list, Inbox). */
  readonly replied?: boolean | undefined;
  readonly kitSaved?: boolean | undefined;
}

export type StepState = 'done' | 'next' | 'waiting' | 'later';

export interface StepView {
  readonly id: StepId;
  readonly state: StepState;
  /** The safety code and reply rows: the owner-confirmed name of the contact we wait for. */
  readonly name?: string | undefined;
  /** The safety code row only: an answered contact exists, so "Compare safety code" is offered. */
  readonly compare?: boolean | undefined;
  /** Connect only: the open agent's AI app (plain text), or null. */
  readonly appName?: string | null | undefined;
  /** Connect only: the app has run AgentLink (Running), else it needs a restart. */
  readonly running?: boolean | undefined;
  /** Connect only: the AI apps read gave no answer and no tick is known. */
  readonly problem?: boolean | undefined;
}

export interface StartView {
  readonly steps: readonly StepView[];
  readonly doneCount: number;
  readonly total: number;
  /** The first counted step not done; null when none, or while any read is unanswered. */
  readonly nextId: StepId | null;
  /** All seven counted steps are done. */
  readonly complete: boolean;
  /** A step is not done and its read gave no answer. */
  readonly unknown: boolean;
  /** The say hello step's prompt: "Say hello to {alias} on AgentLink." or our own template. */
  readonly helloPrompt: string;
}

/** The owner-confirmed alias as shown, or null when the name came from the other side. */
function ownerName(row: ContactRow): string | null {
  return row.nameSource === 'owner' && row.name.trim() !== ''
    ? formatContactName({ alias: row.name }).text
    : null;
}

/** Answered and owner-named first: the person who can actually receive the hello. */
function rank(row: ContactRow): number {
  return (row.pairing === 'complete' ? 0 : 2) + (ownerName(row) === null ? 1 : 0);
}

function pick(rows: readonly ContactRow[]): ContactRow | undefined {
  return rows
    .filter((r) => r.status === 'active')
    .sort((a, b) => rank(a) - rank(b) || a.since - b.since)[0];
}

export function deriveStart(signals: Signals, remembered: ReadonlySet<StepId>): StartView {
  const rows = signals.contacts;
  const has = rows !== undefined && rows.length > 0;
  const agent = signals.agent;
  const done: Record<StepId, boolean> = {
    protect: remembered.has('protect') || signals.protect === true,
    name: remembered.has('name') || agent?.named === true,
    // Follows the open agent: derived on every read, never remembered.
    connect: agent?.connected === true,
    invite: remembered.has('invite') || has,
    check:
      remembered.has('check') || (rows?.some((r) => r.label === 'safety-code-checked') ?? false),
    send: remembered.has('send') || signals.sent === true,
    reply: remembered.has('reply') || signals.replied === true,
    // Never remembered: "kit not put off" is not a saved read, so it is derived on every load.
    kit: signals.kitSaved === true,
  };
  const unknown =
    (!done.protect && signals.protect === undefined) ||
    (!done.name && agent === undefined) ||
    (!done.connect && agent === undefined) ||
    (!done.invite && rows === undefined) ||
    (!done.send && signals.sent === undefined && has) ||
    (!done.reply && signals.replied === undefined && has) ||
    (!done.kit && signals.kitSaved === undefined);

  const doneCount = COUNTED.filter((id) => done[id]).length;
  const firstUndone = COUNTED.find((id) => !done[id]);
  const nextId = unknown ? null : (firstUndone ?? null);

  const answered = rows?.find((r) => r.status === 'active' && r.pairing === 'complete');
  const waitingFor = rows?.find((r) => r.status === 'active' && r.pairing === 'pending');
  const hello = rows === undefined ? undefined : pick(rows);
  const helloName = hello === undefined ? null : ownerName(hello);
  const steps: StepView[] = STEP_IDS.map((id): StepView => {
    if (id === 'connect') {
      if (done.connect) {
        return {
          id,
          state: 'done',
          appName: agent?.appName ?? null,
          running: agent?.running === true,
        };
      }
      return {
        id,
        state: id === nextId ? 'next' : 'later',
        appName: agent?.appName ?? null,
        problem: agent === undefined,
      };
    }
    if (done[id]) {
      return { id, state: 'done' };
    }
    if (id === 'check') {
      if (answered === undefined && waitingFor !== undefined) {
        return { id, state: 'waiting', name: ownerName(waitingFor) ?? undefined };
      }
      return { id, state: 'later', compare: answered !== undefined };
    }
    if (id === 'reply') {
      return { id, state: id === nextId ? 'next' : 'later', name: helloName ?? undefined };
    }
    return { id, state: id === nextId ? 'next' : 'later' };
  });

  return {
    steps,
    doneCount,
    total: COUNTED.length,
    nextId,
    complete: doneCount === COUNTED.length,
    unknown,
    helloPrompt: startHello(helloName),
  };
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The steps that have happened once in this browser. Ids only; anything else is ignored. */
export function loadDone(): ReadonlySet<StepId> {
  const out = new Set<StepId>();
  try {
    const raw = storage()?.getItem(START_DONE_KEY);
    if (raw === null || raw === undefined) return out;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const id of parsed as unknown[]) {
        const known = STEP_IDS.find((s) => s === id);
        if (known !== undefined && !NOT_REMEMBERED.includes(known)) out.add(known);
      }
    }
  } catch {
    // Not remembered; the reads decide.
  }
  return out;
}

export function saveDone(done: ReadonlySet<StepId>): void {
  try {
    storage()?.setItem(
      START_DONE_KEY,
      JSON.stringify([...done].filter((id) => !NOT_REMEMBERED.includes(id))),
    );
  } catch {
    // Not remembered; nothing else changes.
  }
}

/** The reads behind the card; every one is replaceable in tests. `undefined` is "no answer". */
export interface StartHereReads {
  readonly protect?: () => Promise<boolean | undefined>;
  /** The open agent: its label, its AI app and whether the app runs it. */
  readonly agent?: () => Promise<AgentSignal | undefined>;
  readonly contacts?: () => Promise<readonly ContactRow[] | undefined>;
  readonly sent?: (contacts: readonly ContactRow[]) => Promise<boolean | undefined>;
  /** A message from a contact is stored. */
  readonly replied?: (contacts: readonly ContactRow[]) => Promise<boolean | undefined>;
  readonly kitSaved?: () => boolean | undefined;
  /** Milliseconds between reads (default 14 000). */
  readonly intervalMs?: number;
  /** How long "You're all set." shows (default 1 600). */
  readonly allSetMs?: number;
}
