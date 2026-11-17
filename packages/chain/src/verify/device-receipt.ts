// Automatic device receipts in a proof pack (07 §8 "Automatic device receipts"; 02 F-23; 04 §3.4;
// SEC-RECEIPTS-DEFAULT, D-156).
//
// The contact's signed "received" ack v2, carried by the sender's pack. It is not an on-chain
// receipt and never counts as one: the verifier reports each entry on its own, beside `receipts`,
// labelled DEVICE_RECEIPT_LABEL, and a failing entry never changes the record's verdict. Each entry
// is checked fail closed, in order; any failure is the fixed code `device_receipt_invalid`:
//   1. the strict entry (envelope, 32-byte content key, card with `cardSig`);
//   2. the card's `cardSig` by its `ownerEvm` (04 §2.4), owner and agent keys distinct (04 §2.9);
//      with a disclosed recipient, the card's `agentEvm` is that recipient;
//   3. the ack envelope's signature under its `from`, which must be the card's `agentNostr`, and
//      the card in force at the ack's `createdAt`;
//   4. the key commitment and the decryption with the carried content key (04 §3.3);
//   5. the strict v2 body: `{kind: "received", envelopeId, envelopeHash, recordId?}` with
//      `replyTo` equal to `envelopeId` and `envelopeHash` equal to the pack's.
// All crypto is @4thtech-io/crypto's (I-8). The content key and plaintext are wiped when done.
// Nothing of an entry reaches an error (I-5).
import {
  checkKeyCommitment,
  decodeBase64url,
  decodeUtf8,
  decryptPayload,
  parseEnvelope,
  parseJson,
  verifyCardOwnerSig,
  verifyEnvelope,
  wipe,
  type Envelope,
} from '@4thtech-io/crypto';
import {
  DEVICE_RECEIPT_LABEL,
  payloadSchema,
  proofPackDeviceReceiptSchema,
} from '@4thtech-io/types';

export const DEVICE_RECEIPT_FAILURES = Object.freeze(['device_receipt_invalid'] as const);

export type DeviceReceiptFailure = (typeof DEVICE_RECEIPT_FAILURES)[number];

export type DeviceReceiptCheck =
  | {
      readonly ok: true;
      readonly label: typeof DEVICE_RECEIPT_LABEL;
      /** The contact's agent ID from its verified card: whose AI received the envelope. */
      readonly agentEvm: string;
      /** The card's owner, who signed it. */
      readonly ownerEvm: string;
      /** The ack's `createdAt`, unix seconds, chosen by the contact's AI. */
      readonly at: number;
    }
  | { readonly ok: false; readonly reason: DeviceReceiptFailure };

const INVALID: DeviceReceiptCheck = Object.freeze({
  ok: false as const,
  reason: 'device_receipt_invalid' as const,
});

const HASH = /^0x[0-9a-f]{64}$/;
const V2_KEYS = new Set(['kind', 'envelopeId', 'envelopeHash', 'recordId']);

/**
 * Checks one pack `deviceReceipts` entry against the pack's `envelopeHash` (`0x` + 64 lowercase
 * hex) and, when the pack discloses it, the recipient's EVM address. Never throws.
 */
export async function checkDeviceReceipt(
  value: unknown,
  packEnvelopeHash: string,
  recipientEvm: string | null = null,
): Promise<DeviceReceiptCheck> {
  const entry = proofPackDeviceReceiptSchema.safeParse(value);
  if (!entry.success || !HASH.test(packEnvelopeHash)) return INVALID;
  const { agentCard: card, cardSig } = entry.data.card;
  try {
    if (card.ownerEvm === card.agentEvm || !verifyCardOwnerSig(card, cardSig)) return INVALID;
  } catch {
    return INVALID;
  }
  if (recipientEvm !== null && card.agentEvm !== recipientEvm) return INVALID;
  let envelope: Envelope;
  try {
    envelope = parseEnvelope(entry.data.envelope);
  } catch {
    return INVALID;
  }
  if (!verifyEnvelope(envelope) || `0x${envelope.from}` !== card.agentNostr) return INVALID;
  // The card was in force when the ack was made (`expiresAt` 0 is no expiry).
  if (card.expiresAt !== 0 && card.expiresAt <= envelope.createdAt) return INVALID;
  let cek: Uint8Array;
  try {
    cek = decodeBase64url(entry.data.contentKey, { length: 32 });
  } catch {
    return INVALID;
  }
  let plaintext: Uint8Array | undefined;
  try {
    if (!checkKeyCommitment(envelope, cek)) return INVALID;
    plaintext = await decryptPayload(envelope, cek);
    const parsed = payloadSchema.safeParse(parseJson(decodeUtf8(plaintext)));
    if (!parsed.success || parsed.data.type !== 'ack') return INVALID;
    const { body, replyTo } = parsed.data;
    if (typeof body !== 'object' || body === null) return INVALID;
    const b = body as Record<string, unknown>;
    if (
      !Object.keys(b).every((k) => V2_KEYS.has(k)) ||
      b['kind'] !== 'received' ||
      typeof b['envelopeId'] !== 'string' ||
      b['envelopeId'] !== replyTo ||
      b['envelopeHash'] !== packEnvelopeHash ||
      (b['recordId'] !== undefined &&
        (typeof b['recordId'] !== 'string' || !HASH.test(b['recordId'])))
    ) {
      return INVALID;
    }
    return Object.freeze({
      ok: true as const,
      label: DEVICE_RECEIPT_LABEL,
      agentEvm: card.agentEvm,
      ownerEvm: card.ownerEvm,
      at: envelope.createdAt,
    });
  } catch {
    return INVALID;
  } finally {
    wipe(cek);
    if (plaintext) wipe(plaintext);
  }
}
