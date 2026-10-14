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
  // M1-1c: HPKE open of a CEK with the recipient's secret key, and envelope-hash signing.
  'unwrapCek',
  'signEnvelopeHash',
  // M1-1e (IR-M1-1e-1 M-1): ECDSA signing with a secret key.
  'signDigestEcdsa',
  'signTypedData',
  'signAgentCard',
];

// M1-1c: the deterministic test seam (fixed HPKE ephemeral key or AES-GCM IV, raw RFC 9180 suite).
const TEST_SEAM = [
  'wrapCekWithEphemeralKey',
  'encryptPayloadWithIv',
  'hpkeSealSequence',
  'hpkeOpen',
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
      // M1-1c: envelope structure, hashes and verification, and the CEK and payload operations,
      // which take a per-envelope CEK but no long-term secret (03 §3: hpkeOpen returns the CEK).
      'parseEnvelope',
      'parseUnsignedEnvelope',
      'parseEnvelopeHeader',
      'envelopeHash',
      'envelopeAad',
      'envelopeSignatureInput',
      'verifyEnvelope',
      'cekInfo',
      'wrapCek',
      'generateCek',
      'encryptPayload',
      'decryptPayload',
      'recoverEvmAddress',
      'decodeEcdsaSignature',
      'hashTypedData',
      'hashAgentCard',
      'verifyAgentCard',
      'verifyCardOwnerSig',
      'verifyCardAgentSig',
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

  it('exports the deterministic test seam from no entry point (M1-1c)', async () => {
    const seam = await import('./testing.js');
    expect(Object.keys(seam).sort()).toEqual([...TEST_SEAM].sort());
    for (const name of TEST_SEAM) {
      expect(Object.keys(main), name).not.toContain(name);
      expect(Object.keys(keystore), name).not.toContain(name);
    }
  });

  it('never builds the test seam: tsconfig.json excludes src/testing.ts from dist (M1-1c)', async () => {
    const config = (await import('../tsconfig.json', { with: { type: 'json' } })).default as {
      exclude: string[];
    };
    expect(config.exclude).toContain('src/testing.ts');
  });
});
