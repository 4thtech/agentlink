// M1-8a against the real OS keychain (macOS Keychain, Windows Credential Manager, the Linux Secret
// Service through @napi-rs/keyring). Opt-in (IR-M1-8a-1 L-2): it runs only with
// AGENTLINK_REQUIRE_KEYCHAIN=1, so a plain `pnpm test` never writes to a developer's keychain. When
// the flag is set, a keychain that fails the probe FAILS the suite instead of skipping it (M-1: the
// CI keychain matrix sets the flag, so a runner without a keychain cannot pass green). Items go
// under a random test service and are deleted afterwards; `agentlink` items are never touched.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeHex, randomBytes } from '@agentlink/crypto';
import { deriveAgentId } from '@agentlink/crypto/keystore';
import { afterAll, describe, expect, it } from 'vitest';
import { KeychainKeyStore, createKeychainAgent } from './keychain-keystore.js';
import { withInterProcessLock } from './inter-process-lock.js';
import { keychainAccount, osKeychain, probeKeychain } from './keychain.js';
import { keychainPolicyMark } from './policy-mark.js';

const required = process.env['AGENTLINK_REQUIRE_KEYCHAIN'] === '1';
const service = `agentlink-test-${encodeHex(randomBytes(8))}`;
const keychain = osKeychain(service);
const created: string[] = [];

describe.skipIf(!required)(`the OS keychain (${process.platform})`, () => {
  afterAll(async () => {
    // Every delete is attempted, whatever happens to the others.
    await Promise.allSettled(
      created.flatMap((agentId) => [
        keychain.delete(keychainAccount(agentId, 'seed')),
        keychain.delete(keychainAccount(agentId, 'store-key')),
        keychain.delete(keychainAccount(agentId, 'policy-version')),
      ]),
    );
  });

  it('the keychain probe succeeds (a failure here fails the run, never skips it)', async () => {
    expect(await probeKeychain(keychain, { timeoutMs: 5_000 })).toEqual({ ok: true });
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

  it('keeps the policy-version mark as an item that only rises (M1-8g)', async () => {
    const agentId = await createKeychainAgent(keychain);
    created.push(agentId);
    const dir = await mkdtemp(join(tmpdir(), 'agentlink-mark-native-'));
    try {
      const withLock = <T>(fn: () => Promise<T> | T): Promise<T> =>
        withInterProcessLock(join(dir, 'agent.sqlite.lock'), fn);
      const mark = keychainPolicyMark(keychain, agentId, withLock);
      expect(await mark.read()).toBe(0);
      expect(await mark.raise(3)).toBe(3);
      expect(await mark.raise(2)).toBe(3);
      expect(await keychainPolicyMark(keychain, agentId, withLock).read()).toBe(3);
      expect(await keychain.get(keychainAccount(agentId, 'policy-version'))).toEqual(
        Uint8Array.from([0x33]),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
