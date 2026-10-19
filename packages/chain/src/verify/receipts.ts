// Receipt checks for proof-pack verification (05 §3.3, §6; 07 §8; M1-4d-c, D-97).
//
// - `receiptFlagsConsistent`: the D-97 layout. Receipt type `t` (1 DELIVERED, 2 OPENED, 3 ACCEPTED,
//   4 REJECTED) sets bit `t − 1` of `receiptFlags` and stores its time in `receiptAt[t − 1]`. A bit
//   is set exactly when its time is non-zero, bits 4–7 are 0, and ACCEPTED and REJECTED are never
//   both set. Anything else is a record the verifier cannot read (`malformed_record`).
// - `checkReceiptTx`: the `txHash` a pack names for a receipt, checked with one transaction-receipt
//   read (`eth_getTransactionReceipt`), never a log query (some RPCs prune logs, 05 §3.3). It is
//   `confirmed` only when the transaction succeeded and carries the Notary's `ReceiptRecorded` for
//   this record, type, signer and time. `ReceiptSkipped` is never evidence of a receipt (05 §6).
//   A transaction the chain does not show, or a read that fails, is `not_checked`; the receipt
//   itself already stands on `getRecord`, so neither changes the verdict.
import { RECEIPT_TYPES, type ReceiptTypeName } from '@4thtech-io/types';
import { decodeEventLog, type Hex as ViemHex } from 'viem';
import { NOTARY_CLIENT_ABI } from '../clients/calls.js';
import type { Hex } from '../ids/index.js';
import type { VerifyChain } from './verify.js';

/** The four receipt types: bits 0–3. Bits 4–7 must stay 0 (D-97). */
const RECEIPT_BITS = 0b1111;
/** ACCEPTED (type 3, bit 2) and REJECTED (type 4, bit 3). */
const ACCEPTED_AND_REJECTED = 0b1100;

/** The D-97 cross-check of `receiptFlags` against `receiptAt`. */
export function receiptFlagsConsistent(flags: unknown, receiptAt: readonly unknown[]): boolean {
  if (typeof flags !== 'number' || !Number.isInteger(flags) || flags < 0 || flags > 0xff) {
    return false;
  }
  if ((flags & ~RECEIPT_BITS) !== 0) return false;
  if ((flags & ACCEPTED_AND_REJECTED) === ACCEPTED_AND_REJECTED) return false;
  if (receiptAt.length !== 4) return false;
  for (let bit = 0; bit < 4; bit += 1) {
    const at = receiptAt[bit];
    if (typeof at !== 'bigint') return false;
    if ((((flags >> bit) & 1) === 1) !== at > 0n) return false;
  }
  return true;
}

/**
 * What the `txHash` a pack names for a receipt shows:
 * - `confirmed`: that transaction records this receipt (`txHash` is then safe to show and link);
 * - `not_checked`: the pack names none for this receipt, or the chain did not show the transaction
 *   (pruned, unknown or the read failed);
 * - `mismatch`: the transaction does not record this receipt (non-fatal `receipt_tx_mismatch`).
 */
export type ReceiptTx =
  | { readonly status: 'confirmed'; readonly txHash: Hex }
  | { readonly status: 'not_checked' }
  | { readonly status: 'mismatch' };

export const NOT_CHECKED: ReceiptTx = Object.freeze({ status: 'not_checked' });
const MISMATCH: ReceiptTx = Object.freeze({ status: 'mismatch' });

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when `log` is the Notary's `ReceiptRecorded` for exactly this receipt. Never throws. */
function recordsReceipt(
  log: unknown,
  notary: Hex,
  recordId: Hex,
  type: number,
  signer: string,
  at: bigint,
): boolean {
  if (!isObject(log) || typeof log.address !== 'string') return false;
  if (log.address.toLowerCase() !== notary) return false;
  if (!Array.isArray(log.topics) || typeof log.data !== 'string') return false;
  try {
    const event = decodeEventLog({
      abi: NOTARY_CLIENT_ABI,
      topics: log.topics as [ViemHex, ...ViemHex[]],
      data: log.data as ViemHex,
      strict: true,
    });
    if (event.eventName !== 'ReceiptRecorded') return false;
    const args = event.args as {
      recordId: string;
      receiptType: number;
      signer: string;
      timestamp: bigint;
    };
    return (
      args.recordId.toLowerCase() === recordId &&
      args.receiptType === type &&
      args.signer.toLowerCase() === signer &&
      args.timestamp === at
    );
  } catch {
    return false;
  }
}

/**
 * Checks the `txHash` a pack names for one receipt the chain holds (`at`: its `receiptAt`, in
 * seconds). One `eth_getTransactionReceipt` through the caller's address-checked read client.
 * Never throws; the pack's hash is returned only when the transaction confirms the receipt.
 */
export async function checkReceiptTx(
  chain: VerifyChain,
  notary: Hex,
  recordId: Hex,
  claimed: { readonly type: ReceiptTypeName; readonly signer: string; readonly txHash: string },
  at: bigint,
): Promise<ReceiptTx> {
  let answer: unknown;
  try {
    answer = await chain.client.request({
      method: 'eth_getTransactionReceipt',
      params: [claimed.txHash as ViemHex],
    });
  } catch {
    // The chain could not be asked: the receipt stands on getRecord, the link is not checked.
    return NOT_CHECKED;
  }
  if (answer === null || answer === undefined) return NOT_CHECKED;
  // An answer that is not a transaction receipt is the RPC's fault, not the pack's.
  if (!isObject(answer) || (answer.status !== '0x1' && answer.status !== '0x0')) return NOT_CHECKED;
  if (answer.status === '0x0') return MISMATCH;
  if (!Array.isArray(answer.logs)) return NOT_CHECKED;
  const type = RECEIPT_TYPES[claimed.type];
  const found = answer.logs.some((log) =>
    recordsReceipt(log, notary, recordId, type, claimed.signer, at),
  );
  return found ? Object.freeze({ status: 'confirmed', txHash: claimed.txHash as Hex }) : MISMATCH;
}
