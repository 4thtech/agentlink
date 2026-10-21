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
}

/**
 * One delete-on-receipt pass: every sent envelope with a stored file not yet deleted is checked for
 * its DELIVERED receipt, and the files of each delivered one are deleted. The caller checks that
 * the effective policy says `files.deleteAfter: receipt` first. Never throws.
 */
export async function deleteFilesOnReceipt(
  ctx: CoreContext,
  platform: FilesPlatform | undefined,
  deps: ReceiptRetentionDeps,
): Promise<ReceiptRetentionResult> {
  const pending = await ctx.store.transaction((tx) => {
    const byEnvelope = new Map<string, Row<'files'>[]>();
    for (const row of tx.select('files')) {
      if (row.deleted_at !== null) continue;
      const envelope = tx.get('envelopes', { envelope_id: row.envelope_id });
      // Only files this agent sent: a receipt is about the sender's own record.
      if (envelope?.direction !== 'out') continue;
      const rows = byEnvelope.get(row.envelope_id) ?? [];
      rows.push(row);
      byEnvelope.set(row.envelope_id, rows);
    }
    return [...byEnvelope.entries()].slice(0, MAX_RECEIPT_RETENTION_PER_PASS);
  });
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
