// M1-3f (D-83): the vendored OCC v2 ABI bundle in packages/occ-v2-abi is exactly the contracts
// release it pins. Every file matches manifest.json, manifest.json matches the pinned SHA-256, only
// the Base Sepolia (84532) address file exists and it is a testnet, and the generated TypeScript is
// the vendored JSON.
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAINNET_CHAIN_IDS, PACKAGE_DIR, checkPackage, readPin } from './check.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const temps = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

/** A copy of the package's pin, artifacts and generated sources in a fresh temp dir. */
function copyPackage() {
  const dir = mkdtempSync(join(tmpdir(), 'occ-v2-abi-'));
  temps.push(dir);
  for (const name of ['release.json', 'artifacts', 'src']) {
    cpSync(join(PACKAGE_DIR, name), join(dir, name), { recursive: true });
  }
  return dir;
}

const artifactsOf = (dir) => join(dir, 'artifacts', readPin(dir).tag);

/** Rewrites manifest.json with the current hashes of its files and re-pins its SHA-256. */
function rehash(dir, extraFiles = {}) {
  const artifacts = artifactsOf(dir);
  const manifestPath = join(artifacts, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const files = { ...manifest.files, ...extraFiles };
  for (const path of Object.keys(files)) files[path] = sha256(readFileSync(join(artifacts, path)));
  const text = `${JSON.stringify({ ...manifest, files }, null, 2)}\n`;
  writeFileSync(manifestPath, text);
  const pin = readPin(dir);
  writeFileSync(
    join(dir, 'release.json'),
    `${JSON.stringify({ ...pin, manifestSha256: sha256(text) }, null, 2)}\n`,
  );
}

describe('occ-v2-abi bundle check', () => {
  it('passes for the vendored release', () => {
    expect(checkPackage(PACKAGE_DIR)).toEqual([]);
  });

  it('pins v0.1.0-testnet.2 of 4thtech/occ-v2-contracts at its published manifest hash', () => {
    expect(readPin(PACKAGE_DIR)).toEqual({
      repository: '4thtech/occ-v2-contracts',
      tag: 'v0.1.0-testnet.2',
      sourceCommit: 'd46545b60bb324f63fb16a77af445bd50a51317a',
      manifestSha256: 'b1a8daa57d51bcbfbecbc91e6c5d2740d76428a4f63bbd5f1043537591188c1b',
    });
  });

  it('a copy passes before it is tampered with', () => {
    expect(checkPackage(copyPackage())).toEqual([]);
  });

  it('fails when a vendored file differs from the manifest', () => {
    const dir = copyPackage();
    const path = join(artifactsOf(dir), 'abi', 'IOCCNotary.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"notarize"', '"notarise"'));
    expect(checkPackage(dir).join('\n')).toMatch(/abi\/IOCCNotary\.json.*SHA-256/);
  });

  it('fails when manifest.json differs from the pinned SHA-256', () => {
    const dir = copyPackage();
    const path = join(artifactsOf(dir), 'manifest.json');
    writeFileSync(path, `${readFileSync(path, 'utf8')} `);
    expect(checkPackage(dir).join('\n')).toMatch(/manifest\.json.*pinned/);
  });

  it('fails when a listed file is missing', () => {
    const dir = copyPackage();
    rmSync(join(artifactsOf(dir), 'abi', 'IOCCManaged.json'));
    expect(checkPackage(dir).join('\n')).toMatch(/abi\/IOCCManaged\.json.*missing/);
  });

  it('fails on a file the manifest does not list', () => {
    const dir = copyPackage();
    writeFileSync(join(artifactsOf(dir), 'abi', 'Extra.json'), '[]\n');
    expect(checkPackage(dir).join('\n')).toMatch(/abi\/Extra\.json.*not listed/);
  });

  it('fails when the pin names another tag than the vendored release', () => {
    const dir = copyPackage();
    const pin = readPin(dir);
    writeFileSync(
      join(dir, 'release.json'),
      `${JSON.stringify({ ...pin, tag: 'v0.1.0-testnet.1' }, null, 2)}\n`,
    );
    const problems = checkPackage(dir).join('\n');
    expect(problems).toMatch(/v0\.1\.0-testnet\.1/);
  });

  it('fails when artifacts/ holds a second release', () => {
    const dir = copyPackage();
    mkdirSync(join(dir, 'artifacts', 'v0.0.9-old'));
    expect(checkPackage(dir).join('\n')).toMatch(/v0\.0\.9-old/);
  });

  it('fails on an address file for any chain other than Base Sepolia (84532)', () => {
    const dir = copyPackage();
    const artifacts = artifactsOf(dir);
    const base = JSON.parse(readFileSync(join(artifacts, 'addresses', '84532.json'), 'utf8'));
    writeFileSync(
      join(artifacts, 'addresses', '8453.json'),
      `${JSON.stringify({ ...base, chainId: 8453, testnet: false }, null, 2)}\n`,
    );
    rehash(dir, { 'addresses/8453.json': '' });
    const problems = checkPackage(dir).join('\n');
    expect(problems).toMatch(/addresses\/8453\.json/);
    expect(problems).toMatch(/mainnet/);
  });

  it('fails when the Base Sepolia file is not marked testnet or names another chain', () => {
    const dir = copyPackage();
    const path = join(artifactsOf(dir), 'addresses', '84532.json');
    const base = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, `${JSON.stringify({ ...base, testnet: false, chainId: 1 }, null, 2)}\n`);
    rehash(dir);
    const problems = checkPackage(dir).join('\n');
    expect(problems).toMatch(/testnet/);
    expect(problems).toMatch(/chainId/);
  });

  it('fails when the generated TypeScript differs from the vendored JSON', () => {
    const dir = copyPackage();
    const generated = join(dir, 'src', 'generated');
    const [first] = readdirSync(generated).filter((name) => name.endsWith('.ts'));
    const path = join(generated, first);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n// edited by hand\n`);
    expect(checkPackage(dir).join('\n')).toMatch(/generated.*import/);
  });

  it('knows the mainnet chain IDs it refuses', () => {
    for (const id of [1, 10, 100, 137, 8453, 42161]) expect(MAINNET_CHAIN_IDS).toContain(id);
    expect(MAINNET_CHAIN_IDS).not.toContain(84532);
  });
});
