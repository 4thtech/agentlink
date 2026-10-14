// M1-1g-b (IR-M1-1g-G2-1 R2-L-1): transport-nostr tests use the in-memory KeyStore by package name
// (04 §3.1.1: the test doubles are allowed in tests, test-vectors and e2e, never in production src).
import { CryptoInputError, KeyStoreError } from '@agentlink/crypto';
import { MemoryKeyStore } from '@agentlink/crypto/testing';
import { describe, expect, it } from 'vitest';

describe('the crypto test seam in @agentlink/transport-nostr tests', () => {
  it('resolves MemoryKeyStore, with one copy of the crypto module', async () => {
    const store = new MemoryKeyStore(new Uint8Array(32).fill(7));
    const bundle = await store.getPublicBundle();
    expect(bundle.agentId).toMatch(/^0x[0-9a-f]{40}$/);
    expect(() => new MemoryKeyStore(new Uint8Array(31))).toThrow(CryptoInputError);
    await store.close();
    await expect(store.getPublicBundle()).rejects.toBeInstanceOf(KeyStoreError);
  });
});
