// WP-D10: the offline signing tool against the app's own verifier (apps/desktop/src/main/updater).
// Every refusal of the plan's acceptance list, the full rotation rehearsal (introduce → release →
// rotate → old key refused → revoke → introduce again), and the phase-1 flow with a fake network.
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
  INITIAL_KEY_STATE,
  MAX_DOCUMENT_BYTES,
  acceptManifest,
  applyStatement,
  parseUpdateDocument,
  pinnedRoot,
} from '../../apps/desktop/src/main/updater/manifest.ts';
import { loadKeyState, saveKeyState } from '../../apps/desktop/src/main/updater/state.ts';
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
  signStatement,
  statementMessage,
} from './sign-manifest.mjs';

const FAST_KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 };
const PASS = encodeUtf8('correct horse battery staple');
const NOW = Date.parse('2026-11-12T10:00:00Z');
const DAY = 86_400_000;

function key(role) {
  for (;;) {
    const secretKey = crypto.getRandomValues(new Uint8Array(32));
    try {
      return { role, secretKey, publicKey: encodeHex(bip340PublicKey(secretKey)) };
    } catch {
      /* out of range: draw again */
    }
  }
}

const root = key('root');
const k1 = key('update');
const k2 = key('update');
const k3 = key('update');
const ROOT = pinnedRoot({ rootPublicKey: root.publicKey, minimumStatementSequence: 0 });

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
const statement = (sequence, action, updateKey, signer = root, opts = {}) =>
  signStatement({
    root: signer,
    action,
    channel: opts.channel ?? 'stable',
    updateKey,
    sequence,
    now: opts.now ?? NOW - DAY,
    expiresDays: opts.expiresDays ?? 395,
  });
const manifest = (version, update, stmt, opts = {}) =>
  signManifest({
    update,
    statement: stmt,
    unsigned: unsignedFor(version, opts.extra),
    now: opts.now ?? NOW - 60_000,
    days: opts.days,
  });

const bytesOf = (value) => encodeUtf8(JSON.stringify(value));
const omit = (o, name) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== name));
const ctx = (state = INITIAL_KEY_STATE, extra = {}) => ({
  root: ROOT,
  state,
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
    if (doc.kind !== 'manifest')
      return applyStatement(
        context.state,
        doc.statement,
        context.root,
        context.now,
        context.channel,
      );
    return acceptManifest(doc.manifest, context);
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

const s1 = statement(1, 'introduce', k1.publicKey);
const good = manifest('0.5.0', k1, s1);

describe('the tool stays offline and off CI', () => {
  it('refuses to run when CI or GITHUB_ACTIONS is set, before asking anything', async () => {
    expect(() => refuseInCi({ CI: 'true' })).toThrow(ToolError);
    expect(() => refuseInCi({ GITHUB_ACTIONS: 'true' })).toThrow(ToolError);
    expect(() => refuseInCi({})).not.toThrow();
    let asked = false;
    const io = { readHidden: async () => ((asked = true), PASS) };
    await expect(
      main(['generate', '--role', 'root', '--out', '/nonexistent/x'], { env: { CI: '1' }, io }),
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

describe('key files (ALKO sealing)', () => {
  let file;
  beforeAll(async () => {
    file = await generateKeyFile({ role: 'update', passphrase: PASS, kdf: FAST_KDF });
  });

  it('round-trips and re-derives the public key', async () => {
    expect(file.format).toBe('agentlink-desktop-key/v1');
    expect(Object.keys(file).sort()).toEqual(['format', 'publicKey', 'role', 'sealed']);
    const opened = await openKeyFile(file, 'update', PASS);
    expect(encodeHex(bip340PublicKey(opened.secretKey))).toBe(file.publicKey);
  });

  it('refuses a wrong passphrase, the wrong role, a swapped public key and a short passphrase', async () => {
    await expect(
      openKeyFile(file, 'update', encodeUtf8('not the right passphrase')),
    ).rejects.toThrow(/wrong passphrase/);
    await expect(openKeyFile(file, 'root', PASS)).rejects.toThrow(/update key/);
    await expect(openKeyFile({ ...file, publicKey: k2.publicKey }, 'update', PASS)).rejects.toThrow(
      /does not match/,
    );
    expect(() => readKeyFile({ ...file, extra: 1 })).toThrow(ToolError);
    await expect(
      generateKeyFile({ role: 'root', passphrase: encodeUtf8('short'), kdf: FAST_KDF }),
    ).rejects.toThrow(/16 characters/);
  });

  it('never makes the root key the update key, and signs statements only with the root role', () => {
    expect(() =>
      signStatement({ root, action: 'introduce', updateKey: root.publicKey, sequence: 1 }),
    ).toThrow(/never be the update key/);
    expect(() =>
      signStatement({ root: k1, action: 'introduce', updateKey: k2.publicKey, sequence: 1 }),
    ).toThrow(/root key/);
    expect(() =>
      signManifest({ update: root, statement: s1, unsigned: unsignedFor('0.5.0') }),
    ).toThrow(/update key/);
    expect(() =>
      signManifest({ update: k2, statement: s1, unsigned: unsignedFor('0.5.0') }),
    ).toThrow(/another update key/);
  });
});

describe('the app accepts a manifest the tool signed', () => {
  it('accepts the good manifest for this computer', () => {
    const accepted = check(good);
    expect(accepted.version).toBe('0.5.0');
    expect(accepted.required).toBe(false);
    expect(accepted.asset.platform).toBe('darwin');
    expect(accepted.state.updateKey).toBe(k1.publicKey);
    expect(
      check(good, ctx(INITIAL_KEY_STATE, { platform: 'win32', arch: 'x64' })).asset.url,
    ).toMatch(/setup\.exe$/);
    expect(check(good, ctx(INITIAL_KEY_STATE, { currentVersion: '0.3.9' })).required).toBe(true);
  });
});

describe('refusals (plan acceptance list)', () => {
  it('tampered: any signed field changed after signing', () => {
    expect(check({ ...good, minimumVersion: '0.4.1' })).toBe('bad_signature');
    expect(check({ ...good, assets: [{ ...good.assets[0], sha256: '0'.repeat(64) }] })).toBe(
      'bad_signature',
    );
    expect(check({ ...good, statement: { ...s1, sequence: 2 } })).toBe('bad_signature');
  });

  it('unsigned: no sig on the manifest or on its statement', () => {
    const noSig = omit(good, 'sig');
    expect(check(noSig)).toBe('unsigned');
    const stmtNoSig = omit(s1, 'sig');
    expect(check({ ...good, statement: stmtNoSig })).toBe('unsigned');
  });

  it('wrong key: a manifest key the statement does not name, or a statement not from the root', () => {
    expect(check(resign({ ...good, updateKey: k2.publicKey }, k2))).toBe('wrong_key');
    expect(
      check(
        manifest('0.5.0', k1, statement(1, 'introduce', k1.publicKey, { ...k2, role: 'root' })),
      ),
    ).toBe('bad_signature');
    expect(check(resign(good, k2))).toBe('bad_signature');
    expect(check(resign(good, root))).toBe('bad_signature');
  });

  it('unrotated key: a statement older than the one the app has', () => {
    const s2 = statement(2, 'rotate', k2.publicKey);
    const state = applyStatement(INITIAL_KEY_STATE, s2, ROOT, NOW, 'stable');
    expect(check(manifest('0.6.0', k1, s1), ctx(state))).toBe('unrotated_key');
    // The same sequence with different content is not "the statement already held".
    expect(check(manifest('0.6.0', k1, statement(2, 'rotate', k1.publicKey)), ctx(state))).toBe(
      'unrotated_key',
    );
    // A floor pinned in a later build refuses older statements even on a fresh state.
    const floored = pinnedRoot({ rootPublicKey: root.publicKey, minimumStatementSequence: 2 });
    expect(check(good, ctx(INITIAL_KEY_STATE, { root: floored }))).toBe('unrotated_key');
  });

  it('downgrade: the same or an older version', () => {
    expect(check(manifest('0.4.13', k1, s1))).toBe('not_newer');
    expect(check(manifest('0.4.2', k1, s1))).toBe('not_newer');
    expect(
      check(manifest('0.5.0', k1, s1), ctx(INITIAL_KEY_STATE, { currentVersion: '0.5.0' })),
    ).toBe('not_newer');
    expect(
      check(
        manifest('0.5.0-beta.1', k1, s1, { extra: { channel: 'beta' } }),
        ctx(INITIAL_KEY_STATE, { channel: 'beta', currentVersion: '0.5.0' }),
      ),
    ).toBe('not_newer');
  });

  it('wrong channel, platform or arch', () => {
    expect(check(good, ctx(INITIAL_KEY_STATE, { channel: 'beta' }))).toBe('wrong_channel');
    expect(check(good, ctx(INITIAL_KEY_STATE, { platform: 'linux' }))).toBe(
      'no_asset_for_this_computer',
    );
    expect(check(good, ctx(INITIAL_KEY_STATE, { arch: 'x64' }))).toBe('no_asset_for_this_computer');
    expect(check(good, ctx(INITIAL_KEY_STATE, { platform: 'win32', arch: 'arm64' }))).toBe(
      'no_asset_for_this_computer',
    );
    expect(check(manifest('0.5.0-beta.1', k1, s1))).toBe('malformed'); // a prerelease on stable
  });

  it('expired, or dated in the future', () => {
    expect(check(good, ctx(INITIAL_KEY_STATE, { now: NOW + 31 * DAY }))).toBe('expired');
    expect(check(manifest('0.5.0', k1, s1, { now: NOW + DAY }))).toBe('not_yet_valid');
    expect(check(manifest('0.5.0', k1, s1, { days: 31 }))).not.toBeTypeOf('string');
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
    expect(check({ ...good, statement: { ...s1, note: 'x' } })).toBe('unknown_field');
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

describe('rotation rehearsal', () => {
  it('introduce → release → rotate → old key refused → revoke → introduce again (state persisted)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentlink-rotation-'));
    try {
      // 1. First release with K1 (statement #1).
      let state = await loadKeyState(dir, ROOT, NOW, 'stable');
      expect(state).toEqual(INITIAL_KEY_STATE);
      const r1 = check(good, ctx(state));
      await saveKeyState(dir, r1.state);
      state = await loadKeyState(dir, ROOT, NOW, 'stable');
      expect(state.updateKey).toBe(k1.publicKey);

      // 2. The owner rotates to K2 (#2); the next release is signed by K2.
      const s2 = statement(2, 'rotate', k2.publicKey);
      const r2 = check(manifest('0.6.0', k2, s2), ctx(state, { currentVersion: '0.5.0' }));
      expect(r2.state.sequence).toBe(2);
      await saveKeyState(dir, r2.state);
      state = await loadKeyState(dir, ROOT, NOW, 'stable');
      expect(state.updateKey).toBe(k2.publicKey);

      // 3. K1 is no longer accepted, with either statement.
      expect(check(manifest('0.7.0', k1, s1), ctx(state, { currentVersion: '0.6.0' }))).toBe(
        'unrotated_key',
      );
      expect(
        check(resign({ ...manifest('0.7.0', k2, s2), updateKey: k1.publicKey }, k1), ctx(state)),
      ).toBe('wrong_key');

      // 4. Revoke K2 (#3), published as a statement-only document.
      const s3 = statement(3, 'revoke', k2.publicKey);
      state = check(s3, ctx(state));
      expect(state.updateKey).toBeNull();
      await saveKeyState(dir, state);
      state = await loadKeyState(dir, ROOT, NOW, 'stable');
      expect(state.sequence).toBe(3);
      expect(check(manifest('0.7.0', k2, s2), ctx(state, { currentVersion: '0.6.0' }))).toBe(
        'unrotated_key',
      );
      expect(
        check(
          resign({ ...manifest('0.7.0', k2, s2), statement: s3 }, k2),
          ctx(state, { currentVersion: '0.6.0' }),
        ),
      ).toBe('revoked');

      // 5. Introduce K3 (#4) and release again.
      const s4 = statement(4, 'introduce', k3.publicKey);
      const r4 = check(manifest('0.7.0', k3, s4), ctx(state, { currentVersion: '0.6.0' }));
      expect(r4.state.updateKey).toBe(k3.publicKey);

      // A tampered state file falls back to "nothing accepted", never to a forged key.
      const forged = { ...s4, updateKey: k1.publicKey };
      await saveKeyState(dir, { sequence: 4, updateKey: k1.publicKey, statement: forged });
      expect(await loadKeyState(dir, ROOT, NOW, 'stable')).toEqual(INITIAL_KEY_STATE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      root: { rootPublicKey: root.publicKey, minimumStatementSequence: 0 },
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
    expect(existsSync(join(t.stateDir, 'update-keys.json'))).toBe(true);
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

  it('an up-to-date app still adopts a rotation and a revocation (Fable M1)', async () => {
    // Up to date (0.5.0) and the manifest for 0.5.0 carries rotation #2 to K2.
    const s2 = statement(2, 'rotate', k2.publicKey);
    const t = setup({ document: manifest('0.5.0', k2, s2) });
    const deps = { ...t.deps, currentVersion: '0.5.0' };
    expect(await runUpdateCheck(deps)).toEqual({ kind: 'up_to_date' });
    let state = await loadKeyState(t.stateDir, ROOT, NOW, 'stable');
    expect([state.sequence, state.updateKey]).toEqual([2, k2.publicKey]);
    // An expired manifest still delivers its statement.
    const s3 = statement(3, 'rotate', k3.publicKey);
    const u = setup({ document: manifest('0.6.0', k3, s3, { now: NOW - 40 * DAY, days: 31 }) });
    expect(await runUpdateCheck({ ...u.deps, stateDir: t.stateDir })).toEqual({
      kind: 'refused',
      code: 'expired',
    });
    state = await loadKeyState(t.stateDir, ROOT, NOW, 'stable');
    expect(state.updateKey).toBe(k3.publicKey);
    // A manifest that embeds a revocation: refused, and the revocation is kept.
    const s4 = statement(4, 'revoke', k3.publicKey);
    const revoking = resign({ ...manifest('0.5.0', k3, s3), statement: s4 }, k3);
    const v = setup({ document: revoking });
    expect(
      await runUpdateCheck({ ...v.deps, stateDir: t.stateDir, currentVersion: '0.5.0' }),
    ).toEqual({
      kind: 'refused',
      code: 'revoked',
    });
    state = await loadKeyState(t.stateDir, ROOT, NOW, 'stable');
    expect([state.sequence, state.updateKey]).toEqual([4, null]);
    // Later, the old K3 manifest is refused: the app does not go back.
    const w = setup({ document: manifest('0.6.0', k3, s3) });
    expect(await runUpdateCheck({ ...w.deps, stateDir: t.stateDir })).toEqual({
      kind: 'refused',
      code: 'unrotated_key',
    });
  });

  it('an older release is "up to date"; a refused document offers nothing', async () => {
    const t = setup({ document: manifest('0.4.0', k1, s1) });
    expect(await runUpdateCheck(t.deps)).toEqual({ kind: 'up_to_date' });
    const u = setup({ document: { ...good, minimumVersion: '0.4.5' } });
    expect(await runUpdateCheck(u.deps)).toEqual({ kind: 'refused', code: 'bad_signature' });
    expect(u.opened).toHaveLength(0);
  });

  it('does nothing while the root key is the placeholder', async () => {
    const t = setup();
    const deps = omit(t.deps, 'root');
    expect(await runUpdateCheck(deps)).toEqual({ kind: 'not_configured' });
    expect(t.seen).toEqual([]);
  });
});

describe('the command line, end to end (real offline KDF)', () => {
  it('generate → public-key → check → statement → sign, then the app accepts it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentlink-keys-'));
    try {
      let answer = 'yes';
      const io = { readHidden: async () => PASS.slice(), readLine: async () => encodeUtf8(answer) };
      const lines = [];
      const run = (args) =>
        main(args, { env: {}, io, out: (l) => lines.push(l), verifier: appVerifier });
      const p = (name) => join(dir, name);
      await run(['generate', '--role', 'root', '--out', p('root.key')]);
      await run(['generate', '--role', 'update', '--out', p('update.key')]);
      expect(statSync(p('root.key')).mode & 0o777).toBe(0o600);
      await expect(run(['generate', '--role', 'root', '--out', p('root.key')])).rejects.toThrow(
        /already exists/,
      );
      const realUpdate = JSON.parse(readFileSync(p('update.key'), 'utf8'));
      expect(readFileSync(p('root.key'), 'utf8')).not.toContain(new TextDecoder().decode(PASS));
      await run(['public-key', p('update.key')]);
      expect(lines.at(-1)).toBe(`update public key: ${realUpdate.publicKey}`);
      await run(['check', p('root.key')]);
      expect(lines.at(-1)).toMatch(/^OK: /);
      // The offline strength above (generate, refuse to overwrite, open to check) is the part that
      // needs 256 MiB derivations. The signing flow below opens a key file the same way whatever
      // its derivation setting is (it is read from the file), so it uses quick-to-open files.
      const fastRoot = await generateKeyFile({ role: 'root', passphrase: PASS, kdf: FAST_KDF });
      const fastUpdate = await generateKeyFile({ role: 'update', passphrase: PASS, kdf: FAST_KDF });
      writeFileSync(p('root.key'), JSON.stringify(fastRoot));
      writeFileSync(p('update.key'), JSON.stringify(fastUpdate));
      const rootFile = fastRoot;
      const updateFile = fastUpdate;
      await run([
        'statement',
        '--root-key',
        p('root.key'),
        '--action',
        'introduce',
        '--update-key',
        updateFile.publicKey,
        '--sequence',
        '1',
        '--channel',
        'stable',
        '--expires-days',
        '395',
        '--out',
        p('s1.json'),
      ]);
      writeFileSync(p('unsigned.json'), JSON.stringify(unsignedFor('0.5.0')));
      const signArgs = (keyFile, out) => [
        'sign',
        '--update-key',
        keyFile,
        '--statement',
        p('s1.json'),
        '--manifest',
        p('unsigned.json'),
        '--out',
        out,
        '--root-public',
        rootFile.publicKey,
      ];
      // Without a pinned root (root-key.json is the placeholder) and no --root-public: refused.
      await expect(run(signArgs(p('update.key'), p('a.json')).slice(0, -2))).rejects.toThrow(
        /placeholder/,
      );
      // The owner sees what is signed and must type yes.
      answer = 'no';
      await expect(run(signArgs(p('update.key'), p('b.json')))).rejects.toThrow(/Not signed/);
      expect(existsSync(p('b.json'))).toBe(false);
      answer = 'yes';
      await run(signArgs(p('update.key'), p('signed.json')));
      expect(lines.some((l) => l.includes('darwin/arm64') && l.includes('sha256'))).toBe(true);
      // A statement from another root is refused before the passphrase is asked.
      const otherRoot = key('root');
      await expect(
        run([...signArgs(p('update.key'), p('c.json')).slice(0, -1), otherRoot.publicKey]),
      ).rejects.toThrow(/statement refused/);
      const appRoot = pinnedRoot({
        rootPublicKey: rootFile.publicKey,
        minimumStatementSequence: 0,
      });
      const accepted = check(
        readFileSync(p('signed.json'), 'utf8'),
        ctx(INITIAL_KEY_STATE, { root: appRoot, now: Date.now() }),
      );
      expect(accepted.version).toBe('0.5.0');
      expect(accepted.state.updateKey).toBe(updateFile.publicKey);
      // The root key file cannot sign a manifest, nor the update key file a statement.
      await expect(run(signArgs(p('root.key'), p('x.json')))).rejects.toThrow(
        /update key is needed/,
      );
      await expect(
        run([
          'statement',
          '--root-key',
          p('update.key'),
          '--action',
          'rotate',
          '--update-key',
          updateFile.publicKey,
          '--sequence',
          '2',
          '--channel',
          'stable',
          '--expires-days',
          '90',
          '--out',
          p('y.json'),
        ]),
      ).rejects.toThrow(/root key is needed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Four real offline-strength key derivations (256 MiB, 4 passes: about 3.5 s each on an idle
    // laptop, several times that on a CI runner sharing its CPUs with other suites).
  }, 300_000);
});

// --- UPD-1: format v2 ------------------------------------------------------------------------------

describe('format v2 (UPD-1): channel-bound, expiring statements and asset kinds', () => {
  const zipAsset = (version) => ({
    ...assetFor(version),
    kind: 'zip',
    url: `https://github.com/4thtech/agentlink/releases/download/v${version}/AgentLink-${version}-arm64.zip`,
  });

  it('signs statements with channel and expires; refuses an unknown channel and > 400 days', () => {
    const s = statement(1, 'introduce', k1.publicKey, root, { channel: 'beta', expiresDays: 90 });
    expect(s.domain).toBe('agentlink-desktop-root/v2');
    expect([s.channel, s.issued, s.expires]).toEqual([
      'beta',
      '2026-11-11T10:00:00Z',
      '2027-02-09T10:00:00Z',
    ]);
    expect(() => statement(1, 'introduce', k1.publicKey, root, { channel: 'nightly' })).toThrow(
      /channel/,
    );
    expect(() => statement(1, 'introduce', k1.publicKey, root, { expiresDays: 401 })).toThrow(
      /400/,
    );
    expect(() => statement(1, 'introduce', k1.publicKey, root, { expiresDays: 0 })).toThrow(/400/);
    expect(statement(1, 'introduce', k1.publicKey, root, { expiresDays: 400 }).expires).toBe(
      '2027-12-16T10:00:00Z',
    );
  });

  it('renew keeps the key with a higher sequence and a later expiry', () => {
    const renew = statement(2, 'renew', k1.publicKey);
    const r = check(manifest('0.5.0', k1, renew));
    expect([r.state.sequence, r.state.updateKey, r.version]).toEqual([2, k1.publicKey, '0.5.0']);
  });

  it('statement_expired: a manifest whose statement has run out is refused, even if fresh', () => {
    const old = statement(1, 'introduce', k1.publicKey, root, {
      now: NOW - 100 * DAY,
      expiresDays: 30,
    });
    expect(check(manifest('0.5.0', k1, old))).toBe('statement_expired');
  });

  it('wrong_channel: a beta key cannot sign a stable manifest; the tool refuses it too', () => {
    const beta = statement(1, 'introduce', k1.publicKey, root, { channel: 'beta' });
    expect(() => manifest('0.5.0', k1, beta)).toThrow(/channel/);
    const forged = resign({ ...good, statement: beta }, k1);
    expect(check(forged)).toBe('wrong_channel');
    expect(check(forged, ctx(INITIAL_KEY_STATE, { channel: 'beta' }))).toBe('wrong_channel');
    const betaManifest = manifest('0.5.0', k1, beta, { extra: { channel: 'beta' } });
    expect(check(betaManifest, ctx(INITIAL_KEY_STATE, { channel: 'beta' })).version).toBe('0.5.0');
    expect(check(betaManifest)).toBe('wrong_channel');
  });

  it('failed_version: a version that failed to start is never offered again', () => {
    expect(check(good, ctx(INITIAL_KEY_STATE, { failedVersion: '0.5.0' }))).toBe('failed_version');
    expect(check(good, ctx(INITIAL_KEY_STATE, { failedVersion: '0.4.99' })).version).toBe('0.5.0');
  });

  it('old_format: a v1 manifest is refused for install, even when its signature is good', () => {
    const v1 = { ...good, domain: 'agentlink-desktop-update/v1' };
    expect(check(v1)).toBe('old_format');
    expect(check({ ...s1, domain: 'agentlink-desktop-root/v1' })).toBe('old_format');
  });

  it('kind: the in-app installer takes the zip, phase 1 the DMG; each must exist', () => {
    const both = manifest('0.5.0', k1, s1, {
      extra: { assets: [assetFor('0.5.0'), zipAsset('0.5.0')] },
    });
    expect(check(both, ctx(INITIAL_KEY_STATE, { kind: 'zip' })).asset.url).toMatch(/\.zip$/);
    expect(check(both).asset.url).toMatch(/\.dmg$/);
    expect(check(good, ctx(INITIAL_KEY_STATE, { kind: 'zip' }))).toBe('no_asset_for_this_computer');
  });

  it('the tool computes the same messages as the shared vectors', () => {
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
      const message = doc.domain.startsWith('agentlink-desktop-root')
        ? statementMessage(doc)
        : manifestMessage(doc);
      expect(encodeHex(message), c.id).toBe(c.expected.message);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('the command line needs --channel and --expires-days for a statement', async () => {
    const io = { readHidden: async () => PASS.slice(), readLine: async () => encodeUtf8('yes') };
    const base = [
      'statement',
      '--root-key',
      '/nonexistent/root.key',
      '--action',
      'renew',
      '--update-key',
      k1.publicKey,
      '--sequence',
      '2',
      '--out',
      '/nonexistent/s.json',
    ];
    const run = (args) => main(args, { env: {}, io, out: () => undefined });
    await expect(run([...base, '--expires-days', '90'])).rejects.toThrow(/--channel/);
    await expect(run([...base, '--channel', 'beta'])).rejects.toThrow(/--expires-days/);
    await expect(run([...base, '--channel', 'beta', '--expires-days', '401'])).rejects.toThrow(
      /400/,
    );
    await expect(run([...base, '--channel', 'gamma', '--expires-days', '90'])).rejects.toThrow(
      /channel/,
    );
  });
});
