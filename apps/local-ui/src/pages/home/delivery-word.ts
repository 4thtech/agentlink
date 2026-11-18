// SEC-RECEIPTS-DEFAULT (11 §5; 02 F-23; D-156): the words for a message your AI sent.
//
// - `receipt`: the contact's AI signed a receipt over this exact message (a v2 ack bound to its
//   content hash). The only state that reads as received or delivered.
// - `receivedOlder`: only an older app's receipt (it names the message, not its content): shown as
//   weaker, and never enough for a message sent with proof.
// - A message sent with proof never reads as delivered without the signed receipt.
// - `availability: unknown` (SEC-RELAY-READBACK, D-156 (7)): the relays took it but none could be
//   asked to hand it back: "Sent, availability unknown" until a signed receipt arrives.
import type { MessageItem } from '../messages/api.js';
import { HOME_STRINGS as S, fmt } from './people-strings.js';

type Item = Pick<MessageItem, 'status' | 'receipt' | 'receivedOlder' | 'proof'> &
  Partial<Pick<MessageItem, 'availability' | 'relays'>>;

/** The delivery word under a sent message. */
export function sentWord(item: Item, name: string): string {
  // A signed receipt proves the contact's AI has it, whatever the relays said (SEC-RELAY-READBACK).
  if (item.receipt) return fmt(item.proof ? S.proofDelivered : S.receivedBy, { name });
  if (item.status === 'queued') return S.waitingToSend;
  if (item.status === 'not_delivered') return S.notDelivered;
  if (item.availability === 'unknown') return S.sentAvailabilityUnknown;
  if (item.proof) return S.sentNoReceipt;
  if (item.receivedOlder === true) return S.receivedOlder;
  return S.sent;
}

/** The receipt line under the hood (the 11 §5.10 status detail). */
export function receiptWord(item: Item, name: string): string {
  if (item.status === 'queued') return S.receiptPending;
  if (item.receipt) return fmt(item.proof ? S.proofDelivered : S.receivedByDetail, { name });
  if (item.proof) return S.sentNoReceipt;
  if (item.receivedOlder === true) return S.receivedOlder;
  return S.receiptNo;
}

/**
 * DELIVERY-DETAILS: the relays line of a sent message, e.g. "Message network: accepted by 3,
 * available from 2"; "Sent, availability unknown" when no relay could be asked; nothing when the counts were not
 * kept (a message sent before) or the message is not sent.
 */
export function relaysWord(item: Item): string | undefined {
  if (item.status !== 'sent' || item.relays === undefined) return undefined;
  const { accepted, available } = item.relays;
  if (item.availability === 'unknown' || available === 0) return S.sentAvailabilityUnknown;
  return fmt(S.relayDetails, { accepted, available });
}

/**
 * RESTORE-TRACES (D-156; 11 §5): the quiet label "From before the restore" under a message from the
 * other side that was sent before a restore and arrived after it. Undefined otherwise.
 */
export function receivedAgainWord(
  item: Partial<Pick<MessageItem, 'receivedAgain'>>,
  out: boolean,
): string | undefined {
  return !out && item.receivedAgain === true ? S.receivedAgain : undefined;
}
