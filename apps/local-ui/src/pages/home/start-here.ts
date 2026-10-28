// Start here, the pure part (UX2-g; B-11 §27.1 and §27.3; owner decision 7.1).
//
// Every step is derived from real local reads, never from a click, a timer or a copy. An unread
// signal is not "done" and is reported as unknown. Steps 1, 2, 4 and 5 are counted ("x of 4");
// step 3 (check the safety code) is shown and ticks, but never holds the card and never blocks
// step 4. "Done" means "has happened once": it is remembered in this browser (ids only) and does
// not untick, so removing the only contact does not bring the card back.
//
// I-5: a name the other side chose never goes into the prompt the owner copies to their AI; only the
// owner-confirmed alias does. Names are returned as plain text for React to render as text.
import { formatContactName } from '@4thtech-io/ui';
import type { ContactRow } from '../contacts/data.js';
import { startHello } from './strings.js';

export type StepId = 'protect' | 'invite' | 'check' | 'send' | 'kit';
export const STEP_IDS: readonly StepId[] = ['protect', 'invite', 'check', 'send', 'kit'];
/** The steps that count toward "x of 4" and decide when the card leaves. */
export const COUNTED: readonly StepId[] = ['protect', 'invite', 'send', 'kit'];

export const START_DONE_KEY = 'agentlink.startHere.done';

/** What the reads said. `undefined` means "no answer", never "no". */
export interface Signals {
  readonly protect?: boolean | undefined;
  readonly contacts?: readonly ContactRow[] | undefined;
  /** Whether any message was sent (the Messages list, Sent). */
  readonly sent?: boolean | undefined;
  readonly kitSaved?: boolean | undefined;
}

export type StepState = 'done' | 'next' | 'waiting' | 'later';

export interface StepView {
  readonly id: StepId;
  readonly state: StepState;
  /** Step 3 only: the owner-confirmed name of the contact we wait for. */
  readonly name?: string | undefined;
  /** Step 3 only: an answered contact exists, so "Compare safety code" is offered. */
  readonly compare?: boolean | undefined;
}

export interface StartView {
  readonly steps: readonly StepView[];
  readonly doneCount: number;
  readonly total: number;
  /** The first counted step not done; null when none, or while any read is unanswered. */
  readonly nextId: StepId | null;
  /** Steps 1, 2, 4 and 5 are all done. */
  readonly complete: boolean;
  /** A step is not done and its read gave no answer. */
  readonly unknown: boolean;
  /** Step 4's prompt: "Say hello to {alias} on AgentLink." or our own template. */
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
  const done: Record<StepId, boolean> = {
    protect: remembered.has('protect') || signals.protect === true,
    invite: remembered.has('invite') || has,
    check:
      remembered.has('check') || (rows?.some((r) => r.label === 'safety-code-checked') ?? false),
    send: remembered.has('send') || signals.sent === true,
    kit: remembered.has('kit') || signals.kitSaved === true,
  };
  const unknown =
    (!done.protect && signals.protect === undefined) ||
    (!done.invite && rows === undefined) ||
    (!done.send && signals.sent === undefined && has) ||
    (!done.kit && signals.kitSaved === undefined);

  const doneCount = COUNTED.filter((id) => done[id]).length;
  const firstUndone = COUNTED.find((id) => !done[id]);
  const nextId = unknown ? null : (firstUndone ?? null);

  const answered = rows?.find((r) => r.status === 'active' && r.pairing === 'complete');
  const waitingFor = rows?.find((r) => r.status === 'active' && r.pairing === 'pending');
  const steps: StepView[] = STEP_IDS.map((id): StepView => {
    if (done[id]) return { id, state: 'done' };
    if (id === 'check') {
      if (answered === undefined && waitingFor !== undefined) {
        return { id, state: 'waiting', name: ownerName(waitingFor) ?? undefined };
      }
      return { id, state: 'later', compare: answered !== undefined };
    }
    return { id, state: id === nextId ? 'next' : 'later' };
  });

  const hello = rows === undefined ? undefined : pick(rows);
  return {
    steps,
    doneCount,
    total: COUNTED.length,
    nextId,
    complete: doneCount === COUNTED.length,
    unknown,
    helloPrompt: startHello(hello === undefined ? null : ownerName(hello)),
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
        if (known !== undefined) out.add(known);
      }
    }
  } catch {
    // Not remembered; the reads decide.
  }
  return out;
}

export function saveDone(done: ReadonlySet<StepId>): void {
  try {
    storage()?.setItem(START_DONE_KEY, JSON.stringify([...done]));
  } catch {
    // Not remembered; nothing else changes.
  }
}

/** The reads behind the card; every one is replaceable in tests. `undefined` is "no answer". */
export interface StartHereReads {
  readonly protect?: () => Promise<boolean | undefined>;
  readonly contacts?: () => Promise<readonly ContactRow[] | undefined>;
  readonly sent?: (contacts: readonly ContactRow[]) => Promise<boolean | undefined>;
  readonly kitSaved?: () => boolean | undefined;
  /** Milliseconds between reads (default 14 000). */
  readonly intervalMs?: number;
  /** How long "You're all set." shows (default 1 600). */
  readonly allSetMs?: number;
}
