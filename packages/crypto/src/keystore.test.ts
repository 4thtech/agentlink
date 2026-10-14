// IR-M1-1b-1 M-1: functions that take a master seed or a secret key, or return a secret, live only
// in the restricted subpath @agentlink/crypto/keystore (04 §8.1). The main entry keeps public-key
// and verification functions. tools/deps-check limits who may import the subpath.
import { describe, expect, it } from 'vitest';
import * as main from './index.js';
import * as keystore from './keystore.js';

const SEED_OR_SECRET = [
  'deriveKey',
  'deriveSecretKey',
  'derivePublicKey',
  'deriveAgentId',
  'derivePublicIdentity',
  'bip340Sign',
  'bip340PublicKey',
  // M1-1e (IR-M1-1e-1 M-1): ECDSA signing with a secret key.
  'signDigestEcdsa',
  'signTypedData',
  'signAgentCard',
  // M1-1f: Argon2id, password() normalisation and code generation, and the ALKS / ALKO seal and
  // open functions (04 §2.8), which take or return a passphrase-derived key, a seed or the entries.
  'argon2id',
  'normalizeSecret',
  'generateSecretCode',
  'deriveKeystoreKek',
  'newKeystoreKek',
  'sealKeystoreFile',
  'openKeystoreFile',
  'openKeystoreFileWithKek',
  'sealOwnerSeed',
  'openOwnerSeed',
  // IR-M1-1f-1 L-3: the agent ≠ owner probes take a candidate secret (04 §2.8).
  'ownerSecretUnlocks',
  'keystoreSecretUnlocks',
];

// M1-1f: the deterministic test seam (fixed nonce for ALKS and ALKO, Argon2id with K and X).
const TEST_SEAM = [
  'argon2idWithSecretAndAd',
  'sealKeystoreFileWithNonce',
  'sealOwnerSeedWithNonce',
];

describe('@agentlink/crypto/keystore', () => {
  it('exports exactly the seed and secret-key functions', () => {
    expect(Object.keys(keystore).sort()).toEqual([...SEED_OR_SECRET].sort());
    for (const name of SEED_OR_SECRET) {
      expect(typeof (keystore as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  it('is the only entry that has them: the main entry exports none', () => {
    const exported = Object.keys(main);
    for (const name of SEED_OR_SECRET) expect(exported, name).not.toContain(name);
  });

  it('keeps the public-key, verification and fingerprint functions in the main entry', () => {
    for (const name of [
      'bip340Verify',
      'isBip340PublicKey',
      'kidFromEncPublicKey',
      'evmAddressChecksummed',
      'evmAddressFromPublicKey',
      'ownerFingerprint',
      'agentFingerprint',
      'formatFingerprint',
      'KEY_LABELS',
      'recoverEvmAddress',
      'decodeEcdsaSignature',
      'hashTypedData',
      'hashAgentCard',
      'verifyAgentCard',
      'verifyCardOwnerSig',
      'verifyCardAgentSig',
      // M1-1f: public values only (the invite secret's proofKey and the pairing transcript).
      'derivePairingProofKey',
      'pairingProof',
      'verifyPairingProof',
      'hmacSha256',
      'safetyCodeCommit',
      'checkSafetyCodeReveal',
      'safetyCodeTranscript',
      'pairingDigest',
      'safetyCodeFromDigest',
      'computeSafetyCode',
      'safetyCodeForRole',
      'KEYSTORE_KDF_DEFAULTS',
      'KEYSTORE_KDF_BOUNDS',
    ]) {
      expect(Object.keys(main), name).toContain(name);
    }
  });

  it('exposes a ./keystore subpath in the package exports, next to the main entry', async () => {
    const manifest = (await import('../package.json', { with: { type: 'json' } })).default as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(manifest.exports).sort()).toEqual(['.', './keystore']);
    expect(manifest.exports['./keystore']).toEqual({
      types: './dist/keystore.d.ts',
      default: './dist/keystore.js',
    });
  });

  it('exports the deterministic test seam from no entry point (M1-1f)', async () => {
    const seam = await import('./testing.js');
    expect(Object.keys(seam).sort()).toEqual([...TEST_SEAM].sort());
    for (const name of TEST_SEAM) {
      expect(Object.keys(main), name).not.toContain(name);
      expect(Object.keys(keystore), name).not.toContain(name);
    }
  });

  // IR-M1-1f-1 L-2: the fixed-nonce sealers exist in the built keystore-file module (production
  // seals call them with a fresh nonce), so they are kept unreachable instead: no entry point exports
  // them, package.json `exports` has no path to dist/keystore-file.js, and deps-check and ESLint
  // refuse deep imports into a workspace package's dist/ or src/ (tools/deps-check/policy.mjs).
  it('exports the fixed-nonce sealers from no entry point', () => {
    for (const name of [
      'sealKeystoreFileWithNonceUnsafe',
      'sealOwnerSeedWithNonceUnsafe',
      'sealKeystoreFileWithNonce',
      'sealOwnerSeedWithNonce',
    ]) {
      expect(Object.keys(main), name).not.toContain(name);
      expect(Object.keys(keystore), name).not.toContain(name);
    }
  });

  it('does not build the test seam file: tsconfig.json excludes src/testing.ts from dist', async () => {
    const config = (await import('../tsconfig.json', { with: { type: 'json' } })).default as {
      exclude: string[];
    };
    expect(config.exclude).toContain('src/testing.ts');
  });
});
