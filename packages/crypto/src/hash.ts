// Hashing (04 §3.1, §2.5.1). The primitives come from @noble/hashes (audited, on the 04 §8.1
// allowlist); nothing here implements a hash function (I-8).
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { keccak_256 as nobleKeccak256 } from '@noble/hashes/sha3.js';
import { assertBytes } from './bytes.js';
import { CryptoInputError } from './errors.js';
import { encodeUtf8 } from './encoding.js';

/**
 * The BIP-340 tags of the protocol. Each signing context has its own tag, so a signature in one
 * context is never valid in another, nor as a Nostr event signature.
 */
export const TAGS = {
  /** 04 §3.1: envelope `sig` is BIP-340 over taggedHash(TAGS.envelope, envelopeHash). */
  envelope: 'agentlink/envelope/v1',
  /** 04 §2.5.1: owner-action `sig` is BIP-340 over taggedHash(TAGS.ownerAction, sha256(JCS(...))). */
  ownerAction: 'agentlink/owner-action/v1',
} as const;

/** SHA-256 (FIPS 180-4). */
export function sha256(data: Uint8Array): Uint8Array {
  assertBytes(data, 'sha256: data');
  return nobleSha256(data);
}

/** Keccak-256 as Ethereum uses it (original Keccak padding, not FIPS 202 SHA3-256). */
export function keccak256(data: Uint8Array): Uint8Array {
  assertBytes(data, 'keccak256: data');
  return nobleKeccak256(data);
}

/**
 * BIP-340 tagged hash: sha256(sha256(tag) || sha256(tag) || message), with the tag hashed as its
 * exact UTF-8 bytes. Use the constants in TAGS for protocol signatures; any well-formed tag is
 * accepted so that BIP-340's own tags (`BIP0340/challenge`, ...) can be computed too.
 */
export function taggedHash(tag: string, message: Uint8Array): Uint8Array {
  if (typeof tag !== 'string') {
    throw new CryptoInputError('invalid_argument', 'taggedHash: tag must be a string');
  }
  assertBytes(message, 'taggedHash: message');
  const tagHash = nobleSha256(encodeUtf8(tag));
  return nobleSha256.create().update(tagHash).update(tagHash).update(message).digest();
}
