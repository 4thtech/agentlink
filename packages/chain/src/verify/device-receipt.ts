// The automatic device receipt in a proof pack (07 §8; 02 F-23; SEC-RECEIPTS-DEFAULT, D-156).
//
// The recipient AI's signed "received" ack, carried by the sender's pack under the label
// "automatic device receipt". It is not an on-chain receipt and never counts as one: the verifier
// reports it on its own, beside `receipts`. Checked fail closed, in order:
//   1. the strict pack member (label, envelope, 32-byte content key);
//   2. the envelope's signature under its `from` key (04 §3.1.1 step 4);
//   3. the key commitment and the decryption with the carried content key (04 §3.3);
//   4. the strict payload: an `ack` whose body is `{kind: "received", envelopeId, envelopeHash}`,
//      `replyTo` naming the same ID, and `envelopeHash` equal to the pack's.
// `signer` is the ack's `from` key: it proves which key signed, not whose it is. Attributing it to
// the recipient needs the recipient's card, which the pack does not carry.
// All crypto is @4thtech-io/crypto's (I-8). The content key and plaintext are wiped when done.
import {
  checkKeyCommitment,
  decodeBase64url,
  decodeUtf8,
  decryptPayload,
  parseEnvelope,
  parseJson,
  verifyEnvelope,
  wipe,
  type Envelope,
} from '@4thtech-io/crypto';
import {
  DEVICE_RECEIPT_LABEL,
  payloadSchema,
  proofPackDeviceReceiptSchema,
} from '@4thtech-io/types';

export const DEVICE_RECEIPT_FAILURES = Object.freeze([
  'device_receipt_invalid',
  'device_receipt_signature_invalid',
  'device_receipt_unreadable',
  'device_receipt_mismatch',
] as const);

export type DeviceReceiptFailure = (typeof DEVICE_RECEIPT_FAILURES)[number];

export type DeviceReceiptCheck =
  | {
      readonly ok: true;
      readonly label: typeof DEVICE_RECEIPT_LABEL;
      /** The ack's `from` key (64 lowercase hex) whose signature verified. */
      readonly signer: string;
      /** The ack's `createdAt`, unix seconds, chosen by the recipient's AI. */
      readonly at: number;
    }
  | { readonly ok: false; readonly reason: DeviceReceiptFailure };

const fail = (reason: DeviceReceiptFailure): DeviceReceiptCheck => ({ ok: false, reason });

const HASH = /^0x[0-9a-f]{64}$/;

/**
 * Checks a pack's `deviceReceipt` against the pack's `envelopeHash` (`0x` + 64 lowercase hex).
 * Never throws; the member is untrusted (I-5) and nothing of it reaches an error.
 */
export async function checkDeviceReceipt(
  value: unknown,
  packEnvelopeHash: string,
): Promise<DeviceReceiptCheck> {
  const member = proofPackDeviceReceiptSchema.safeParse(value);
  if (!member.success || !HASH.test(packEnvelopeHash)) return fail('device_receipt_invalid');
  let envelope: Envelope;
  try {
    envelope = parseEnvelope(member.data.envelope);
  } catch {
    return fail('device_receipt_invalid');
  }
  if (!verifyEnvelope(envelope)) return fail('device_receipt_signature_invalid');
  let cek: Uint8Array;
  try {
    cek = decodeBase64url(member.data.contentKey, { length: 32 });
  } catch {
    return fail('device_receipt_invalid');
  }
  let plaintext: Uint8Array | undefined;
  try {
    if (!checkKeyCommitment(envelope, cek)) return fail('device_receipt_unreadable');
    try {
      plaintext = await decryptPayload(envelope, cek);
    } catch {
      return fail('device_receipt_unreadable');
    }
    let parsed: ReturnType<typeof payloadSchema.safeParse>;
    try {
      parsed = payloadSchema.safeParse(parseJson(decodeUtf8(plaintext)));
    } catch {
      return fail('device_receipt_unreadable');
    }
    if (!parsed.success || parsed.data.type !== 'ack') return fail('device_receipt_mismatch');
    const { body, replyTo } = parsed.data;
    if (typeof body !== 'object' || body === null) return fail('device_receipt_mismatch');
    const b = body as Record<string, unknown>;
    if (
      b['kind'] !== 'received' ||
      typeof b['envelopeId'] !== 'string' ||
      b['envelopeId'] !== replyTo ||
      b['envelopeHash'] !== packEnvelopeHash
    ) {
      return fail('device_receipt_mismatch');
    }
    return Object.freeze({
      ok: true as const,
      label: DEVICE_RECEIPT_LABEL,
      signer: envelope.from,
      at: envelope.createdAt,
    });
  } finally {
    wipe(cek);
    if (plaintext) wipe(plaintext);
  }
}
