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
 *
 * Every buffer is attempted, whatever happens to the others (IR-M1-1a-1 L-2). Afterwards:
 * - if any `fill` threw (for example on a detached ArrayBuffer), a `wipe_failed` error is thrown
 *   whose `cause` is an AggregateError holding each failure;
 * - otherwise, if an argument was not a Uint8Array, an `invalid_argument` error is thrown.
 */
export function wipe(...buffers: readonly (Uint8Array | null | undefined)[]): void {
  // One bad buffer must not leave the other secrets in memory: attempt all, report afterwards.
  let refused = false;
  const failures: unknown[] = [];
  for (const buffer of buffers) {
    if (buffer === null || buffer === undefined) continue;
    if (!(buffer instanceof Uint8Array)) {
      refused = true;
      continue;
    }
    try {
      buffer.fill(0);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new CryptoInputError('wipe_failed', 'wipe: at least one buffer could not be wiped', {
      cause: new AggregateError(failures, 'wipe: buffers that could not be wiped'),
    });
  }
  if (refused) {
    throw new CryptoInputError('invalid_argument', 'wipe: only a Uint8Array can be wiped');
  }
}
