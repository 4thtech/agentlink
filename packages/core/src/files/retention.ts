// Delete on receipt (M1-1g-h): `files.deleteAfter: receipt` (04 §4 retention and the encrypted
// drop; 06 §3 "Delivery receipts", D-109; 07 §5.4 upload epoch, D-108).
//
// The trigger is the contact's DELIVERED receipt for an envelope this agent sent, as the chain
// shows it on the agent's own record of that envelope (05 §3; the contract accepts a receipt only
// from the recipient the record commits to). Then the sender's core deletes the stored object of
// every file of that envelope through deleteFileObject: own storage, or the drop with a DELETE
// signed by the drop key of the epoch the object was uploaded under (the sealed locator records
// it), so a receipt seen after a key rotation still deletes it. The row, and with it the sealed
// file key, is then deleted (M1-7f-2, crypto-shredding; 04 §4).
//
// Retention at expiry (M1-7f-2; 04 §4, 06 §3): deleteExpiredFiles runs under every policy. At
// `expiresAt` the sender deletes the stored object of each of its rows (under `expiry`, under
// `receipt` without a DELIVERED receipt (M1-33d), and for rows stored before the snapshot) and then
// the row; the receiver deletes its own row (D-98), never an object. Before `expiresAt` nothing is
// deleted, so the owner keeps access until then (I-9).
//
// Per file, the policy at send time (M1-1g-i): a row is deleted on receipt only if it was sent under
// `receipt` (`files.delete_after`) and the policy in effect now still says `receipt` (the caller's
// check). So switching to `receipt` never deletes files sent earlier under `expiry`, switching back
// to `expiry` stops deletion, and a row stored before the snapshot existed (null) is kept until it
// expires: deletion is irreversible, so every doubt keeps the file (I-9).
//
// History retention (RET-6; D-148; 04 §4.2 "Retention policy"; 06 §3 `history`; proposed, owner
// confirms at merge): HistoryRetention below. Once a day the lease holder's background loop asks it
// to delete what the owner's signed `history.*` says is older than kept, through RET-3's plan and
// apply and nothing else: saved files to the OS Trash (`include: 'files'`), message bodies to
// tombstones (`include: 'messages'`), protected items kept. It deletes nothing unless the policy in
// force is a verified owner-signed one (never the defaults, never fail closed), while the ID is
// paused (checked again before each apply; an unreadable pause row counts as paused), or when the
// store cannot be read. A policy signed before D-148 reads as keep forever. No MCP tool reaches it
// (I-4).
//
// Best effort, retried on the next pass: a failed chain read deletes nothing, and a failed delete
// leaves the row as it was. Nothing about an object (locator, URL, object ID) reaches a log line,
// an error or a result (I-7): logs carry fixed codes only.
import { HISTORY_PRE_D148, historySchema, type HistoryPolicy } from '@4thtech-io/types';
import { nowOf, type CoreContext } from '../context.js';
import { CoreError } from '../errors.js';
import type { HistoryDeleteInclude, HistoryService } from '../history/delete.js';
import type { EffectivePolicy } from '../policy-engine.js';
import type { Row } from '../store/schema.js';
import type { FilesPlatform } from './platform.js';
import { deleteFileObject } from './records.js';

/** At most this many expired files are handled in one expiry pass. */
export const MAX_EXPIRY_RETENTION_PER_PASS = 200;

/** At most this many sent envelopes are checked against the chain in one pass. */
export const MAX_RECEIPT_RETENTION_PER_PASS = 50;

export interface ReceiptRetentionResult {
  /** Files deleted in this pass (an inline file has no stored object; its row is only marked). */
  readonly deleted: number;
  /** File objects whose delete failed; their rows stay for the next pass. */
  readonly failed: number;
}

export interface ReceiptRetentionDeps {
  /** True when the chain shows the contact's DELIVERED receipt for this sent envelope. */
  delivered(envelopeId: string): Promise<boolean>;
  /**
   * The last envelope ID the previous pass checked (kept by the caller across passes; null before
   * the first). The next pass starts at the first candidate after it in envelope ID order, wrapping
   * around, so candidates whose receipt never comes cannot hold the per-pass window for good, and a
   * candidate removed between passes never shifts the window past another (IR-M1-1g-h-2).
   */
  readonly cursor: { after: string | null };
}

/** The statuses of an own record on-chain (proofs/service.ts ON_CHAIN). */
const OWN_ON_CHAIN = ['recorded', 'announced'] as const;

/**
 * One delete-on-receipt pass. Candidates are only the sent envelopes this agent recorded on-chain
 * (an own `proofs` row in `recorded` or `announced`): without an own record no receipt can exist,
 * so an envelope never notarized is never a candidate and costs no chain read. For each candidate
 * with a file sent under `receipt` and not yet deleted (its rows read by the `files` key prefix),
 * the chain is asked for the DELIVERED receipt, and those files of each delivered one are deleted.
 * At most MAX_RECEIPT_RETENTION_PER_PASS candidates per pass, rotating through the list by envelope
 * ID. The caller checks that the effective policy says `files.deleteAfter: receipt` first. Never
 * throws.
 */
export async function deleteFilesOnReceipt(
  ctx: CoreContext,
  platform: FilesPlatform | undefined,
  deps: ReceiptRetentionDeps,
): Promise<ReceiptRetentionResult> {
  const candidates = await ctx.store.transaction((tx) => {
    const envelopeIds = [
      ...new Set(
        tx.select('proofs', { status: { in: [...OWN_ON_CHAIN] } }).map((r) => r.envelope_id),
      ),
    ].sort();
    const out: [string, Row<'files'>[]][] = [];
    for (const envelopeId of envelopeIds) {
      // Only files this agent sent: a receipt is about the sender's own record.
      if (tx.get('envelopes', { envelope_id: envelopeId })?.direction !== 'out') continue;
      const rows = tx
        .select('files', { envelope_id: envelopeId })
        // Only files sent under `receipt` (M1-1g-i); null (stored before the snapshot) is kept.
        .filter((row) => row.deleted_at === null && row.delete_after === 'receipt');
      if (rows.length > 0) out.push([envelopeId, rows]);
    }
    return out;
  });
  // Candidates are in envelope ID order: start after the last one checked, wrapping around.
  const after = deps.cursor.after;
  const found = after === null ? -1 : candidates.findIndex(([envelopeId]) => envelopeId > after);
  const start = found === -1 ? 0 : found;
  const pending = [...candidates.slice(start), ...candidates.slice(0, start)].slice(
    0,
    MAX_RECEIPT_RETENTION_PER_PASS,
  );
  const last = pending.at(-1);
  deps.cursor.after = last === undefined ? null : last[0];
  let deleted = 0;
  let failed = 0;
  for (const [envelopeId, rows] of pending) {
    let delivered: boolean;
    try {
      delivered = await deps.delivered(envelopeId);
    } catch {
      delivered = false;
    }
    if (!delivered) continue;
    for (const row of rows) {
      try {
        if (platform === undefined) throw new CoreError('storage_failed', 'not deleted');
        await deleteFileObject(ctx, platform, row);
      } catch (error) {
        failed += 1;
        ctx.log.warn('file not deleted on receipt', {
          code: error instanceof CoreError ? error.code : 'storage_failed',
        });
        continue;
      }
      // The file key goes with the row (crypto-shredding, 04 §4).
      await ctx.store.transaction((tx) => {
        tx.delete('files', { envelope_id: row.envelope_id, idx: row.idx });
      });
      deleted += 1;
    }
  }
  return { deleted, failed };
}

/**
 * One expiry pass (see the header): every `files` row whose `expires_at` has passed, oldest first,
 * at most MAX_EXPIRY_RETENTION_PER_PASS. A row of a received envelope is deleted on its own; a row of
 * a sent envelope (or one whose envelope row is gone) after its stored object is deleted (nothing to
 * delete for an inline file, or when the receipt pass already did). A failed delete keeps the row
 * for the next pass; busy or unavailable storage ends the pass. Never throws.
 */
export async function deleteExpiredFiles(
  ctx: CoreContext,
  platform: FilesPlatform | undefined,
): Promise<ReceiptRetentionResult> {
  const now = nowOf(ctx);
  const due = await ctx.store.transaction((tx) =>
    tx
      .select(
        'files',
        { expires_at: { lte: now } },
        {
          orderBy: [
            ['expires_at', 'asc'],
            ['envelope_id', 'asc'],
            ['idx', 'asc'],
          ],
          limit: MAX_EXPIRY_RETENTION_PER_PASS,
        },
      )
      .map((row) => ({
        row,
        received: tx.get('envelopes', { envelope_id: row.envelope_id })?.direction === 'in',
      })),
  );
  let deleted = 0;
  let failed = 0;
  for (const { row, received } of due) {
    if (!received && row.deleted_at === null) {
      try {
        if (platform === undefined) throw new CoreError('storage_failed', 'not deleted');
        await deleteFileObject(ctx, platform, row);
      } catch (error) {
        failed += 1;
        const code = error instanceof CoreError ? error.code : 'storage_failed';
        ctx.log.warn('file not deleted at expiry', { code });
        if (code === 'storage_unavailable') break;
        continue;
      }
    }
    await ctx.store.transaction((tx) => {
      tx.delete('files', { envelope_id: row.envelope_id, idx: row.idx });
    });
    deleted += 1;
  }
  return { deleted, failed };
}

// --- History retention (RET-6) --------------------------------------------------------------------

/** The history pass runs at most once in this many seconds (04 §4.2: "a daily core pass"). */
export const HISTORY_RETENTION_INTERVAL_SECONDS = 86_400;
/**
 * IR-RET-67-1 Low 6: after a failed pass the next one waits this long, doubling with each failure in
 * a row up to a day, so a failing plan is not repeated on every loop pass.
 */
export const HISTORY_RETENTION_BACKOFF_SECONDS = 3_600;
const DAY_SECONDS = 86_400;

/** The owner's `history.*` limits in days (0 keeps forever). */
export type HistoryKeep = Readonly<HistoryPolicy>;

/**
 * The `history.*` limits of the policy in force, only when it is a verified owner-signed policy
 * (G-6): undefined for the defaults (no policy signed yet), under fail closed, or for a value off the
 * 06 §3 lists. A policy signed before D-148 reads as keep forever (HISTORY_PRE_D148).
 */
export function historyKeepOf(effective: EffectivePolicy): HistoryKeep | undefined {
  if (effective.mode !== 'signed') return undefined;
  const parsed = historySchema.safeParse(
    (effective.policy as { readonly history?: unknown }).history ?? HISTORY_PRE_D148,
  );
  if (!parsed.success) return undefined;
  return Object.freeze({
    messagesKeepDays: parsed.data.messagesKeepDays,
    filesKeepDays: parsed.data.filesKeepDays,
  });
}

export type HistoryRetentionOutcome =
  /** Messages tombstoned and saved files moved to the Trash in this pass. */
  | { readonly status: 'ran'; readonly messages: number; readonly files: number }
  | {
      readonly status: 'skipped';
      readonly reason: 'not_due' | 'backoff' | 'paused' | 'policy_not_signed' | 'off' | 'failed';
    };

/** What limits would remove now (counts and stored bytes only; nothing is deleted). */
export interface HistoryRetentionPreview {
  readonly messages: { readonly count: number; readonly bytes: number };
  readonly files: { readonly count: number; readonly bytes: number };
  /** A count was capped (one plan takes MAX_PLAN_MESSAGES): the page says "about". */
  readonly truncated: boolean;
}

export interface HistoryRetentionDeps {
  /** The policy in force (OwnerActions.loadPolicy). */
  loadPolicy(): Promise<EffectivePolicy>;
  /** The ID's pause (true when the row cannot be read: fail closed). */
  paused(): Promise<boolean>;
  /** RET-3's plan and apply. */
  readonly history: Pick<HistoryService, 'plan' | 'apply'>;
}

/** The cutoff for `days`: messages created before it are older than kept. */
const cutoff = (now: number, days: number): number => Math.max(0, now - days * DAY_SECONDS);

/** The daily history retention pass and its preview (see the header). */
export class HistoryRetention {
  readonly #ctx: CoreContext;
  readonly #deps: HistoryRetentionDeps;
  /** When the pass last ran to the end (unix seconds), in this process. */
  #lastRunAt: number | undefined;
  /** When the last pass failed, and how many failed in a row (Low 6). */
  #failedAt: number | undefined;
  #failures = 0;
  #running: Promise<HistoryRetentionOutcome> | undefined;

  constructor(ctx: CoreContext, deps: HistoryRetentionDeps) {
    this.#ctx = ctx;
    this.#deps = deps;
  }

  /** One pass when due (once a day); one at a time. Never throws: a failure deletes nothing more. */
  run(): Promise<HistoryRetentionOutcome> {
    if (this.#running !== undefined) return this.#running;
    const running = this.#run().finally(() => {
      this.#running = undefined;
    });
    this.#running = running;
    return running;
  }

  async #run(): Promise<HistoryRetentionOutcome> {
    const skipped = (reason: Extract<HistoryRetentionOutcome, { status: 'skipped' }>['reason']) =>
      Object.freeze({ status: 'skipped', reason }) as HistoryRetentionOutcome;
    const ctx = this.#ctx;
    const deps = this.#deps;
    try {
      const now = nowOf(ctx);
      const last = this.#lastRunAt;
      if (last !== undefined && now >= last && now - last < HISTORY_RETENTION_INTERVAL_SECONDS) {
        return skipped('not_due');
      }
      const failedAt = this.#failedAt;
      if (failedAt !== undefined && now >= failedAt) {
        const wait = Math.min(
          HISTORY_RETENTION_BACKOFF_SECONDS * 2 ** Math.min(this.#failures - 1, 5),
          HISTORY_RETENTION_INTERVAL_SECONDS,
        );
        if (now - failedAt < wait) return skipped('backoff');
      }
      if (await deps.paused()) return skipped('paused');
      const keep = historyKeepOf(await deps.loadPolicy());
      if (keep === undefined) return skipped('policy_not_signed');
      if (keep.messagesKeepDays === 0 && keep.filesKeepDays === 0) return skipped('off');
      let messages = 0;
      let files = 0;
      if (keep.messagesKeepDays > 0) {
        const plan = await deps.history.plan({
          before: cutoff(now, keep.messagesKeepDays),
          include: 'messages',
        });
        if (plan.messages.count > 0) {
          // Paused between the plan and the apply: nothing is deleted.
          if (await deps.paused()) return skipped('paused');
          messages = (await deps.history.apply(plan)).messages.deleted;
        }
      }
      if (keep.filesKeepDays > 0) {
        const plan = await deps.history.plan({
          before: cutoff(now, keep.filesKeepDays),
          include: 'files',
        });
        if (plan.files.count > 0) {
          if (await deps.paused()) return skipped('paused');
          files = (await deps.history.apply(plan)).files.trashed;
        }
      }
      this.#lastRunAt = now;
      this.#failedAt = undefined;
      this.#failures = 0;
      ctx.log.info('history retention', { messages, files });
      return Object.freeze({ status: 'ran', messages, files });
    } catch (error) {
      try {
        this.#failedAt = nowOf(ctx);
        this.#failures += 1;
      } catch {
        // No valid clock: the next pass tries again (nothing was deleted by this one).
      }
      // Codes only (I-7): never the error's text.
      ctx.log.warn('history retention not run', {
        code: error instanceof CoreError ? error.code : 'failed',
      });
      return skipped('failed');
    }
  }

  /**
   * What `keep` would remove now (the Storage editor shows it before the owner signs; 04 §4.2).
   * Plans only: writes and deletes nothing. A value off the 06 §3 lists is `history_input_invalid`.
   */
  async preview(keep: unknown): Promise<HistoryRetentionPreview> {
    const parsed = historySchema.safeParse(keep);
    if (!parsed.success) {
      throw new CoreError('history_input_invalid', 'That retention setting is not valid.');
    }
    const now = nowOf(this.#ctx);
    let truncated = false;
    const count = async (days: number, include: HistoryDeleteInclude) => {
      if (days === 0) return { count: 0, bytes: 0 };
      const plan = await this.#deps.history.plan({ before: cutoff(now, days), include });
      if (plan.truncated) truncated = true;
      const part = include === 'files' ? plan.files : plan.messages;
      return { count: part.count, bytes: part.bytes };
    };
    const messages = await count(parsed.data.messagesKeepDays, 'messages');
    const files = await count(parsed.data.filesKeepDays, 'files');
    return Object.freeze({
      messages: Object.freeze(messages),
      files: Object.freeze(files),
      truncated,
    });
  }
}
