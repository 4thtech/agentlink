import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// OPS-REL-3: GitHub rejects a Release body over 125,000 characters. The check is inline bash in the
// `publish-latest` job of release.yml (that job holds the OIDC token and runs no repository code).
// This test extracts the blocks between the BODY-LIMIT and DOWNLOAD markers (DOCS-MAC-2: every body
// starts with a "Download" section) and runs them on fixtures.

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/release.yml'),
  'utf8',
);
const block = /# BODY-LIMIT-BEGIN\n([\s\S]*?)\s*# BODY-LIMIT-END/.exec(workflow)?.[1] ?? '';
const download = /# DOWNLOAD-BEGIN\n([\s\S]*?)\s*# DOWNLOAD-END/.exec(workflow)?.[1] ?? '';
const script = `${block}\n${download}`.replace(/^ {10}/gm, '');

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
  it('finds the blocks', () => {
    expect(script).toContain('123000');
    expect(script).toContain('## Download');
  });
  it('keeps changes at the limit, and the whole body fits under 125000', () => {
    const out = run({ size: 123000 });
    expect(out).toContain('x'.repeat(123000));
    expect(out.length).toBeLessThanOrEqual(125000);
  });
  it('falls back one character over, linking the CHANGELOG section', () => {
    const out = run({ size: 123001 });
    expect(out.length).toBeLessThan(2000);
    expect(out).toContain(
      'https://github.com/4thtech/agentlink/blob/v0.2.0/CHANGELOG.md#020---2026-11-01',
    );
  });
  it('prefers docs/releases/v<version>.md', () => {
    expect(run({ size: 123001, releaseNote: true })).toContain(
      '/blob/v0.2.0/docs/releases/v0.2.0.md',
    );
  });
});

describe('release body Download section (inline in release.yml)', () => {
  const out = run({ size: 10 });
  it("starts with Download, then the changes under What's new", () => {
    expect(out.startsWith('## Download\n')).toBe(true);
    expect(out).toContain("## What's new\n\nxxxxxxxxxx");
    expect(out.indexOf('## Download')).toBeLessThan(out.indexOf("## What's new"));
  });
  it('names each file next to the computer it is for', () => {
    expect(out).toContain(
      '| Mac with Apple chip (M1, M2, M3, M4) | [AgentLink-0.2.0-mac-arm64.dmg](https://github.com/4thtech/agentlink/releases/download/v0.2.0/AgentLink-0.2.0-mac-arm64.dmg) |',
    );
    expect(out).toContain(
      '| Mac with Intel chip | [AgentLink-0.2.0-mac-x64.dmg](https://github.com/4thtech/agentlink/releases/download/v0.2.0/AgentLink-0.2.0-mac-x64.dmg) |',
    );
    expect(out).toContain('| Windows or Linux | No download: [one command]');
    expect(out).toContain('**arm64 = Apple chip** and **x64 = Intel**');
    expect(out).toContain('About This Mac');
  });
  it('gives the numbered first-time steps for the Mac, with the reason and a link', () => {
    expect(out).toContain('**Mac, first time:** 1) Open the .dmg');
    expect(out).toContain('press **Open Anyway**');
    expect(out).toContain('4) You only do this once.');
    expect(out).toContain("AgentLink isn't signed with an Apple Developer ID yet");
    expect(out).toContain('/apps/desktop-app.md#open-it-the-first-time');
  });
  it('says the other files are not needed', () => {
    expect(out).toContain(
      "The other files (`.mcpb`, `SHA256SUMS`) are for AI-app extensions and checks. You don't need them.",
    );
  });
});
