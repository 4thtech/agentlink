// termsHash (04 §3.4, D-32): sha256(JCS(terms)), RFC 8785, as bare 64 lower-case hex (04 §2.4.1:
// it never reaches a Record). The shape and canonical form of `terms` are checked by
// @4thtech-io/types (`termsSchema`) before hashing, on send and on receipt; this helper hashes exactly
// the JSON object it is given and never normalises it.
import { decodeHex, encodeHex } from './encoding.js';
import { equalBytes } from './bytes.js';
import { CryptoInputError } from './errors.js';
import { sha256 } from './hash.js';
import { canonicalizeToBytes } from './jcs.js';

const isPlainObject = (value: unknown): value is object => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

function termsDigest(terms: unknown): Uint8Array {
  if (!isPlainObject(terms)) {
    throw new CryptoInputError('invalid_argument', 'termsHash: terms must be a JSON object');
  }
  return sha256(canonicalizeToBytes(terms));
}

/**
 * `termsHash = sha256(JCS(terms))` as bare 64 lower-case hex (04 §3.4). Throws CryptoInputError for
 * anything that is not a plain JSON object (arrays, cycles, lone surrogates, non-finite numbers…).
 */
export function termsHash(terms: unknown): string {
  return encodeHex(termsDigest(terms));
}

/**
 * True when `expected` is the canonical spelling (bare 64 lower-case hex) of `termsHash(terms)`.
 * Compares bytes; any other spelling, or terms that cannot be hashed, is false. Never throws. An
 * `accept` or `reject` binds the exact terms it answers: the core checks the body's own hash with
 * this and then compares it with the answered offer's `termsHash` (04 §3.4).
 */
export function verifyTermsHash(terms: unknown, expected: unknown): boolean {
  try {
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) return false;
    return equalBytes(termsDigest(terms), decodeHex(expected, { length: 32 }));
  } catch {
    return false;
  }
}
