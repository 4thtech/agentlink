// WP-D10, format v2 (UPD-1): the offline signing tool against the app's own verifier
// (apps/desktop/src/main/updater). Every refusal of the plan's acceptance list, the re-pin (a release
// that pins a new key) and the phase-1 flow with a fake network. Owner decision 2026-11-13: one
// update key pinned in the app; no root key and no key statements.
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { encodeHex, encodeUtf8, sha256 } from '@4thtech-io/crypto';
import { bip340PublicKey, bip340Sign } from '@4thtech-io/crypto/keystore';
import {
  MAX_DOCUMENT_BYTES,
  acceptManifest,
  parseUpdateDocument,
  pinnedRoot,
} from '../../apps/desktop/src/main/updater/manifest.ts';
import { saveFailedVersion } from '../../apps/desktop/src/main/updater/state.ts';
import { DOCUMENT_URLS, runUpdateCheck } from '../../apps/desktop/src/main/updater/index.ts';
import * as appVerifier from '../../apps/desktop/src/main/updater/manifest.ts';
import {
  ToolError,
  generateKeyFile,
  main,
  manifestMessage,
  openKeyFile,
  readKeyFile,
  refuseInCi,
  signManifest,
} from './sign-manifest.mjs';

const FAST_KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 };
const PASS = encodeUtf8('correct horse battery staple');
const NOW = Date.parse('2026-11-12T10:00:00Z');
const DAY = 86_400_000;

function key(role = 'update') {
  for (;;) {
    const secretKey = crypto.getRandomValues(new Uint8Array(32));
    try {
      return { role, secretKey, publicKey: encodeHex(bip340PublicKey(secretKey)) };
    } catch {
      /* out of range: draw again */
    }
  }
}

const k1 = key();
const k2 = key();
const PINNED = pinnedRoot({ rootPublicKey: k1.publicKey, minimumStatementSequence: 0 });

const INSTALLER = encodeUtf8('pretend this is AgentLink-0.5.0-arm64.dmg');
const assetFor = (version, bytes = INSTALLER, extra = {}) => ({
  platform: 'darwin',
  arch: 'arm64',
  kind: 'dmg',
  url: `https://github.com/4thtech/agentlink/releases/download/v${version}/AgentLink-${version}-arm64.dmg`,
  sha256: encodeHex(sha256(bytes)),
  size: bytes.length,
  ...extra,
});
const zipFor = (version) =>
  assetFor(version, INSTALLER, {
    kind: 'zip',
    url: `https://github.com/4thtech/agentlink/releases/download/v${version}/AgentLink-${version}-arm64.zip`,
  });
const unsignedFor = (version, extra = {}) => ({
  domain: 'agentlink-desktop-update/v2',
  channel: 'stable',
  version,
  minimumVersion: '0.4.0',
  assets: [
    assetFor(version),
    {
      ...assetFor(version),
      platform: 'win32',
      arch: 'x64',
      kind: 'nsis',
      url: `https://github.com/4thtech/agentlink/releases/download/v${version}/AgentLink-${version}-setup.exe`,
    },
  ],
  ...extra,
});
const manifest = (version, update = k1, opts = {}) =>
  signManifest({
    update,
    unsigned: unsignedFor(version, opts.extra),
    now: opts.now ?? NOW - 60_000,
    days: opts.days,
  });

const bytesOf = (value) => encodeUtf8(JSON.stringify(value));
const omit = (o, name) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== name));
const ctx = (extra = {}) => ({
  root: PINNED,
  currentVersion: '0.4.13',
  channel: 'stable',
  platform: 'darwin',
  arch: 'arm64',
  kind: 'dmg',
  failedVersion: null,
  now: NOW,
  ...extra,
});
/** Parses as the app does, then accepts; returns the accepted update or the refusal code. */
function check(value, context = ctx()) {
  try {
    const doc = parseUpdateDocument(typeof value === 'string' ? encodeUtf8(value) : bytesOf(value));
    return acceptManifest(doc, context);
  } catch (error) {
    if (error?.name === 'UpdateRefusal') return error.code;
    throw error;
  }
}
/** Re-signs a modified manifest body with `signer` (to test rules behind the signature). */
const resign = (m, signer) => {
  const body = omit(m, 'sig');
  return { ...body, sig: encodeHex(bip340Sign(signer.secretKey, manifestMessage(body))) };
};

const good = manifest('0.5.0');

describe('the tool stays offline and off CI', () => {
  it('refuses to run when CI or GITHUB_ACTIONS is set, before asking anything', async () => {
    expect(() => refuseInCi({ CI: 'true' })).toThrow(ToolError);
    expect(() => refuseInCi({ GITHUB_ACTIONS: 'true' })).toThrow(ToolError);
    expect(() => refuseInCi({})).not.toThrow();
    let asked = false;
    const io = { readHidden: async () => ((asked = true), PASS) };
    await expect(
      main(['generate', '--out', '/nonexistent/x'], { env: { CI: '1' }, io }),
    ).rejects.toThrow(/does not run in CI/);
    expect(asked).toBe(false);
  });

  it('imports no network module and calls no network API', () => {
    const source = readFileSync(new URL('./sign-manifest.mjs', import.meta.url), 'utf8');
    for (const banned of [
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'node:dgram',
      'node:child_process',
      'fetch(',
      'WebSocket',
      'XMLHttpRequest',
    ]) {
      expect(source.includes(banned), banned).toBe(false);
    }
  });
});

describe('key files (ALKU sealing)', () => {
  let file;
  beforeAll(async () => {
    file = await generateKeyFile({ passphrase: PASS, kdf: FAST_KDF });
  });

  it('round-trips and re-derives the public key', async () => {
    expect(file.format).toBe('agentlink-desktop-key/v1');
    expect(file.role).toBe('update');
    expect(Object.keys(file).sort()).toEqual(['format', 'publicKey', 'role', 'sealed']);
    const opened = await openKeyFile(file, 'update', PASS);
    expect(encodeHex(bip340PublicKey(opened.secretKey))).toBe(file.publicKey);
  });

  it('refuses a wrong passphrase, the root role, a swapped public key and a short passphrase', async () => {
    await expect(
      openKeyFile(file, 'update', encodeUtf8('not the right passphrase')),
    ).rejects.toThrow(/wrong passphrase/);
    expect(() => readKeyFile({ ...file, role: 'root' })).toThrow(/unknown role/);
    await expect(openKeyFile({ ...file, publicKey: k2.publicKey }, 'update', PASS)).rejects.toThrow(
      /does not match/,
    );
    expect(() => readKeyFile({ ...file, extra: 1 })).toThrow(ToolError);
    await expect(
      generateKeyFile({ role: 'root', passphrase: PASS, kdf: FAST_KDF }),
    ).rejects.toThrow(/role must be update/);
    await expect(
      generateKeyFile({ passphrase: encodeUtf8('short'), kdf: FAST_KDF }),
    ).rejects.toThrow(/16 characters/);
  });

  it('signs manifests only with the update role, and only a known channel', () => {
    expect(() =>
      signManifest({ update: { ...k1, role: 'root' }, unsigned: unsignedFor('0.5.0') }),
    ).toThrow(/update key/);
    expect(() =>
      signManifest({ update: k1, unsigned: unsignedFor('0.5.0', { channel: 'nightly' }) }),
    ).toThrow(/channel/);
    expect(() =>
      signManifest({ update: k1, unsigned: { ...unsignedFor('0.5.0'), statement: {} } }),
    ).toThrow(/expected exactly/);
  });
});

describe('the app accepts a manifest the tool signed', () => {
  it('accepts the good manifest for this computer', () => {
    const accepted = check(good);
    expect(good.domain).toBe('agentlink-desktop-update/v2');
    expect(accepted.version).toBe('0.5.0');
    expect(accepted.required).toBe(false);
    expect(accepted.asset.platform).toBe('darwin');
    expect(check(good, ctx({ platform: 'win32', arch: 'x64', kind: 'nsis' })).asset.url).toMatch(
      /setup\.exe$/,
    );
    expect(check(good, ctx({ currentVersion: '0.3.9' })).required).toBe(true);
  });
});

describe('refusals (plan acceptance list)', () => {
  it('tampered: any signed field changed after signing', () => {
    expect(check({ ...good, minimumVersion: '0.4.1' })).toBe('bad_signature');
    expect(check({ ...good, assets: [{ ...good.assets[0], sha256: '0'.repeat(64) }] })).toBe(
      'bad_signature',
    );
    expect(
      check({ ...good, assets: [{ ...good.assets[0], kind: 'zip', url: zipFor('0.5.0').url }] }),
    ).toBe('bad_signature');
  });

  it('unsigned: no sig on the manifest', () => {
    expect(check(omit(good, 'sig'))).toBe('unsigned');
  });

  it('wrong key: a manifest by or naming a key that is not pinned', () => {
    expect(check(manifest('0.5.0', k2))).toBe('wrong_key');
    expect(check(resign({ ...good, updateKey: k2.publicKey }, k2))).toBe('wrong_key');
    expect(check(resign(good, k2))).toBe('bad_signature'); // names the pinned key, signed by another
  });

  it('re-pin (replaces the unrotated-key test): after a release pins a new key, the old key is refused', () => {
    const repinned = pinnedRoot({ rootPublicKey: k2.publicKey, minimumStatementSequence: 0 });
    expect(check(manifest('0.6.0', k1), ctx({ root: repinned }))).toBe('wrong_key');
    expect(check(manifest('0.6.0', k2), ctx({ root: repinned })).version).toBe('0.6.0');
  });

  it('downgrade: the same or an older version', () => {
    expect(check(manifest('0.4.13'))).toBe('not_newer');
    expect(check(manifest('0.4.2'))).toBe('not_newer');
    expect(check(manifest('0.5.0'), ctx({ currentVersion: '0.5.0' }))).toBe('not_newer');
    expect(
      check(
        manifest('0.5.0-beta.1', k1, { extra: { channel: 'beta' } }),
        ctx({ channel: 'beta', currentVersion: '0.5.0' }),
      ),
    ).toBe('not_newer');
  });

  it('failed version: a version that failed to start here is never offered again', () => {
    expect(check(good, ctx({ failedVersion: '0.5.0' }))).toBe('failed_version');
    expect(check(good, ctx({ failedVersion: '0.4.99' })).version).toBe('0.5.0');
  });

  it('wrong channel, platform, arch or kind', () => {
    expect(check(good, ctx({ channel: 'beta' }))).toBe('wrong_channel');
    const beta = manifest('0.5.0', k1, { extra: { channel: 'beta' } });
    expect(check(beta)).toBe('wrong_channel');
    expect(check(beta, ctx({ channel: 'beta' })).version).toBe('0.5.0');
    expect(check(good, ctx({ platform: 'linux' }))).toBe('no_asset_for_this_computer');
    expect(check(good, ctx({ arch: 'x64' }))).toBe('no_asset_for_this_computer');
    expect(check(good, ctx({ platform: 'win32', arch: 'arm64', kind: 'nsis' }))).toBe(
      'no_asset_for_this_computer',
    );
    expect(check(good, ctx({ kind: 'zip' }))).toBe('no_asset_for_this_computer');
    const both = manifest('0.5.0', k1, {
      extra: { assets: [assetFor('0.5.0'), zipFor('0.5.0')] },
    });
    expect(check(both, ctx({ kind: 'zip' })).asset.url).toMatch(/\.zip$/);
    expect(check(both).asset.url).toMatch(/\.dmg$/);
    expect(check(manifest('0.5.0-beta.1'))).toBe('malformed'); // a prerelease on stable
  });

  it('old format: a v1 manifest is refused for install, even with a good signature', () => {
    expect(check({ ...good, domain: 'agentlink-desktop-update/v1' })).toBe('old_format');
    expect(check({ domain: 'agentlink-desktop-root/v1' })).toBe('old_format');
  });

  it('expired, or dated in the future', () => {
    expect(check(good, ctx({ now: NOW + 31 * DAY }))).toBe('expired');
    expect(check(manifest('0.5.0', k1, { now: NOW + DAY }))).toBe('not_yet_valid');
    expect(check(manifest('0.5.0', k1, { days: 31 }))).not.toBeTypeOf('string');
    expect(check(resign({ ...good, expires: '2027-01-12T10:00:00Z' }, k1))).toBe('malformed'); // > 31 days
  });

  it('wrong host or URL form', () => {
    for (const url of [
      'https://evil.example/4thtech/agentlink/releases/download/v0.5.0/AgentLink-0.5.0-arm64.dmg',
      'http://github.com/4thtech/agentlink/releases/download/v0.5.0/AgentLink-0.5.0-arm64.dmg',
      'https://github.com/someone/agentlink/releases/download/v0.5.0/AgentLink-0.5.0-arm64.dmg',
      'https://github.com/4thtech/agentlink/releases/download/v0.4.0/AgentLink-0.5.0-arm64.dmg',
      'https://user@github.com/4thtech/agentlink/releases/download/v0.5.0/AgentLink-0.5.0-arm64.dmg',
      'https://github.com:444/4thtech/agentlink/releases/download/v0.5.0/AgentLink-0.5.0-arm64.dmg',
    ]) {
      expect(check(resign({ ...good, assets: [{ ...good.assets[0], url }] }, k1)), url).toBe(
        'wrong_host',
      );
    }
    for (const name of [
      '../x.dmg',
      'a/b.dmg',
      'AgentLink.exe',
      'AgentLink.dmg?x=1',
      'AgentLink%2e.dmg',
      'AgentLink.zip',
    ]) {
      const url = `https://github.com/4thtech/agentlink/releases/download/v0.5.0/${name}`;
      expect(check(resign({ ...good, assets: [{ ...good.assets[0], url }] }, k1)), name).toBe(
        'malformed',
      );
    }
  });

  it('unknown fields, at every level', () => {
    expect(check({ ...good, note: 'x' })).toBe('unknown_field');
    expect(check({ ...good, assets: [{ ...good.assets[0], note: 'x' }] })).toBe('unknown_field');
    expect(check({ ...good, statement: {} })).toBe('unknown_field');
  });

  it('oversize, duplicate or escaped member names, wrong types (D-128)', () => {
    const text = JSON.stringify(good);
    expect(check(text + ' '.repeat(MAX_DOCUMENT_BYTES - text.length + 1))).toBe('oversize');
    expect(check(text.replace('{"domain"', '{"version":"9.9.9","domain"'))).toBe('malformed');
    expect(check(text.replace('"channel"', '"\\u0063hannel"'))).toBe('malformed');
    expect(check(resign({ ...good, assets: [{ ...good.assets[0], size: 1.5 }] }, k1))).toBe(
      'malformed',
    );
    expect(
      check(resign({ ...good, assets: [{ ...good.assets[0], sha256: 'AB'.repeat(32) }] }, k1)),
    ).toBe('malformed');
    expect(check(resign({ ...good, assets: [good.assets[0], good.assets[0]] }, k1))).toBe(
      'malformed',
    );
    expect(check(resign({ ...good, released: '2026-11-12T10:00:00.000Z' }, k1))).toBe('malformed');
    expect(check(resign({ ...good, minimumVersion: '0.6.0' }, k1))).toBe('malformed');
    expect(check('[]')).toBe('malformed');
    expect(check(new TextDecoder().decode(Uint8Array.of(0xff)))).toBe('malformed');
  });
});

describe('the shared vectors', () => {
  it('the tool computes the same messages as the independent generator', () => {
    const vectors = JSON.parse(
      readFileSync(
        new URL('../../test-vectors/desktop-update/vectors.json', import.meta.url),
        'utf8',
      ),
    );
    let checked = 0;
    for (const c of vectors.cases) {
      const doc = c.input.document;
      if (c.input.tag !== doc.domain || !doc.domain.endsWith('/v2')) continue;
      expect(encodeHex(manifestMessage(doc)), c.id).toBe(c.expected.message);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(7);
  });
});

describe('phase 1 flow: verified download, then "Open the installer"', () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup({
    installer = INSTALLER,
    redirectTo = 'https://objects.githubusercontent.com/x/y',
    answer = 0,
    document = good,
  } = {}) {
    const stateDir = mkdtempSync(join(tmpdir(), 'agentlink-upd-state-'));
    const tempRoot = mkdtempSync(join(tmpdir(), 'agentlink-upd-tmp-'));
    dirs.push(stateDir, tempRoot);
    const seen = [];
    const opened = [];
    const fetchImpl = async (url, init) => {
      seen.push(url);
      expect(init.redirect).toBe('manual');
      if (url === DOCUMENT_URLS.stable)
        return new Response(JSON.stringify(document), { status: 200 });
      if (url === good.assets[0].url)
        return new Response(null, { status: 302, headers: { location: redirectTo } });
      if (url === redirectTo) return new Response(installer, { status: 200 });
      return new Response(null, { status: 404 });
    };
    const deps = {
      currentVersion: '0.4.13',
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
      stateDir,
      tempRoot,
      root: { rootPublicKey: k1.publicKey, minimumStatementSequence: 0 },
      now: () => NOW,
      fetch: fetchImpl,
      markDownloaded: async () => undefined,
      openPath: async (path) => {
        opened.push({ path, bytes: readFileSync(path) });
        return '';
      },
      showMessageBox: async (options) => {
        expect(options.buttons).toEqual(['Open the installer', 'Later']);
        expect(options.title).toBe('Update available');
        return { response: answer };
      },
    };
    return { deps, seen, opened, tempRoot, stateDir };
  }

  it('downloads into a private temp folder, checks it, and opens it only after "Open the installer"', async () => {
    const t = setup();
    expect(await runUpdateCheck(t.deps)).toEqual({ kind: 'opened', version: '0.5.0' });
    expect(t.opened).toHaveLength(1);
    expect(t.opened[0].path.startsWith(t.tempRoot)).toBe(true);
    expect(Buffer.from(t.opened[0].bytes).equals(Buffer.from(INSTALLER))).toBe(true);
  });

  it('"Later" opens nothing and removes the download', async () => {
    const t = setup({ answer: 1 });
    expect(await runUpdateCheck(t.deps)).toEqual({ kind: 'later', version: '0.5.0' });
    expect(t.opened).toHaveLength(0);
    expect(readdirSync(t.tempRoot)).toEqual([]);
  });

  it('wrong hash, wrong size and a redirect off the allowlist are refused and nothing is kept', async () => {
    const wrongHash = encodeUtf8('pretend this is AgentLink-0.5.0-arm64.dmX');
    for (const [opts, code] of [
      [{ installer: wrongHash }, 'hash_mismatch'],
      [{ installer: encodeUtf8('short') }, 'size_mismatch'],
      [{ installer: new Uint8Array(INSTALLER.length + 1) }, 'size_mismatch'],
      [{ redirectTo: 'https://evil.example/AgentLink.dmg' }, 'wrong_host'],
      [{ redirectTo: 'http://objects.githubusercontent.com/x' }, 'wrong_host'],
    ]) {
      const t = setup(opts);
      expect(await runUpdateCheck(t.deps)).toEqual({ kind: 'refused', code });
      expect(t.opened).toHaveLength(0);
      expect(readdirSync(t.tempRoot)).toEqual([]);
    }
  });

  it('a version recorded as failed is not offered; nothing is downloaded', async () => {
    const t = setup();
    await saveFailedVersion(t.stateDir, '0.5.0');
    expect(await runUpdateCheck(t.deps)).toEqual({ kind: 'refused', code: 'failed_version' });
    expect(t.seen).toEqual([DOCUMENT_URLS.stable]);
  });

  it('an older release is "up to date"; a refused document offers nothing', async () => {
    const t = setup({ document: manifest('0.4.0') });
    expect(await runUpdateCheck(t.deps)).toEqual({ kind: 'up_to_date' });
    const u = setup({ document: { ...good, minimumVersion: '0.4.5' } });
    expect(await runUpdateCheck(u.deps)).toEqual({ kind: 'refused', code: 'bad_signature' });
    expect(u.opened).toHaveLength(0);
    const v = setup({ document: manifest('0.5.0', k2) });
    expect(await runUpdateCheck(v.deps)).toEqual({ kind: 'refused', code: 'wrong_key' });
  });

  it('does nothing while the key is the placeholder', async () => {
    const t = setup();
    const deps = omit(t.deps, 'root');
    expect(await runUpdateCheck(deps)).toEqual({ kind: 'not_configured' });
    expect(t.seen).toEqual([]);
  });
});

describe('the command line, end to end (real offline KDF)', () => {
  it('generate → public-key → check → sign, then the app accepts it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentlink-keys-'));
    try {
      let answer = 'yes';
      const io = { readHidden: async () => PASS.slice(), readLine: async () => encodeUtf8(answer) };
      const lines = [];
      const run = (args) =>
        main(args, { env: {}, io, out: (l) => lines.push(l), verifier: appVerifier });
      const p = (name) => join(dir, name);
      await run(['generate', '--out', p('update.key')]);
      expect(statSync(p('update.key')).mode & 0o777).toBe(0o600);
      await expect(run(['generate', '--out', p('update.key')])).rejects.toThrow(/already exists/);
      const realUpdate = JSON.parse(readFileSync(p('update.key'), 'utf8'));
      expect(realUpdate.role).toBe('update');
      expect(readFileSync(p('update.key'), 'utf8')).not.toContain(new TextDecoder().decode(PASS));
      await run(['public-key', p('update.key')]);
      expect(lines.at(-1)).toBe(`update public key: ${realUpdate.publicKey}`);
      await run(['check', p('update.key')]);
      expect(lines.at(-1)).toMatch(/^OK: /);
      // The offline strength above (generate, refuse to overwrite, open to check) is the part that
      // needs 256 MiB derivations. The signing flow below opens a key file the same way whatever
      // its derivation setting is (it is read from the file), so it uses a quick-to-open file.
      const fast = await generateKeyFile({ passphrase: PASS, kdf: FAST_KDF });
      writeFileSync(p('update.key'), JSON.stringify(fast));
      writeFileSync(p('unsigned.json'), JSON.stringify(unsignedFor('0.5.0')));
      const signArgs = (out, pinned = fast.publicKey) => [
        'sign',
        '--update-key',
        p('update.key'),
        '--manifest',
        p('unsigned.json'),
        '--out',
        out,
        '--pinned-public',
        pinned,
      ];
      // Without a pinned key (root-key.json is the placeholder) and no --pinned-public: refused.
      await expect(run(signArgs(p('a.json')).slice(0, -2))).rejects.toThrow(/placeholder/);
      // A key file that is not the pinned key is refused before the passphrase is asked.
      await expect(run(signArgs(p('c.json'), k2.publicKey))).rejects.toThrow(
        /not the update key pinned/,
      );
      // The owner sees what is signed and must type yes.
      answer = 'no';
      await expect(run(signArgs(p('b.json')))).rejects.toThrow(/Not signed/);
      expect(existsSync(p('b.json'))).toBe(false);
      answer = 'yes';
      await run(signArgs(p('signed.json')));
      expect(lines.some((l) => l.includes('darwin/arm64 dmg') && l.includes('sha256'))).toBe(true);
      const appPinned = pinnedRoot({ rootPublicKey: fast.publicKey, minimumStatementSequence: 0 });
      const accepted = check(
        readFileSync(p('signed.json'), 'utf8'),
        ctx({ root: appPinned, now: Date.now() }),
      );
      expect(accepted.version).toBe('0.5.0');
      // The retired statement command and root role are gone.
      await expect(run(['statement', '--out', p('s.json')])).rejects.toThrow(ToolError);
      await expect(run(['generate', '--role', 'root', '--out', p('r.key')])).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Two real offline-strength key derivations (256 MiB, 4 passes).
  }, 300_000);
});
