// M1-33b (D-109, 11 §5.6): what a proof makes public, as lines for summaries and approval cards.
// Everything here is a catalogue key; the only slots are the name-rule contact name and one of three
// fixed receipt words. No inbound content reaches any of it (I-5): the receipt word is looked up in
// a fixed table, so an unknown value from a stored action yields no line.
import { copy } from './index.js';

const RECEIPT_WORDS: Readonly<Record<string, string>> = Object.freeze({
  opened: 'opened',
  accepted: 'accepted',
  rejected: 'rejected',
});

/** The "first proof / every approval that adds proof" lines (receipt line never dropped). */
export function proofLines(contactName?: string): string[] {
  return [
    copy('common.privacy.proof'),
    contactName === undefined
      ? copy('common.privacy.proofReceiptGeneric')
      : copy('common.privacy.proofReceipt', { contactName }),
  ];
}

/** The same as one line, for a tool summary (tool text is one line, 06 §1). */
export const proofDisclosure = (contactName?: string): string => proofLines(contactName).join(' ');

/** The line for an opened, accepted or rejected receipt; undefined for any other value. */
export function receiptDisclosure(type: unknown): string | undefined {
  const receipt = typeof type === 'string' ? RECEIPT_WORDS[type] : undefined;
  return receipt === undefined ? undefined : copy('common.privacy.receiptPublic', { receipt });
}

export const exportDisclosure = (): string => copy('common.privacy.export');
export const topUpDisclosure = (): string => copy('common.privacy.topUp');

/** Joins a summary and a disclosure on one line (tool text has no line breaks). */
export const withDisclosure = (summary: string, disclosure: string): string =>
  `${summary} ${disclosure}`;

/**
 * The disclosure lines for one approval card, by the stored action's tool and arguments. `who` is
 * the contact's name under the name rule; `undefined` when the card has no named contact (the
 * receipt line then uses the unnamed form); `null` when there is no recipient (a note to yourself),
 * which drops the receipt line. Empty when the action adds no proof and makes nothing public.
 */
function cardProofLines(who: string | null | undefined): string[] {
  const [first = ''] = proofLines();
  return who === null ? [first] : proofLines(who);
}

export function cardDisclosure(
  tool: string,
  args: Readonly<Record<string, unknown>> | undefined,
  who: string | null | undefined,
): string[] {
  switch (tool) {
    case 'agentlink_notarize':
    case 'agentlink_propose_terms':
    case 'agentlink_respond_to_terms':
      return cardProofLines(who);
    case 'agentlink_send':
      return args?.['notarize'] === true ? cardProofLines(who) : [];
    case 'agentlink_acknowledge': {
      const line = receiptDisclosure(args?.['type']);
      return line === undefined ? [] : [line];
    }
    case 'agentlink_export_proof_pack':
      return [exportDisclosure()];
    default:
      return [];
  }
}
