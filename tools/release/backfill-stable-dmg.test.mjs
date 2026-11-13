import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backfill, parseSums } from './backfill-stable-dmg.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex');

/** A mocked gh: `release download` writes the fixture files, `release upload` is recorded. */
function mockGh({ corrupt = false, omit = false } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[1] === 'download') {
      const dir = args[args.indexOf('--dir') + 1];
      writeFileSync(join(dir, 'AgentLink-0.5.2-mac-arm64.dmg'), corrupt ? 'bad' : 'arm bytes');
      writeFileSync(join(dir, 'AgentLink-0.5.2-mac-x64.dmg'), 'x64 bytes');
      const lines = [`${hash('arm bytes')}  AgentLink-0.5.2-mac-arm64.dmg`];
      if (!omit) lines.push(`${hash('x64 bytes')}  AgentLink-0.5.2-mac-x64.dmg`);
      writeFileSync(join(dir, 'SHA256SUMS-desktop-app.txt'), `${lines.join('\n')}\n`);
    }
    return '';
  };
  return { gh, calls };
}

const base = () => ({
  tag: 'v0.5.2',
  repo: '4thtech/agentlink',
  dir: mkdtempSync(join(tmpdir(), 'backfill-test-')),
  log: () => {},
});

describe('backfill-stable-dmg', () => {
  it('is a dry run by default: downloads, verifies, uploads nothing', () => {
    const { gh, calls } = mockGh();
    const r = backfill({ ...base(), gh });
    expect(r.uploaded).toBe(false);
    expect(calls.map((c) => c[1])).toEqual(['download']);
  });

  it('downloads only the versioned DMGs and the sums of that tag', () => {
    const { gh, calls } = mockGh();
    backfill({ ...base(), gh });
    const patterns = calls[0].filter((_, i, a) => a[i - 1] === '--pattern');
    expect(patterns).toEqual([
      'AgentLink-0.5.2-mac-arm64.dmg',
      'AgentLink-0.5.2-mac-x64.dmg',
      'SHA256SUMS-desktop-app.txt',
    ]);
  });

  it('with --apply uploads the stable copies and the new sums with --clobber', () => {
    const { gh, calls } = mockGh();
    const opts = base();
    const r = backfill({ ...opts, gh, apply: true });
    expect(r.uploaded).toBe(true);
    const up = calls[1];
    expect(up.slice(0, 3)).toEqual(['release', 'upload', 'v0.5.2']);
    expect(up).toContain('--clobber');
    expect(up.slice(up.indexOf('--') + 1).map((p) => p.split('/').pop())).toEqual([
      'AgentLink-mac-arm64.dmg',
      'AgentLink-mac-x64.dmg',
      'SHA256SUMS-desktop-app.txt',
    ]);
    expect(readFileSync(join(opts.dir, 'AgentLink-mac-arm64.dmg'), 'utf8')).toBe('arm bytes');
    const sums = parseSums(readFileSync(join(opts.dir, 'SHA256SUMS-desktop-app.txt'), 'utf8'));
    expect(sums.size).toBe(4);
    expect(sums.get('AgentLink-mac-x64.dmg')).toBe(hash('x64 bytes'));
  });

  it('refuses a DMG that does not match the release sums', () => {
    const { gh, calls } = mockGh({ corrupt: true });
    expect(() => backfill({ ...base(), gh, apply: true })).toThrow(/does not match/);
    expect(calls.map((c) => c[1])).toEqual(['download']);
  });

  it('refuses a DMG missing from the sums', () => {
    const { gh } = mockGh({ omit: true });
    expect(() => backfill({ ...base(), gh, apply: true })).toThrow(/not listed/);
  });

  it('rejects a bad tag or repository', () => {
    const { gh } = mockGh();
    expect(() => backfill({ ...base(), gh, tag: '0.5.2' })).toThrow(/--tag/);
    expect(() => backfill({ ...base(), gh, repo: 'x' })).toThrow(/--repo/);
  });
});
