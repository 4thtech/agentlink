// Delivery receipt requests (M1-33d; D-109; 04 §3.4 "Receipt request", 06 §2.2, §2.4, §3).
//
// Sender side: when the user asked for a delivery receipt (`requestReceipt` on `agentlink_notarize`
// or `agentlink_send` with `notarize`), the core keeps a marker row next to the signed Record, in
// the transaction that stores the Record. The `proof` envelope then carries
// `receiptRequest: "delivered"`; a replacement Record keeps it (the marker is per envelope). The
// marker never enters the signed item, so nothing about the request reaches the submitter.
//
// Recipient side: a checked `proof` body's request is stored with the received record as a flag.
// It never signs anything (I-4): DELIVERED is signed only by policy (`receipts.autoDelivered`) or by
// the user's `agentlink_acknowledge {type: "delivered"}`. The inbox item says the sender asked
// while the record has no DELIVERED receipt. The flag is the sender's content (I-5): it is a
// boolean here and never text in a summary.
import { parseJson } from '@4thtech-io/crypto';
import type { StoreTx } from '../store/store.js';

/** The `proofs` row status of the sender's marker, keyed `request:<envelope id>`. */
export const RECEIPT_REQUEST = 'receipt_request';
const RECEIPT_REQUEST_PREFIX = 'request:';
/** The DELIVERED receipt type code (05 §3.2). */
const DELIVERED = 1;

export const receiptRequestKey = (envelopeId: string): string =>
  `${RECEIPT_REQUEST_PREFIX}${envelopeId}`;

/** True when this agent asked for a delivery receipt for its own envelope. */
export function senderRequestedTx(tx: StoreTx, envelopeId: string): boolean {
  const row = tx.get('proofs', { record_id: receiptRequestKey(envelopeId) });
  return row?.status === RECEIPT_REQUEST && row.envelope_id === envelopeId;
}

/**
 * The envelopes among `envelopeIds` for which a contact's checked record of the received envelope
 * carries the sender's request and this agent has signed no DELIVERED receipt for it (06 §2.2
 * `receiptRequested`). One select of the received records and one of their DELIVERED receipts, so
 * an inbox page reads it once, not once per item (M1-33d-b).
 */
export function receiptRequestedSetTx(
  tx: StoreTx,
  envelopeIds: readonly string[],
): ReadonlySet<string> {
  const out = new Set<string>();
  if (envelopeIds.length === 0) return out;
  const asking: { readonly recordId: string; readonly envelopeId: string }[] = [];
  for (const row of tx.select('proofs', {
    envelope_id: { in: [...envelopeIds] },
    status: 'received',
  })) {
    let item: unknown;
    try {
      item = parseJson(row.record_json);
    } catch {
      continue;
    }
    if ((item as { receiptRequest?: unknown } | null)?.receiptRequest !== 'delivered') continue;
    asking.push({ recordId: row.record_id, envelopeId: row.envelope_id });
  }
  if (asking.length === 0) return out;
  const signed = new Set(
    tx
      .select('receipts', { record_id: { in: asking.map((r) => r.recordId) }, type: DELIVERED })
      .map((r) => r.record_id),
  );
  for (const { recordId, envelopeId } of asking) {
    if (!signed.has(recordId)) out.add(envelopeId);
  }
  return out;
}
