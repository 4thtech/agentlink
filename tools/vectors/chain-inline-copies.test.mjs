// IR-M1-4a-1 L-1: the @4thtech-io/chain tests carry verbatim copies of vector values, because a
// package may not read test-vectors/ (deps-check). This test may: every hex or decimal literal
// between `// vector-copies:start` and `// vector-copies:end` must equal, byte for byte, a value of
// one of the vector cases that section cites by ID. A regenerated vector file that changes a copied
// value fails here until the copy is updated.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');

const SUITES = ['eip712-proof', 'eip712'].map((suite) =>
  JSON.parse(read(`test-vectors/${suite}/vectors.json`)),
);
const CASES = new Map(SUITES.flatMap((file) => file.cases.map((c) => [c.id, c])));

const FILES = [
  { path: 'packages/chain/src/typed-data/typed-data.test.ts', minLiterals: 30 },
  { path: 'packages/chain/src/ids/ids.test.ts', minLiterals: 4 },
];

/** Every string and number leaf of a case's input and expected values. */
function leaves(value, out = new Set()) {
  if (typeof value === 'string') {
    out.add(value);
    // Expected hashes are stored without `0x`; the copies carry the prefix.
    if (/^[0-9a-f]{64}$/.test(value)) out.add(`0x${value}`);
  } else if (typeof value === 'number') {
    out.add(String(value));
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) leaves(v, out);
  }
  return out;
}

function section(path) {
  const text = read(path);
  const start = text.indexOf('// vector-copies:start');
  const end = text.indexOf('// vector-copies:end');
  if (start < 0 || end < start) throw new Error(`${path}: no vector-copies section`);
  return text.slice(start, end);
}

describe('chain test vector copies equal test-vectors (IR-M1-4a-1 L-1)', () => {
  for (const { path, minLiterals } of FILES) {
    it(path, () => {
      const text = section(path);
      const cited = [...CASES.keys()].filter((id) =>
        new RegExp(`(^|[^a-z0-9-])${id}([^a-z0-9-]|$)`).test(text),
      );
      expect(cited.length).toBeGreaterThan(0);
      const allowed = new Set();
      for (const id of cited) leaves(CASES.get(id), allowed);
      const literals = [
        ...[...text.matchAll(/'(0x[0-9a-f]+|[0-9]+)'/g)].map((m) => m[1]),
        ...[...text.matchAll(/(?<![\w'.x])([0-9]{5,})(?![\w'n])/g)].map((m) => m[1]),
        // bigint literals: compared as their decimal string
        ...[...text.matchAll(/(?<![\w'.x])([0-9]+)n\b/g)].map((m) => m[1]),
      ];
      expect(literals.length).toBeGreaterThanOrEqual(minLiterals);
      const missing = literals.filter((l) => !allowed.has(l));
      expect(missing).toEqual([]);
    });
  }
});
