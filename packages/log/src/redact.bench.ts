// Optional local timings for the redaction worst cases (`pnpm --filter @agentlink/log bench`).
// Not part of `pnpm test` or CI: wall-clock limits are flaky on shared runners, so the tests assert
// deterministic work bounds instead (review-ir-m0-8-1.test.ts, F02 and F08).

import { bench, describe } from 'vitest';
import { redact, redactString } from './redact.js';

const n = 16 * 1024;
const strings: Record<string, string> = {
  'key: chain': 'a:'.repeat(n / 2),
  'key= chain': 'ab='.repeat(Math.floor(n / 3)),
  'quoted pairs': 'a:"'.repeat(Math.floor(n / 3)),
  'data: chain': 'data:'.repeat(Math.floor(n / 5)),
  'hex runs of 63': ('ab'.repeat(31) + 'a ').repeat(Math.floor(n / 64)),
  'hyphen groups': 'abcd-'.repeat(Math.floor(n / 5)),
};

describe('redactString, 16 KiB adversarial strings', () => {
  for (const [name, text] of Object.entries(strings)) bench(name, () => void redactString(text));
});

describe('redact, worst-case records', () => {
  bench(
    '256 KiB of key: chains',
    () => void redact(Array.from({ length: 200 }, () => strings['key: chain'])),
  );
  bench('16K-character key', () => void redact({ ['a_'.repeat(8 * 1024)]: 1 }));
  bench('256-character key of 128 words', () => void redact({ ['a_'.repeat(128)]: 1 }));
  bench('fan-out 5^7 of shared references', () => {
    let node: unknown = { leaf: 1 };
    for (let i = 0; i < 7; i += 1) node = [node, node, node, node, node];
    redact(node);
  });
});
