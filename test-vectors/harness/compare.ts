import type { Comparison } from './suite';

/**
 * Judges a suite's output against the committed vector (IR-M0-9-1 F03). The expected values come
 * only from the vector file, and the suite must return exactly one value for every field of
 * `expected`, no more and no fewer, so a suite can neither echo its own output as "expected" nor
 * skip a field.
 *
 * @returns Problems; empty when every field matches.
 */
export function compareToVector(expected: unknown, comparisons: readonly Comparison[]): string[] {
  // RED (expected): implemented in the next commit.
  void expected;
  void comparisons;
  throw new Error('compareToVector: not implemented yet');
}
