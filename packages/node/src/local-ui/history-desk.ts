// RET-4 (S2; D-148; 04 §4.2 "Presence and undo"; 08 §1 "The delete sheet"; I-4, I-7): the server
// side of Delete history in the app.
//
// - `begin(body)` (the history route kind: session, CSRF, Origin; no presence): checks the page's
//   selection (a person, an age, both, or chosen message IDs; and what to remove), asks core for the
//   plan, and keeps it in a ticket bound to this page session and the open ID. The page gets counts,
//   sizes and a random nonce: never the item list or the plan hash.
// - `finish(nonce)` runs only inside the finish route, after the central gate verified presence. It
//   takes no selector (the page cannot name any other list), checks the ticket is this session's and
//   still planned, re-plans the same input and refuses when the item set changed (`changed`), then
//   schedules core's apply of exactly the bound plan for when the Undo window ends.
// - `undo(nonce)` inside the window cancels the timer: nothing is applied. After it, `too_late`.
// - `status(nonce)`: the ticket's state and, once applied, core's counts (no name, path or ID).
// - The apply runs again under core's own check (apply re-plans and compares the hash in one
//   transaction), and only for the ID the ticket was made on; a switch in between applies nothing.
//   Closing the server drops every waiting delete (nothing applied: the safe direction).
//
// No MCP tool reaches this (I-4): only the local app's page session does, through the server's
// gates. Nothing here logs; answers are fixed words and numbers.
import type {
  HistoryDeleteInclude,
  HistoryDeleteInput,
  HistoryDeletePlan,
  HistoryDeleteResult,
} from '@4thtech-io/core';
import {
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  randomBytes,
  sha256,
  type JsonObject,
} from '@4thtech-io/crypto';

/** The Undo window (04 §4.2 OD-5): the apply waits this long after the gesture. */
export const HISTORY_UNDO_MS = 10_000;
/** A planned ticket nobody finished is forgotten after this; a finished one is kept as long. */
export const HISTORY_TICKET_TTL_MS = 10 * 60_000;
/** At most this many tickets are kept (the oldest finished or planned ones go first). */
export const MAX_HISTORY_TICKETS = 32;
/** A selection names at most this many messages. */
export const MAX_SELECTED_MESSAGES = 500;
/** "Older than" in whole days, 1 to 10 years. */
const MAX_DAYS = 3650;
const DAY_S = 86_400;

const CONTACT = /^0x[0-9a-f]{40}$/;
const ENVELOPE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const INCLUDES: readonly HistoryDeleteInclude[] = ['messages', 'files', 'both'];
const BODY_KEYS: ReadonlySet<string> = new Set([
  'contact',
  'olderThanDays',
  'envelopeIds',
  'include',
]);

/** The open ID's history, as core gives it (client.history). */
export interface HistoryPort {
  readonly agentId: string;
  plan(input: HistoryDeleteInput): Promise<HistoryDeletePlan>;
  apply(plan: HistoryDeletePlan): Promise<HistoryDeleteResult>;
}

export interface HistoryDeskDeps {
  /** The open ID's history now; undefined while none is open. */
  current(): HistoryPort | undefined;
  /** Milliseconds. */
  now(): number;
  undoMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(id: unknown): void;
}

/**
 * The page's selection as one core selector, or undefined when it is not exactly one of: a person,
 * an age, a person and an age, or chosen message IDs; plus what to remove. `nowMs` fixes the age.
 */
export function parseHistorySelection(
  body: unknown,
  nowMs: number,
): HistoryDeleteInput | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const o = body as Record<string, unknown>;
  if (Object.keys(o).some((k) => !BODY_KEYS.has(k))) return undefined;
  const include = o['include'];
  if (typeof include !== 'string' || !INCLUDES.includes(include as HistoryDeleteInclude)) {
    return undefined;
  }
  const inc = include as HistoryDeleteInclude;
  const ids = o['envelopeIds'];
  const contact = o['contact'];
  const days = o['olderThanDays'];
  if (ids !== undefined) {
    if (contact !== undefined || days !== undefined) return undefined;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > MAX_SELECTED_MESSAGES ||
      !ids.every((id) => typeof id === 'string' && ENVELOPE_ID.test(id))
    ) {
      return undefined;
    }
    return { envelopeIds: [...new Set(ids as string[])], include: inc };
  }
  if (contact !== undefined && (typeof contact !== 'string' || !CONTACT.test(contact))) {
    return undefined;
  }
  let before: number | undefined;
  if (days !== undefined) {
    if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) {
      return undefined;
    }
    before = Math.floor(nowMs / 1000) - days * DAY_S;
  }
  if (contact !== undefined) {
    return before === undefined
      ? { contactId: contact as string, include: inc }
      : { contactId: contact as string, before, include: inc };
  }
  return before === undefined ? undefined : { before, include: inc };
}

export type HistoryBeginAnswer =
  | {
      readonly status: 'planned';
      readonly nonce: string;
      readonly messages: { readonly count: number; readonly bytes: number };
      readonly files: { readonly count: number; readonly bytes: number };
      readonly notarized: number;
      readonly kept: number;
      readonly truncated: boolean;
      readonly undoSeconds: number;
    }
  | { readonly status: 'invalid' | 'unavailable' | 'busy' };

export type HistoryFinishOutcome = 'scheduled' | 'not_found' | 'changed' | 'agent_changed';
export type HistoryUndoOutcome = 'cancelled' | 'too_late' | 'not_found';

type TicketState =
  | 'planned'
  | 'scheduled'
  | 'applying'
  | 'done'
  | 'cancelled'
  | 'changed'
  | 'agent_changed'
  | 'failed';

export type HistoryStatusAnswer =
  | { readonly status: 'done'; readonly result: HistoryDeleteResult }
  | { readonly status: Exclude<TicketState, 'done'> | 'not_found' };

interface Ticket {
  readonly session: string;
  readonly agentId: string;
  readonly plan: HistoryDeletePlan;
  readonly createdAt: number;
  state: TicketState;
  timer?: unknown;
  result?: HistoryDeleteResult;
}

/** One page session's view of the desk (the server binds it to the request's session cookie). */
export interface LocalUiHistorySession {
  begin(body: unknown): Promise<HistoryBeginAnswer>;
  finish(nonce: unknown): Promise<HistoryFinishOutcome>;
  undo(nonce: unknown): Promise<HistoryUndoOutcome>;
  status(nonce: unknown): Promise<HistoryStatusAnswer>;
}

const sessionKey = (cookie: string): string => encodeHex(sha256(encodeUtf8(`ret4:${cookie}`)));

const freezeResult = (r: HistoryDeleteResult): HistoryDeleteResult =>
  Object.freeze({
    messages: Object.freeze({
      deleted: r.messages.deleted,
      notarized: r.messages.notarized,
      kept: r.messages.kept,
    }),
    files: Object.freeze({
      trashed: r.files.trashed,
      changed: r.files.changed,
      missing: r.files.missing,
      refused: r.files.refused,
      noTrash: r.files.noTrash,
      failed: r.files.failed,
    }),
  });

export class HistoryDesk {
  readonly #deps: HistoryDeskDeps;
  readonly #tickets = new Map<string, Ticket>();
  readonly #undoMs: number;
  #closed = false;

  constructor(deps: HistoryDeskDeps) {
    this.#deps = deps;
    this.#undoMs = deps.undoMs ?? HISTORY_UNDO_MS;
  }

  /** The desk for one page session (`cookie` is the session cookie value; only its hash is kept). */
  forSession(cookie: string): LocalUiHistorySession {
    const session = sessionKey(cookie);
    return Object.freeze<LocalUiHistorySession>({
      begin: (body) => this.#begin(session, body),
      finish: (nonce) => this.#finish(session, nonce),
      undo: (nonce) => Promise.resolve(this.#undo(session, nonce)),
      status: (nonce) => Promise.resolve(this.#status(session, nonce)),
    });
  }

  /** Drops every ticket; a waiting delete is never applied. */
  close(): void {
    this.#closed = true;
    for (const t of this.#tickets.values()) {
      if (t.timer !== undefined) this.#clear(t.timer);
      if (t.state === 'scheduled') t.state = 'cancelled';
    }
    this.#tickets.clear();
  }

  #clear(id: unknown): void {
    if (this.#deps.clearTimer !== undefined) this.#deps.clearTimer(id);
    else clearTimeout(id as ReturnType<typeof setTimeout>);
  }

  #set(fn: () => void): unknown {
    if (this.#deps.setTimer !== undefined) return this.#deps.setTimer(fn, this.#undoMs);
    const id = setTimeout(fn, this.#undoMs);
    (id as { unref?: () => void }).unref?.();
    return id;
  }

  #prune(): void {
    const now = this.#deps.now();
    for (const [nonce, t] of this.#tickets) {
      const live = t.state === 'scheduled' || t.state === 'applying';
      if (!live && now - t.createdAt > HISTORY_TICKET_TTL_MS) this.#tickets.delete(nonce);
    }
    if (this.#tickets.size < MAX_HISTORY_TICKETS) return;
    for (const [nonce, t] of this.#tickets) {
      if (this.#tickets.size < MAX_HISTORY_TICKETS) break;
      if (t.state !== 'scheduled' && t.state !== 'applying') this.#tickets.delete(nonce);
    }
  }

  #mine(session: string, nonce: unknown): Ticket | undefined {
    if (typeof nonce !== 'string' || !NONCE.test(nonce)) return undefined;
    const t = this.#tickets.get(nonce);
    return t === undefined || t.session !== session ? undefined : t;
  }

  async #begin(session: string, body: unknown): Promise<HistoryBeginAnswer> {
    if (this.#closed) return { status: 'unavailable' };
    const input = parseHistorySelection(body, this.#deps.now());
    if (input === undefined) return { status: 'invalid' };
    const port = this.#deps.current();
    if (port === undefined) return { status: 'unavailable' };
    const plan = await port.plan(input);
    this.#prune();
    if (this.#tickets.size >= MAX_HISTORY_TICKETS) return { status: 'busy' };
    const nonce = encodeBase64url(randomBytes(32));
    this.#tickets.set(nonce, {
      session,
      agentId: port.agentId,
      plan,
      createdAt: this.#deps.now(),
      state: 'planned',
    });
    return {
      status: 'planned',
      nonce,
      messages: { count: plan.messages.count, bytes: plan.messages.bytes },
      files: { count: plan.files.count, bytes: plan.files.bytes },
      notarized: plan.notarized,
      kept: plan.kept.count,
      truncated: plan.truncated,
      undoSeconds: Math.round(this.#undoMs / 1000) || 10,
    };
  }

  async #finish(session: string, nonce: unknown): Promise<HistoryFinishOutcome> {
    const t = this.#mine(session, nonce);
    if (t === undefined || t.state !== 'planned' || this.#closed) return 'not_found';
    if (this.#deps.now() - t.createdAt > HISTORY_TICKET_TTL_MS) return 'not_found';
    const port = this.#deps.current();
    if (port === undefined || port.agentId !== t.agentId) {
      t.state = 'agent_changed';
      return 'agent_changed';
    }
    // A stale plan (the list changed since it was shown) is refused before anything is scheduled.
    const fresh = await port.plan(t.plan.input);
    if ((t.state as TicketState) !== 'planned') return 'not_found';
    if (fresh.planHash !== t.plan.planHash) {
      t.state = 'changed';
      return 'changed';
    }
    t.state = 'scheduled';
    t.timer = this.#set(() => void this.#apply(t));
    return 'scheduled';
  }

  async #apply(t: Ticket): Promise<void> {
    t.timer = undefined;
    if (t.state !== 'scheduled' || this.#closed) return;
    t.state = 'applying';
    const port = this.#deps.current();
    if (port === undefined || port.agentId !== t.agentId) {
      t.state = 'agent_changed';
      return;
    }
    try {
      // Exactly the bound plan: core re-plans the same input and refuses a changed item set.
      t.result = freezeResult(await port.apply(t.plan));
      t.state = 'done';
    } catch (error) {
      t.state =
        (error as { code?: unknown } | undefined)?.code === 'history_plan_changed'
          ? 'changed'
          : 'failed';
    }
  }

  #undo(session: string, nonce: unknown): HistoryUndoOutcome {
    const t = this.#mine(session, nonce);
    if (t === undefined) return 'not_found';
    if (t.state === 'cancelled') return 'cancelled';
    if (t.state !== 'scheduled') return t.state === 'planned' ? 'not_found' : 'too_late';
    if (t.timer !== undefined) this.#clear(t.timer);
    t.timer = undefined;
    t.state = 'cancelled';
    return 'cancelled';
  }

  #status(session: string, nonce: unknown): HistoryStatusAnswer {
    const t = this.#mine(session, nonce);
    if (t === undefined) return { status: 'not_found' };
    if (t.state === 'done' && t.result !== undefined) return { status: 'done', result: t.result };
    return { status: t.state === 'done' ? 'failed' : t.state };
  }
}

/** The finish route's input: exactly `{nonce}`. */
export function finishNonce(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const o = input as JsonObject;
  const keys = Object.keys(o);
  if (keys.length !== 1 || keys[0] !== 'nonce') return undefined;
  const nonce = o['nonce'];
  return typeof nonce === 'string' && NONCE.test(nonce) ? nonce : undefined;
}
