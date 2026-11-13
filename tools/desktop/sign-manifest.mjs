#!/usr/bin/env node
// WP-D10 (plan 2026-11-12 Decision 5, Fable H3; 08 §8 "Signed updates"), format v2 (UPD-1): the
// owner's OFFLINE tool for the desktop update key. Owner guide: docs/runbooks/desktop-update-keys.md
// (RB-23). Since the owner decision of 2026-11-13 there is ONE update key, its public key pinned in
// the app (root-key.json `rootPublicKey`); no root key and no key statements. Release signing moves
// to one approved CI job (UPD-3); this tool stays for local signing and checks.
//
//   generate    --out <key file>                         a new update key pair, sealed under a passphrase
//   public-key  <key file>                               prints the public key (no passphrase)
//   check       <key file>                               asks the passphrase and checks it opens (test a backup)
//   sign        --update-key <key file> --manifest <unsigned manifest> --out <file>
//               [--days 30] [--pinned-public <64 hex>]
//
// Rules:
// - It never touches the network: no network module is imported (a test checks the source), and all
//   crypto is @4thtech-io/crypto (BIP-340, the ALKU key file, JCS, the TAGS registry).
// - It refuses to run when CI or GITHUB_ACTIONS is set.
// - Key files: JSON {format, role, publicKey, sealed}; `sealed` is an `ALKU` v1 file (its own magic,
//   KDF label and the role in the AAD; Argon2id at 256 MiB, 4 passes → HKDF → AES-256-GCM). The
//   public key is re-derived from the opened secret and compared, so a swapped file is refused.
// - Passphrases are typed in the terminal with echo off, never taken from arguments, files or the
//   environment. Output files are created new (never overwritten), mode 0600 for key files.
// - `sign` first checks the key file is the pinned key (root-key.json, or --pinned-public), shows
//   what will be signed and asks for "yes", and after signing runs the APP'S OWN parser and
//   acceptance checks (apps/desktop/dist/main/updater/manifest.js, built with
//   `pnpm --filter @4thtech-io/desktop build`) on the exact bytes it writes.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  TAGS,
  canonicalizeToBytes,
  decodeBase64url,
  decodeHex,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  equalBytes,
  isBip340PublicKey,
  parseReceivedJson,
  randomBytes,
  taggedHash,
  wipe,
} from '@4thtech-io/crypto';
import {
  bip340PublicKey,
  bip340Sign,
  openUpdateKeyFile,
  readUpdateKeyFileRole,
  sealUpdateKeyFile,
} from '@4thtech-io/crypto/keystore';

export const KEY_FILE_FORMAT = 'agentlink-desktop-key/v1';
export const MANIFEST_DOMAIN = TAGS.desktopUpdateManifest;
/** UPD-1: one update key; the `root` role of the ALKU file format is no longer used. */
export const ROLES = Object.freeze(['update']);
export const CHANNELS = Object.freeze(['stable', 'beta']);
/** The strongest setting inside the 04 §2.8 bounds (KEYSTORE_KDF_BOUNDS). */
export const OFFLINE_KDF = Object.freeze({ memoryKiB: 262144, iterations: 4, parallelism: 1 });
export const MIN_PASSPHRASE_CHARACTERS = 16;
export const DEFAULT_VALIDITY_DAYS = 30;
export const MAX_VALIDITY_DAYS = 31;
const HEX32 = /^[0-9a-f]{64}$/;
const MAX_INPUT_BYTES = 65536;
const ROOT_KEY_JSON = new URL('../../apps/desktop/src/main/updater/root-key.json', import.meta.url);
const APP_VERIFIER = new URL('../../apps/desktop/dist/main/updater/manifest.js', import.meta.url);

export class ToolError extends Error {}

/** This offline tool never runs on a CI runner: any non-empty CI or GITHUB_ACTIONS stops it. */
export function refuseInCi(env = process.env) {
  if ((env.CI ?? '') !== '' || (env.GITHUB_ACTIONS ?? '') !== '') {
    throw new ToolError(
      'This tool is for the owner offline computer only. It does not run in CI (CI or GITHUB_ACTIONS is set).',
    );
  }
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function exactKeys(value, keys, what) {
  if (!isObject(value)) throw new ToolError(`${what}: not a JSON object`);
  const have = Object.keys(value).sort();
  const want = [...keys].sort();
  if (have.length !== want.length || have.some((k, i) => k !== want[i])) {
    throw new ToolError(`${what}: expected exactly the fields ${want.join(', ')}`);
  }
  return value;
}

/** Strict JSON (D-128 received-text rules) from bytes, with a size cap. */
export function parseStrict(bytes, what) {
  if (bytes.length > MAX_INPUT_BYTES) throw new ToolError(`${what}: file too large`);
  try {
    return parseReceivedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ToolError(`${what}: not valid strict JSON`);
  }
}

function checkPassphrase(passphrase) {
  if (!(passphrase instanceof Uint8Array)) throw new ToolError('passphrase must be bytes');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(passphrase).normalize('NFKC');
  if ([...text].length < MIN_PASSPHRASE_CHARACTERS) {
    throw new ToolError(
      `The passphrase needs at least ${MIN_PASSPHRASE_CHARACTERS} characters (a sentence of five or six words is good).`,
    );
  }
}

const isoSeconds = (ms) =>
  new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

const isPublicKey = (hex) =>
  typeof hex === 'string' && HEX32.test(hex) && isBip340PublicKey(decodeHex(hex));

// --- key files -----------------------------------------------------------------------------------

/** A new key pair for `role`, sealed under `passphrase` (bytes). Returns the key file object. */
export async function generateKeyFile({ role = 'update', passphrase, kdf = OFFLINE_KDF }) {
  if (!ROLES.includes(role)) throw new ToolError('role must be update');
  checkPassphrase(passphrase);
  let secret;
  let publicKey;
  for (;;) {
    secret = randomBytes(32);
    try {
      publicKey = bip340PublicKey(secret);
      break;
    } catch {
      wipe(secret); // 0 or >= n: astronomically rare, draw again
    }
  }
  try {
    const sealed = await sealUpdateKeyFile(role, secret, passphrase, kdf);
    return Object.freeze({
      format: KEY_FILE_FORMAT,
      role,
      publicKey: encodeHex(publicKey),
      sealed: encodeBase64url(sealed),
    });
  } finally {
    wipe(secret);
  }
}

/** Parses a key file object (public parts only); no passphrase needed. */
export function readKeyFile(value, role) {
  const o = exactKeys(value, ['format', 'role', 'publicKey', 'sealed'], 'key file');
  if (o.format !== KEY_FILE_FORMAT) {
    throw new ToolError('key file: not an AgentLink desktop key file');
  }
  if (!ROLES.includes(o.role)) throw new ToolError('key file: unknown role');
  if (role !== undefined && o.role !== role) {
    throw new ToolError(`key file: this is the ${o.role} key, but the ${role} key is needed`);
  }
  if (!isPublicKey(o.publicKey)) throw new ToolError('key file: bad public key');
  let sealed;
  try {
    sealed = decodeBase64url(o.sealed);
  } catch {
    throw new ToolError('key file: damaged');
  }
  if (readUpdateKeyFileRole(sealed) !== o.role) throw new ToolError('key file: damaged');
  return { role: o.role, publicKey: o.publicKey, sealed };
}

/** Opens a key file: returns the secret key (wipe it) and its public key, checked against the file. */
export async function openKeyFile(value, role, passphrase) {
  const file = readKeyFile(value, role);
  let secret;
  try {
    secret = await openUpdateKeyFile(file.sealed, file.role, passphrase);
  } catch {
    throw new ToolError('Cannot open the key file: wrong passphrase, or the file is damaged.');
  }
  let derived;
  try {
    derived = bip340PublicKey(secret);
  } catch {
    wipe(secret);
    throw new ToolError('key file: damaged');
  }
  if (!equalBytes(derived, decodeHex(file.publicKey))) {
    wipe(secret);
    throw new ToolError('key file: the sealed key does not match the public key in the file');
  }
  return { secretKey: secret, publicKey: file.publicKey, role: file.role };
}

// --- signing -------------------------------------------------------------------------------------

const withoutSig = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'sig'));
export const manifestMessage = (m) =>
  taggedHash(MANIFEST_DOMAIN, canonicalizeToBytes(withoutSig(m)));

const UNSIGNED_KEYS = ['domain', 'channel', 'version', 'minimumVersion', 'assets'];

/**
 * Signs the unsigned manifest CI produced ({domain, channel, version, minimumVersion, assets}, each
 * asset with its `kind`). The tool adds `released` (now), `expires` (now + days) and the update key,
 * then the signature. `checkManifestText` (below) re-checks it as the app would.
 */
export function signManifest({ update, unsigned, now = Date.now(), days = DEFAULT_VALIDITY_DAYS }) {
  if (update.role !== 'update') throw new ToolError('manifests are signed with the update key');
  const body = manifestBody({ updateKey: update.publicKey, unsigned, now, days });
  return Object.freeze({
    ...body,
    sig: encodeHex(bip340Sign(update.secretKey, manifestMessage(body))),
  });
}

function manifestBody({ updateKey, unsigned, now, days }) {
  const m = exactKeys(unsigned, UNSIGNED_KEYS, 'unsigned manifest');
  if (m.domain !== MANIFEST_DOMAIN) throw new ToolError('unsigned manifest: wrong domain');
  if (!CHANNELS.includes(m.channel)) throw new ToolError('unsigned manifest: unknown channel');
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_VALIDITY_DAYS) {
    throw new ToolError(`--days must be 1 to ${MAX_VALIDITY_DAYS}`);
  }
  const released = Math.floor(now / 1000) * 1000;
  return {
    domain: MANIFEST_DOMAIN,
    channel: m.channel,
    version: m.version,
    minimumVersion: m.minimumVersion,
    released: isoSeconds(released),
    expires: isoSeconds(released + days * 86_400_000),
    updateKey,
    assets: m.assets,
  };
}

/** The pinned key: --pinned-public, else root-key.json in this checkout (refused while a placeholder). */
export function pinnedRootFor(verifier, pinnedPublic) {
  const raw =
    pinnedPublic === undefined
      ? JSON.parse(readFileSync(ROOT_KEY_JSON, 'utf8'))
      : { rootPublicKey: pinnedPublic, minimumStatementSequence: 0 };
  const root = verifier.pinnedRoot(raw);
  if (root === undefined) {
    throw new ToolError(
      'No real update public key is pinned (root-key.json is still the placeholder). Pass --pinned-public <the pinned public key>.',
    );
  }
  return root;
}

/**
 * Runs the app's own parser and acceptance on the exact text written: every asset must be accepted
 * for its own platform, arch and kind by an app on version 0.0.0 of that channel.
 */
export function checkManifestText(verifier, root, text, now = Date.now()) {
  try {
    const manifest = verifier.parseUpdateDocument(encodeUtf8(text));
    for (const asset of manifest.assets) {
      verifier.acceptManifest(manifest, {
        root,
        currentVersion: '0.0.0',
        channel: manifest.channel,
        platform: asset.platform,
        arch: asset.arch,
        kind: asset.kind,
        failedVersion: null,
        now,
      });
    }
    return manifest;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`the signed manifest fails the app's checks (${error?.code ?? 'error'})`);
  }
}

/** What the owner checks before typing "yes". */
export function describeManifest(body) {
  const lines = [
    `AgentLink ${body.version} (${body.channel}), minimum ${body.minimumVersion}`,
    `valid from ${body.released} until ${body.expires}`,
    `update key ${body.updateKey}`,
  ];
  for (const a of body.assets) {
    lines.push(
      `  ${a.platform}/${a.arch} ${a.kind}  ${a.size} bytes  sha256 ${a.sha256}`,
      `    ${a.url}`,
    );
  }
  return lines;
}

async function loadVerifier() {
  try {
    return await import(APP_VERIFIER.href);
  } catch {
    throw new ToolError(
      "The app's checks are not built. Run: pnpm --filter @4thtech-io/desktop build (then try again).",
    );
  }
}

// --- command line --------------------------------------------------------------------------------

/** Reads a line from the terminal; echo off for passphrases. Refuses when stdin is not a terminal. */
export function readHidden(
  prompt,
  { stdin = process.stdin, stderr = process.stderr, echo = false } = {},
) {
  if (!stdin.isTTY) {
    return Promise.reject(
      new ToolError('Run this in a terminal: the passphrase is typed, never piped.'),
    );
  }
  return new Promise((resolve, reject) => {
    const bytes = [];
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    const done = (error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stderr.write('\n');
      if (error) {
        bytes.fill(0);
        reject(error);
      } else {
        const out = Uint8Array.from(bytes);
        bytes.fill(0);
        resolve(out);
      }
    };
    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 0x0d || byte === 0x0a) return done();
        if (byte === 0x03) return done(new ToolError('Stopped.'));
        if (byte === 0x7f || byte === 0x08) {
          // Backspace: drop one UTF-8 character.
          while (bytes.length > 0 && (bytes[bytes.length - 1] & 0xc0) === 0x80) bytes.pop();
          bytes.pop();
        } else {
          bytes.push(byte);
          if (echo) stderr.write(Buffer.of(byte));
        }
      }
      chunk.fill(0);
    };
    stdin.on('data', onData);
  });
}

const confirm = async (io, question) => {
  const answer = await io.readLine(question);
  return new TextDecoder().decode(answer).trim().toLowerCase() === 'yes';
};

const readJson = (path, what) => parseStrict(readFileSync(path), what);

function writeNew(path, text, mode) {
  try {
    writeFileSync(path, text, { flag: 'wx', mode });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new ToolError(`${path} already exists; choose a new file name`);
    }
    throw new ToolError(`cannot write ${path}`);
  }
}

async function askNewPassphrase(io) {
  const first = await io.readHidden('New passphrase (at least 16 characters): ');
  try {
    checkPassphrase(first);
    const second = await io.readHidden('Type it again: ');
    try {
      if (!equalBytes(first, second)) {
        throw new ToolError('The two passphrases differ. Nothing was written.');
      }
    } finally {
      wipe(second);
    }
    return first;
  } catch (error) {
    wipe(first);
    throw error;
  }
}

async function withKey(path, role, io, fn) {
  const value = readJson(path, 'key file');
  readKeyFile(value, role); // the wrong file is refused before the passphrase is asked
  const passphrase = await io.readHidden(`Passphrase for the ${role} key: `);
  let key;
  try {
    key = await openKeyFile(value, role, passphrase);
  } finally {
    wipe(passphrase);
  }
  try {
    return await fn(key);
  } finally {
    wipe(key.secretKey);
  }
}

const USAGE = `Usage (offline only; guide: docs/runbooks/desktop-update-keys.md):
  sign-manifest.mjs generate --out <key file>
  sign-manifest.mjs public-key <key file>
  sign-manifest.mjs check <key file>
  sign-manifest.mjs sign --update-key <key file> --manifest <unsigned manifest> --out <file> [--days 30] [--pinned-public <hex>]`;

const defaultIo = {
  readHidden,
  readLine: (prompt) => readHidden(prompt, { echo: true }),
};

export async function main(
  argv,
  { env = process.env, io = defaultIo, out = console.log, verifier } = {},
) {
  refuseInCi(env);
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    options: {
      out: { type: 'string' },
      'update-key': { type: 'string' },
      'pinned-public': { type: 'string' },
      manifest: { type: 'string' },
      days: { type: 'string' },
    },
  });
  const need = (name) => {
    if (typeof values[name] !== 'string' || values[name] === '') {
      throw new ToolError(`--${name} is required\n${USAGE}`);
    }
    return values[name];
  };
  switch (command) {
    case 'generate': {
      const role = 'update';
      const path = need('out');
      const passphrase = await askNewPassphrase(io);
      try {
        out('Sealing the key (this takes a few seconds)...');
        const file = await generateKeyFile({ role, passphrase });
        writeNew(path, JSON.stringify(file, null, 2) + '\n', 0o600);
        out(`Wrote the ${role} key to ${path}.`);
        out(`${role} public key: ${file.publicKey}`);
      } finally {
        wipe(passphrase);
      }
      return;
    }
    case 'public-key': {
      const path = positionals[0];
      if (path === undefined) throw new ToolError(USAGE);
      const file = readKeyFile(readJson(path, 'key file'));
      out(`${file.role} public key: ${file.publicKey}`);
      return;
    }
    case 'check': {
      const path = positionals[0];
      if (path === undefined) throw new ToolError(USAGE);
      const role = readKeyFile(readJson(path, 'key file')).role;
      await withKey(path, role, io, (key) =>
        out(`OK: the passphrase opens the ${role} key ${key.publicKey}.`),
      );
      return;
    }
    case 'sign': {
      if (values.days !== undefined && !/^[1-9][0-9]*$/.test(values.days)) {
        throw new ToolError('--days must be a whole number');
      }
      const days = values.days === undefined ? DEFAULT_VALIDITY_DAYS : Number(values.days);
      const path = need('out');
      const keyPath = need('update-key');
      const unsigned = readJson(need('manifest'), 'unsigned manifest');
      const app = verifier ?? (await loadVerifier());
      const root = pinnedRootFor(app, values['pinned-public']);
      const key = readKeyFile(readJson(keyPath, 'key file'), 'update');
      if (key.publicKey !== root.rootPublicKey) {
        throw new ToolError('This key file is not the update key pinned in the app.');
      }
      const now = Date.now();
      const preview = manifestBody({ updateKey: key.publicKey, unsigned, now, days });
      out('About to sign:');
      for (const line of describeManifest(preview)) out(line);
      if (!(await confirm(io, 'Check the version, sizes and checksums. Type yes to sign: '))) {
        throw new ToolError('Not signed.');
      }
      const signed = await withKey(keyPath, 'update', io, (update) =>
        signManifest({ update, unsigned, now, days }),
      );
      const text = JSON.stringify(signed, null, 2) + '\n';
      checkManifestText(app, root, text);
      writeNew(path, text, 0o644);
      out(
        `Signed AgentLink ${signed.version} (${signed.channel}), valid until ${signed.expires}: ${path}`,
      );
      return;
    }
    default:
      throw new ToolError(USAGE);
  }
}

// Run only as a script, never on import (the tests import the functions).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof ToolError ? error.message : 'Unexpected error; nothing was written.'}\n`,
    );
    process.exitCode = 1;
  });
}
