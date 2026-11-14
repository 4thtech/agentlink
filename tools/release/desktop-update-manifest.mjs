#!/usr/bin/env node
// UPD-3 (D-151, owner decision 2026-11-13): the signed desktop update manifest of a GitHub Release.
// Run by release.yml in three steps, each with only what it needs:
//
//   build   (job desktop-update-manifest, no secret): from the release assets that were downloaded
//           from the Release, whose SHA-256 sums and build provenance attestations the job checked,
//           writes the UNSIGNED manifest (format v2, apps/desktop/src/main/updater/manifest.ts).
//           It also checks the pin (Fable L3): every built app (both Macs and, since
//           WIN-INAPP-UPDATE, Windows) has updates on and carries exactly the key pinned in
//           root-key.json, which must be a real key, never the placeholder.
//   sign    (job sign-update-manifest, the ONE step with the key): reads the private key from the one
//           environment variable DESKTOP_UPDATE_KEY, masks it (`::add-mask::`), removes it from the
//           environment, refuses a key that is not the pinned one, and signs through
//           @4thtech-io/crypto (tools/desktop/sign-manifest.mjs `signManifest`). Writes
//           desktop-update-<key id>.json (Fable M1: the name carries the key id, so an app with an older
//           pin still asks for its own key's document) and the same bytes as desktop-update.json.
//   verify  (no secret): runs the APP'S OWN parser and acceptance checks (apps/desktop/dist, built
//           before the key is read) on the exact bytes, for every asset. A bad or unsigned manifest
//           fails here, before the publish step uploads anything.
//
// Never logs the key, never puts it in an error. No network module.
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { decodeHex, encodeHex, isBip340PublicKey, sha256, wipe } from '@4thtech-io/crypto';
import { bip340PublicKey } from '@4thtech-io/crypto/keystore';
import {
  MANIFEST_DOMAIN,
  MAX_VALIDITY_DAYS,
  ToolError,
  checkManifestText,
  signManifest,
} from '../desktop/sign-manifest.mjs';

export { ToolError };

export const REPOSITORY = '4thtech/agentlink';
export const KEY_ID_LENGTH = 16;
export const STABLE_DOCUMENT = 'desktop-update.json';
export const SUMS_FILE = 'SHA256SUMS-desktop-app.txt';
export const KEY_ENV = 'DESKTOP_UPDATE_KEY';
export const DEFAULT_DAYS = 30;
const HEX32 = /^[0-9a-f]{64}$/;
/** Read only: no link, never blocking on a pipe (each flag 0 where the OS lacks it). */
const READ_NOFOLLOW =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
const RELEASE_VERSION = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
const CHANNELS = ['stable', 'beta'];
const APP_VERIFIER = new URL('../../apps/desktop/dist/main/updater/manifest.js', import.meta.url);

const isPublicKey = (hex) =>
  typeof hex === 'string' && HEX32.test(hex) && isBip340PublicKey(decodeHex(hex));

/** The key id in the document name: the first 16 hex of the public key. */
export function keyId(publicKey) {
  if (!isPublicKey(publicKey)) throw new ToolError('not an update public key');
  return publicKey.slice(0, KEY_ID_LENGTH);
}

export function documentNames(publicKey) {
  return Object.freeze({
    keyed: `desktop-update-${keyId(publicKey)}.json`,
    stable: STABLE_DOCUMENT,
  });
}

/**
 * The release assets a manifest lists, in its order: the Mac zips (in-app install), the DMGs, then
 * the Windows NSIS setup (WIN-INAPP-UPDATE: the Windows app's in-app install runs it silently).
 */
export function releaseAssets(version) {
  const list = [];
  for (const kind of ['zip', 'dmg']) {
    for (const arch of ['arm64', 'x64']) {
      list.push({
        name: `AgentLink-${version}-mac-${arch}.${kind}`,
        platform: 'darwin',
        arch,
        kind,
      });
    }
  }
  list.push({
    name: `AgentLink-${version}-win-x64-setup.exe`,
    platform: 'win32',
    arch: 'x64',
    kind: 'nsis',
  });
  return list;
}

/** The build records the manifest job reads (desktop.yml uploads them with each build). */
export const BUILD_RECORDS = Object.freeze([
  'inputs-mac-arm64.json',
  'inputs-mac-x64.json',
  'inputs-win-x64.json',
]);

/** The pinned key from root-key.json text; refuses the placeholder and the updates-off file. */
export function pinFromRootKeyJson(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ToolError('root-key.json is not JSON');
  }
  const key = value?.rootPublicKey;
  if (!isPublicKey(key)) {
    throw new ToolError(
      'root-key.json has no real update key pinned (still the placeholder, or updates off): nothing is signed',
    );
  }
  return key;
}

/**
 * The three builds (BUILD_RECORDS: Mac arm64, Mac x64, Windows x64) must have updates on and carry
 * exactly `pin`: the manifest lists all of their files.
 */
export function checkBuildInputs(inputs, pin) {
  if (!Array.isArray(inputs) || inputs.length !== BUILD_RECORDS.length) {
    throw new ToolError(
      'expected the build records of all three apps (Mac arm64, Mac x64 and Windows x64)',
    );
  }
  for (const record of inputs) {
    if (record?.updates !== 'on') {
      throw new ToolError('a built app has updates off: nothing is signed for this release');
    }
    if (record.updatePin !== pin) {
      throw new ToolError('a built app does not carry the update key pinned in root-key.json');
    }
  }
}

/** `sha256sum` output, strictly: "<64 lowercase hex>  <name>", each name once. */
export function parseSums(text) {
  const sums = new Map();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const m = /^([0-9a-f]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(line);
    if (m === null) throw new ToolError(`${SUMS_FILE}: a line is not in sha256sum form`);
    if (sums.has(m[2])) throw new ToolError(`${SUMS_FILE}: ${m[2]} is listed twice`);
    sums.set(m[2], m[1]);
  }
  return sums;
}

/** The unsigned manifest {domain, channel, version, minimumVersion, assets}. */
export function buildUnsigned({ version, channel, sums, sizes, repository }) {
  if (repository !== REPOSITORY) {
    throw new ToolError(`the update manifest is built only for the repository ${REPOSITORY}`);
  }
  if (typeof version !== 'string' || !RELEASE_VERSION.test(version)) {
    throw new ToolError('the version must be MAJOR.MINOR.PATCH');
  }
  if (!CHANNELS.includes(channel)) throw new ToolError('the channel must be stable or beta');
  const assets = releaseAssets(version).map(({ name, platform, arch, kind }) => {
    const sha = sums.get(name);
    if (sha === undefined) throw new ToolError(`${name} is not in ${SUMS_FILE}`);
    const size = sizes.get(name);
    if (!Number.isSafeInteger(size) || size < 1) throw new ToolError(`${name}: no size`);
    return {
      platform,
      arch,
      kind,
      url: `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`,
      sha256: sha,
      size,
    };
  });
  return { domain: MANIFEST_DOMAIN, channel, version, minimumVersion: '0.0.0', assets };
}

/**
 * Signs `unsigned` with the key in env.DESKTOP_UPDATE_KEY (64 hex, one trailing newline allowed).
 * Under GitHub Actions the key is masked before anything else; it is removed from `env` at once.
 * Returns the manifest text.
 */
export function signFromEnv({ unsigned, env, pin, now = Date.now(), days = DEFAULT_DAYS, log }) {
  const raw = env[KEY_ENV];
  delete env[KEY_ENV];
  if (typeof raw !== 'string' || raw === '') {
    throw new ToolError(`${KEY_ENV} is not set (GitHub environment desktop-update)`);
  }
  if (env.GITHUB_ACTIONS === 'true') {
    for (const line of raw.split(/\r?\n/)) if (line !== '') log(`::add-mask::${line}`);
  }
  const text = raw.replace(/\r?\n$/, '');
  if (!HEX32.test(text)) throw new ToolError(`${KEY_ENV} is not 64 lowercase hex characters`);
  const secretKey = decodeHex(text);
  try {
    let publicKey;
    try {
      publicKey = encodeHex(bip340PublicKey(secretKey));
    } catch {
      throw new ToolError(`${KEY_ENV} is not a valid update key`);
    }
    if (publicKey !== pin) {
      throw new ToolError(`${KEY_ENV} is not the update key pinned in root-key.json`);
    }
    const signed = signManifest({
      update: { role: 'update', secretKey, publicKey },
      unsigned,
      now,
      days,
    });
    return `${JSON.stringify(signed, null, 2)}\n`;
  } finally {
    wipe(secretKey);
  }
}

/**
 * The app's own parser and acceptance checks on `text` (every asset), plus: signed by `pin`, this
 * version, this channel. Throws ToolError on any refusal.
 */
export function verifyDocument({ text, verifier, pin, version, channel, now = Date.now() }) {
  const root = verifier.pinnedRoot({ rootPublicKey: pin, minimumStatementSequence: 0 });
  if (root === undefined) throw new ToolError('the pin is not a valid update key');
  const manifest = checkManifestText(verifier, root, text, now);
  if (manifest.updateKey !== pin) throw new ToolError('the manifest names another update key');
  if (manifest.version !== version) throw new ToolError('the manifest is for another version');
  if (manifest.channel !== channel) throw new ToolError('the manifest is for another channel');
  return manifest;
}

// --- command line --------------------------------------------------------------------------------

const USAGE = [
  'Usage:',
  '  desktop-update-manifest.mjs build  --version <x.y.z> --channel stable --dir <assets> --root-key <root-key.json> --repository <owner/repo> (--build-sums <file> | --renewal) --out <unsigned.json>',
  '  desktop-update-manifest.mjs sign   --in <unsigned.json> --root-key <root-key.json> --out-dir <dir> [--days 30]   (key in DESKTOP_UPDATE_KEY)',
  '  desktop-update-manifest.mjs verify --dir <dir> --root-key <root-key.json> --version <x.y.z> --channel stable',
].join('\n');

function writeNew(path, text) {
  try {
    writeFileSync(path, text, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new ToolError(`${path} already exists`);
    throw new ToolError(`cannot write ${path}`);
  }
}

const readText = (path, what) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new ToolError(`cannot read ${what}`);
  }
};

async function loadVerifier() {
  try {
    return await import(APP_VERIFIER.href);
  } catch {
    throw new ToolError(
      "The app's checks are not built. Run: pnpm exec turbo run build --filter=@4thtech-io/desktop...",
    );
  }
}

const required = (values, names) => {
  for (const n of names) {
    if (typeof values[n] !== 'string' || values[n] === '') throw new ToolError(USAGE);
  }
};

export async function main(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line));
  const env = io.env ?? process.env;
  const now = io.now ?? Date.now();
  const [command, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        version: { type: 'string' },
        channel: { type: 'string' },
        dir: { type: 'string' },
        'root-key': { type: 'string' },
        repository: { type: 'string' },
        out: { type: 'string' },
        in: { type: 'string' },
        'out-dir': { type: 'string' },
        days: { type: 'string' },
        'build-sums': { type: 'string' },
        renewal: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new ToolError(USAGE);
  }
  switch (command) {
    case 'build': {
      required(values, ['version', 'channel', 'dir', 'root-key', 'repository', 'out']);
      // A release run passes this run's own build sums and build records. A renewal
      // (desktop-update-renew.yml) has neither: its anchor is the attestation bound to the release
      // commit on main, checked by the workflow before this runs (IR-UPD-8-1 #1, #4).
      const renewal = values.renewal === true;
      if (renewal === (typeof values['build-sums'] === 'string')) {
        throw new ToolError(
          'pass --build-sums <this run’s build sums> for a release, or --renewal alone for a renewal',
        );
      }
      const pin = pinFromRootKeyJson(readText(values['root-key'], 'root-key.json'));
      let buildSums;
      if (!renewal) {
        const inputs = BUILD_RECORDS.map((name) => {
          try {
            return JSON.parse(readText(join(values.dir, name), 'a build record'));
          } catch (error) {
            if (error instanceof ToolError) throw error;
            throw new ToolError(`${name} is not JSON`);
          }
        });
        checkBuildInputs(inputs, pin);
        buildSums = parseSums(readText(values['build-sums'], "this run's build sums"));
      }
      const sums = parseSums(readText(join(values.dir, SUMS_FILE), SUMS_FILE));
      const sizes = new Map();
      for (const { name } of releaseAssets(values.version)) {
        const path = join(values.dir, name);
        let bytes;
        try {
          // CI-823: one open (no link, never blocking on a pipe), then fstat and read that same
          // descriptor: no stat-then-read race on the path.
          const fd = openSync(path, READ_NOFOLLOW);
          try {
            if (!fstatSync(fd).isFile()) throw new Error('not a file');
            bytes = readFileSync(fd);
          } finally {
            closeSync(fd);
          }
        } catch {
          throw new ToolError(`${name} was not downloaded from the release`);
        }
        // The workflow ran sha256sum --check already; checked here again, through @4thtech-io/crypto.
        const digest = encodeHex(sha256(bytes));
        if (sums.get(name) !== digest) {
          throw new ToolError(`${name} does not match ${SUMS_FILE}`);
        }
        // IR-UPD-8-1 #1: the file on the Release must be the one this run built.
        if (buildSums !== undefined && buildSums.get(name) !== digest) {
          throw new ToolError(`${name} on the Release is not the file this run's build made`);
        }
        sizes.set(name, bytes.length);
      }
      const unsigned = buildUnsigned({
        version: values.version,
        channel: values.channel,
        sums,
        sizes,
        repository: values.repository,
      });
      writeNew(values.out, `${JSON.stringify(unsigned, null, 2)}\n`);
      out(
        `Unsigned update manifest for AgentLink ${values.version} (${values.channel}), ${unsigned.assets.length} files, key id ${keyId(pin)}.`,
      );
      return;
    }
    case 'sign': {
      required(values, ['in', 'root-key', 'out-dir']);
      const days = values.days === undefined ? DEFAULT_DAYS : Number(values.days);
      if (!Number.isSafeInteger(days) || days < 1 || days > MAX_VALIDITY_DAYS) {
        throw new ToolError(`--days must be 1 to ${MAX_VALIDITY_DAYS}`);
      }
      const pin = pinFromRootKeyJson(readText(values['root-key'], 'root-key.json'));
      let unsigned;
      try {
        unsigned = JSON.parse(readText(values.in, 'the unsigned manifest'));
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError('the unsigned manifest is not JSON');
      }
      const text = signFromEnv({ unsigned, env, pin, now, days, log: out });
      const names = documentNames(pin);
      mkdirSync(values['out-dir'], { recursive: true });
      writeNew(join(values['out-dir'], names.keyed), text);
      writeNew(join(values['out-dir'], names.stable), text);
      const signed = JSON.parse(text);
      out(
        `Signed the update manifest for AgentLink ${signed.version} (${signed.channel}), valid until ${signed.expires}: ${names.keyed}, ${names.stable}.`,
      );
      return;
    }
    case 'verify': {
      required(values, ['dir', 'root-key', 'version', 'channel']);
      const pin = pinFromRootKeyJson(readText(values['root-key'], 'root-key.json'));
      const names = documentNames(pin);
      const keyed = readText(join(values.dir, names.keyed), names.keyed);
      const stable = readText(join(values.dir, names.stable), names.stable);
      if (keyed !== stable) throw new ToolError(`${names.keyed} and ${names.stable} differ`);
      const verifier = io.verifier ?? (await loadVerifier());
      const m = verifyDocument({
        text: keyed,
        verifier,
        pin,
        version: values.version,
        channel: values.channel,
        now,
      });
      out(
        `The app accepts the update manifest for AgentLink ${m.version} (${m.channel}) for all ${m.assets.length} files, valid until ${m.expires}.`,
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
    // Fixed messages only: never the key, never inbound text.
    process.stdout.write(
      `::error::${error instanceof ToolError ? error.message : 'Unexpected error; nothing was written.'}\n`,
    );
    process.exitCode = 1;
  });
}
