import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStableVersion, rollChangelog, runCli } from './roll-changelog.mjs';

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
    expect(out).toContain('[0.2.0]: https://github.com/4thtech/agentlink/compare/v0.1.0...v0.2.0');
    expect(out).toContain('[0.1.0]: https://github.com/4thtech/agentlink/compare/v0.0.1...v0.1.0');
  });

  it('refuses an empty [Unreleased], including one with only headings', () => {
    const empty = FIXTURE.replace(
      /## \[Unreleased\][\s\S]*?(?=## \[0\.1\.0\])/,
      '## [Unreleased]\n\n',
    );
    expect(() => rollChangelog(empty, '0.2.0', '2026-11-01')).toThrow(
      /add an entry under \[Unreleased\]/,
    );
    const headings = FIXTURE.replace(/- Thing one \(M1-1\)\./, '').replace(
      /- Thing two \(M1-2\)\./,
      '',
    );
    expect(() => rollChangelog(headings, '0.2.0', '2026-11-01')).toThrow(/empty/i);
  });

  it('refuses a missing [Unreleased], an existing version section and a bad version or date', () => {
    expect(() => rollChangelog('# Changelog\n', '0.2.0', '2026-11-01')).toThrow(/Unreleased/);
    expect(() => rollChangelog(FIXTURE, '0.1.0', '2026-11-01')).toThrow(/already/i);
    expect(() => rollChangelog(FIXTURE, '0.2.0-next.1', '2026-11-01')).toThrow(/stable/i);
    expect(() => rollChangelog(FIXTURE, '0.2.0', 'yesterday')).toThrow(/date/i);
  });

  it('works for the first release (no earlier version section)', () => {
    const first =
      '# C\n\n## [Unreleased]\n\n- a\n\n[Unreleased]: https://github.com/o/r/commits/main\n';
    const out = rollChangelog(first, '0.0.1', '2026-10-12');
    expect(out).toContain('## [0.0.1] - 2026-10-12\n\n- a');
    expect(out).toContain('[0.0.1]: https://github.com/o/r/releases/tag/v0.0.1');
  });
});

describe('CRLF', () => {
  it('normalises CRLF input to LF output', () => {
    const out = rollChangelog(FIXTURE.replace(/\n/g, '\r\n'), '0.2.0', '2026-11-01');
    expect(out).not.toContain('\r');
    expect(out).toContain('## [0.2.0] - 2026-11-01');
  });
});

describe('isStableVersion', () => {
  it('accepts only x.y.z', () => {
    expect(isStableVersion('1.2.3')).toBe(true);
    expect(isStableVersion('1.2.3-next.1')).toBe(false);
    expect(isStableVersion('')).toBe(false);
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

  it('roll is a no-op when the version section already exists', () => {
    const d = dir();
    const file = join(d, 'CHANGELOG.md');
    writeFileSync(file, FIXTURE);
    runCli(['roll', '--file', file, '--version', '0.1.0']);
    expect(readFileSync(file, 'utf8')).toBe(FIXTURE);
  });
});

// OPS-REL-4: changelog fragments in changelog.d/ are folded into the new version section.
describe('fragments', () => {
  const EMPTY = `# Changelog

## [Unreleased]

## [0.1.0] - 2026-10-16

### Added

- First release.

[Unreleased]: https://github.com/4thtech/agentlink/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/4thtech/agentlink/releases/tag/v0.1.0
`;
  const frag = (name, section, ...bullets) => ({
    name,
    text: `---\nsection: ${section}\n---\n\n${bullets.join('\n')}\n`,
  });

  it('folds fragments into a section grouped in a stable order, sorted by file name', () => {
    const out = rollChangelog(EMPTY, '0.2.0', '2026-11-01', [
      frag('M1-2.md', 'Fixed', '- Fix two (M1-2).'),
      frag('M1-3.md', 'Added', '- Add three (M1-3).'),
      frag('M1-1.md', 'Added', '- Add one (M1-1).'),
      frag('M1-4.md', 'Security', '- Sec four (M1-4).'),
      frag('M1-5.md', 'Changed', '- Change five (M1-5).'),
    ]);
    const body = out.slice(out.indexOf('## [0.2.0]'), out.indexOf('## [0.1.0]'));
    const order = ['### Added', '### Changed', '### Fixed', '### Security'].map((h) =>
      body.indexOf(h),
    );
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body.indexOf('Add one')).toBeLessThan(body.indexOf('Add three'));
    expect(out).toMatch(/## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-11-01/);
  });

  it('accepts a section heading instead of front matter, and several headings in one file', () => {
    const out = rollChangelog(EMPTY, '0.2.0', '2026-11-01', [
      { name: 'a.md', text: '### Added\n\n- A.\n\n### Fixed\n\n- B.\n' },
    ]);
    expect(out).toContain('### Added\n\n- A.');
    expect(out).toContain('### Fixed\n\n- B.');
  });

  it('merges fragments with legacy lines already under [Unreleased]', () => {
    const legacy = EMPTY.replace(
      '## [Unreleased]\n',
      '## [Unreleased]\n\n### Added\n\n- Legacy.\n',
    );
    const out = rollChangelog(legacy, '0.2.0', '2026-11-01', [
      frag('x.md', 'Added', '- From fragment.'),
    ]);
    const body = out.slice(out.indexOf('## [0.2.0]'), out.indexOf('## [0.1.0]'));
    expect(body.match(/^### Added/gm)).toHaveLength(1);
    expect(body.indexOf('Legacy')).toBeLessThan(body.indexOf('From fragment'));
  });

  it('rolls with fragments only, and refuses only when both are empty', () => {
    expect(() => rollChangelog(EMPTY, '0.2.0', '2026-11-01', [])).toThrow(/empty/i);
    expect(() =>
      rollChangelog(EMPTY, '0.2.0', '2026-11-01', [frag('x.md', 'Added', '- ok')]),
    ).not.toThrow();
  });

  it('validates section names and bullets, naming the file', () => {
    expect(() =>
      rollChangelog(EMPTY, '0.2.0', '2026-11-01', [frag('bad.md', 'Misc', '- x')]),
    ).toThrow(/bad\.md.*Misc/s);
    expect(() =>
      rollChangelog(EMPTY, '0.2.0', '2026-11-01', [{ name: 'nosec.md', text: '- x\n' }]),
    ).toThrow(/nosec\.md.*section/is);
    expect(() =>
      rollChangelog(EMPTY, '0.2.0', '2026-11-01', [{ name: 'nob.md', text: '### Added\n\n' }]),
    ).toThrow(/nob\.md.*bullet/is);
  });

  it('skips a "none" fragment (a recorded reason, no changelog entry)', () => {
    const none = { name: 'n.md', text: '---\nsection: none\n---\n\nInternal refactor.\n' };
    expect(() => rollChangelog(EMPTY, '0.2.0', '2026-11-01', [none])).toThrow(/empty/i);
    const out = rollChangelog(EMPTY, '0.2.0', '2026-11-01', [none, frag('x.md', 'Fixed', '- F.')]);
    expect(out).not.toContain('Internal refactor');
  });
});

describe('runCli with a fragments directory', () => {
  const setup = (fragments, text = FIXTURE) => {
    const d = mkdtempSync(join(tmpdir(), 'roll-frag-'));
    const file = join(d, 'CHANGELOG.md');
    const fdir = join(d, 'changelog.d');
    mkdirSync(fdir);
    writeFileSync(file, text);
    for (const [n, c] of Object.entries(fragments)) writeFileSync(join(fdir, n), c);
    return { d, file, fdir };
  };
  const args = (file, fdir) => [
    'roll',
    '--file',
    file,
    '--fragments',
    fdir,
    '--version',
    '0.2.0',
    '--date',
    '2026-11-01',
  ];

  it('consumes fragments, deletes them, keeps README.md, and is idempotent', () => {
    const { file, fdir } = setup({
      'README.md': '# format\n',
      'M1-9.md': '---\nsection: Added\n---\n\n- Nine.\n',
    });
    runCli(args(file, fdir));
    const once = readFileSync(file, 'utf8');
    expect(once).toContain('- Nine.');
    expect(readdirSync(fdir)).toEqual(['README.md']);
    runCli(args(file, fdir));
    expect(readFileSync(file, 'utf8')).toBe(once);
  });

  it('rolls fragments into an otherwise empty [Unreleased]', () => {
    const { file, fdir } = setup(
      { 'a.md': '### Fixed\n\n- Only fragment.\n' },
      '# C\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-16\n\n- x\n',
    );
    runCli(args(file, fdir));
    expect(readFileSync(file, 'utf8')).toContain(
      '## [0.2.0] - 2026-11-01\n\n### Fixed\n\n- Only fragment.',
    );
  });

  it('keeps the fragments when the roll fails or the version is a prerelease', () => {
    const { file, fdir } = setup({ 'bad.md': '### Nope\n\n- x\n' });
    expect(() => runCli(args(file, fdir))).toThrow(/bad\.md/);
    expect(readdirSync(fdir)).toEqual(['bad.md']);
    const pre = setup({ 'a.md': '### Added\n\n- x\n' });
    runCli(['roll', '--file', pre.file, '--fragments', pre.fdir, '--version', '0.2.0-next.1']);
    expect(readdirSync(pre.fdir)).toEqual(['a.md']);
  });

  it('works with no fragments directory at all', () => {
    const d = mkdtempSync(join(tmpdir(), 'roll-nodir-'));
    const file = join(d, 'CHANGELOG.md');
    writeFileSync(file, FIXTURE);
    runCli(args(file, join(d, 'missing')));
    expect(readFileSync(file, 'utf8')).toContain('## [0.2.0] - 2026-11-01');
  });
});
