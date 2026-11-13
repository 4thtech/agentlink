// WP-D10 updater (src/main/updater): the rules that need no signature. The signed paths (every
// refusal of the acceptance list, the rotation rehearsal and the download flow) are tested against
// the offline signing tool in tools/desktop/sign-manifest.test.mjs, because only that zone may sign.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import rootKeyFile from '../../src/main/updater/root-key.json' with { type: 'json' };
import {
  BUILD_CHANNEL,
  installerKind,
  procTranslated,
  updateChannel,
  updaterArch,
} from '../../src/main/updater/host.js';
import { configuredRoot, runUpdateCheck, UPDATE_COPY } from '../../src/main/updater/index.js';
import {
  MANIFEST_DOMAIN,
  MAX_DOCUMENT_BYTES,
  UpdateRefusal,
  allowedDownloadUrl,
  compareVersions,
  parseUpdateDocument,
  pinnedRoot,
} from '../../src/main/updater/manifest.js';
import { macQuarantineValue } from '../../src/main/updater/quarantine.js';
import {
  FAILED_FILE,
  loadFailedVersion,
  saveFailedVersion,
} from '../../src/main/updater/state.js';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  scheduleUpdateChecks,
} from '../../src/main/updater/schedule.js';

// The x coordinate of the secp256k1 generator point G: a public, well-known valid x-only key.
const GENERATOR_X = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
/** A well-formed v2 manifest (its signature is not checked by the parser). */
const MANIFEST: Record<string, unknown> = {
  domain: 'agentlink-desktop-update/v2',
  channel: 'beta',
  version: '0.5.3',
  minimumVersion: '0.5.0',
  released: '2026-11-13T08:00:00Z',
  expires: '2026-12-13T08:00:00Z',
  updateKey: GENERATOR_X,
  assets: [
    {
      platform: 'darwin',
      arch: 'arm64',
      kind: 'zip',
      url: 'https://github.com/4thtech/agentlink/releases/download/v0.5.3/AgentLink-0.5.3-arm64.zip',
      sha256: 'ab'.repeat(32),
      size: 10,
    },
  ],
  sig: '00'.repeat(64),
};
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof UpdateRefusal) return error.code;
    throw error;
  }
  return 'accepted';
};

describe('pinned root', () => {
  it('the repository holds the placeholder, which configures nothing', () => {
    expect(rootKeyFile.rootPublicKey).toMatch(/^PLACEHOLDER-AGENTLINK-DESKTOP-ROOT-KEY/);
    expect(configuredRoot()).toBeUndefined();
  });

  it('accepts only a valid x-only key and a whole-number floor', () => {
    const g = GENERATOR_X;
    expect(pinnedRoot({ rootPublicKey: g, minimumStatementSequence: 0 })).toEqual({
      rootPublicKey: g,
      minimumStatementSequence: 0,
    });
    expect(
      pinnedRoot({ rootPublicKey: g.toUpperCase(), minimumStatementSequence: 0 }),
    ).toBeUndefined();
    expect(
      pinnedRoot({ rootPublicKey: 'ff'.repeat(32), minimumStatementSequence: 0 }),
    ).toBeUndefined();
    expect(pinnedRoot({ rootPublicKey: g, minimumStatementSequence: -1 })).toBeUndefined();
  });

  it('the updater does nothing without a pinned root (no network, no dialog)', async () => {
    const outcome = await runUpdateCheck({
      currentVersion: '0.4.13',
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
      stateDir: '/nonexistent',
      fetch: () => Promise.reject(new Error('must not fetch')),
      openPath: () => Promise.reject(new Error('must not open')),
      showMessageBox: () => Promise.reject(new Error('must not ask')),
    });
    expect(outcome).toEqual({ kind: 'not_configured' });
  });
});

describe('release build with updates off (DESK051-C4, until the offline key ceremony)', () => {
  it('the updates-off root configures nothing, carries the mark and no placeholder', async () => {
    const off = (await import('../../src/main/updater/root-key.updates-off.json', {
      with: { type: 'json' },
    })) as { default: Record<string, unknown> };
    expect(JSON.stringify(off.default)).toContain('AGENTLINK-DESKTOP-UPDATES-OFF');
    expect(JSON.stringify(off.default)).not.toContain('PLACEHOLDER-AGENTLINK-DESKTOP-ROOT-KEY');
    expect(configuredRoot(off.default)).toBeUndefined();
    const outcome = await runUpdateCheck({
      currentVersion: '0.5.1',
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
      stateDir: '/nonexistent',
      root: off.default,
      fetch: () => Promise.reject(new Error('must not fetch')),
      openPath: () => Promise.reject(new Error('must not open')),
      showMessageBox: () => Promise.reject(new Error('must not ask')),
    });
    expect(outcome).toEqual({ kind: 'not_configured' });
  });
});

describe('versions', () => {
  it('orders releases after their betas and compares numerically', () => {
    expect(compareVersions('0.5.0', '0.4.13')).toBe(1);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.5.0-beta.2', '0.5.0-beta.10')).toBe(-1);
    expect(compareVersions('0.5.0-beta.9', '0.5.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    for (const bad of ['1.0', '01.0.0', '1.0.0-rc.1', 'v1.0.0', '1.0.0+x', ' 1.0.0']) {
      expect(
        code(() => compareVersions(bad, '1.0.0')),
        bad,
      ).toBe('malformed');
    }
  });
});

describe('host allowlist', () => {
  it('allows only https to this repository on github.com and the GitHub download hosts', () => {
    expect(
      allowedDownloadUrl('https://github.com/4thtech/agentlink/releases/download/v1.0.0/a.dmg'),
    ).toBeDefined();
    expect(allowedDownloadUrl('https://objects.githubusercontent.com/x')).toBeDefined();
    expect(allowedDownloadUrl('https://release-assets.githubusercontent.com/x')).toBeDefined();
    for (const bad of [
      'http://github.com/4thtech/agentlink/releases/x',
      'https://github.com/4thtech/other/releases/x',
      'https://github.com.evil.example/4thtech/agentlink/releases/x',
      'https://a:b@objects.githubusercontent.com/x',
      'https://objects.githubusercontent.com:8443/x',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(allowedDownloadUrl(bad), bad).toBeUndefined();
    }
  });
});

describe('strict parsing before any signature check', () => {
  it('refuses oversize, non-JSON, other domains and duplicate names', () => {
    expect(code(() => parseUpdateDocument(new Uint8Array(MAX_DOCUMENT_BYTES + 1)))).toBe(
      'oversize',
    );
    expect(code(() => parseUpdateDocument(enc('not json')))).toBe('malformed');
    expect(code(() => parseUpdateDocument(enc('{"domain":"other/v1"}')))).toBe('malformed');
    expect(
      code(() => parseUpdateDocument(enc('{"domain":"agentlink-desktop-root/v1","domain":"x"}'))),
    ).toBe('malformed');
    expect(code(() => parseUpdateDocument(Uint8Array.of(0x7b, 0xff, 0x7d)))).toBe('malformed');
  });

  it('refuses a manifest with a missing sig as unsigned and an extra field as unknown', () => {
    const body = { ...MANIFEST };
    delete body['sig'];
    expect(code(() => parseUpdateDocument(enc(JSON.stringify(body))))).toBe('unsigned');
    expect(code(() => parseUpdateDocument(enc(JSON.stringify({ ...MANIFEST, x: 1 }))))).toBe(
      'unknown_field',
    );
    expect(
      code(() => parseUpdateDocument(enc(JSON.stringify({ ...MANIFEST, version: '0.5' })))),
    ).toBe('malformed');
    expect(
      code(() =>
        parseUpdateDocument(enc(JSON.stringify({ ...MANIFEST, released: '2026-02-30T10:00:00Z' }))),
      ),
    ).toBe('malformed');
    expect(parseUpdateDocument(enc(JSON.stringify(MANIFEST))).version).toBe('0.5.3');
  });
});

describe('phase-1 words and marks', () => {
  it('offers only "Open the installer" or "Later" (no silent install)', () => {
    expect([UPDATE_COPY.open, UPDATE_COPY.later]).toEqual(['Open the installer', 'Later']);
    expect(UPDATE_COPY.message('0.5.0')).toBe('AgentLink 0.5.0 is ready to install.');
  });

  it('marks the macOS download as downloaded and not yet opened', () => {
    expect(macQuarantineValue(Date.parse('2026-11-12T10:00:00Z'))).toMatch(
      /^0081;[0-9a-f]+;AgentLink;$/,
    );
  });
});

describe('schedule', () => {
  it('checks shortly after launch, then daily, one pass at a time', async () => {
    const timers: { cb: () => void; ms: number }[] = [];
    let runs = 0;
    let release: () => void = () => undefined;
    scheduleUpdateChecks({} as never, { setTimeout: (cb, ms) => timers.push({ cb, ms }) }, () => {
      runs += 1;
      return new Promise((resolve) => {
        release = () => resolve({ kind: 'up_to_date' });
      });
    });
    expect(timers.map((t) => t.ms)).toEqual([FIRST_CHECK_DELAY_MS]);
    timers[0]?.cb();
    expect(runs).toBe(1);
    expect(timers[1]?.ms).toBe(CHECK_INTERVAL_MS);
    timers[1]?.cb(); // still running: skipped
    expect(runs).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    timers[2]?.cb();
    expect(runs).toBe(2);
  });
});

// --- UPD-1: format v2, channel and arch of this build, failed versions ---------------------------

describe('format v2 (UPD-1): one pinned key, asset kinds, v1 refused', () => {
  const parse = (value: unknown): string =>
    code(() => parseUpdateDocument(enc(JSON.stringify(value))));

  it('the manifest tag is /v2; v1 manifests and v1 key statements are the old format', () => {
    expect(MANIFEST_DOMAIN).toBe('agentlink-desktop-update/v2');
    expect(parse({ ...MANIFEST, domain: 'agentlink-desktop-update/v1' })).toBe('old_format');
    expect(parse({ domain: 'agentlink-desktop-root/v1' })).toBe('old_format');
    expect(parse({ domain: 'agentlink-desktop-root/v2' })).toBe('malformed');
    expect(parse({ ...MANIFEST, statement: {} })).toBe('unknown_field');
  });

  it('an asset needs a kind that matches its platform and file name', () => {
    const asset = (kind: string, name: string, platform = 'darwin'): Record<string, unknown> => ({
      platform,
      arch: platform === 'win32' ? 'x64' : 'arm64',
      kind,
      url: `https://github.com/4thtech/agentlink/releases/download/v0.5.3/${name}`,
      sha256: 'ab'.repeat(32),
      size: 10,
    });
    const manifest = (assets: unknown[]): unknown => ({ ...MANIFEST, assets });
    expect(parse(manifest([asset('zip', 'AgentLink-0.5.3-arm64.zip')]))).toBe('accepted');
    expect(parse(manifest([asset('zip', 'A-arm64.zip'), asset('dmg', 'A-arm64.dmg')]))).toBe(
      'accepted',
    );
    expect(parse(manifest([asset('zip', 'AgentLink-0.5.3-arm64.dmg')]))).toBe('malformed');
    expect(parse(manifest([asset('dmg', 'AgentLink-0.5.3-arm64.zip')]))).toBe('malformed');
    expect(parse(manifest([asset('tar', 'AgentLink-0.5.3-arm64.tar')]))).toBe('malformed');
    expect(parse(manifest([asset('zip', 'AgentLink-0.5.3.zip', 'win32')]))).toBe('malformed');
    expect(parse(manifest([asset('nsis', 'AgentLink-0.5.3-setup.exe', 'win32')]))).toBe(
      'accepted',
    );
    expect(parse(manifest([asset('zip', 'A.zip'), asset('zip', 'B.zip')]))).toBe('malformed');
    const noKind = asset('zip', 'A.zip');
    delete noKind['kind'];
    expect(parse(manifest([noKind]))).toBe('malformed');
  });
});

describe('channel and arch of this build (UPD-1, main.ts fix)', () => {
  it('a pre-release version follows beta; others follow the build channel', () => {
    expect(BUILD_CHANNEL).toBe('beta');
    expect(updateChannel('0.6.0-beta.2')).toBe('beta');
    expect(updateChannel('0.6.0-beta.2', 'stable')).toBe('beta');
    expect(updateChannel('0.6.0', 'stable')).toBe('stable');
    expect(updateChannel('0.6.0')).toBe(BUILD_CHANNEL);
  });

  it('detects Rosetta with sysctl.proc_translated, fixed arguments only', () => {
    const calls: [string, readonly string[]][] = [];
    const run =
      (out: string | Error) =>
      (cmd: string, args: readonly string[]): string => {
        calls.push([cmd, args]);
        if (out instanceof Error) throw out;
        return out;
      };
    expect(procTranslated(run('1\n'))).toBe(true);
    expect(procTranslated(run('0\n'))).toBe(false);
    expect(procTranslated(run(new Error('unknown oid')))).toBe(false); // Intel: no such key
    expect(procTranslated(run('yes'))).toBe(false);
    expect(calls[0]).toEqual(['/usr/sbin/sysctl', ['-n', 'sysctl.proc_translated']]);
  });

  it('an x64 copy under Rosetta is offered the Apple silicon build', () => {
    expect(updaterArch('darwin', 'x64', true)).toBe('arm64');
    expect(updaterArch('darwin', 'x64', false)).toBe('x64');
    expect(updaterArch('darwin', 'arm64', false)).toBe('arm64');
    expect(updaterArch('win32', 'x64', true)).toBe('x64');
  });

  it('phase 1 opens the DMG on a Mac and the setup program on Windows', () => {
    expect(installerKind('darwin')).toBe('dmg');
    expect(installerKind('win32')).toBe('nsis');
  });
});

describe('failed version (UPD-1)', () => {
  it('is persisted, read back strictly, and absent by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentlink-failed-'));
    try {
      expect(await loadFailedVersion(dir)).toBeNull();
      await saveFailedVersion(dir, '0.5.3');
      expect(await loadFailedVersion(dir)).toBe('0.5.3');
      await saveFailedVersion(dir, '0.5.4-beta.1');
      expect(await loadFailedVersion(dir)).toBe('0.5.4-beta.1');
      await expect(saveFailedVersion(dir, 'not a version')).rejects.toThrow();
      await writeFile(join(dir, FAILED_FILE), '{"failedVersion":"0.5.3","x":1}');
      expect(await loadFailedVersion(dir)).toBeNull();
      await writeFile(join(dir, FAILED_FILE), '{"failedVersion":"../../x"}');
      expect(await loadFailedVersion(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
