// 04 §3.6 pairing proof, with the byte-exact input of the spec:
//   proofKey = HKDF-SHA256(ikm = invite secret (32 raw bytes), salt = "", info = "agentlink/v1/pairing-proof", 32)
//   proof    = HMAC-SHA256(proofKey, utf8("agentlink-handshake") ‖ inviteId (16 raw bytes) ‖ sha256(JCS(B's card)))
// The raw secret is never an HMAC key. HMAC and HKDF are @noble/hashes (I-8). B derives proofKey from
// the invite link; A keeps only proofKey (07 §3) and verifies in constant time. These take no
// long-term key, so they are in the main entry; proofKey still answers one invite and must be stored
// encrypted (04 §3.6).
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { agentCardJcsHash } from './agent-card.js';
import { assertBytes, concatBytes, equalBytes } from './bytes.js';
import { encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { hkdfSha256 } from './hkdf.js';

/** HKDF info for proofKey (04 §3.6). */
export const PAIRING_PROOF_INFO = 'agentlink/v1/pairing-proof';
/** The 19-byte label that starts the proof message (04 §3.6). */
export const PAIRING_HANDSHAKE_LABEL = 'agentlink-handshake';
export const INVITE_SECRET_LENGTH = 32;
export const INVITE_ID_LENGTH = 16;
export const PAIRING_PROOF_LENGTH = 32;

function assertLength(value: Uint8Array, length: number, what: string): void {
  assertBytes(value, what);
  if (value.length !== length) {
    throw new CryptoInputError('invalid_length', `${what} must be ${String(length)} bytes`);
  }
}

/** HMAC-SHA256 (RFC 2104). The caller owns and wipes the key and the result. */
export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  assertBytes(key, 'hmacSha256: key');
  assertBytes(data, 'hmacSha256: data');
  return hmac(nobleSha256, key, data);
}

/** proofKey from the invite's 32-byte secret. A stores this, never the secret; wipe both when done. */
export function derivePairingProofKey(inviteSecret: Uint8Array): Uint8Array {
  assertLength(inviteSecret, INVITE_SECRET_LENGTH, 'derivePairingProofKey: secret');
  return hkdfSha256(inviteSecret, new Uint8Array(0), encodeUtf8(PAIRING_PROOF_INFO), 32);
}

/**
 * The 32-byte `proof` for B's card (card JSON form, parsed strictly: a non-canonical card is
 * refused with `invalid_card`). Sent as base64url (43 characters).
 */
export function pairingProof(
  proofKey: Uint8Array,
  inviteId: Uint8Array,
  card: unknown,
): Uint8Array {
  assertLength(proofKey, 32, 'pairingProof: proofKey');
  assertLength(inviteId, INVITE_ID_LENGTH, 'pairingProof: inviteId');
  const message = concatBytes(
    encodeUtf8(PAIRING_HANDSHAKE_LABEL),
    inviteId,
    agentCardJcsHash(card),
  );
  return hmacSha256(proofKey, message);
}

/**
 * A's check: recomputes the proof with the stored proofKey and compares in constant time. A proof
 * of any length other than 32 bytes is false; a malformed proofKey, inviteId or card throws.
 */
export function verifyPairingProof(
  proofKey: Uint8Array,
  inviteId: Uint8Array,
  card: unknown,
  proof: Uint8Array,
): boolean {
  assertBytes(proof, 'verifyPairingProof: proof');
  const expected = pairingProof(proofKey, inviteId, card);
  return proof.length === PAIRING_PROOF_LENGTH && equalBytes(expected, proof);
}
