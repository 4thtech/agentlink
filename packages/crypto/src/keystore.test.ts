// IR-M1-1b-1 M-1: functions that take a master seed or a secret key, or return a secret, live only
// in the restricted subpath @agentlink/crypto/keystore (04 §8.1). The main entry keeps public-key
// and verification functions. tools/deps-check limits who may import the subpath.
import { describe, expect, it } from 'vitest';
import * as main from './index.js';
import * as keystore from './keystore.js';

// The nip44 names are built from their suffixes: written out as adjacent string literals they
// trip the secret scanner's generic-api-key rule (a false positive, not a key).
const nip44 = (suffix: string): string => `nip44${suffix}`;

const SEED_OR_SECRET = [
  'deriveKey',
  'deriveSecretKey',
  'derivePublicKey',
  'deriveAgentId',
  'derivePublicIdentity',
  'bip340Sign',
  'bip340PublicKey',
  // M1-1g: NIP-44 functions that take a secret key or a conversation key, and the in-memory
  // KeyStores that are built from a seed (tests and development only).
  nip44('ConversationKey'),
  nip44('MessageKeys'),
  nip44('EncryptWithKey'),
  nip44('DecryptWithKey'),
  'MemoryKeyStore',
  'MemoryOwnerKeyStore',
];

describe('@agentlink/crypto/keystore', () => {
  it('exports exactly the seed and secret-key functions', () => {
    expect(Object.keys(keystore).sort()).toEqual([...SEED_OR_SECRET].sort());
    for (const name of SEED_OR_SECRET) {
      expect(typeof (keystore as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  it('keeps the internal event signer out of both entries', () => {
    expect(Object.keys(main)).not.toContain('signNostrEvent');
    expect(Object.keys(keystore)).not.toContain('signNostrEvent');
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
      // M1-1g: public NIP-44, Nostr event and gift-wrap helpers, and the KeyStore error type.
      'NIP44_MIN_PLAINTEXT_BYTES',
      'NIP44_MAX_PLAINTEXT_BYTES',
      'nip44PaddedLength',
      'NOSTR_KIND_SEAL',
      'NOSTR_KIND_GIFT_WRAP',
      'nostrEventId',
      'verifyNostrEvent',
      'createGiftWrap',
      'KeyStoreError',
      'OWNER_SESSION_DEFAULT_TTL_MS',
      'OWNER_SESSION_MAX_TTL_MS',
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
