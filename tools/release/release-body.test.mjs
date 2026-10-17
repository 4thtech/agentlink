import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// OPS-REL-3: GitHub rejects a Release body over 125,000 characters. The check is inline bash in the
// `publish-latest` job of release.yml (that job holds the OIDC token and runs no repository code).
// This test extracts the block between the BODY-LIMIT markers and runs it on fixtures.

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/release.yml'),
  'utf8',
);
const block = /# BODY-LIMIT-BEGIN\n([\s\S]*?)\s*# BODY-LIMIT-END/.exec(workflow)?.[1] ?? '';
const script = block.replace(/^ {10}/gm, '');

function run({ size, releaseNote }) {
  const dir = mkdtempSync(join(tmpdir(), 'body-'));
  mkdirSync(join(dir, 'docs/releases'), { recursive: true });
  writeFileSync(
    join(dir, 'CHANGELOG.md'),
    '# C\n\n## [Unreleased]\n\n## [0.2.0] - 2026-11-01\n\n- x\n',
  );
  if (releaseNote) writeFileSync(join(dir, 'docs/releases/v0.2.0.md'), 'note');
  const notes = join(dir, 'notes.md');
  writeFileSync(notes, 'x'.repeat(size));
  execFileSync('bash', ['-euo', 'pipefail', '-c', script], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      notes,
      version: '0.2.0',
      GITHUB_REPOSITORY: '4thtech/agentlink',
    },
    stdio: 'pipe',
  });
  return readFileSync(notes, 'utf8');
}

describe('release body size fallback (inline in release.yml)', () => {
  it('finds the block', () => expect(script).toContain('125000'));
  it('keeps a body at the limit', () => expect(run({ size: 125000 })).toHaveLength(125000));
  it('falls back one character over, linking the CHANGELOG section', () => {
    const out = run({ size: 125001 });
    expect(out.length).toBeLessThan(500);
    expect(out).toContain(
      'https://github.com/4thtech/agentlink/blob/v0.2.0/CHANGELOG.md#020---2026-11-01',
    );
  });
  it('prefers docs/releases/v<version>.md', () => {
    expect(run({ size: 125001, releaseNote: true })).toContain(
      '/blob/v0.2.0/docs/releases/v0.2.0.md',
    );
  });
});
