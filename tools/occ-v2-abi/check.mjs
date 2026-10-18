// M1-3f (D-83): the vendored OCC v2 ABI bundle is exactly the contracts release it pins. Run by
// `pnpm lint` (turbo task `check`) and therefore by CI.
//
// packages/occ-v2-abi/release.json pins { repository, tag, sourceCommit, manifestSha256 }; the
// manifest hash is the one printed in the release notes, copied by the person who ran the import.
// This check fails when:
//   - artifacts/ holds anything but the pinned tag's directory;
//   - manifest.json's SHA-256 differs from the pin, or the manifest names another tag, commit,
//     package or schema;
//   - a listed ABI file is missing or its SHA-256 differs, or a file is not listed;
//   - the manifest lists an address file for any chain but Base Sepolia (84532), or a known mainnet
//     (testnet only until M3, 05 §9), or none for 84532;
//   - an address file is vendored: address files are kept only in the scanner-safe generated form
//     src/addresses.generated.ts (the secret scan flags the raw file; no allowlist, owner decision);
//   - src/addresses.generated.ts is missing, covers other chains than the manifest, or holds a
//     `0x` + 40-hex literal. Its content is checked against the manifest's SHA-256 by
//     packages/chain/src/occ-v2-abi.test.ts, which rebuilds the exact released bytes;
//   - src/generated/ differs from what render.mjs makes of the vendored JSON.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderGenerated } from './render.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PACKAGE_DIR = join(root, 'packages', 'occ-v2-abi');
export const PACKAGE_NAME = '@4thtech-io/occ-v2-abi';
export const REPOSITORY = '4thtech/occ-v2-contracts';

/** The only chain the bundle may carry addresses for until a decision adds one (05 §9, D-63). */
export const ALLOWED_CHAIN_IDS = [84532];

/** Mainnet chain IDs that must never appear (testnet only until M3-2c): a non-exhaustive guard. */
export const MAINNET_CHAIN_IDS = [
  1, 10, 56, 100, 130, 137, 146, 324, 1101, 5000, 8453, 34443, 42161, 42220, 43114, 59144, 81457,
  534352, 7777777,
];

const TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FILE_PATH = /^(abi|addresses)\/[A-Za-z0-9]+\.json$/;
const PIN_KEYS = ['manifestSha256', 'repository', 'sourceCommit', 'tag'];

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The parsed release.json of a package directory. */
export function readPin(packageDir) {
  return JSON.parse(readFileSync(join(packageDir, 'release.json'), 'utf8'));
}

/** Problems with the pin itself (shape only). */
export function checkPin(pin) {
  const problems = [];
  const keys = Object.keys(pin ?? {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify(PIN_KEYS)) {
    problems.push(`release.json: expected exactly the keys ${PIN_KEYS.join(', ')}`);
  }
  if (pin?.repository !== REPOSITORY)
    problems.push(`release.json: repository must be ${REPOSITORY}`);
  if (!TAG.test(String(pin?.tag))) problems.push('release.json: tag is not a release tag');
  if (!COMMIT.test(String(pin?.sourceCommit))) {
    problems.push('release.json: sourceCommit is not a 40-hex commit');
  }
  if (!SHA256.test(String(pin?.manifestSha256))) {
    problems.push('release.json: manifestSha256 is not a lower-case SHA-256');
  }
  return problems;
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listFiles(path, base));
    else out.push(relative(base, path).split('\\').join('/'));
  }
  return out;
}

/** Problems with one address file path listed in the manifest (addresses/<chainId>.json). */
export function checkAddressPath(path) {
  const problems = [];
  const id = Number(path.slice('addresses/'.length, -'.json'.length));
  if (!ALLOWED_CHAIN_IDS.includes(id)) {
    problems.push(
      `${path}: only Base Sepolia (84532) is allowed; another chain needs a decision and a reviewed change here`,
    );
  }
  if (MAINNET_CHAIN_IDS.includes(id)) {
    problems.push(`${path}: a mainnet chain; the bundle is testnet only (05 §9)`);
  }
  return problems;
}

/** An address literal as gitleaks would see it: `0x` and 40 hex digits. */
const ADDRESS_LITERAL = /0x[0-9a-fA-F]{40}/;

/** Every problem with the package's pinned release, vendored files and generated sources. */
export function checkPackage(packageDir) {
  const pin = readPin(packageDir);
  const problems = checkPin(pin);
  if (problems.length) return problems;

  const artifactsDir = join(packageDir, 'artifacts');
  const releases = existsSync(artifactsDir) ? readdirSync(artifactsDir).sort() : [];
  for (const name of releases) {
    if (name !== pin.tag) {
      problems.push(
        `artifacts/${name}: release.json pins ${pin.tag}; only that release may be vendored`,
      );
    }
  }
  const releaseDir = join(artifactsDir, pin.tag);
  if (!releases.includes(pin.tag)) {
    problems.push(`artifacts/${pin.tag}: missing (release.json pins ${pin.tag})`);
    return problems;
  }

  const manifestBytes = readFileSync(join(releaseDir, 'manifest.json'));
  const manifestHash = sha256Hex(manifestBytes);
  if (manifestHash !== pin.manifestSha256) {
    problems.push(
      `manifest.json: SHA-256 ${manifestHash} differs from the pinned ${pin.manifestSha256} (release.json)`,
    );
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.tag !== pin.tag)
    problems.push(`manifest.json: tag ${manifest.tag} is not ${pin.tag}`);
  if (manifest.sourceCommit !== pin.sourceCommit) {
    problems.push(
      `manifest.json: sourceCommit ${manifest.sourceCommit} is not ${pin.sourceCommit}`,
    );
  }
  if (manifest.package !== PACKAGE_NAME)
    problems.push(`manifest.json: package is not ${PACKAGE_NAME}`);
  if (manifest.schemaVersion !== 1) problems.push('manifest.json: schemaVersion is not 1');

  const listed = manifest.files ?? {};
  for (const [path, hash] of Object.entries(listed)) {
    if (!FILE_PATH.test(path)) {
      problems.push(`${path}: not an abi/<Name>.json or addresses/<chainId>.json path`);
      continue;
    }
    if (path.startsWith('addresses/')) continue; // generated form, checked below
    const file = join(releaseDir, path);
    if (!existsSync(file)) {
      problems.push(`${path}: listed in manifest.json but missing`);
      continue;
    }
    const actual = sha256Hex(readFileSync(file));
    if (actual !== hash)
      problems.push(`${path}: SHA-256 ${actual} differs from the manifest's ${hash}`);
  }
  for (const path of listFiles(releaseDir)) {
    if (path.startsWith('addresses/')) {
      problems.push(
        `${path}: is vendored, but address files are not vendored; the import keeps them in src/addresses.generated.ts`,
      );
    } else if (path !== 'manifest.json' && !Object.hasOwn(listed, path)) {
      problems.push(`${path}: not listed in manifest.json`);
    }
  }

  const addressFiles = Object.keys(listed).filter(
    (p) => FILE_PATH.test(p) && p.startsWith('addresses/'),
  );
  if (!addressFiles.includes('addresses/84532.json')) {
    problems.push(
      'addresses/84532.json: missing from manifest.json; Base Sepolia is the bundle chain',
    );
  }
  for (const path of addressFiles) problems.push(...checkAddressPath(path));

  const addressesTs = join(packageDir, 'src', 'addresses.generated.ts');
  if (!existsSync(addressesTs)) {
    problems.push('src/addresses.generated.ts: missing; re-run node tools/occ-v2-abi/import.mjs');
  } else {
    const text = readFileSync(addressesTs, 'utf8');
    if (ADDRESS_LITERAL.test(text)) {
      problems.push(
        'src/addresses.generated.ts: holds a 0x-prefixed address literal; it must stay scanner-safe (40 hex digits without 0x)',
      );
    }
    const covered = [...text.matchAll(/^ {2}'(\d+)': \{$/gm)].map((m) => m[1]).sort();
    const listedIds = addressFiles.map((p) => p.slice('addresses/'.length, -'.json'.length)).sort();
    if (JSON.stringify(covered) !== JSON.stringify(listedIds)) {
      problems.push(
        `src/addresses.generated.ts: covers chains ${covered.join(', ') || 'none'}, the manifest lists ${listedIds.join(', ') || 'none'}`,
      );
    }
  }

  let expected;
  try {
    expected = renderGenerated(packageDir);
  } catch (error) {
    problems.push(`src/generated: ${error.message}`);
    return problems;
  }
  const generatedDir = join(packageDir, 'src', 'generated');
  const present = existsSync(generatedDir)
    ? listFiles(generatedDir).map((p) => `src/generated/${p}`)
    : [];
  for (const path of new Set([...present, ...Object.keys(expected)])) {
    const file = join(packageDir, path);
    const actual = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (actual !== (expected[path] ?? null)) {
      problems.push(
        `${path}: the generated file differs from the vendored JSON; re-run node tools/occ-v2-abi/import.mjs (never edit it by hand)`,
      );
    }
  }
  return problems;
}

function main() {
  const problems = checkPackage(PACKAGE_DIR);
  if (problems.length) {
    for (const problem of problems) console.error(`occ-v2-abi: ${problem}`);
    process.exit(1);
  }
  const { tag } = readPin(PACKAGE_DIR);
  console.log(`occ-v2-abi: ${tag} matches its pinned manifest; Base Sepolia (84532) only. OK.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
