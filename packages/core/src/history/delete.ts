// RET-3 (S2; D-148; 04 §4.2; 07 §3.8; proposed, owner confirms at merge): the owner's history
// delete, on this computer only.
//
// Two steps, so the owner's one presence gesture binds the exact list (04 §4.2 "Presence and undo"):
// - `plan(input)` selects the messages (by envelope IDs, by contact, older than a time, or, RET-4,
//   one contact older than a time), sets the
//   protected ones aside with a fixed reason, lists the saved files of the rest, and answers counts,
//   sizes and a `planHash` over the exact item set. It writes nothing.
// - `apply(plan)` computes the plan again from the same input and refuses (`history_plan_changed`)
//   when the item set differs; otherwise it tombstones the messages in one store transaction
//   (re-checking each row's protection inside it, so a row is never half deleted) and then moves the
//   saved files to the OS Trash through the files platform, each only if unchanged.
//
// What a tombstone keeps (07 §3.8): the key columns, so the duplicate check (04 §3.1.1 step 9) drops
// a relay replay of a deleted envelope; `deleted_at`; and, for a notarized envelope (OD-4), the
// signed ciphertext, so its proof pack still exports and verifies. The decrypted body and the
// receiver's file keys (`files` rows) go. Reads treat a tombstone as absent.
//
// Protected (kept, with a fixed reason; the delete skips them and never fails half way):
// - `pairing`: handshake, handshake-ack and card-update envelopes (the safety code is recomputed from
//   them; card-updates are the source of revoke recipients);
// - `terms`: offer, accept and reject envelopes. The negotiation chain is rebuilt from every stored
//   terms body and fails closed when one is missing (terms-store.ts), so all of them are kept, which
//   covers "the newest envelope of a thread with open terms" (04 §4.2) and more;
// - `approval`: an envelope a pending approval answers, an approved one whose commitment scope still
//   has a live part, or one a live `commitment_parts` row references (owner or policy grant alike);
// - `outbox`: an outbound envelope still queued, with a pending outbox row or a staged row;
// - `ledger`: a notarized envelope whose budget ledger entry is still only reserved;
// - `receipt` (IR-RET-3-1 Low 7): every `proof` envelope, an `ack` of a notarized message, an `ack`
//   whose message stays, and an `ack` whose body does not name one message. Other acks follow the
//   message they name: they go with it, or after it was deleted.
//
// A later plan with `include: files` or `both` also lists the still indexed saved files of messages
// deleted earlier (a Trash move that did not happen), so a partial apply leaves no orphans.
//
// No MCP tool applies this (I-4, 06 §1): the client exposes it to the owner surfaces only. RET-7's
// `agentlink_tidy` reaches `plan` alone, through the tool layer's `tidyPreview` (counts and sizes
// only), to propose a cleanup the owner confirms in the app. Nothing is sent to the contact, a
// relay, the drop or any 4thTech service. Logs carry counts only (I-7).
import { encodeHex, parseJson, sha256 } from '@4thtech-io/crypto';
import { nowOf, open, type CoreContext } from '../context.js';
import { CoreError } from '../errors.js';
import type { FileFetcher, SavedFileKey, TrashSavedCounts } from '../files/incoming.js';
import type { Row } from '../store/schema.js';
import type { StoreTx, Where } from '../store/store.js';
import { isTermsType } from '../terms-store.js';

/** What a delete removes: message bodies, the saved files, or both. */
export type HistoryDeleteInclude = 'messages' | 'files' | 'both';

/** Exactly one selector, and what to remove. */
export type HistoryDeleteInput =
  | { readonly envelopeIds: readonly string[]; readonly include: HistoryDeleteInclude }
  | {
      readonly contactId: string;
      /** RET-4: only this person's messages whose `createdAt` is before this unix time (seconds). */
      readonly before?: number;
      readonly include: HistoryDeleteInclude;
    }
  /** Messages whose `createdAt` is before this unix time (seconds). */
  | { readonly before: number; readonly include: HistoryDeleteInclude };

/** Why a selected message is kept (04 §4.2 "Protected items"). */
export type HistoryKeptReason = 'pairing' | 'terms' | 'approval' | 'outbox' | 'ledger' | 'receipt';

export interface HistoryDeletePlan {
  /** The input the plan was made from; apply plans it again and compares. */
  readonly input: HistoryDeleteInput;
  readonly include: HistoryDeleteInclude;
  /** sha256 (hex) over the exact item set: what goes and what is kept. */
  readonly planHash: string;
  /** The messages that go, oldest first (empty for `include: 'files'`'s message side). */
  readonly envelopeIds: readonly string[];
  /** Messages whose body goes: count and the stored bytes freed. */
  readonly messages: { readonly count: number; readonly bytes: number };
  /** Of those, notarized ones: the body goes, the ciphertext and proof stay (OD-4). */
  readonly notarized: number;
  /** Saved files that would go to the Trash (indexed, not yet trashed): count and bytes. */
  readonly files: { readonly count: number; readonly bytes: number };
  /** The saved files by their index row (no name, no path). */
  readonly savedFiles: readonly SavedFileKey[];
  /** Selected messages kept as protected, by reason. */
  readonly kept: {
    readonly count: number;
    readonly by: Readonly<Record<HistoryKeptReason, number>>;
  };
  /** More messages matched than one plan takes (MAX_PLAN_MESSAGES); run it again for the rest. */
  readonly truncated: boolean;
}

export interface HistoryDeleteResult {
  readonly messages: {
    /** Messages tombstoned. */
    readonly deleted: number;
    /** Of those, notarized (ciphertext and proof kept). */
    readonly notarized: number;
    /** Protected at apply time (kept). */
    readonly kept: number;
  };
  readonly files: Readonly<TrashSavedCounts>;
}

/** One plan takes at most this many messages (a large delete runs again for the rest). */
export const MAX_PLAN_MESSAGES = 20_000;
/** An `envelopeIds` selector names at most this many IDs. */
export const MAX_PLAN_IDS = 20_000;
/** P2-TRUNCATED-COUNT: the most rows one plan reads while looking for MAX_PLAN_MESSAGES to take. */
export const MAX_PLAN_SCAN_ROWS = 200_000;

const INCLUDES: readonly HistoryDeleteInclude[] = Object.freeze(['messages', 'files', 'both']);
const PAIRING_TYPES: readonly string[] = Object.freeze([
  'handshake',
  'handshake-ack',
  'card-update',
]);
const LIVE_PARTS = { in: ['unclaimed', 'claimed'] } as const;

const invalid = (): CoreError =>
  new CoreError('history_input_invalid', 'That delete request is not valid.');

/** Checks the input shape: exactly one selector, a known `include`; fixed error otherwise. */
function checkInput(input: unknown): HistoryDeleteInput {
  if (typeof input !== 'object' || input === null) throw invalid();
  const o = input as Record<string, unknown>;
  const include = o.include;
  if (typeof include !== 'string' || !INCLUDES.includes(include as HistoryDeleteInclude)) {
    throw invalid();
  }
  const keys = ['envelopeIds', 'contactId', 'before'].filter((k) => o[k] !== undefined);
  // RET-4: a person and an age together are one selector ("Marko, older than 90 days").
  const personByAge = keys.length === 2 && keys[0] === 'contactId' && keys[1] === 'before';
  if (keys.length !== 1 && !personByAge) throw invalid();
  const inc = include as HistoryDeleteInclude;
  if (o.envelopeIds !== undefined) {
    const ids = o.envelopeIds;
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_PLAN_IDS ||
      !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)
    ) {
      throw invalid();
    }
    return Object.freeze({ envelopeIds: Object.freeze([...(ids as string[])]), include: inc });
  }
  if (o.contactId !== undefined) {
    const id = o.contactId;
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) throw invalid();
    if (!personByAge) return Object.freeze({ contactId: id, include: inc });
    return Object.freeze({ contactId: id, before: checkBefore(o.before), include: inc });
  }
  return Object.freeze({ before: checkBefore(o.before), include: inc });
}

function checkBefore(before: unknown): number {
  if (typeof before !== 'number' || !Number.isSafeInteger(before) || before < 0) throw invalid();
  return before;
}

/** The store filter of a contact or age selector (both for a person by age). */
function whereOf(
  base: Where<'envelopes'>,
  input: Exclude<HistoryDeleteInput, { readonly envelopeIds: readonly string[] }>,
): Where<'envelopes'> {
  if (!('contactId' in input)) return { ...base, created_at: { lt: input.before } };
  return input.before === undefined
    ? { ...base, contact_id: input.contactId }
    : { ...base, contact_id: input.contactId, created_at: { lt: input.before } };
}

/**
 * IR-RET-67-1 Medium 1: how old a message is on this computer. The sender signs `createdAt`, so a
 * contact could backdate a message into an age filter; an age therefore never comes from it alone.
 * - Own sent messages: `createdAt` is this computer's own send time.
 * - Received messages: the earliest time this computer recorded for the message (first seen, read,
 *   a file of it saved; each is at or after its arrival), and never earlier than `createdAt`.
 *   P2-UNREAD-AGE: with none of these (its first-seen row pruned, never read, nothing saved) the
 *   age is `createdAt`. Sync prunes first-seen rows only once they are at least 7 days old, so such
 *   a message arrived at least 7 days ago; a contact that backdates it can therefore hasten its
 *   deletion only for a message already a week old here, and unread history ages out under the
 *   same keep-days rule instead of staying for ever.
 */
export function localAgeTx(tx: StoreTx, row: Row<'envelopes'>): number {
  if (row.direction === 'out') return row.created_at;
  const local: number[] = [];
  const seen = tx.get('seen', { kind: 'envelope', id: row.envelope_hash });
  if (seen !== undefined) local.push(seen.first_seen_at);
  if (row.read_at !== null) local.push(row.read_at);
  for (const f of tx.select('saved_files', { envelope_id: row.envelope_id })) {
    local.push(f.saved_at);
  }
  if (local.length === 0) return row.created_at;
  return Math.max(row.created_at, Math.min(...local));
}

/** The age cutoff of a selector, if it has one. */
const beforeOf = (input: HistoryDeleteInput): number | undefined =>
  'before' in input ? input.before : undefined;

/** True when `row` is older than the selector's cutoff by its local age (or there is no cutoff). */
function oldEnoughTx(tx: StoreTx, row: Row<'envelopes'>, input: HistoryDeleteInput): boolean {
  const before = beforeOf(input);
  if (before === undefined) return true;
  const age = localAgeTx(tx, row);
  return age !== undefined && age < before;
}

/**
 * The live (not deleted, processed) messages the selector names, oldest first, capped. `cap` is a
 * test seam (package-internal: not exported from the index); production always uses the default.
 */
export function selectTx(
  tx: StoreTx,
  input: HistoryDeleteInput,
  cap: number = MAX_PLAN_MESSAGES,
): { rows: Row<'envelopes'>[]; truncated: boolean } {
  const live: Where<'envelopes'> = { state: 'ok', deleted_at: null };
  let rows: Row<'envelopes'>[];
  if ('envelopeIds' in input) {
    const seen = new Set<string>();
    rows = [];
    for (const id of input.envelopeIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = tx.get('envelopes', { envelope_id: id });
      if (row !== undefined && row.state === 'ok' && row.deleted_at === null) rows.push(row);
    }
  } else {
    // P2-TRUNCATED-COUNT: the local-age filter runs per page, so `truncated` means "more than
    // MAX_PLAN_MESSAGES rows pass the filter", not "more rows matched before it". Pages follow the
    // (created_at, envelope_id) order; the scan is bounded (MAX_PLAN_SCAN_ROWS), and hitting that
    // bound also reads as truncated (run again for the rest).
    rows = [];
    const base = whereOf(live, input);
    const upper = 'before' in input ? input.before : undefined;
    let from: number | undefined;
    let after: string | undefined;
    let scanned = 0;
    const order: [['created_at', 'asc'], ['envelope_id', 'asc']] = [
      ['created_at', 'asc'],
      ['envelope_id', 'asc'],
    ];
    const size = cap + 1;
    while (rows.length <= cap && scanned < MAX_PLAN_SCAN_ROWS) {
      let page: Row<'envelopes'>[];
      if (from === undefined || after === undefined) {
        page = tx.select('envelopes', base, { orderBy: order, limit: size });
      } else {
        // Keyset: the rest of the cursor's own second first, then the later seconds.
        page = tx.select(
          'envelopes',
          { ...base, created_at: from, envelope_id: { gt: after } },
          { orderBy: order, limit: size },
        );
        if (page.length < size) {
          const later = upper === undefined ? { gt: from } : { gt: from, lt: upper };
          page = [
            ...page,
            ...tx.select(
              'envelopes',
              { ...base, created_at: later },
              { orderBy: order, limit: size - page.length },
            ),
          ];
        }
      }
      let last: Row<'envelopes'> | undefined;
      for (const row of page) {
        scanned += 1;
        last = row;
        // `createdAt` before the cutoff is necessary (the local age is never earlier), not enough.
        if (oldEnoughTx(tx, row, input)) rows.push(row);
      }
      if (page.length < size || last === undefined) break;
      from = last.created_at;
      after = last.envelope_id;
    }
    if (scanned >= MAX_PLAN_SCAN_ROWS && rows.length <= cap) {
      return { rows, truncated: true };
    }
  }
  rows.sort((a, b) =>
    a.created_at !== b.created_at
      ? a.created_at - b.created_at
      : a.envelope_id < b.envelope_id
        ? -1
        : a.envelope_id > b.envelope_id
          ? 1
          : 0,
  );
  const truncated = rows.length > cap;
  return { rows: truncated ? rows.slice(0, cap) : rows, truncated };
}

/** Why `row` must be kept, or undefined when it may go (04 §4.2). Inside the caller's transaction. */
function protectionTx(tx: StoreTx, row: Row<'envelopes'>): HistoryKeptReason | undefined {
  const id = row.envelope_id;
  if (PAIRING_TYPES.includes(row.type)) return 'pairing';
  if (isTermsType(row.type)) return 'terms';
  if (tx.count('approvals', { answers_envelope_id: id, status: 'pending' }) > 0) return 'approval';
  for (const a of tx.select('approvals', { answers_envelope_id: id, status: 'approved' })) {
    if (tx.count('commitment_parts', { approval_id: a.approval_id, state: LIVE_PARTS }) > 0) {
      return 'approval';
    }
  }
  if (tx.count('commitment_parts', { item_ref: id, state: LIVE_PARTS }) > 0) return 'approval';
  if (
    row.delivery === 'queued' ||
    tx.count('outbox', { envelope_id: id, state: 'pending' }) > 0 ||
    tx.get('outbox_staged', { envelope_id: id }) !== undefined
  ) {
    return 'outbox';
  }
  for (const p of tx.select('proofs', { envelope_id: id })) {
    if (tx.count('budget_ledger', { record_id: p.record_id, state: 'reserved' }) > 0) {
      return 'ledger';
    }
  }
  return undefined;
}

const notarizedTx = (tx: StoreTx, id: string): boolean =>
  tx.count('proofs', { envelope_id: id }) > 0;

const lengthOf = (v: string | null): number => (v === null ? 0 : v.length);

const wantsMessages = (i: HistoryDeleteInclude): boolean => i !== 'files';
const wantsFiles = (i: HistoryDeleteInclude): boolean => i !== 'messages';

const utf8 = new TextEncoder();

/** Ack envelope ID -> the envelope it acknowledges (null when its body does not say or is unreadable). */
type AckLinks = ReadonlyMap<string, string | null>;

/** Ack rows read per contact for the links (newest first). */
const MAX_ACK_LINKS_PER_CONTACT = 5_000;

/** Already deleted messages the selector names (their saved files may still be indexed). */
function tombstonedTx(tx: StoreTx, input: HistoryDeleteInput): Row<'envelopes'>[] {
  const gone: Where<'envelopes'> = { state: 'ok', deleted_at: { gte: 0 } };
  if ('envelopeIds' in input) {
    const out: Row<'envelopes'>[] = [];
    for (const id of new Set(input.envelopeIds)) {
      const row = tx.get('envelopes', { envelope_id: id });
      if (row !== undefined && row.state === 'ok' && row.deleted_at !== null) out.push(row);
    }
    return out;
  }
  return tx.select('envelopes', whereOf(gone, input), {
    orderBy: [
      ['created_at', 'asc'],
      ['envelope_id', 'asc'],
    ],
    limit: MAX_PLAN_MESSAGES,
  });
}

/** The plan, from one consistent read. */
function planTx(tx: StoreTx, input: HistoryDeleteInput, links: AckLinks): HistoryDeletePlan {
  const { rows, truncated } = selectTx(tx, input);
  const by: Record<HistoryKeptReason, number> = {
    pairing: 0,
    terms: 0,
    approval: 0,
    outbox: 0,
    ledger: 0,
    receipt: 0,
  };
  const going: string[] = [];
  const goingSet = new Set<string>();
  const keptIds: string[] = [];
  let bytes = 0;
  let notarized = 0;
  const savedFiles: SavedFileKey[] = [];
  const fileSeen = new Set<string>();
  let fileBytes = 0;
  const keep = (id: string, reason: HistoryKeptReason): void => {
    by[reason] += 1;
    keptIds.push(id);
  };
  // IR-RET-67-1 Medium 1: under an age selector a saved file ages from when it was saved here.
  const cutoff = beforeOf(input);
  const filesOf = (envelopeId: string): void => {
    for (const f of tx.select(
      'saved_files',
      { envelope_id: envelopeId, trashed_at: null },
      { orderBy: [['idx', 'asc']] },
    )) {
      if (cutoff !== undefined && !(f.saved_at < cutoff)) continue;
      const key = `${f.envelope_id}/${String(f.idx)}`;
      if (fileSeen.has(key)) continue;
      fileSeen.add(key);
      savedFiles.push(Object.freeze({ envelopeId: f.envelope_id, index: f.idx }));
      fileBytes += f.size;
    }
  };
  const take = (row: Row<'envelopes'>): void => {
    goingSet.add(row.envelope_id);
    if (wantsMessages(input.include)) {
      const isNotarized = notarizedTx(tx, row.envelope_id);
      if (isNotarized) notarized += 1;
      bytes += lengthOf(row.payload_json) + (isNotarized ? 0 : lengthOf(row.envelope_json));
      going.push(row.envelope_id);
    }
    if (wantsFiles(input.include)) filesOf(row.envelope_id);
  };
  // 1. Conversation messages.
  for (const row of rows) {
    if (row.type === 'ack' || row.type === 'proof') continue;
    const reason = protectionTx(tx, row);
    if (reason !== undefined) keep(row.envelope_id, reason);
    else take(row);
  }
  // 2. Proof envelopes always belong to a notarized message: kept (IR-RET-3-1 Low 7).
  for (const row of rows) if (row.type === 'proof') keep(row.envelope_id, 'receipt');
  // 3. Acks follow the message they name: they go when it goes (or is already deleted) and it is
  //    not notarized; an ack of a notarized message, of a message that stays, or whose body does not
  //    say which message it names, is kept.
  if (wantsMessages(input.include)) {
    const selected = rows.filter((r) => r.type === 'ack').map((r) => r.envelope_id);
    const selectedSet = new Set(selected);
    const following = [...links.entries()]
      .filter(([id, target]) => !selectedSet.has(id) && target !== null && goingSet.has(target))
      .map(([id]) => id)
      .sort();
    for (const id of [...selected, ...following]) {
      const row = tx.get('envelopes', { envelope_id: id });
      if (
        row === undefined ||
        row.type !== 'ack' ||
        row.state !== 'ok' ||
        row.deleted_at !== null
      ) {
        continue;
      }
      const target = links.get(id) ?? null;
      const targetRow = target === null ? undefined : tx.get('envelopes', { envelope_id: target });
      const follows =
        target !== null &&
        targetRow !== undefined &&
        !notarizedTx(tx, target) &&
        (goingSet.has(target) || targetRow.deleted_at !== null);
      if (!follows) {
        keep(id, 'receipt');
        continue;
      }
      const reason = protectionTx(tx, row);
      if (reason !== undefined) keep(id, reason);
      else take(row);
    }
  }
  // 4. Saved files of messages deleted earlier whose move did not happen (IR-RET-3-1 Low 6).
  if (wantsFiles(input.include)) {
    for (const row of tombstonedTx(tx, input)) filesOf(row.envelope_id);
  }
  const digest = encodeHex(
    sha256(
      utf8.encode(
        JSON.stringify({
          v: 1,
          include: input.include,
          messages: going,
          files: savedFiles.map((f) => [f.envelopeId, f.index]),
          kept: keptIds,
          truncated,
        }),
      ),
    ),
  );
  return Object.freeze({
    input,
    include: input.include,
    planHash: digest,
    envelopeIds: Object.freeze(going),
    messages: Object.freeze({ count: going.length, bytes }),
    notarized,
    files: Object.freeze({ count: savedFiles.length, bytes: fileBytes }),
    savedFiles: Object.freeze(savedFiles),
    kept: Object.freeze({ count: keptIds.length, by: Object.freeze(by) }),
    truncated,
  });
}

export interface HistoryDeps {
  /** The saved-file mover (FileFetcher.trashSavedFiles). */
  readonly files: Pick<FileFetcher, 'trashSavedFiles'>;
}

/**
 * The owner's history delete (see the header). Owner surfaces only (the local app's routes with
 * presence, RET-4; the retention pass, RET-6); never an MCP tool (I-4).
 */
export class HistoryService {
  readonly #ctx: CoreContext;
  readonly #deps: HistoryDeps;

  constructor(ctx: CoreContext, deps: HistoryDeps) {
    this.#ctx = ctx;
    this.#deps = deps;
  }

  /**
   * Which message each ack of the selected contacts names, read from its sealed body before the
   * plan's transaction (bodies open outside a transaction, 07 §3.1). A body that does not open or
   * name one envelope maps to null (the ack is then kept).
   */
  async #ackLinks(input: HistoryDeleteInput): Promise<AckLinks> {
    const ctx = this.#ctx;
    const acks = await ctx.store.transaction((tx) => {
      const { rows } = selectTx(tx, input);
      const contacts = new Set<string>();
      for (const r of rows) if (r.contact_id !== null) contacts.add(r.contact_id);
      if ('contactId' in input) contacts.add(input.contactId);
      const out: Row<'envelopes'>[] = [];
      for (const contactId of [...contacts].sort()) {
        out.push(
          ...tx.select(
            'envelopes',
            { contact_id: contactId, type: 'ack', state: 'ok', deleted_at: null },
            {
              orderBy: [
                ['created_at', 'desc'],
                ['envelope_id', 'asc'],
              ],
              limit: MAX_ACK_LINKS_PER_CONTACT,
            },
          ),
        );
      }
      return out;
    });
    const links = new Map<string, string | null>();
    for (const ack of acks) {
      let target: string | null = null;
      if (ack.payload_json !== null) {
        try {
          const text = await open(
            ctx,
            'envelopes',
            'payload_json',
            [ack.envelope_id],
            ack.payload_json,
          );
          const parsed = parseJson(text) as {
            readonly type?: unknown;
            readonly replyTo?: unknown;
            readonly body?: { readonly envelopeId?: unknown } | null;
          } | null;
          const named = parsed?.body?.envelopeId;
          if (
            parsed?.type === 'ack' &&
            typeof named === 'string' &&
            (parsed.replyTo === null || parsed.replyTo === undefined || parsed.replyTo === named)
          ) {
            target = named;
          }
        } catch {
          target = null;
        }
      }
      links.set(ack.envelope_id, target);
    }
    return links;
  }

  /** What a delete would remove and keep, with counts, sizes and the plan hash. Writes nothing. */
  async plan(input: HistoryDeleteInput): Promise<HistoryDeletePlan> {
    const checked = checkInput(input);
    const links = await this.#ackLinks(checked);
    return this.#ctx.store.transaction((tx) => planTx(tx, checked, links));
  }

  /**
   * Applies a plan the owner confirmed. Refuses with `history_plan_changed` (nothing deleted) when
   * the same input no longer gives the same item set.
   */
  async apply(plan: HistoryDeletePlan): Promise<HistoryDeleteResult> {
    const ctx = this.#ctx;
    if (typeof plan !== 'object' || plan === null || typeof plan.planHash !== 'string') {
      throw invalid();
    }
    const input = checkInput(plan.input);
    const links = await this.#ackLinks(input);
    const now = nowOf(ctx);
    const outcome = await ctx.store.transaction((tx) => {
      const fresh = planTx(tx, input, links);
      if (fresh.planHash !== plan.planHash) return undefined;
      let deleted = 0;
      let notarized = 0;
      let kept = 0;
      for (const id of fresh.envelopeIds) {
        const row = tx.get('envelopes', { envelope_id: id });
        if (row === undefined || row.state !== 'ok' || row.deleted_at !== null) continue;
        // Re-checked in this transaction: a row is never half deleted.
        if (protectionTx(tx, row) !== undefined) {
          kept += 1;
          continue;
        }
        const keepCiphertext = notarizedTx(tx, id);
        const changed = tx.update(
          'envelopes',
          { envelope_id: id, envelope_hash: row.envelope_hash, deleted_at: null },
          {
            payload_json: null,
            envelope_json: keepCiphertext ? row.envelope_json : null,
            deleted_at: now,
            read_at: row.read_at ?? now,
          },
        );
        if (changed !== 1) continue;
        // The receiver's file keys and links go with the message (04 §4.2). A sender's rows stay
        // until their own retention deletes the stored objects at expiry or receipt.
        if (row.direction === 'in') tx.delete('files', { envelope_id: id });
        deleted += 1;
        if (keepCiphertext) notarized += 1;
      }
      return { deleted, notarized, kept, savedFiles: fresh.savedFiles };
    });
    if (outcome === undefined) {
      throw new CoreError(
        'history_plan_changed',
        'What would be deleted changed since it was shown. Nothing was deleted.',
      );
    }
    if (outcome.deleted > 0) await ctx.store.compact?.().catch(() => undefined);
    const files = await this.#deps.files.trashSavedFiles(outcome.savedFiles);
    ctx.log.info('history deleted', {
      messages: outcome.deleted,
      notarized: outcome.notarized,
      kept: plan.kept.count + outcome.kept,
      trashed: files.trashed,
      changed: files.changed,
      missing: files.missing,
      refused: files.refused,
      noTrash: files.noTrash,
      failed: files.failed,
    });
    return Object.freeze({
      messages: Object.freeze({
        deleted: outcome.deleted,
        notarized: outcome.notarized,
        kept: outcome.kept,
      }),
      files: Object.freeze({ ...files }),
    });
  }

  /** plan, then apply at once (the retention pass; tests). */
  async delete(input: HistoryDeleteInput): Promise<HistoryDeleteResult> {
    return this.apply(await this.plan(input));
  }
}
