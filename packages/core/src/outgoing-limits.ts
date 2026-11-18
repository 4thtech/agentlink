// SEC-OUTBOUND-CAPS (D-156; 06 §3 `outgoing`, 07 §3.2): what this agent sent with `agentlink_send`
// in the rolling 24 h window, read from the store inside the caller's transaction, so the count and
// the stored envelope are one step (two concurrent sends never both pass on the same count).
//
// Counted: outbound envelopes of the `agentlink_send` types (text, note, request, delivery) and the
// file rows they carry. Not counted: acks, receipts, proofs, pairing, card updates, owner-channel and
// terms envelopes. A message the owner deleted still counts until it leaves the window (its row
// stays as a tombstone). Counts and bytes only: nothing here reads a name, a path or a body.
//
// Scope: this protects against a runaway or steered AI using the tools. A process holding the agent
// key can bypass it; the recipient's inbound limit (`contacts.rateLimitPerContactPerHour`) is the
// backstop. The counts are local to one store: a restored backup counts from what it holds.
import { SEND_TOOL_PAYLOAD_TYPES } from '@4thtech-io/types';
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
 * IDs per `in` query: a SQL store binds one parameter per ID, and the Durable Object SQL API allows
 * only a small number of bound parameters per statement, so the file rows are read in chunks.
 */
const IN_CHUNK = 50;

/**
 * The outgoing usage over the window ending at `now` (an entry counts while `created_at > now −
 * 86 400`, as the budget window), for `contact` and in all. Synchronous, inside the caller's
 * transaction (07 §3.1).
 */
export function outgoingUsage(tx: StoreTx, contact: string, now: number): OutgoingUsageDetail {
  const rows = tx.select('envelopes', {
    direction: 'out',
    type: { in: [...SEND_TOOL_PAYLOAD_TYPES] },
    created_at: { gt: now - OUTGOING_WINDOW_SECONDS },
  });
  let contactMessages = 0;
  let contactOldestAt: number | null = null;
  let oldestAt: number | null = null;
  const contactOf = new Map<string, boolean>();
  const createdOf = new Map<string, number>();
  for (const r of rows) {
    const mine = r.contact_id === contact;
    if (mine) {
      contactMessages += 1;
      contactOldestAt = minOf(contactOldestAt, r.created_at);
    }
    oldestAt = minOf(oldestAt, r.created_at);
    contactOf.set(r.envelope_id, mine);
    createdOf.set(r.envelope_id, r.created_at);
  }
  let files = 0;
  let contactFiles = 0;
  let bytes = 0;
  let contactFileOldestAt: number | null = null;
  let fileOldestAt: number | null = null;
  if (contactOf.size > 0) {
    const ids = [...contactOf.keys()];
    const fileRows = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      fileRows.push(...tx.select('files', { envelope_id: { in: ids.slice(i, i + IN_CHUNK) } }));
    }
    for (const f of fileRows) {
      const at = createdOf.get(f.envelope_id) ?? now;
      files += 1;
      bytes += f.size;
      fileOldestAt = minOf(fileOldestAt, at);
      if (contactOf.get(f.envelope_id) === true) {
        contactFiles += 1;
        contactFileOldestAt = minOf(contactFileOldestAt, at);
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
