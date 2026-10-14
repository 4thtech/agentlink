// M1-8a against the real OS keychain (macOS Keychain, Windows Credential Manager, the Linux Secret
// Service through @napi-rs/keyring). It skips itself where the probe finds no usable keychain, as on
// a headless Linux CI runner without a D-Bus session. Items go under a random test service and are
// deleted afterwards, so the user's `agentlink` items are never touched.
import { encodeHex, randomBytes } from '@agentlink/crypto';
import { deriveAgentId } from '@agentlink/crypto/keystore';
import { afterAll, describe, expect, it } from 'vitest';
import {
  KeychainKeyStore,
  createKeychainAgent,
  keychainAccount,
  osKeychain,
  probeKeychain,
} from './index.js';

const service = `agentlink-test-${encodeHex(randomBytes(8))}`;
const keychain = osKeychain(service);
const probe = await probeKeychain(keychain, { timeoutMs: 5_000 });
const created: string[] = [];

describe.skipIf(!probe.ok)(`the OS keychain (${process.platform})`, () => {
  afterAll(async () => {
    for (const agentId of created) {
      await keychain.delete(keychainAccount(agentId, 'seed'));
      await keychain.delete(keychainAccount(agentId, 'store-key'));
    }
  });

  it('stores and returns bytes exactly, and reports a missing item as null', async () => {
    const account = `bytes:${encodeHex(randomBytes(8))}`;
    const value = Uint8Array.from([0, 255, 1, 128, 0, 10, 13]);
    await keychain.set(account, value);
    try {
      expect(await keychain.get(account)).toEqual(value);
    } finally {
      expect(await keychain.delete(account)).toBe(true);
    }
    expect(await keychain.get(account)).toBeNull();
    expect(await keychain.delete(account)).toBe(false);
  });

  it('creates an agent, reopens it and signs with it', async () => {
    const agentId = await createKeychainAgent(keychain);
    created.push(agentId);
    const seed = await keychain.get(keychainAccount(agentId, 'seed'));
    expect(seed === null ? null : deriveAgentId(seed)).toBe(agentId);
    const store = await KeychainKeyStore.open(keychain, agentId);
    expect((await store.getPublicBundle()).agentId).toBe(agentId);
    expect(await store.signEnvelopeHash(new Uint8Array(32))).toMatch(/^[0-9a-f]{128}$/);
    await store.close();
  });
});
