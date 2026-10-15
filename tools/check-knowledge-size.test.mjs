import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collectEntries,
  estimateTokens,
  evaluateBudget,
  MAX_TOKENS,
  TARGET_TOKENS,
} from './check-knowledge-size.mjs';

describe('estimateTokens', () => {
  it('is bytes / 4 rounded up', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
  });
});

describe('evaluateBudget', () => {
  const at = (tokens) => [{ path: 'a.md', bytes: tokens * 4 }];

  it('is ok up to and including the target', () => {
    expect(evaluateBudget(at(TARGET_TOKENS)).level).toBe('ok');
  });

  it('warns above the target, up to and including the hard max', () => {
    expect(evaluateBudget(at(TARGET_TOKENS + 1)).level).toBe('warn');
    expect(evaluateBudget(at(MAX_TOKENS)).level).toBe('warn');
  });

  it('fails above the hard max', () => {
    expect(evaluateBudget(at(MAX_TOKENS + 1)).level).toBe('fail');
  });

  it('sums the files and reports each one', () => {
    const result = evaluateBudget([
      { path: 'a.md', bytes: 40 },
      { path: 'b.md', bytes: 41 },
    ]);
    expect(result.files).toEqual([
      { path: 'a.md', tokens: 10 },
      { path: 'b.md', tokens: 11 },
    ]);
    expect(result.total).toBe(21);
  });
});

describe('the committed knowledge base', () => {
  it('lists llms.txt and the knowledge files and stays under the hard max', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const entries = collectEntries(root);
    expect(entries[0].path).toBe('llms.txt');
    expect(entries.some((entry) => entry.path === 'knowledge/README.md')).toBe(true);
    expect(evaluateBudget(entries).level).not.toBe('fail');
  });
});
