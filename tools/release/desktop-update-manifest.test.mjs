// UPD-3 (D-151): the signed desktop update manifest in release.yml. One update key, held as the
// environment secret DESKTOP_UPDATE_KEY in `desktop-update` (Tali as required reviewer), read by ONE
// step after his approval click. The manifest is built from the attested and verified release assets,
// signed through @4thtech-io/crypto, checked with the APP'S OWN parser before anything is uploaded, and
// published as desktop-update-<key id>.json (Fable M1: an app with an old pin still finds its
// document) plus the stable name desktop-update.json. Fable L3: the pin of the built app must equal
// root-key.json and never be the placeholder when updates are on.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeHex } from '@4thtech-io/crypto';
import { bip340PublicKey } from '@4thtech-io/crypto/keystore';
import * as verifier from '../../apps/desktop/src/main/updater/manifest.ts';
import { documentUrl, updateKeyId } from '../../apps/desktop/src/main/updater/index.ts';
import {
  KEY_ID_LENGTH,
  ToolError,
  buildUnsigned,
  checkBuildInputs,
  documentNames,
  keyId,
  main,
  parseSums,
  pinFromRootKeyJson,
  releaseAssets,
  signFromEnv,
  verifyDocument,
} from './desktop-update-manifest.mjs';
import { RENEW, expiryStatus } from './desktop-update-expiry.mjs';
import { EnvironmentError, OWNER_ID, checkEnvironment } from './desktop-update-environment.mjs';

const root = resolve(import.meta.dirname, '../..');
const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
const NOW = Date.parse('2026-11-13T10:00:00Z');
const DAY = 86_400_000;
const VERSION = '0.5.3';

function key() {
  for (;;) {
    const secretKey = crypto.getRandomValues(new Uint8Array(32));
    try {
      return { secretHex: encodeHex(secretKey), publicKey: encodeHex(bip340PublicKey(secretKey)) };
    } catch {
      /* out of range: draw again */
    }
  }
}
const k1 = key();
const k2 = key();

const hex = (c) => c.repeat(64);
const SUMS = [
  `${hex('a')}  AgentLink-${VERSION}-mac-arm64.dmg`,
  `${hex('b')}  AgentLink-${VERSION}-mac-x64.dmg`,
  `${hex('c')}  AgentLink-${VERSION}-mac-arm64.zip`,
  `${hex('d')}  AgentLink-${VERSION}-mac-x64.zip`,
  `${hex('e')}  AgentLink-mac-arm64.dmg`,
  `${hex('f')}  AgentLink-${VERSION}-win-x64-setup.exe`,
].join('\n');
const SIZES = new Map([
  [`AgentLink-${VERSION}-mac-arm64.dmg`, 120_000_001],
  [`AgentLink-${VERSION}-mac-x64.dmg`, 120_000_002],
  [`AgentLink-${VERSION}-mac-arm64.zip`, 110_000_003],
  [`AgentLink-${VERSION}-mac-x64.zip`, 110_000_004],
  [`AgentLink-${VERSION}-win-x64-setup.exe`, 130_000_005],
]);
const unsigned = (over = {}) =>
  buildUnsigned({
    version: VERSION,
    channel: 'stable',
    sums: parseSums(SUMS),
    sizes: SIZES,
    repository: '4thtech/agentlink',
    ...over,
  });
const rootKeyJson = (pin) => JSON.stringify({ rootPublicKey: pin, minimumStatementSequence: 0 });
// UPD-2: root-key.json is now the real pin; the placeholder is a fixture.
const PLACEHOLDER = JSON.stringify({
  rootPublicKey: 'PLACEHOLDER-AGENTLINK-DESKTOP-ROOT-KEY-run-the-offline-key-ceremony',
  minimumStatementSequence: 0,
});
const UPDATES_OFF = readFileSync(
  join(root, 'apps/desktop/src/main/updater/root-key.updates-off.json'),
  'utf8',
);

const sign = (over = {}) => {
  const log = [];
  const text = signFromEnv({
    unsigned: unsigned(),
    env: { DESKTOP_UPDATE_KEY: k1.secretHex },
    pin: k1.publicKey,
    now: NOW,
    days: 30,
    log: (l) => log.push(l),
    ...over,
  });
  return { text, log };
};

describe('key id and document names (Fable M1)', () => {
  it('the key id is the first 16 hex of the public key; the app asks for the same name', () => {
    expect(KEY_ID_LENGTH).toBe(16);
    expect(keyId(k1.publicKey)).toBe(k1.publicKey.slice(0, 16));
    expect(updateKeyId(k1.publicKey)).toBe(keyId(k1.publicKey));
    const names = documentNames(k1.publicKey);
    expect(names).toEqual({
      keyed: `desktop-update-${k1.publicKey.slice(0, 16)}.json`,
      stable: 'desktop-update.json',
    });
    expect(documentUrl('stable', k1.publicKey)).toBe(
      `https://github.com/4thtech/agentlink/releases/latest/download/${names.keyed}`,
    );
    expect(documentUrl('stable', k2.publicKey)).not.toBe(documentUrl('stable', k1.publicKey));
    expect(() => keyId('PLACEHOLDER')).toThrow(ToolError);
  });
});

describe('the pin (Fable L3)', () => {
  it('reads a real pin from root-key.json and refuses the placeholder and the updates-off file', () => {
    expect(pinFromRootKeyJson(rootKeyJson(k1.publicKey))).toBe(k1.publicKey);
    expect(
      pinFromRootKeyJson(
        readFileSync(join(root, 'apps/desktop/src/main/updater/root-key.json'), 'utf8'),
      ),
    ).toBe('7efc699ddc401adc0c9901f12e152397c835c825d5bc34e7f5f4de00f5f6c984');
    expect(() => pinFromRootKeyJson(PLACEHOLDER)).toThrow(/placeholder|no real/i);
    expect(() => pinFromRootKeyJson(UPDATES_OFF)).toThrow(ToolError);
    expect(() => pinFromRootKeyJson('{')).toThrow(ToolError);
    expect(() => pinFromRootKeyJson(rootKeyJson('0'.repeat(64)))).toThrow(ToolError);
  });

  it('every built app must have updates on and carry exactly the pin of root-key.json', () => {
    const on = (pin, extra = {}) => ({
      platform: 'darwin',
      updates: 'on',
      updatePin: pin,
      ...extra,
    });
    // WIN-INAPP-UPDATE: the Windows build's record too (three: Mac arm64, Mac x64, Windows x64).
    const win = (pin, extra = {}) => on(pin, { platform: 'win32', ...extra });
    expect(() =>
      checkBuildInputs([on(k1.publicKey), on(k1.publicKey), win(k1.publicKey)], k1.publicKey),
    ).not.toThrow();
    expect(() =>
      checkBuildInputs([on(k1.publicKey), on(k2.publicKey), win(k1.publicKey)], k1.publicKey),
    ).toThrow(/pin/);
    expect(() =>
      checkBuildInputs([on(k1.publicKey), on(k1.publicKey), win(k2.publicKey)], k1.publicKey),
    ).toThrow(/pin/);
    expect(() =>
      checkBuildInputs(
        [on(k1.publicKey), on(k1.publicKey), { platform: 'win32', updates: 'off', updatePin: null }],
        k1.publicKey,
      ),
    ).toThrow(/updates/);
    expect(() => checkBuildInputs([on(null)], k1.publicKey)).toThrow(ToolError);
    expect(() => checkBuildInputs([], k1.publicKey)).toThrow(ToolError);
    expect(() => checkBuildInputs([on(k1.publicKey)], k1.publicKey)).toThrow(/three|Windows/i);
    expect(() => checkBuildInputs([on(k1.publicKey), on(k1.publicKey)], k1.publicKey)).toThrow(
      /three|Windows/i,
    );
  });
});

describe('the unsigned manifest from the verified release assets', () => {
  it('lists the zip and the DMG for arm64 and x64, and the Windows setup, with SHA-256, size and URL', () => {
    const m = unsigned();
    expect(m).toEqual({
      domain: 'agentlink-desktop-update/v2',
      channel: 'stable',
      version: VERSION,
      minimumVersion: '0.0.0',
      assets: [
        ['arm64', 'zip', 'c', 110_000_003],
        ['x64', 'zip', 'd', 110_000_004],
        ['arm64', 'dmg', 'a', 120_000_001],
        ['x64', 'dmg', 'b', 120_000_002],
      ].map(([arch, kind, c, size]) => ({
        platform: 'darwin',
        arch,
        kind,
        url: `https://github.com/4thtech/agentlink/releases/download/v${VERSION}/AgentLink-${VERSION}-mac-${arch}.${kind}`,
        sha256: hex(c),
        size,
      })).concat([
        {
          platform: 'win32',
          arch: 'x64',
          kind: 'nsis',
          url: `https://github.com/4thtech/agentlink/releases/download/v${VERSION}/AgentLink-${VERSION}-win-x64-setup.exe`,
          sha256: hex('f'),
          size: 130_000_005,
        },
      ]),
    });
    expect(releaseAssets(VERSION).map((a) => a.name)).toEqual([
      `AgentLink-${VERSION}-mac-arm64.zip`,
      `AgentLink-${VERSION}-mac-x64.zip`,
      `AgentLink-${VERSION}-mac-arm64.dmg`,
      `AgentLink-${VERSION}-mac-x64.dmg`,
      `AgentLink-${VERSION}-win-x64-setup.exe`,
    ]);
  });

  it('refuses a missing asset, a missing size, another repository, a bad version or channel', () => {
    const sums = parseSums(SUMS.split('\n').slice(1).join('\n'));
    expect(() => unsigned({ sums })).toThrow(/arm64\.dmg/);
    const sizes = new Map(SIZES);
    sizes.delete(`AgentLink-${VERSION}-mac-x64.zip`);
    expect(() => unsigned({ sizes })).toThrow(ToolError);
    expect(() => unsigned({ repository: 'someone/agentlink' })).toThrow(/repository/);
    expect(() => unsigned({ version: '0.5' })).toThrow(ToolError);
    expect(() => unsigned({ version: '0.5.3-next.1' })).toThrow(ToolError);
    expect(() => unsigned({ channel: 'nightly' })).toThrow(ToolError);
  });

  it('parses sha256sum lines strictly', () => {
    expect(parseSums(SUMS).get(`AgentLink-${VERSION}-mac-x64.zip`)).toBe(hex('d'));
    expect(() => parseSums(`${hex('a')} one-space.dmg`)).toThrow(ToolError);
    expect(() => parseSums(`${hex('A')}  upper.dmg`)).toThrow(ToolError);
    expect(() => parseSums(`${hex('a')}  x.dmg\n${hex('b')}  x.dmg`)).toThrow(/twice/);
  });
});

describe('signing from the one environment variable', () => {
  it('signs a manifest the app accepts for every asset, valid at most 31 days', () => {
    const { text } = sign();
    const m = verifyDocument({
      text,
      verifier,
      pin: k1.publicKey,
      version: VERSION,
      channel: 'stable',
      now: NOW,
    });
    expect(m.version).toBe(VERSION);
    expect(m.updateKey).toBe(k1.publicKey);
    expect(Date.parse(m.expires) - Date.parse(m.released)).toBe(30 * DAY);
    expect(() => sign({ days: 32 })).toThrow(ToolError);
  });

  it('never prints the key; masks it first under GitHub Actions; removes it from the environment', () => {
    const env = { DESKTOP_UPDATE_KEY: k1.secretHex, GITHUB_ACTIONS: 'true' };
    const { log, text } = sign({ env });
    expect(env.DESKTOP_UPDATE_KEY).toBeUndefined();
    expect(log[0]).toBe(`::add-mask::${k1.secretHex}`);
    for (const line of log.slice(1)) {
      expect(line.toLowerCase()).not.toContain(k1.secretHex);
    }
    expect(text.toLowerCase()).not.toContain(k1.secretHex);
    const quiet = sign({ env: { DESKTOP_UPDATE_KEY: k1.secretHex } }).log;
    expect(quiet.join('\n')).not.toContain(k1.secretHex);
    expect(quiet.join('\n')).not.toContain('::add-mask::');
  });

  it('refuses a missing or malformed key without echoing it, and a key that is not the pin', () => {
    for (const value of [undefined, '', 'zz', `${k1.secretHex}\n${k1.secretHex}`, '0'.repeat(64)]) {
      let error;
      try {
        sign({ env: value === undefined ? {} : { DESKTOP_UPDATE_KEY: value } });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ToolError);
      if (value) expect(error.message).not.toContain(value);
    }
    expect(() => sign({ env: { DESKTOP_UPDATE_KEY: k2.secretHex } })).toThrow(/pinned/);
    // trailing newline from a pasted secret is accepted
    expect(() => sign({ env: { DESKTOP_UPDATE_KEY: `${k1.secretHex}\n` } })).not.toThrow();
  });
});

describe("the check with the app's own parser blocks a bad or unsigned manifest", () => {
  const check = (text, over = {}) =>
    verifyDocument({
      text,
      verifier,
      pin: k1.publicKey,
      version: VERSION,
      channel: 'stable',
      now: NOW,
      ...over,
    });

  it('refuses unsigned, tampered, other-key, wrong version and wrong channel documents', () => {
    const { text } = sign();
    const doc = JSON.parse(text);
    const noSig = { ...doc };
    delete noSig.sig;
    expect(() => check(JSON.stringify(noSig))).toThrow(ToolError);
    expect(() =>
      check(
        JSON.stringify({ ...doc, assets: doc.assets.map((a) => ({ ...a, size: a.size + 1 })) }),
      ),
    ).toThrow(ToolError);
    expect(() => check(text, { pin: k2.publicKey })).toThrow(ToolError);
    expect(() => check(text, { version: '0.5.4' })).toThrow(/version/);
    expect(() => check(text, { channel: 'beta' })).toThrow(/channel/);
    expect(() => check(text, { now: NOW + 31 * DAY })).toThrow(ToolError);
    expect(() => check('not json')).toThrow(ToolError);
  });
});

describe('command line', () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('build → sign → verify writes both names with the same bytes', async () => {
    const d = mkdtempSync(join(tmpdir(), 'agentlink-upd3-'));
    dirs.push(d);
    const assets = join(d, 'assets');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(assets);
    const lines = [];
    for (const { name } of releaseAssets(VERSION)) {
      const bytes = Buffer.from(`fake ${name}`);
      writeFileSync(join(assets, name), bytes);
      const { sha256 } = await import('@4thtech-io/crypto');
      lines.push(`${encodeHex(sha256(bytes))}  ${name}`);
    }
    writeFileSync(join(assets, 'SHA256SUMS-desktop-app.txt'), `${lines.join('\n')}\n`);
    // IR-UPD-8-1 #1: this run's own build sums (a job output), not a file from the Release.
    const buildSums = join(d, 'build-sums.txt');
    writeFileSync(buildSums, `${lines.join('\n')}\n`);
    for (const arch of ['arm64', 'x64']) {
      writeFileSync(
        join(assets, `inputs-mac-${arch}.json`),
        JSON.stringify({ platform: 'darwin', updates: 'on', updatePin: k1.publicKey }),
      );
    }
    writeFileSync(
      join(assets, 'inputs-win-x64.json'),
      JSON.stringify({ platform: 'win32', updates: 'on', updatePin: k1.publicKey }),
    );
    const rk = join(d, 'root-key.json');
    writeFileSync(rk, rootKeyJson(k1.publicKey));
    const out = [];
    const io = { out: (l) => out.push(l), env: {}, verifier, now: NOW };
    await main(
      [
        'build',
        '--version',
        VERSION,
        '--channel',
        'stable',
        '--dir',
        assets,
        '--root-key',
        rk,
        '--repository',
        '4thtech/agentlink',
        '--build-sums',
        buildSums,
        '--out',
        join(d, 'unsigned.json'),
      ],
      io,
    );
    await main(
      ['sign', '--in', join(d, 'unsigned.json'), '--root-key', rk, '--out-dir', join(d, 'signed')],
      { ...io, env: { DESKTOP_UPDATE_KEY: k1.secretHex } },
    );
    await main(
      [
        'verify',
        '--dir',
        join(d, 'signed'),
        '--root-key',
        rk,
        '--version',
        VERSION,
        '--channel',
        'stable',
      ],
      io,
    );
    const names = documentNames(k1.publicKey);
    const a = readFileSync(join(d, 'signed', names.keyed));
    const b = readFileSync(join(d, 'signed', names.stable));
    expect(a.equals(b)).toBe(true);

    // IR-UPD-8-1 #1: a Release file that differs from this run's build is refused; so is a build
    // without this run's sums (only a renewal, bound to the release commit's attestation, has none).
    const buildArgs = (extra, out) => [
      'build',
      '--version',
      VERSION,
      '--channel',
      'stable',
      '--dir',
      assets,
      '--root-key',
      rk,
      '--repository',
      '4thtech/agentlink',
      ...extra,
      '--out',
      join(d, out),
    ];
    const swapped = join(d, 'swapped-sums.txt');
    writeFileSync(
      swapped,
      `${lines.map((l, i) => (i === 0 ? `${'f'.repeat(64)}${l.slice(64)}` : l)).join('\n')}\n`,
    );
    await expect(main(buildArgs(['--build-sums', swapped], 'u2.json'), io)).rejects.toThrow(
      /this run's build/,
    );
    await expect(main(buildArgs([], 'u3.json'), io)).rejects.toThrow(ToolError);
    // Renewal: no build records and no build sums; the release assets and the pin only.
    rmSync(join(assets, 'inputs-mac-arm64.json'));
    await main(buildArgs(['--renewal'], 'u4.json'), io);
    expect(JSON.parse(readFileSync(join(d, 'u4.json'), 'utf8'))).toEqual(
      JSON.parse(readFileSync(join(d, 'unsigned.json'), 'utf8')),
    );
    await expect(
      main(buildArgs(['--renewal', '--build-sums', buildSums], 'u5.json'), io),
    ).rejects.toThrow(ToolError);
    expect(out.join('\n')).not.toContain(k1.secretHex);
    // A changed stable copy is refused by verify.
    writeFileSync(join(d, 'signed', names.stable), `${b.toString()} `);
    await expect(
      main(
        [
          'verify',
          '--dir',
          join(d, 'signed'),
          '--root-key',
          rk,
          '--version',
          VERSION,
          '--channel',
          'stable',
        ],
        io,
      ),
    ).rejects.toThrow(ToolError);
  });
});

describe('renewal warning (scheduled, no secret)', () => {
  const doc = (expiresInDays) =>
    JSON.stringify({
      expires: new Date(NOW + expiresInDays * DAY).toISOString().replace('.000Z', 'Z'),
    });
  it('ok above 7 days, warns within 7 days, fails when expired or unreadable', () => {
    expect(expiryStatus(doc(10), NOW, 7).level).toBe('ok');
    expect(expiryStatus(doc(6), NOW, 7).level).toBe('warn');
    expect(expiryStatus(doc(-1), NOW, 7).level).toBe('expired');
    expect(expiryStatus('nope', NOW, 7).level).toBe('error');
    expect(expiryStatus(JSON.stringify({ expires: 'soon' }), NOW, 7).level).toBe('error');
  });
});

// --- the workflow ----------------------------------------------------------------------------------

/** The body of one job: from `  <name>:` to the next job header or the end. */
function job(source, name) {
  const start = source.indexOf(`\n  ${name}:\n`);
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 2);
}
function permissions(body) {
  const m = body.match(/\n {4}permissions:\n((?: {6}[^\n]*\n)+)/);
  if (!m) return [];
  return m[1]
    .split('\n')
    .filter(Boolean)
    .map((l) => l.replace(/#.*$/, '').trim());
}
/** The steps of a job, split at `      - name:`. */
function steps(body) {
  return body.split(/\n(?= {6}- name: )/).slice(1);
}

describe('release.yml: desktop-app-release attaches the zips and reports the update mode', () => {
  const attach = job(release, 'desktop-app-release');
  it('attaches the Mac zips next to the DMGs, and outputs the update mode of the builds', () => {
    expect(attach).toContain('"AgentLink-$VERSION-mac-arm64.zip" "AgentLink-$VERSION-mac-x64.zip"');
    expect(attach).toMatch(
      /\n {4}outputs:\n {6}updates: \$\{\{ steps\.mode\.outputs\.updates \}\}/,
    );
    expect(attach).toMatch(/inputs-mac-arm64\.json/);
    expect(attach).not.toMatch(/secrets\./);
  });
  // IR-UPD-8-1 #1: the build's own sums leave this job as an output, never as a Release file.
  it('outputs the build sums of the zips and DMGs it checked against the build', () => {
    expect(attach).toMatch(/\n {6}build-sums: \$\{\{ steps\.names\.outputs\.build-sums \}\}/);
    const step = attach.slice(attach.indexOf('- name: Check the names and the sums'));
    expect(step).toMatch(/\n {8}id: names\n/);
    expect(step).toMatch(/build-sums<<[A-Z_]+/);
  });
});

describe('release.yml: desktop-update-manifest (no secret)', () => {
  const prep = job(release, 'desktop-update-manifest');
  it('runs on push to main after the app is attached, with updates on; no secret, read-only', () => {
    expect(prep).not.toBe('');
    expect(prep).toMatch(/needs: \[[^\]]*desktop-app-release[^\]]*\]/);
    expect(prep).toMatch(/github\.event_name == 'push'/);
    expect(prep).toMatch(/github\.ref == 'refs\/heads\/main'/);
    expect(prep).toMatch(/needs\.desktop-app-release\.outputs\.updates == 'on'/);
    expect(prep).not.toMatch(/secrets\.|environment:/);
    expect(permissions(prep).sort()).toEqual(['attestations: read', 'contents: read']);
  });
  it('verifies the attestations and the sums of the release assets, then builds the manifest', () => {
    expect(prep).toMatch(/gh attestation verify [^\n]*--signer-workflow/);
    // IR-UPD-8-1 #1: bound to this commit on main, signed by desktop.yml at this commit.
    const verify = prep.match(/gh attestation verify [^\n]*/)[0];
    expect(verify).toContain('--source-digest "$GITHUB_SHA"');
    expect(verify).toContain('--source-ref refs/heads/main');
    expect(verify).toContain('--signer-digest "$GITHUB_SHA"');
    expect(prep).toMatch(/BUILD_SUMS: \$\{\{ needs\.desktop-app-release\.outputs\.build-sums \}\}/);
    expect(prep).toMatch(/--build-sums "\$RUNNER_TEMP\/build-sums\.txt"/);
    expect(prep).not.toMatch(/--renewal/);
    expect(prep).toMatch(/needs: \[[^\]]*desktop-update-environment[^\]]*\]/);
    expect(prep).toMatch(/sha256sum --check --strict SHA256SUMS-desktop-app\.txt/);
    expect(prep).toMatch(/desktop-update-manifest\.mjs build/);
    expect(prep).toMatch(/--root-key apps\/desktop\/src\/main\/updater\/root-key\.json/);
    expect(prep).toMatch(/ref: \$\{\{ github\.sha \}\}/);
  });
});

describe('release.yml: sign-update-manifest (the one job with the key)', () => {
  const signJob = job(release, 'sign-update-manifest');
  const all = steps(signJob);
  const at = (name) => all.findIndex((s) => s.includes(`- name: ${name}`));

  it('environment desktop-update, contents: write only, push to main only, after the manifest job', () => {
    expect(signJob).not.toBe('');
    expect(signJob).toMatch(/\n {4}environment: desktop-update\n/);
    expect(permissions(signJob)).toEqual(['contents: write']);
    expect(signJob).toMatch(/needs: \[[^\]]*desktop-update-manifest[^\]]*\]/);
    expect(signJob).toMatch(/github\.event_name == 'push'/);
    expect(signJob).toMatch(/github\.ref == 'refs\/heads\/main'/);
    expect(signJob).toMatch(/vars\.DEPLOY_FREEZE != 'true'/);
    expect(signJob).toMatch(/Stop if DEPLOY_FREEZE is set/);
    expect(signJob).toMatch(/ref: \$\{\{ github\.sha \}\}/);
    expect(signJob).toMatch(/persist-credentials: false/);
    expect(signJob).toMatch(/timeout-minutes: \d+/);
  });

  it('the key is read in exactly one step, from one env var, and nowhere else in release.yml', () => {
    expect(release.match(/secrets\.DESKTOP_UPDATE_KEY/g)).toHaveLength(1);
    const withSecret = all.filter((s) => /secrets\./.test(s));
    expect(withSecret).toHaveLength(1);
    const s = withSecret[0];
    expect(s).toMatch(/- name: Sign the update manifest\n/);
    expect(s).toMatch(/\n {10}DESKTOP_UPDATE_KEY: \$\{\{ secrets\.DESKTOP_UPDATE_KEY \}\}\n/);
    expect(s).not.toMatch(
      /GH_TOKEN|github\.token|set -x|echo "\$DESKTOP_UPDATE_KEY|run: .*secrets/,
    );
    expect(s).toMatch(/desktop-update-manifest\.mjs sign/);
  });

  it('checks with the app parser, then publishes; a bad or unsigned manifest stops before the upload', () => {
    const signAt = at('Sign the update manifest');
    const verifyAt = at('Check the signed manifest with the app');
    const publishAt = at('Publish the update manifest');
    expect(signAt).toBeGreaterThan(0);
    expect(verifyAt).toBeGreaterThan(signAt);
    expect(publishAt).toBeGreaterThan(verifyAt);
    expect(all[verifyAt]).toMatch(/desktop-update-manifest\.mjs verify/);
    expect(all[verifyAt]).not.toMatch(/continue-on-error|\|\| true/);
    expect(all[publishAt]).not.toMatch(/\n {8}if:|continue-on-error/);
    expect(all[publishAt]).toMatch(/desktop-update\.json/);
    expect(all[publishAt]).not.toMatch(/secrets\./);
    // Builds the app's verifier before the key is read; nothing after the sign step installs code.
    expect(at('Build the verifier')).toBeLessThan(signAt);
    // IR-UPD-8-1 #5: a re-run never signs a release that is no longer Latest.
    const latestAt = at('Check the release is still Latest');
    expect(latestAt).toBeGreaterThan(0);
    expect(latestAt).toBeLessThan(signAt);
    expect(all[latestAt]).toMatch(/releases\/latest/);
    for (const s of all.slice(signAt)) expect(s).not.toMatch(/pnpm install|setup-node-pnpm|turbo/);
  });
});

describe('desktop-update-expiry.yml: renewal warning 7 days before expiry', () => {
  const wf = readFileSync(join(root, '.github/workflows/desktop-update-expiry.yml'), 'utf8');
  it('is scheduled, needs no secret, reads only', () => {
    expect(wf).toMatch(/\n {2}schedule:\n {4}- cron: /);
    expect(wf).toMatch(/\npermissions: \{\}\n/);
    expect(wf).not.toMatch(/secrets\.|environment:/);
    expect(wf).toMatch(/desktop-update-expiry\.mjs[^\n]*--warn-days 7/);
    expect(wf).toContain('releases/latest/download/desktop-update.json');
  });
});

// IR-UPD-8-1 #2: GitHub creates a missing environment with no rules on first use. Before any job can
// reach the key, a job without a secret checks that `desktop-update` exists with a required reviewer,
// a main-only branch rule and no admin bypass.
describe('the desktop-update environment check (IR-UPD-8-1 #2)', () => {
  const good = {
    name: 'desktop-update',
    can_admins_bypass: false,
    protection_rules: [
      {
        type: 'required_reviewers',
        reviewers: [{ type: 'User', reviewer: { login: 'talirezun', id: OWNER_ID } }],
      },
      { type: 'branch_policy' },
    ],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  const mainOnly = { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] };

  it('passes the protected environment', () => {
    expect(() => checkEnvironment(good, mainOnly)).not.toThrow();
  });

  it.each([
    ['missing', null],
    ['admin bypass', { ...good, can_admins_bypass: true }],
    ['no bypass field', { ...good, can_admins_bypass: undefined }],
    ['no reviewer', { ...good, protection_rules: [{ type: 'branch_policy' }] }],
    [
      'an empty reviewer list',
      { ...good, protection_rules: [{ type: 'required_reviewers', reviewers: [] }] },
    ],
    ['no branch rule', { ...good, deployment_branch_policy: null }],
    [
      'protected branches instead of main',
      {
        ...good,
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      },
    ],
  ])('fails when %s', (_label, env) => {
    expect(() => checkEnvironment(env, mainOnly)).toThrow(EnvironmentError);
  });

  it.each([
    ['no branch', { total_count: 0, branch_policies: [] }],
    [
      'another branch too',
      {
        total_count: 2,
        branch_policies: [
          { name: 'main', type: 'branch' },
          { name: 'wave-4', type: 'branch' },
        ],
      },
    ],
    ['a pattern', { total_count: 1, branch_policies: [{ name: '*', type: 'branch' }] }],
    ['a tag', { total_count: 1, branch_policies: [{ name: 'main', type: 'tag' }] }],
  ])('fails when the branch rule has %s', (_label, policies) => {
    expect(() => checkEnvironment(good, policies)).toThrow(EnvironmentError);
  });

  const envJob = job(release, 'desktop-update-environment');
  it('runs in release.yml without a secret, read-only, before the manifest job', () => {
    expect(envJob).not.toBe('');
    expect(envJob).not.toMatch(/secrets\.|\n {4}environment:/);
    expect(permissions(envJob)).toEqual(['actions: read', 'contents: read']);
    expect(envJob).toMatch(/gh api [^\n]*environments\/desktop-update/);
    expect(envJob).toMatch(/deployment-branch-policies/);
    expect(envJob).toMatch(/desktop-update-environment\.mjs/);
  });
});

// IR-UPD-8-1 #4/#5: renewal is its own dispatch-only workflow that re-signs the CURRENT Latest
// release, rebuilt from the Release assets and their attestations bound to the release commit on
// main (no build artifacts), under the same environment and the same environment check.
describe('desktop-update-renew.yml (IR-UPD-8-1 #4)', () => {
  const wf = readFileSync(join(root, '.github/workflows/desktop-update-renew.yml'), 'utf8');
  it('is dispatch-only, on main, with permissions {} at the top', () => {
    const on = wf.slice(wf.indexOf('\non:'), wf.indexOf('\npermissions:'));
    expect(on).toMatch(/workflow_dispatch:/);
    expect(on).not.toMatch(/push:|schedule:|pull_request|workflow_run|workflow_call/);
    expect(wf).toMatch(/\npermissions: \{\}\n/);
    expect(wf).toMatch(/github\.ref == 'refs\/heads\/main'/);
  });
  it('checks the environment, the Latest release and the attestations bound to its commit', () => {
    expect(wf).toMatch(/desktop-update-environment\.mjs/);
    expect(wf).toMatch(/releases\/latest/);
    const verify = wf.match(/gh attestation verify [^\n]*/)[0];
    expect(verify).toContain('--source-digest "$RELEASE_SHA"');
    expect(verify).toContain('--source-ref refs/heads/main');
    expect(verify).toContain('--signer-digest "$RELEASE_SHA"');
    expect(wf).toMatch(/desktop-update-manifest\.mjs build [^\n]*--renewal/);
    expect(wf).not.toMatch(/pattern: desktop-app-|name: desktop-app-/);
  });
  it('signs in one step of a job in environment desktop-update, checks, then publishes', () => {
    expect(wf.match(/secrets\.DESKTOP_UPDATE_KEY/g)).toHaveLength(1);
    expect(wf.match(/secrets\./g)).toHaveLength(1);
    const signJob = job(wf, 'renew-sign');
    expect(signJob).toMatch(/\n {4}environment: desktop-update\n/);
    expect(permissions(signJob)).toEqual(['contents: write']);
    const all = steps(signJob);
    const at = (name) => all.findIndex((st) => st.includes(`- name: ${name}`));
    const checkName = "Check the signed manifest with the app's own checks";
    expect(at('Check the release is still Latest')).toBeGreaterThan(0);
    expect(at('Check the release is still Latest')).toBeLessThan(at('Sign the update manifest'));
    expect(at('Sign the update manifest')).toBeLessThan(at(checkName));
    expect(at(checkName)).toBeLessThan(at('Publish the update manifest'));
    for (const st of all.slice(at('Sign the update manifest'))) {
      expect(st).not.toMatch(/pnpm install|setup-node-pnpm|turbo/);
    }
    expect(permissions(job(wf, 'renew-manifest')).sort()).toEqual([
      'attestations: read',
      'contents: read',
    ]);
  });
  it('the expiry warning points at the renewal workflow', () => {
    expect(RENEW).toContain('desktop-update-renew');
  });
});

// WIN-INAPP-UPDATE: the Windows setup is in the signed manifest, the signature covers it, the app
// picks it on win32/x64 (kind nsis), and the workflows check its attestation and build record.
describe('WIN-INAPP-UPDATE: the Windows setup in the signed manifest', () => {
  const ctx = (over = {}) => ({
    root: { rootPublicKey: k1.publicKey, minimumStatementSequence: 0 },
    currentVersion: '0.5.2',
    channel: 'stable',
    platform: 'win32',
    arch: 'x64',
    kind: 'nsis',
    failedVersion: null,
    now: NOW,
    ...over,
  });
  const enc = (t) => new TextEncoder().encode(t);

  it('the app accepts the signed manifest on win32/x64 and selects the setup', () => {
    const { text } = sign();
    const accepted = verifier.acceptManifest(verifier.parseUpdateDocument(enc(text)), ctx());
    expect(accepted.asset).toEqual({
      platform: 'win32',
      arch: 'x64',
      kind: 'nsis',
      url: `https://github.com/4thtech/agentlink/releases/download/v${VERSION}/AgentLink-${VERSION}-win-x64-setup.exe`,
      sha256: hex('f'),
      size: 130_000_005,
    });
    // No Windows arm64 build: an arm64 Windows asks for x64 (host.ts), nothing else is offered.
    expect(() =>
      verifier.acceptManifest(verifier.parseUpdateDocument(enc(text)), ctx({ arch: 'arm64' })),
    ).toThrow(/no installer/);
  });

  it('the signature covers the Windows asset: a changed hash, size or URL is refused', () => {
    const { text } = sign();
    for (const change of [
      (a) => ({ ...a, sha256: hex('0') }),
      (a) => ({ ...a, size: a.size + 1 }),
      (a) => ({ ...a, url: a.url.replace('win-x64-setup', 'win-x64-setup2') }),
    ]) {
      const doc = JSON.parse(text);
      doc.assets = doc.assets.map((a) => (a.platform === 'win32' ? change(a) : a));
      expect(() =>
        verifier.acceptManifest(verifier.parseUpdateDocument(enc(JSON.stringify(doc))), ctx()),
      ).toThrow(/signature/);
    }
  });

  const renew = readFileSync(join(root, '.github/workflows/desktop-update-renew.yml'), 'utf8');
  const attested = (source) => {
    const m = source.match(/for f in ([^;]*); do\n\s*gh attestation verify/);
    return m === null ? '' : m[1];
  };
  it('release.yml and the renewal check the setup’s build provenance attestation', () => {
    expect(attested(job(release, 'desktop-update-manifest'))).toContain(
      '"AgentLink-$VERSION-win-x64-setup.exe"',
    );
    expect(attested(renew)).toContain('"AgentLink-$VERSION-win-x64-setup.exe"');
  });

  it('the manifest job reads the Windows build record; the attach job checks its update mode and pin', () => {
    const prep = job(release, 'desktop-update-manifest');
    expect(prep).toMatch(/inputs-win-x64\.json/);
    const attach = job(release, 'desktop-app-release');
    const mode = attach.slice(attach.indexOf('- name: Read the update mode of the builds'));
    expect(mode).toMatch(/inputs-win-x64\.json/);
    // No new permission or secret on either job.
    expect(permissions(prep).sort()).toEqual(['attestations: read', 'contents: read']);
    expect(prep).not.toMatch(/secrets\./);
  });
});
