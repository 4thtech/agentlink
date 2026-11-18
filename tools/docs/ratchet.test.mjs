// DOCS-COMPACT-A: tests for the shrink-only allowlist helper and the docs paths module.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ratchet, readAllowlist, writeAllowlist } from './ratchet.mjs';
import { CURRENT_LAYOUT, DOCS, LAYOUTS, pathsFor } from './paths.mjs';

describe('ratchet', () => {
  it('fails new misses, stale entries and growth over the base', () => {
    expect(ratchet(['a', 'b'], ['a', 'b'], ['a', 'b', 'c'])).toEqual({
      fresh: [],
      stale: [],
      grown: [],
    });
    expect(ratchet(['a', 'n'], ['a', 'old'], ['a', 'old'])).toEqual({
      fresh: ['n'],
      stale: ['old'],
      grown: [],
    });
    expect(ratchet(['a', 'n'], ['a', 'n'], ['a']).grown).toEqual(['n']);
    expect(ratchet(['a', 'n'], ['a', 'n'], null).grown).toEqual([]);
  });

  it('writes a sorted, deduplicated list and reads it back; no file is an empty list', () => {
    const root = mkdtempSync(join(tmpdir(), 'ratchet-'));
    expect(readAllowlist(root, 'x.json')).toEqual([]);
    writeAllowlist(root, 'x.json', 'note', ['b', 'a', 'b']);
    expect(readAllowlist(root, 'x.json')).toEqual(['a', 'b']);
    expect(JSON.parse(readFileSync(join(root, 'x.json'), 'utf8')).note).toBe('note');
  });
});

describe('paths', () => {
  it('names one layout as current and derives the pages from it', () => {
    expect(Object.keys(LAYOUTS)).toEqual(['legacy', 'compact']);
    expect(DOCS.name).toBe(CURRENT_LAYOUT);
    expect(pathsFor('legacy').securitySpec).toBe('specs/04-security-and-crypto.md');
    expect(pathsFor('compact').securitySpec).toBe('specs/04-security-and-crypto.md');
    expect(pathsFor('compact').statusPage).toBe('docs/technical/project/status-and-roadmap.md');
    expect(pathsFor('compact').status).toBe('docs/status.yaml');
    expect(() => pathsFor('other')).toThrow(/unknown docs layout/);
  });
});
