// Best-effort wiping of secret bytes (04 §8.3: "where the platform allows").
import { CryptoInputError } from './errors.js';

/**
 * Overwrites each buffer with zeros, in place (`fill(0)`). Call it on seeds, private keys, CEKs,
 * file keys and plaintext buffers as soon as they are no longer needed, typically in `finally`.
 * `null` and `undefined` are skipped so cleanup code can pass optional buffers; anything else that
 * is not a Uint8Array is refused rather than silently left untouched.
 *
 * Limits: JavaScript cannot guarantee zeroization. This clears only the bytes this view covers.
 * It cannot reach:
 * - copies the engine or garbage collector made (a resized or transferred ArrayBuffer, a
 *   compacting GC's old copy), or copies other code made (a `slice()`, an encoded string);
 * - strings: JS strings are immutable and cannot be wiped, so secrets must stay in bytes;
 * - buffers inside libraries or WebCrypto (a CryptoKey's material, a hash's internal state);
 * - memory already written to swap, a core dump or a hibernation file.
 * Treat it as reducing how long a secret sits in memory, not as erasing it.
 */
export function wipe(...buffers: readonly (Uint8Array | null | undefined)[]): void {
  // Wipe every valid buffer first, then report a bad argument: one mistake must not leave the
  // other secrets in memory.
  let refused = false;
  for (const buffer of buffers) {
    if (buffer === null || buffer === undefined) continue;
    if (buffer instanceof Uint8Array) buffer.fill(0);
    else refused = true;
  }
  if (refused) {
    throw new CryptoInputError('invalid_argument', 'wipe: only a Uint8Array can be wiped');
  }
}
