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
  if (typeof expected !== 'object' || expected === null || Array.isArray(expected)) {
    return ['the case has no expected object'];
  }
  const values = expected as Readonly<Record<string, unknown>>;
  const fields = Object.keys(values);
  if (fields.length === 0) return ['the case has no expected fields'];

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { field, actual } of comparisons) {
    if (seen.has(field)) {
      problems.push(`${field}: returned more than once`);
      continue;
    }
    seen.add(field);
    if (!Object.hasOwn(values, field)) {
      problems.push(`${field}: not an expected field of this case`);
      continue;
    }
    const want = values[field];
    if (typeof want !== 'string' || want === '') {
      problems.push(`${field}: the expected value must be a non-empty string`);
    } else if (actual !== want) {
      problems.push(`${field}: expected ${want}, got ${String(actual)}`);
    }
  }
  for (const field of fields) {
    if (!seen.has(field)) problems.push(`${field}: expected but not computed by the suite`);
  }
  return problems;
}
