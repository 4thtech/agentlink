// HKDF-SHA256 (RFC 5869), the KDF of 04 §2.1 and §2.3. The primitive is @noble/hashes (04 §8.1);
// nothing here implements it (I-8).
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { assertBytes } from './bytes.js';
import { CryptoInputError } from './errors.js';

/** RFC 5869 §2.3: L <= 255 * HashLen. */
export const HKDF_SHA256_MAX_LENGTH = 255 * 32;

/**
 * HKDF-SHA256 extract-then-expand. An empty `salt` is the RFC's "not provided" (HMAC pads the key
 * with zeros, so it equals HashLen zero bytes). The library wipes its intermediate PRK; the caller
 * owns `ikm` and the returned key and wipes them (`wipe`) when done.
 */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  assertBytes(ikm, 'hkdfSha256: ikm');
  assertBytes(salt, 'hkdfSha256: salt');
  assertBytes(info, 'hkdfSha256: info');
  if (!Number.isSafeInteger(length) || length < 1 || length > HKDF_SHA256_MAX_LENGTH) {
    throw new CryptoInputError(
      'invalid_argument',
      'hkdfSha256: length must be an integer from 1 to 8160',
    );
  }
  return hkdf(sha256, ikm, salt, info, length);
}
