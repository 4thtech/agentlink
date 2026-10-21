// Delete on receipt (M1-1g-h): `files.deleteAfter: receipt` (04 §4 retention and the encrypted
// drop; 06 §3 "Delivery receipts", D-109; 07 §5.4 upload epoch, D-108).
//
// The trigger is the contact's DELIVERED receipt for an envelope this agent sent, as the chain
// shows it on the agent's own record of that envelope (05 §3; the contract accepts a receipt only
// from the recipient the record commits to). Then the sender's core deletes the stored object of
// every file of that envelope through deleteFileObject: own storage, or the drop with a DELETE
// signed by the drop key of the epoch the object was uploaded under (the sealed locator records
// it), so a receipt seen after a key rotation still deletes it. The row is then marked deleted
// (`deleted_at`) and never deleted again. Discarding the file key on both sides and the expiry
// fallback (no receipt: the object stays until it expires) are M1-7f-2's.
//
// Per file, the policy at send time (M1-1g-i): a row is deleted on receipt only if it was sent under
// `receipt` (`files.delete_after`) and the policy in effect now still says `receipt` (the caller's
// check). So switching to `receipt` never deletes files sent earlier under `expiry`, switching back
// to `expiry` stops deletion, and a row stored before the snapshot existed (null) is kept until it
// expires: deletion is irreversible, so every doubt keeps the file (I-9).
//
// Best effort, retried on the next pass: a failed chain read deletes nothing, and a failed delete
// leaves the row as it was. Nothing about an object (locator, URL, object ID) reaches a log line,
// an error or a result (I-7): logs carry fixed codes only.
import { nowOf, type CoreContext } from '../context.js';
import { CoreError } from '../errors.js';
import type { Row } from '../store/schema.js';
import type { FilesPlatform } from './platform.js';
import { deleteFileObject } from './records.js';

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
      const now = nowOf(ctx);
      await ctx.store.transaction((tx) => {
        const current = tx.get('files', { envelope_id: row.envelope_id, idx: row.idx });
        if (current !== undefined && current.deleted_at === null) {
          tx.update('files', { envelope_id: row.envelope_id, idx: row.idx }, { deleted_at: now });
        }
      });
      deleted += 1;
    }
  }
  return { deleted, failed };
}
