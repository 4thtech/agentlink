import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collectEntries,
  estimateTokens,
  evaluateBudget,
  checkFileSet,
  KNOWLEDGE_FILES,
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
    expect(entries.map((entry) => entry.path)).toEqual([
      'llms.txt',
      ...KNOWLEDGE_FILES.map((name) => `knowledge/${name}`),
    ]);
    expect(evaluateBudget(entries).level).not.toBe('fail');
  });
});

describe('checkFileSet', () => {
  it('accepts exactly the two knowledge files', () => {
    expect(checkFileSet([...KNOWLEDGE_FILES])).toEqual([]);
    expect(KNOWLEDGE_FILES).toHaveLength(2);
  });

  it('rejects a missing and an extra file', () => {
    const problems = checkFileSet(['agentlink-overview.md', 'README.md']);
    expect(problems.join('\n')).toContain('agentlink-userguide.md is missing');
    expect(problems.join('\n')).toContain('README.md is not allowed');
  });
});
