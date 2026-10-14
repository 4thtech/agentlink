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
});
