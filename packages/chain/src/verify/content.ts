// The disclosed-content check of a proof pack, in the 07 §8 order, fail closed (G-46, D-66). Every
// step must pass before the next runs:
//   1. parse the envelope strictly (04 §3.1.1 step 3);
//   2. recompute envelopeHash; it must equal the pack's field and the on-chain Record's hash (the
//      caller has already matched those two to each other and to the chain);
//   3. verify `sig` under `from` with the envelope tag (04 §3.1.1 step 4); with the signer's verified
//      card, `from` must be the card's `agentNostr` (M1-4d-b), else `sender_mismatch`;
//   4. derive `kc` from the 32-byte CEK and compare it with `aead.kc` (04 §3.3);
//   5. decrypt;
//   6. apply the payload's strict schema (04 §3.4); then the D-86 kind check (05 §3.1).
// A failure at any step means the pack proves no content; the record and receipts stand on their own.
// All crypto is @4thtech-io/crypto's (I-8). The CEK and the plaintext are wiped when done.
import {
  checkKeyCommitment,
  decodeBase64url,
  decodeUtf8,
  decryptPayload,
  encodeHex0x,
  envelopeHash,
  parseEnvelope,
  parseJson,
  verifyEnvelope,
  wipe,
  type Envelope,
} from '@4thtech-io/crypto';
import { payloadSchema, type Payload } from '@4thtech-io/types';
import { recordKindForPayload } from './kind.js';
import type { ProofContentFailure } from './reasons.js';

export type ContentCheck =
  /** `sender` is the envelope's `from`, whose signature verified (64 lowercase hex, 04 §3.1). */
  | { readonly ok: true; readonly payload: Payload; readonly sender: string }
  | { readonly ok: false; readonly reason: ProofContentFailure };

const fail = (reason: ProofContentFailure): ContentCheck => ({ ok: false, reason });

/**
 * Checks a disclosed content key against the envelope. `recordedHash` is the envelopeHash that the
 * pack and the on-chain Record agree on; `kind` is the verified Record kind. `cardSender` is the
 * `agentNostr` of the signer's verified card (`0x` + 64 lowercase hex), or null without a card: the
 * envelope's sender must be that key before the content key is used. Never throws.
 */
export async function checkDisclosedContent(
  envelopeValue: unknown,
  contentKey: string,
  recordedHash: string,
  kind: number,
  cardSender: string | null,
): Promise<ContentCheck> {
  let envelope: Envelope;
  try {
    envelope = parseEnvelope(envelopeValue);
  } catch {
    return fail('envelope_invalid');
  }
  if (encodeHex0x(envelopeHash(envelope)) !== recordedHash) return fail('envelope_hash_mismatch');
  if (!verifyEnvelope(envelope)) return fail('envelope_signature_invalid');
  // Both sides are strictly parsed lowercase hex (04 §2.4.1): the envelope's `from` without `0x`,
  // the card's `agentNostr` with it.
  if (cardSender !== null && cardSender !== `0x${envelope.from}`) return fail('sender_mismatch');

  let cek: Uint8Array;
  try {
    cek = decodeBase64url(contentKey, { length: 32 });
  } catch {
    // The parser already refused any other length; unreachable, kept fail-closed.
    return fail('key_commitment_mismatch');
  }
  let plaintext: Uint8Array | undefined;
  try {
    if (!checkKeyCommitment(envelope, cek)) return fail('key_commitment_mismatch');
    try {
      plaintext = await decryptPayload(envelope, cek);
    } catch {
      return fail('decrypt_failed');
    }
    let payload: Payload;
    try {
      const parsed = payloadSchema.safeParse(parseJson(decodeUtf8(plaintext)));
      if (!parsed.success) return fail('payload_invalid');
      payload = parsed.data;
    } catch {
      return fail('payload_invalid');
    }
    if (recordKindForPayload(payload) !== kind) return fail('kind_mismatch');
    return { ok: true, payload, sender: envelope.from };
  } finally {
    wipe(cek);
    if (plaintext) wipe(plaintext);
  }
}
