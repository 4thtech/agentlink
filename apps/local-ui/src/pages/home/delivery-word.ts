// SEC-RECEIPTS-DEFAULT (11 §5; 02 F-23; D-156): the words for a message your AI sent.
//
// - `receipt`: the contact's AI signed a receipt over this exact message (a v2 ack bound to its
//   content hash). The only state that reads as received or delivered.
// - `receivedOlder`: only an older app's receipt (it names the message, not its content): shown as
//   weaker, and never enough for a message sent with proof.
// - A message sent with proof never reads as delivered without the signed receipt.
import type { MessageItem } from '../messages/api.js';
import { HOME_STRINGS as S, fmt } from './people-strings.js';

type Item = Pick<MessageItem, 'status' | 'receipt' | 'receivedOlder' | 'proof'>;

/** The delivery word under a sent message. */
export function sentWord(item: Item, name: string): string {
  if (item.status === 'queued') return S.waitingToSend;
  if (item.status === 'not_delivered') return S.notDelivered;
  if (item.receipt) return fmt(S.receivedBy, { name });
  if (item.proof) return S.sentNoReceipt;
  if (item.receivedOlder === true) return S.receivedOlder;
  return S.sent;
}

/** The receipt line under the hood. */
export function receiptWord(item: Item): string {
  if (item.status === 'queued') return S.receiptPending;
  if (item.receipt) return S.receiptYes;
  if (item.receivedOlder === true && !item.proof) return S.receivedOlder;
  return S.receiptNo;
}
