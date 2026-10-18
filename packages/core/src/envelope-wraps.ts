// Core-side wrap checks for 04 §3.1.1 step 8 and §3.3 (G-46, D-66; IR-M1-1l-1 L-2).
//
// checkWrap (@4thtech-io/crypto) recomputes one entry from the CEK and compares `enc` and `wk`. It
// does not look at `kid`: picking the entry is the caller's job. This helper decodes the base64url
// entry and first asserts that its `kid` is the `kid` of the public key it is checked against
// (sha256(pk)[:16], 04 §3.1), so a wrong pick fails closed instead of comparing the wrong entry.
// Every crypto operation is a call into @4thtech-io/crypto (I-8).
import {
  HPKE_ENC_LENGTH,
  KID_LENGTH,
  WRAPPED_CEK_LENGTH,
  checkWrap,
  decodeBase64url,
  encodeBase64url,
  equalBytes,
  kidFromEncPublicKey,
  type EnvelopeRecipient,
} from '@4thtech-io/crypto';

/** The `kid` of a raw 32-byte X25519 `enc` key, base64url as in an envelope entry (04 §3.1). */
export function kidOf(encPublicKey: Uint8Array): string {
  return encodeBase64url(kidFromEncPublicKey(encPublicKey));
}

/**
 * True only when `entry.kid` is the `kid` of `encPublicKey` and the entry's `enc` and `wk` are byte
 * for byte the wrap of `cek` to that key for this envelope id (04 §3.3). Anything else is false:
 * another key's entry, an entry that does not decode, or a wrap of another CEK. It never throws for
 * bad entry bytes, so the caller treats every failure the same way (a mismatch). The CEK is not
 * modified; the caller wipes it.
 */
export async function checkRecipientWrap(
  encPublicKey: Uint8Array,
  entry: EnvelopeRecipient,
  envelopeId: Uint8Array,
  cek: Uint8Array,
): Promise<boolean> {
  let kid: Uint8Array;
  let enc: Uint8Array;
  let wk: Uint8Array;
  let expectedKid: Uint8Array;
  try {
    kid = decodeBase64url(entry.kid, { length: KID_LENGTH });
    enc = decodeBase64url(entry.enc, { length: HPKE_ENC_LENGTH });
    wk = decodeBase64url(entry.wk, { length: WRAPPED_CEK_LENGTH });
    expectedKid = kidFromEncPublicKey(encPublicKey);
  } catch {
    return false;
  }
  if (!equalBytes(kid, expectedKid)) return false;
  try {
    return await checkWrap(encPublicKey, envelopeId, cek, { enc, wk });
  } catch {
    // A small-order key or a malformed argument: never a pass.
    return false;
  }
}
