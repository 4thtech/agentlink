#!/usr/bin/env node
// M1-3f (D-83): imports a tagged OCC v2 contracts release into packages/occ-v2-abi.
//
// Usage (needs `gh` signed in with read access to the private contracts repository):
//   node tools/occ-v2-abi/import.mjs --tag v0.1.0-testnet.2 --manifest-sha256 <hex from the release notes>
//   node tools/occ-v2-abi/import.mjs --tag … --manifest-sha256 … --from <dir with the downloaded assets>
//
// 1. Downloads the release's JSON assets with `gh release download` into a fresh temp directory
//    (or reads them from --from), and refuses any asset that is not JSON.
// 2. Verifies manifest.json against the SHA-256 given on the command line (copied from the release
//    notes by a person, so a swapped asset cannot vouch for itself), its tag and package name, and
//    that the tag's commit equals the manifest's sourceCommit (skipped with --from).
// 3. Verifies every listed file against the manifest. Asset names are the manifest paths with `/`
//    replaced by `-` (abi/IOCCNotary.json is the asset abi-IOCCNotary.json). Any other asset fails.
// 4. Address files (addresses/<chainId>.json) are checked (allowed chain, chainId, testnet) and
//    NOT vendored: they become src/addresses.generated.ts, a scanner-safe form (neutral field names,
//    addresses without `0x`; render.mjs). The import refuses unless the exporter's exact bytes
//    rebuild from that form (canonicalJson), so the chain test can check them against the manifest.
// 5. Replaces artifacts/ with artifacts/<tag>/ holding the exact bytes of manifest.json and the ABI
//    files, writes release.json (the pin) and regenerates src/generated/, then runs check.mjs.
// Then, in the same PR: review the ABI diff, update FUNCTION_TAGS in src/tags.ts, the pinned surface
// in packages/chain/src/occ-v2-abi.test.ts and OCC_V2_ABI_PIN in packages/chain.
//
// Nothing is executed from the release; the files are only hashed, parsed and copied. No secret is
// read or written (gh uses its own stored credentials).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  PACKAGE_DIR,
  PACKAGE_NAME,
  REPOSITORY,
  checkAddressPath,
  checkPackage,
  checkPin,
  sha256Hex,
} from './check.mjs';
import {
  canonicalJson,
  fromSafeRecord,
  renderAddresses,
  renderGenerated,
  toSafeRecord,
} from './render.mjs';

const FILE_PATH = /^(abi|addresses)\/[A-Za-z0-9]+\.json$/;
const ASSET_NAME = /^[A-Za-z0-9-]+\.json$/;

function fail(message) {
  console.error(`occ-v2-abi import: ${message}`);
  process.exit(1);
}

/** Reads and verifies the release assets in `dir`; returns { manifestBytes, manifest, files }. */
export function verifyAssets(dir, { tag, manifestSha256 }) {
  const names = readdirSync(dir).sort();
  for (const name of names) {
    if (!ASSET_NAME.test(name)) throw new Error(`unexpected asset ${JSON.stringify(name)}`);
  }
  if (!names.includes('manifest.json')) throw new Error('the release has no manifest.json');
  const manifestBytes = readFileSync(join(dir, 'manifest.json'));
  const actual = sha256Hex(manifestBytes);
  if (actual !== manifestSha256) {
    throw new Error(`manifest.json SHA-256 ${actual} differs from the pinned ${manifestSha256}`);
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.tag !== tag) throw new Error(`manifest.json names tag ${manifest.tag}, not ${tag}`);
  if (manifest.package !== PACKAGE_NAME)
    throw new Error(`manifest.json is not for ${PACKAGE_NAME}`);
  if (manifest.schemaVersion !== 1) throw new Error('manifest.json schemaVersion is not 1');
  if (!/^[0-9a-f]{40}$/.test(String(manifest.sourceCommit))) {
    throw new Error('manifest.json sourceCommit is not a 40-hex commit');
  }
  const files = {};
  const expectedAssets = new Set(['manifest.json']);
  for (const [path, hash] of Object.entries(manifest.files ?? {})) {
    if (!FILE_PATH.test(path))
      throw new Error(`manifest path ${JSON.stringify(path)} is not allowed`);
    const asset = path.replace('/', '-');
    expectedAssets.add(asset);
    if (!names.includes(asset)) throw new Error(`asset ${asset} (${path}) is missing`);
    const bytes = readFileSync(join(dir, asset));
    if (sha256Hex(bytes) !== hash) throw new Error(`${asset} differs from the manifest`);
    JSON.parse(bytes.toString('utf8'));
    files[path] = bytes;
  }
  for (const name of names) {
    if (!expectedAssets.has(name)) throw new Error(`asset ${name} is not listed in manifest.json`);
  }
  return { manifestBytes, manifest, files };
}

function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: 'string' },
      'manifest-sha256': { type: 'string' },
      repository: { type: 'string', default: REPOSITORY },
      from: { type: 'string' },
    },
  });
  const pin = {
    manifestSha256: String(values['manifest-sha256'] ?? '').toLowerCase(),
    repository: values.repository,
    sourceCommit: '0'.repeat(40),
    tag: values.tag,
  };
  const pinProblems = checkPin(pin);
  if (pinProblems.length)
    fail(`${pinProblems.join('; ')} (usage: --tag <tag> --manifest-sha256 <hex>)`);

  let dir = values.from;
  let temp;
  if (!dir) {
    temp = mkdtempSync(join(tmpdir(), 'occ-v2-abi-import-'));
    dir = join(temp, 'assets');
    mkdirSync(dir);
    execFileSync(
      'gh',
      ['release', 'download', pin.tag, '-R', pin.repository, '-D', dir, '-p', '*'],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
  }
  try {
    const { manifestBytes, manifest, files } = verifyAssets(dir, pin);
    pin.sourceCommit = manifest.sourceCommit;
    if (!values.from) {
      const tagCommit = execFileSync(
        'gh',
        ['api', `repos/${pin.repository}/commits/${pin.tag}`, '--jq', '.sha'],
        { encoding: 'utf8' },
      ).trim();
      if (tagCommit !== manifest.sourceCommit) {
        throw new Error(
          `tag ${pin.tag} is commit ${tagCommit}, the manifest says ${manifest.sourceCommit}`,
        );
      }
    }
    const records = {};
    for (const [path, bytes] of Object.entries(files)) {
      if (!path.startsWith('addresses/')) continue;
      const id = path.slice('addresses/'.length, -'.json'.length);
      const pathProblems = checkAddressPath(path);
      if (pathProblems.length) throw new Error(pathProblems.join('; '));
      const text = bytes.toString('utf8');
      const file = JSON.parse(text);
      if (file.chainId !== Number(id))
        throw new Error(`${path}: chainId differs from the file name`);
      if (file.testnet !== true) throw new Error(`${path}: not marked testnet: true`);
      const record = toSafeRecord(file);
      if (canonicalJson(fromSafeRecord(record)) !== text) {
        throw new Error(`${path}: the released bytes do not rebuild from the generated form`);
      }
      records[id] = record;
    }
    const artifacts = join(PACKAGE_DIR, 'artifacts');
    rmSync(artifacts, { recursive: true, force: true });
    const releaseDir = join(artifacts, pin.tag);
    mkdirSync(releaseDir, { recursive: true });
    for (const [path, bytes] of Object.entries(files)) {
      if (path.startsWith('addresses/')) continue;
      mkdirSync(join(releaseDir, path.split('/')[0]), { recursive: true });
      writeFileSync(join(releaseDir, path), bytes);
    }
    writeFileSync(join(releaseDir, 'manifest.json'), manifestBytes);
    const { manifestSha256, repository, sourceCommit, tag } = pin;
    writeFileSync(
      join(PACKAGE_DIR, 'release.json'),
      `${JSON.stringify({ repository, tag, sourceCommit, manifestSha256 }, null, 2)}\n`,
    );
    const generatedDir = join(PACKAGE_DIR, 'src', 'generated');
    rmSync(generatedDir, { recursive: true, force: true });
    mkdirSync(generatedDir, { recursive: true });
    for (const [path, text] of Object.entries(renderGenerated(PACKAGE_DIR))) {
      writeFileSync(join(PACKAGE_DIR, path), text);
    }
    writeFileSync(
      join(PACKAGE_DIR, 'src', 'addresses.generated.ts'),
      renderAddresses({ repository, tag, sourceCommit }, records),
    );
  } catch (error) {
    fail(error.message);
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }

  const problems = checkPackage(PACKAGE_DIR);
  if (problems.length) fail(problems.join('\n'));
  console.log(
    `occ-v2-abi import: ${pin.tag} (${pin.sourceCommit}) imported and verified. Now review the ABI diff and update FUNCTION_TAGS, the chain test's pinned surface and OCC_V2_ABI_PIN.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
