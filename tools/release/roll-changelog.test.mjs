import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GITHUB_BODY_LIMIT,
  anchorFor,
  isStableVersion,
  releaseBody,
  rollChangelog,
  runCli,
} from './roll-changelog.mjs';

// OPS-REL-3: the Version packages PR rolls CHANGELOG.md [Unreleased] into a version section, and the
// GitHub Release body falls back to a short note when the section is over GitHub's 125,000-character limit.

const FIXTURE = `# Changelog

Intro text.

## [Unreleased]

### Added

- Thing one (M1-1).

### Fixed

- Thing two (M1-2).

## [0.1.0] - 2026-10-16

### Added

- First release.

[Unreleased]: https://github.com/4thtech/agentlink/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/4thtech/agentlink/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/4thtech/agentlink/releases/tag/v0.0.1
`;

describe('rollChangelog', () => {
  it('moves [Unreleased] into a dated version section and leaves an empty [Unreleased]', () => {
    const out = rollChangelog(FIXTURE, '0.2.0', '2026-11-01');
    expect(out).toContain(
      '## [Unreleased]\n\n## [0.2.0] - 2026-11-01\n\n### Added\n\n- Thing one (M1-1).',
    );
    expect(out).toContain('- Thing two (M1-2).\n\n## [0.1.0] - 2026-10-16');
    expect(out.match(/^## \[Unreleased\]/gm)).toHaveLength(1);
    expect(out.indexOf('Thing one')).toBeGreaterThan(out.indexOf('## [0.2.0]'));
  });

  it('updates the link references', () => {
    const out = rollChangelog(FIXTURE, '0.2.0', '2026-11-01');
    expect(out).toContain(
      '[Unreleased]: https://github.com/4thtech/agentlink/compare/v0.2.0...HEAD',
    );
    expect(out).toContain(
      '[0.2.0]: https://github.com/4thtech/agentlink/compare/v0.1.0...v0.2.0',
    );
    expect(out).toContain('[0.1.0]: https://github.com/4thtech/agentlink/compare/v0.0.1...v0.1.0');
  });

  it('refuses an empty [Unreleased], including one with only headings', () => {
    const empty = FIXTURE.replace(/## \[Unreleased\][\s\S]*?(?=## \[0\.1\.0\])/, '## [Unreleased]\n\n');
    expect(() => rollChangelog(empty, '0.2.0', '2026-11-01')).toThrow(/empty/i);
    const headings = FIXTURE.replace(/- Thing one \(M1-1\)\./, '').replace(/- Thing two \(M1-2\)\./, '');
    expect(() => rollChangelog(headings, '0.2.0', '2026-11-01')).toThrow(/empty/i);
  });

  it('refuses a missing [Unreleased], an existing version section and a bad version or date', () => {
    expect(() => rollChangelog('# Changelog\n', '0.2.0', '2026-11-01')).toThrow(/Unreleased/);
    expect(() => rollChangelog(FIXTURE, '0.1.0', '2026-11-01')).toThrow(/already/i);
    expect(() => rollChangelog(FIXTURE, '0.2.0-next.1', '2026-11-01')).toThrow(/stable/i);
    expect(() => rollChangelog(FIXTURE, '0.2.0', 'yesterday')).toThrow(/date/i);
  });

  it('works for the first release (no earlier version section)', () => {
    const first = '# C\n\n## [Unreleased]\n\n- a\n\n[Unreleased]: https://github.com/o/r/commits/main\n';
    const out = rollChangelog(first, '0.0.1', '2026-10-12');
    expect(out).toContain('## [0.0.1] - 2026-10-12\n\n- a');
    expect(out).toContain('[0.0.1]: https://github.com/o/r/releases/tag/v0.0.1');
  });
});

describe('isStableVersion', () => {
  it('accepts only x.y.z', () => {
    expect(isStableVersion('1.2.3')).toBe(true);
    expect(isStableVersion('1.2.3-next.1')).toBe(false);
    expect(isStableVersion('')).toBe(false);
  });
});

describe('releaseBody', () => {
  const opts = { version: '0.2.0', date: '2026-11-01', repository: '4thtech/agentlink' };

  it('keeps the section when it fits', () => {
    expect(releaseBody('- short\n', opts)).toEqual({ body: '- short\n', fallback: false });
  });

  it('keeps a section exactly at the limit and falls back one character over', () => {
    expect(releaseBody('x'.repeat(GITHUB_BODY_LIMIT), opts).fallback).toBe(false);
    expect(releaseBody('x'.repeat(GITHUB_BODY_LIMIT + 1), opts).fallback).toBe(true);
  });

  it('falls back to docs/releases/<v>.md when present', () => {
    const r = releaseBody('x'.repeat(GITHUB_BODY_LIMIT + 1), { ...opts, hasReleaseNote: true });
    expect(r.fallback).toBe(true);
    expect(r.body).toContain(
      'https://github.com/4thtech/agentlink/blob/v0.2.0/docs/releases/v0.2.0.md',
    );
    expect(r.body.length).toBeLessThan(2000);
  });

  it('otherwise links the CHANGELOG section', () => {
    const r = releaseBody('x'.repeat(GITHUB_BODY_LIMIT + 1), opts);
    expect(r.body).toContain(
      `https://github.com/4thtech/agentlink/blob/v0.2.0/CHANGELOG.md#${anchorFor('0.2.0', '2026-11-01')}`,
    );
    expect(anchorFor('0.1.0', '2026-10-16')).toBe('010---2026-10-16');
  });
});

describe('runCli', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'roll-'));

  it('roll rewrites the file for a stable version', () => {
    const d = dir();
    const file = join(d, 'CHANGELOG.md');
    writeFileSync(file, FIXTURE);
    runCli(['roll', '--file', file, '--version', '0.2.0', '--date', '2026-11-01']);
    expect(readFileSync(file, 'utf8')).toContain('## [0.2.0] - 2026-11-01');
  });

  it('roll leaves the file alone for a prerelease', () => {
    const d = dir();
    const file = join(d, 'CHANGELOG.md');
    writeFileSync(file, FIXTURE);
    runCli(['roll', '--file', file, '--version', '0.2.0-next.1']);
    expect(readFileSync(file, 'utf8')).toBe(FIXTURE);
  });

  it('roll throws on an empty [Unreleased]', () => {
    const d = dir();
    const file = join(d, 'CHANGELOG.md');
    writeFileSync(file, '# C\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-16\n\n- x\n');
    expect(() => runCli(['roll', '--file', file, '--version', '0.2.0'])).toThrow(/empty/i);
  });

  it('body replaces an over-long notes file with the short fallback', () => {
    const d = dir();
    const notes = join(d, 'notes.md');
    writeFileSync(notes, 'x'.repeat(GITHUB_BODY_LIMIT + 5));
    runCli(['body', '--notes', notes, '--version', '0.2.0', '--repo', '4thtech/agentlink', '--date', '2026-11-01']);
    const out = readFileSync(notes, 'utf8');
    expect(out.length).toBeLessThan(2000);
    expect(out).toContain('CHANGELOG.md#');
  });

  it('body leaves a short notes file untouched', () => {
    const d = dir();
    const notes = join(d, 'notes.md');
    writeFileSync(notes, '- ok\n');
    runCli(['body', '--notes', notes, '--version', '0.2.0', '--repo', '4thtech/agentlink']);
    expect(readFileSync(notes, 'utf8')).toBe('- ok\n');
  });
});
