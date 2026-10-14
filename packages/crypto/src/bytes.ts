import { CryptoInputError } from './errors.js';

/** Throws unless `value` is a Uint8Array (or a subclass such as Node's Buffer). */
export function assertBytes(value: unknown, what: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new CryptoInputError('invalid_argument', `${what} must be a Uint8Array`);
  }
}

/**
 * Compares two byte arrays without an early exit on the first difference, so the time taken does
 * not depend on where they differ. Use it for every comparison of secret or authenticating values
 * (MACs, proofs, key fingerprints).
 *
 * Lengths are treated as public: arrays of different lengths return false at once.
 *
 * Limit: this is best effort. JavaScript gives no constant-time guarantee; a JIT may in principle
 * transform the loop. It removes the obvious data-dependent branch, which is what is achievable here.
 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  assertBytes(a, 'equalBytes: a');
  assertBytes(b, 'equalBytes: b');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Concatenates byte arrays into a new array; the inputs are not modified or retained. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    assertBytes(part, 'concatBytes: every part');
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
