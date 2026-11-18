// SEC-OUTBOUND-CAPS (D-156; 06 §3 `outgoing`, 07 §3.2): what this agent sent with `agentlink_send`
// in the rolling 24 h window, per ID. The count is the `outgoing_log` table: one row per sent message,
// written in the transaction that stores the envelope (recordOutgoing), so the count and the stored
// envelope are one step and two concurrent sends never both pass on the same count. Deleting a file
// (retention, delete on receipt) or a message never frees a cap: the log keeps only counts, and rows
// leave it only when they leave the window.
//
// Counted: messages of the `agentlink_send` types and the files they carry. Not counted: acks,
// receipts, proofs, pairing, card updates, owner-channel and terms envelopes (SEC-TERMS-CAPS, later).
// Counts and bytes only: nothing here reads a name, a path or a body.
//
// Scope: this protects against a runaway or steered AI using the tools. A process holding the agent
// key can bypass it; the recipient's inbound limit (`contacts.rateLimitPerContactPerHour`) is the
// backstop. The counts are local to one store: a restored backup counts from what it holds, and an
// update to schema version 17 starts with an empty log.
import { BUDGET_WINDOW_SECONDS, type OutgoingUsage } from './policy-engine.js';
import type { StoreTx } from './store/store.js';

/** The rolling window of the outgoing caps: 24 h, the same as the proof budget (G-7). */
export const OUTGOING_WINDOW_SECONDS = BUDGET_WINDOW_SECONDS;

/** Usage, plus when the oldest counted message of each scope leaves the window (unix seconds). */
export interface OutgoingUsageDetail extends OutgoingUsage {
  /** The oldest counted message to `contact`, or null when none. */
  readonly contactOldestAt: number | null;
  /** The oldest counted message to anyone, or null when none. */
  readonly oldestAt: number | null;
  /** The oldest counted message with files to `contact`, or null. */
  readonly contactFileOldestAt: number | null;
  /** The oldest counted message with files to anyone, or null. */
  readonly fileOldestAt: number | null;
}

const minOf = (a: number | null, b: number): number => (a === null || b < a ? b : a);

/**
 * The outgoing usage over the window ending at `now` (an entry counts while `t > now − 86 400`, as
 * the budget window), for `contact` and in all. Synchronous, inside the caller's transaction (07
 * §3.1).
 */
export function outgoingUsage(tx: StoreTx, contact: string, now: number): OutgoingUsageDetail {
  const rows = tx.select('outgoing_log', { t: { gt: now - OUTGOING_WINDOW_SECONDS } });
  let contactMessages = 0;
  let files = 0;
  let contactFiles = 0;
  let bytes = 0;
  let contactOldestAt: number | null = null;
  let oldestAt: number | null = null;
  let contactFileOldestAt: number | null = null;
  let fileOldestAt: number | null = null;
  for (const r of rows) {
    const mine = r.contact_id === contact;
    oldestAt = minOf(oldestAt, r.t);
    if (mine) {
      contactMessages += 1;
      contactOldestAt = minOf(contactOldestAt, r.t);
    }
    if (r.files > 0) {
      files += r.files;
      bytes += r.bytes;
      fileOldestAt = minOf(fileOldestAt, r.t);
      if (mine) {
        contactFiles += r.files;
        contactFileOldestAt = minOf(contactFileOldestAt, r.t);
      }
    }
  }
  return {
    contactMessages,
    messages: rows.length,
    contactFiles,
    files,
    bytes,
    contactOldestAt,
    oldestAt,
    contactFileOldestAt,
    fileOldestAt,
  };
}

/**
 * Records one sent message in the log, in the transaction that stores its envelope, and drops the
 * rows that left the window. Synchronous (07 §3.1).
 */
export function recordOutgoing(
  tx: StoreTx,
  entry: {
    readonly envelopeId: string;
    readonly contact: string;
    readonly now: number;
    readonly files: number;
    readonly bytes: number;
  },
): void {
  tx.delete('outgoing_log', { t: { lte: entry.now - OUTGOING_WINDOW_SECONDS } });
  tx.insert('outgoing_log', {
    envelope_id: entry.envelopeId,
    contact_id: entry.contact,
    t: entry.now,
    files: entry.files,
    bytes: entry.bytes,
  });
}
