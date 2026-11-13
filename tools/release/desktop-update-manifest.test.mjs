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
import { expiryStatus } from './desktop-update-expiry.mjs';

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
].join('\n');
const SIZES = new Map([
  [`AgentLink-${VERSION}-mac-arm64.dmg`, 120_000_001],
  [`AgentLink-${VERSION}-mac-x64.dmg`, 120_000_002],
  [`AgentLink-${VERSION}-mac-arm64.zip`, 110_000_003],
  [`AgentLink-${VERSION}-mac-x64.zip`, 110_000_004],
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
const PLACEHOLDER = readFileSync(
  join(root, 'apps/desktop/src/main/updater/root-key.json'),
  'utf8',
);
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
    expect(() => pinFromRootKeyJson(PLACEHOLDER)).toThrow(/placeholder|no real/i);
    expect(() => pinFromRootKeyJson(UPDATES_OFF)).toThrow(ToolError);
    expect(() => pinFromRootKeyJson('{')).toThrow(ToolError);
    expect(() => pinFromRootKeyJson(rootKeyJson('0'.repeat(64)))).toThrow(ToolError);
  });

  it('every built app must have updates on and carry exactly the pin of root-key.json', () => {
    const on = (pin, extra = {}) => ({ platform: 'darwin', updates: 'on', updatePin: pin, ...extra });
    expect(() => checkBuildInputs([on(k1.publicKey), on(k1.publicKey)], k1.publicKey)).not.toThrow();
    expect(() => checkBuildInputs([on(k1.publicKey), on(k2.publicKey)], k1.publicKey)).toThrow(
      /pin/,
    );
    expect(() =>
      checkBuildInputs([on(k1.publicKey), { updates: 'off', updatePin: null }], k1.publicKey),
    ).toThrow(/updates/);
    expect(() => checkBuildInputs([on(null)], k1.publicKey)).toThrow(ToolError);
    expect(() => checkBuildInputs([], k1.publicKey)).toThrow(ToolError);
    expect(() => checkBuildInputs([on(k1.publicKey)], k1.publicKey)).toThrow(/two|both|arm64|x64/i);
  });
});

describe('the unsigned manifest from the verified release assets', () => {
  it('lists the zip and the DMG for arm64 and x64 with their SHA-256, size and release URL', () => {
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
      })),
    });
    expect(releaseAssets(VERSION).map((a) => a.name)).toEqual([
      `AgentLink-${VERSION}-mac-arm64.zip`,
      `AgentLink-${VERSION}-mac-x64.zip`,
      `AgentLink-${VERSION}-mac-arm64.dmg`,
      `AgentLink-${VERSION}-mac-x64.dmg`,
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
    const { sig: _sig, ...noSig } = doc;
    expect(() => check(JSON.stringify(noSig))).toThrow(ToolError);
    expect(() =>
      check(JSON.stringify({ ...doc, assets: doc.assets.map((a) => ({ ...a, size: a.size + 1 })) })),
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
    for (const arch of ['arm64', 'x64']) {
      writeFileSync(
        join(assets, `inputs-mac-${arch}.json`),
        JSON.stringify({ platform: 'darwin', updates: 'on', updatePin: k1.publicKey }),
      );
    }
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
    JSON.stringify({ expires: new Date(NOW + expiresInDays * DAY).toISOString().replace('.000Z', 'Z') });
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
    expect(attach).toMatch(/\n {4}outputs:\n {6}updates: \$\{\{ steps\.mode\.outputs\.updates \}\}/);
    expect(attach).toMatch(/inputs-mac-arm64\.json/);
    expect(attach).not.toMatch(/secrets\./);
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
    expect(s).not.toMatch(/GH_TOKEN|github\.token|set -x|echo "\$DESKTOP_UPDATE_KEY|run: .*secrets/);
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
