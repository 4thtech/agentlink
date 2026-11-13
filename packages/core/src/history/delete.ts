// RET-3 (S2; D-148; 04 §4.2; 07 §3.8; proposed, owner confirms at merge): the owner's history
// delete, on this computer only.
//
// Two steps, so the owner's one presence gesture binds the exact list (04 §4.2 "Presence and undo"):
// - `plan(input)` selects the messages (by envelope IDs, by contact, or older than a time), sets the
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
// - `ledger`: a notarized envelope whose budget ledger entry is still only reserved.
//
// No MCP tool reaches this (I-4, 06 §1): the client exposes it to the owner surfaces only. Nothing is
// sent to the contact, a relay, the drop or any 4thTech service. Logs carry counts only (I-7).
import { encodeHex, sha256 } from '@4thtech-io/crypto';
import { nowOf, type CoreContext } from '../context.js';
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
  | { readonly contactId: string; readonly include: HistoryDeleteInclude }
  /** Messages whose `createdAt` is before this unix time (seconds). */
  | { readonly before: number; readonly include: HistoryDeleteInclude };

/** Why a selected message is kept (04 §4.2 "Protected items"). */
export type HistoryKeptReason = 'pairing' | 'terms' | 'approval' | 'outbox' | 'ledger';

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
  if (keys.length !== 1) throw invalid();
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
    return Object.freeze({ contactId: id, include: inc });
  }
  const before = o.before;
  if (typeof before !== 'number' || !Number.isSafeInteger(before) || before < 0) throw invalid();
  return Object.freeze({ before, include: inc });
}

/** The live (not deleted, processed) messages the selector names, oldest first, capped. */
function selectTx(
  tx: StoreTx,
  input: HistoryDeleteInput,
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
    const where: Where<'envelopes'> =
      'contactId' in input
        ? { ...live, contact_id: input.contactId }
        : { ...live, created_at: { lt: input.before } };
    rows = tx.select('envelopes', where, {
      orderBy: [
        ['created_at', 'asc'],
        ['envelope_id', 'asc'],
      ],
      limit: MAX_PLAN_MESSAGES + 1,
    });
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
  const truncated = rows.length > MAX_PLAN_MESSAGES;
  return { rows: truncated ? rows.slice(0, MAX_PLAN_MESSAGES) : rows, truncated };
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

/** The plan, from one consistent read. */
function planTx(tx: StoreTx, input: HistoryDeleteInput): HistoryDeletePlan {
  const { rows, truncated } = selectTx(tx, input);
  const by: Record<HistoryKeptReason, number> = {
    pairing: 0,
    terms: 0,
    approval: 0,
    outbox: 0,
    ledger: 0,
  };
  const going: string[] = [];
  const keptIds: string[] = [];
  let bytes = 0;
  let notarized = 0;
  const savedFiles: SavedFileKey[] = [];
  let fileBytes = 0;
  for (const row of rows) {
    const reason = protectionTx(tx, row);
    if (reason !== undefined) {
      by[reason] += 1;
      keptIds.push(row.envelope_id);
      continue;
    }
    if (wantsMessages(input.include)) {
      const isNotarized = notarizedTx(tx, row.envelope_id);
      if (isNotarized) notarized += 1;
      bytes += lengthOf(row.payload_json) + (isNotarized ? 0 : lengthOf(row.envelope_json));
      going.push(row.envelope_id);
    }
    if (wantsFiles(input.include)) {
      for (const f of tx.select(
        'saved_files',
        { envelope_id: row.envelope_id, trashed_at: null },
        { orderBy: [['idx', 'asc']] },
      )) {
        savedFiles.push(Object.freeze({ envelopeId: f.envelope_id, index: f.idx }));
        fileBytes += f.size;
      }
    }
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

  /** What a delete would remove and keep, with counts, sizes and the plan hash. Writes nothing. */
  async plan(input: HistoryDeleteInput): Promise<HistoryDeletePlan> {
    const checked = checkInput(input);
    return this.#ctx.store.transaction((tx) => planTx(tx, checked));
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
    const now = nowOf(ctx);
    const outcome = await ctx.store.transaction((tx) => {
      const fresh = planTx(tx, input);
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
