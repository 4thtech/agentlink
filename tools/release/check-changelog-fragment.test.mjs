import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkChangelogFragment, evaluateChangelog } from './check-changelog-fragment.mjs';

// OPS-REL-4: a user-visible, spec or process PR adds a fragment in changelog.d/ (or, during the
// transition, a line under CHANGELOG.md [Unreleased]); editing [Unreleased] directly only warns.

const nonPr = { headRef: 'feature/x', author: 'talirezun', sameRepo: true };

describe('evaluateChangelog', () => {
  const ev = (paths, extra = {}) =>
    evaluateChangelog({
      changed: paths.map((p) => (typeof p === 'string' ? { status: 'M', path: p } : p)),
      unreleasedAdded: 0,
      pr: nonPr,
      ...extra,
    });

  it('requires an entry for CLI and library source, specs, process docs and AGENTS.md', () => {
    for (const p of [
      'apps/cli/src/index.ts',
      'packages/core/src/a.ts',
      'docs/foundation/06-mcp.md',
      'docs/process/versioning.md',
      'AGENTS.md',
    ]) {
      const r = ev([p]);
      expect(r.ok, p).toBe(false);
      expect(r.errors.join(' ')).toMatch(/changelog\.d/);
    }
  });

  it('needs nothing for tests, backlog cards, CI, lockfiles or tooling', () => {
    for (const p of [
      'packages/core/src/a.test.ts',
      'docs/process/backlog.md',
      '.github/workflows/ci.yml',
      'pnpm-lock.yaml',
      'tools/release/x.mjs',
      'README.md',
    ]) {
      expect(ev([p]).ok, p).toBe(true);
    }
  });

  it('passes with an added fragment or a legacy [Unreleased] line', () => {
    expect(ev(['AGENTS.md', { status: 'A', path: 'changelog.d/OPS-REL-4.md' }]).ok).toBe(true);
    expect(ev(['AGENTS.md', { status: 'A', path: 'changelog.d/M1-1-slug.md' }]).ok).toBe(true);
    expect(ev(['AGENTS.md'], { unreleasedAdded: 1 }).ok).toBe(true);
  });

  it('does not count changelog.d/README.md, nested files or non-markdown files', () => {
    for (const path of ['changelog.d/README.md', 'changelog.d/sub/a.md', 'changelog.d/a.txt']) {
      expect(ev(['AGENTS.md', { status: 'A', path }]).ok, path).toBe(false);
    }
  });

  it('does not count a deleted fragment', () => {
    expect(ev(['AGENTS.md', { status: 'D', path: 'changelog.d/a.md' }]).ok).toBe(false);
  });

  it('warns (does not fail) when CHANGELOG.md is edited directly', () => {
    const r = ev(['CHANGELOG.md'], { unreleasedAdded: 1 });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/fragment/i);
  });

  it('exempts the Version packages PR', () => {
    const r = ev(['CHANGELOG.md', 'docs/process/versioning.md'], {
      pr: { headRef: 'changeset-release/main', author: 'github-actions[bot]', sameRepo: true },
    });
    expect(r).toMatchObject({ ok: true, warnings: [] });
  });
});

describe('checkChangelogFragment on a fixture repository', () => {
  let dir;
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const run = () => checkChangelogFragment({ cwd: dir, base: 'main', pr: nonPr, log: () => {} });
  const commit = () => {
    git('add', '-A');
    git('commit', '-q', '-m', 'change');
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clfrag-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    write('CHANGELOG.md', '# C\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-16\n\n- old\n');
    write('AGENTS.md', 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feature');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fails a process change without an entry', async () => {
    write('AGENTS.md', 'b\n');
    commit();
    expect((await run()).ok).toBe(false);
  });

  it('passes with a fragment', async () => {
    write('AGENTS.md', 'b\n');
    write('changelog.d/OPS-1.md', '### Changed\n\n- x\n');
    commit();
    expect((await run()).ok).toBe(true);
  });

  it('counts a line added under [Unreleased] (with a warning) but not one in an old section', async () => {
    write('AGENTS.md', 'b\n');
    write('CHANGELOG.md', '# C\n\n## [Unreleased]\n\n- new\n\n## [0.1.0] - 2026-10-16\n\n- old\n');
    commit();
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('fails when the only CHANGELOG edit is in an old version section', async () => {
    write('AGENTS.md', 'b\n');
    write(
      'CHANGELOG.md',
      '# C\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-16\n\n- old\n- typo fix\n',
    );
    commit();
    expect((await run()).ok).toBe(false);
  });
});
