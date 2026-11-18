// DOCS-COMPACT-A: tests for check-public-wording.mjs.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findInternal, publicPages } from './check-public-wording.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('findInternal', () => {
  it('finds the internal markers, but not inside code', () => {
    const text = [
      `Terms of service: ${['DECISION', 'NEEDED'].join(' ')} (owner).`,
      'Limits (proposed): 100 MB.',
      'Rule 3 (D-145; proposed, owner confirms at merge).',
      'Fixed in review IR-UPD-8-1 #9.',
      'Stopped by DEPLOY_FREEZE.',
      'Plain sentence about a proposed change.',
      '`IR-X-1` in code is fine.',
      '```',
      'DEPLOY_FREEZE=true',
      '```',
    ].join('\n');
    expect(findInternal(text).map((p) => p.split(':')[0])).toEqual(['1', '2', '3', '3', '4', '5']);
  });
});

describe('the repository', () => {
  it('has no internal annotation on any public page', () => {
    const problems = publicPages(root).flatMap((rel) =>
      findInternal(readFileSync(join(root, rel), 'utf8')).map((p) => `${rel}:${p}`),
    );
    expect(problems).toEqual([]);
  });
});
