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
    expect(pathsFor('legacy').securitySpec).toBe('docs/foundation/04-security-and-crypto.md');
    expect(pathsFor('compact').securitySpec).toBe('specs/04-security-and-crypto.md');
    expect(pathsFor('compact').statusPage).toBe('docs/technical/project/status-and-roadmap.md');
    expect(pathsFor('compact').status).toBe('docs/status.yaml');
    expect(() => pathsFor('other')).toThrow(/unknown docs layout/);
  });
});

describe("renamed entries", () => {
  it("maps old-path allowlist entries to the new folders", async () => {
    const { renamedEntry } = await import("./ratchet.mjs");
    expect(renamedEntry("docs/foundation/07-x.md: note")).toBe("specs/07-x.md: note");
    expect(renamedEntry("docs/process/a.md: x")).toBe("project/process/a.md: x");
    expect(renamedEntry("docs-site/guide/a.md: x")).toBe("docs/guide/a.md: x");
    expect(renamedEntry("docs/guide/a.md: x")).toBe("docs/guide/a.md: x");
  });
});

describe('baseIsLegacy', () => {
  it('is true only for a ref that still has docs-site/guide/SUMMARY.md', async () => {
    const { baseIsLegacy } = await import('./ratchet.mjs');
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'ratchet-'));
    const git = (...a) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
    git('init', '-q');
    mkdirSync(join(dir, 'docs-site/guide'), { recursive: true });
    writeFileSync(join(dir, 'docs-site/guide/SUMMARY.md'), 'x');
    git('add', '.');
    git('commit', '-qm', 'legacy');
    git('tag', 'legacy');
    git('rm', '-qr', 'docs-site');
    mkdirSync(join(dir, 'docs/guide'), { recursive: true });
    writeFileSync(join(dir, 'docs/guide/SUMMARY.md'), 'x');
    git('add', '.');
    git('commit', '-qm', 'compact');
    git('tag', 'compact');
    expect(baseIsLegacy(dir, 'legacy')).toBe(true);
    expect(baseIsLegacy(dir, 'compact')).toBe(false);
  });
});
