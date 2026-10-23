// M1-3f (D-83): the vendored OCC v2 ABI bundle in packages/occ-v2-abi is exactly the contracts
// release it pins. Every vendored file matches manifest.json, manifest.json matches the pinned
// SHA-256, the generated ABI TypeScript is the vendored JSON, and the manifest lists an address file
// for Base Sepolia (84532) and Gnosis Chiado (10200) only. The address files are not vendored: the import stores them in a
// scanner-safe generated form (src/addresses.generated.ts, no `0x` + 40-hex literal), and
// packages/chain/src/occ-v2-abi.test.ts rebuilds the exact file bytes from it and checks them
// against the manifest's SHA-256.
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
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
  for (const path of Object.keys(files)) {
    if (existsSync(join(artifacts, path)))
      files[path] = sha256(readFileSync(join(artifacts, path)));
  }
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

  it('pins v0.1.0-testnet.4 of 4thtech/occ-v2-contracts at its published manifest hash', () => {
    expect(readPin(PACKAGE_DIR)).toEqual({
      repository: '4thtech/occ-v2-contracts',
      tag: 'v0.1.0-testnet.4',
      sourceCommit: 'd4f4c79d783d87cca90409e5084b8c466bb67cfd',
      manifestSha256: '4d2bfc98e71da1ed3b60fed574c0333ee945a17e701e32bfab10d6cab5bb436e',
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

  it('fails when the manifest lists an address file for any chain but Base Sepolia (84532) and Gnosis Chiado (10200)', () => {
    const dir = copyPackage();
    rehash(dir, { 'addresses/8453.json': 'ab'.repeat(32) });
    const problems = checkPackage(dir).join('\n');
    expect(problems).toMatch(/addresses\/8453\.json/);
    expect(problems).toMatch(/mainnet/);
  });

  it('fails when the manifest lists no Base Sepolia address file', () => {
    const dir = copyPackage();
    const path = join(artifactsOf(dir), 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    delete manifest.files['addresses/84532.json'];
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    rehash(dir);
    expect(checkPackage(dir).join('\n')).toMatch(/addresses\/84532\.json.*missing/);
  });

  it('fails when an address file is vendored verbatim instead of generated', () => {
    const dir = copyPackage();
    mkdirSync(join(artifactsOf(dir), 'addresses'), { recursive: true });
    writeFileSync(join(artifactsOf(dir), 'addresses', '84532.json'), '{}\n');
    expect(checkPackage(dir).join('\n')).toMatch(/addresses\/84532\.json.*not vendored/);
  });

  it('fails when the generated addresses hold a 0x-prefixed 40-hex literal', () => {
    const dir = copyPackage();
    const path = join(dir, 'src', 'addresses.generated.ts');
    const literal = `0x${'a1'.repeat(20)}`;
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nexport const leaked = '${literal}';\n`);
    expect(checkPackage(dir).join('\n')).toMatch(/addresses\.generated\.ts.*scanner-safe/);
  });

  it('fails when the generated addresses are missing or cover another chain set', () => {
    const dir = copyPackage();
    const path = join(dir, 'src', 'addresses.generated.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace("'84532': {", "'11155111': {"));
    expect(checkPackage(dir).join('\n')).toMatch(/addresses\.generated\.ts.*84532/);
    rmSync(path);
    expect(checkPackage(dir).join('\n')).toMatch(/addresses\.generated\.ts.*missing/);
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
