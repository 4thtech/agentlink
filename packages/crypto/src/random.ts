// Secure randomness. Every runtime we support (Node, browsers, Workers) has WebCrypto's
// getRandomValues on globalThis.crypto, so there is exactly one source and no fallback: with no
// secure source the call fails closed. Math.random is never used.
import { CryptoInputError } from './errors.js';

interface RandomSource {
  getRandomValues(array: Uint8Array): Uint8Array;
}

/** getRandomValues refuses more than 65536 bytes per call (WebCrypto QuotaExceededError). */
const MAX_PER_CALL = 65536;

function secureSource(): RandomSource {
  const source = (globalThis as { crypto?: Partial<RandomSource> }).crypto;
  if (typeof source?.getRandomValues !== 'function') {
    throw new CryptoInputError(
      'no_secure_random',
      'no secure random source: globalThis.crypto.getRandomValues is missing',
    );
  }
  return source as RandomSource;
}

/** `length` bytes from the platform CSPRNG (globalThis.crypto.getRandomValues). */
export function randomBytes(length: number): Uint8Array {
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    throw new CryptoInputError(
      'invalid_argument',
      'randomBytes: length must be a non-negative integer',
    );
  }
  const source = secureSource();
  const out = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += MAX_PER_CALL) {
    source.getRandomValues(out.subarray(offset, Math.min(offset + MAX_PER_CALL, length)));
  }
  return out;
}
