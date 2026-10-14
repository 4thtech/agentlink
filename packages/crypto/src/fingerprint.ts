// Owner and agent fingerprints (04 §2.9, G-23). Display strings: they tell contacts apart and do
// not authenticate (only the safety code, a Registry registration or a verified domain does). No
// input field accepts them, so §2.4.1 does not apply to their text forms.
import { assertBytes, concatBytes } from './bytes.js';
import { encodeHex } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { TAGS, taggedHash } from './hash.js';

/**
 * - `short`: first 4 bytes, 8 upper-case hex digits in two groups joined by U+00B7 (default views).
 * - `extended`: first 8 bytes in four groups, shown when two entries share a short form.
 * - `long`: all 32 bytes as 64 upper-case hex digits (Advanced).
 * - `domainClaim`: the long form in lower case, the `fp` of a domain claim (04 §2.7).
 */
export type FingerprintForm = 'short' | 'extended' | 'long' | 'domainClaim';

function assertLength(value: unknown, length: number, what: string): asserts value is Uint8Array {
  assertBytes(value, what);
  if (value.length !== length) {
    throw new CryptoInputError('invalid_length', `${what} has the wrong byte length`);
  }
}

/** taggedHash(TAGS.ownerFingerprint, ownerEvm ‖ ownerNostr ‖ ownerEnc), raw 20, 32 and 32 bytes. */
export function ownerFingerprint(
  ownerEvm: Uint8Array,
  ownerNostr: Uint8Array,
  ownerEnc: Uint8Array,
): Uint8Array {
  assertLength(ownerEvm, 20, 'ownerFingerprint: ownerEvm');
  assertLength(ownerNostr, 32, 'ownerFingerprint: ownerNostr');
  assertLength(ownerEnc, 32, 'ownerFingerprint: ownerEnc');
  return taggedHash(TAGS.ownerFingerprint, concatBytes(ownerEvm, ownerNostr, ownerEnc));
}

/** taggedHash(TAGS.agentFingerprint, agentId) over the raw 20-byte address. */
export function agentFingerprint(agentId: Uint8Array): Uint8Array {
  assertLength(agentId, 20, 'agentFingerprint: agentId');
  return taggedHash(TAGS.agentFingerprint, agentId);
}

function groups(hex: string): string {
  return (hex.match(/.{4}/g) ?? []).join('·');
}

/** A 32-byte fingerprint digest as one of the display forms of 04 §2.9. */
export function formatFingerprint(digest: Uint8Array, form: FingerprintForm): string {
  assertLength(digest, 32, 'formatFingerprint: digest');
  switch (form) {
    case 'short':
      return groups(encodeHex(digest.subarray(0, 4)).toUpperCase());
    case 'extended':
      return groups(encodeHex(digest.subarray(0, 8)).toUpperCase());
    case 'long':
      return encodeHex(digest).toUpperCase();
    case 'domainClaim':
      return encodeHex(digest);
    default:
      throw new CryptoInputError('invalid_argument', 'formatFingerprint: unknown form');
  }
}
