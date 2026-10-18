// Suite `ucd15-table` (M1-21-b, D-74): the pinned UCD 15.0.0 refused-category table that
// @4thtech-io/types ships for the `terms` character rule (04 §3.4 "Characters"), checked in every
// runtime that loads it, through its public lookup `refusedCategory15`. `tableHash` serializes the
// table in the canonical form the generator defines (tools/vectors/generate_ucd15_table.py: the line
// `agentlink/ucd15-refused/v1`, then `FIRST..LAST;Cat` per maximal run in upper-case hex of at least
// four digits, each line ending in LF) and hashes it with @4thtech-io/crypto's SHA-256;
// `categoryCounts` counts the code points per category (an unexpected category adds a field and so
// fails); `category` looks one code point up. Nothing here supplies an expected value.
import { sha256 } from '@4thtech-io/crypto';
import { refusedCategory15 } from '@4thtech-io/types';
import { bytesToHex } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

const SERIALIZATION_TAG = 'agentlink/ucd15-refused/v1';
// The order of the case's expected fields; a category missing from the table still reports 0.
const REFUSED = ['Cc', 'Cf', 'Zl', 'Zp', 'Co', 'Cs', 'Cn'] as const;

interface Range {
  readonly first: number;
  readonly last: number;
  readonly category: string;
}

// The shipped table as seen through its public lookup: maximal runs of one refused category over the
// whole code space, so the hash covers `refusedCategory15` itself, not only the raw ranges.
function shippedRanges(): Range[] {
  const out: Range[] = [];
  let open: { first: number; last: number; category: string } | null = null;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const category = refusedCategory15(cp);
    if (open !== null && category === open.category && open.last === cp - 1) {
      open.last = cp;
      continue;
    }
    if (open !== null) out.push(open);
    open = category === null ? null : { first: cp, last: cp, category };
  }
  if (open !== null) out.push(open);
  return out;
}

const hex4 = (cp: number): string => cp.toString(16).toUpperCase().padStart(4, '0');

function tableHash(): Comparison[] {
  const ranges = shippedRanges();
  const text =
    [
      SERIALIZATION_TAG,
      ...ranges.map((r) => `${hex4(r.first)}..${hex4(r.last)};${r.category}`),
    ].join('\n') + '\n';
  return [
    { field: 'hash', actual: bytesToHex(sha256(new TextEncoder().encode(text))) },
    { field: 'runs', actual: String(ranges.length) },
  ];
}

function categoryCounts(): Comparison[] {
  const counts = new Map<string, number>(REFUSED.map((c) => [c, 0]));
  for (const r of shippedRanges()) {
    counts.set(r.category, (counts.get(r.category) ?? 0) + (r.last - r.first + 1));
  }
  return [...counts].map(([field, n]) => ({ field, actual: String(n) }));
}

export const ucd15Table: SuiteModule = {
  evaluate(testCase) {
    const input = testCase.input as { op?: unknown; codePoint?: unknown } | null;
    switch (input?.op) {
      case 'tableHash':
        return Promise.resolve(tableHash());
      case 'categoryCounts':
        return Promise.resolve(categoryCounts());
      case 'category': {
        if (typeof input.codePoint !== 'number') {
          throw new TypeError('ucd15-table: category needs an integer codePoint');
        }
        const category = refusedCategory15(input.codePoint);
        return Promise.resolve([{ field: 'category', actual: category ?? 'none' }]);
      }
      default:
        throw new TypeError('ucd15-table: input does not match case.schema.json');
    }
  },
};
