// M1-8a: the OS keychain KeyStore (04 §2.2, §2.8 selection, §2.9; 07 §9.1) against an in-memory
// keychain double, so it runs headless on CI. The real OS keychain is exercised by
// keychain-native.test.ts, which skips itself where no keychain is usable.
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CryptoInputError,
  KeyStoreError,
  bip340Verify,
  decodeEcdsaSignature,
  decodeHex,
  encodeBase64url,
  encodeHex,
  envelopeSignatureInput,
  hashTypedData,
  recoverEvmAddress,
  verifyNostrEvent,
  wrapCek,
  type TypedData,
} from '@4thtech-io/crypto';
import { deriveAgentId, derivePublicIdentity } from '@4thtech-io/crypto/keystore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The raw keychain backend is internal (IR-M1-8a-1 M-2): tests reach it through the modules, never
// through the package entry, which exports only opaque entry points (fence.test.ts).
import { NodeKeyStoreError } from './errors.js';
import {
  KeychainKeyStore,
  createKeychainAgent,
  openRecordedKeyStore,
} from './keychain-keystore.js';
import {
  KEYCHAIN_LINUX_STORE,
  KEYCHAIN_SERVICE,
  keychainAccount,
  probeKeychain,
  selectKeyStoreBackend,
  type KeychainBackend,
} from './keychain.js';

const SEED_A = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const SEED_B = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const ID_A = deriveAgentId(SEED_A);
const ID_B = deriveAgentId(SEED_B);
const ENVELOPE_ID = new Uint8Array(16).fill(9);
const CEK = new Uint8Array(32).fill(4);
const TYPED: TypedData = {
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }],
    Note: [{ name: 'text', type: 'string' }],
  },
  primaryType: 'Note',
  domain: { name: 'AgentLink test' },
  message: { text: 'hello' },
};

/** An in-memory keychain: every get returns a fresh copy, recorded so a test can see it wiped. */
class FakeKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  readonly handedOut: Uint8Array[] = [];
  failing = false;
  hanging = false;
  reads = 0;

  #gate(): Promise<void> {
    if (this.hanging) return new Promise(() => undefined);
    if (this.failing) return Promise.reject(new Error('native: secret 0xdeadbeef in message'));
    return Promise.resolve();
  }

  async get(account: string): Promise<Uint8Array | null> {
    await this.#gate();
    this.reads += 1;
    const value = this.items.get(account);
    if (value === undefined) return null;
    const copy = value.slice();
    this.handedOut.push(copy);
    return copy;
  }

  async set(account: string, value: Uint8Array): Promise<void> {
    await this.#gate();
    this.items.set(account, value.slice());
  }

  async delete(account: string): Promise<boolean> {
    await this.#gate();
    return this.items.delete(account);
  }

  put(agentId: string, seed: Uint8Array): void {
    this.items.set(keychainAccount(agentId, 'seed'), seed.slice());
    this.items.set(keychainAccount(agentId, 'store-key'), new Uint8Array(32).fill(7));
  }
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (
      error instanceof NodeKeyStoreError ||
      error instanceof KeyStoreError ||
      error instanceof CryptoInputError
    ) {
      return error.code;
    }
    throw error;
  }
  return 'accepted';
}

const allZero = (bytes: Uint8Array): boolean => bytes.every((b) => b === 0);

describe('keychain items (04 §2.2, §2.8, §2.9)', () => {
  it('uses service agentlink, account <agentId> for the seed and <agentId>:<name> for others', () => {
    expect(KEYCHAIN_SERVICE).toBe('agentlink');
    expect(keychainAccount(ID_A, 'seed')).toBe(ID_A);
    expect(keychainAccount(ID_A, 'store-key')).toBe(`${ID_A}:store-key`);
  });

  it('refuses an agent ID that is not 0x + 40 lowercase hex before building an account', () => {
    for (const bad of [ID_A.toUpperCase(), `0X${ID_A.slice(2)}`, ID_A.slice(0, 41), 'agent', '']) {
      expect(() => keychainAccount(bad, 'seed')).toThrow(NodeKeyStoreError);
    }
  });

  it('pins Linux to the Secret Service, never the non-persistent kernel keyring', () => {
    expect(KEYCHAIN_LINUX_STORE).toBe('secret-service');
  });
});

describe('createKeychainAgent', () => {
  let keychain: FakeKeychain;
  beforeEach(() => {
    keychain = new FakeKeychain();
  });

  it('writes a seed that derives the returned agent ID, and a 32-byte store key', async () => {
    const agentId = await createKeychainAgent(keychain);
    expect(agentId).toMatch(/^0x[0-9a-f]{40}$/);
    const seed = keychain.items.get(keychainAccount(agentId, 'seed'));
    expect(seed?.length).toBe(32);
    expect(deriveAgentId(seed as Uint8Array)).toBe(agentId);
    const storeKey = keychain.items.get(keychainAccount(agentId, 'store-key'));
    expect(storeKey?.length).toBe(32);
    expect(storeKey).not.toEqual(seed);
    expect(keychain.items.size).toBe(2);
  });

  it('keeps several agents side by side, each under its own account', async () => {
    const a = await createKeychainAgent(keychain);
    const b = await createKeychainAgent(keychain);
    expect(a).not.toBe(b);
    const storeA = await KeychainKeyStore.open(keychain, a);
    const storeB = await KeychainKeyStore.open(keychain, b);
    expect((await storeA.getPublicBundle()).agentId).toBe(a);
    expect((await storeB.getPublicBundle()).agentId).toBe(b);
  });

  it('leaves nothing behind when the keychain fails', async () => {
    keychain.failing = true;
    expect(await codeOf(() => createKeychainAgent(keychain))).toBe('keychain_failed');
    expect(keychain.items.size).toBe(0);
  });

  it('writes the seed to no file (acceptance: filesystem diff during init)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentlink-m1-8a-'));
    const savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      const agentId = await createKeychainAgent(keychain);
      const store = await KeychainKeyStore.open(keychain, agentId);
      await store.signEnvelopeHash(new Uint8Array(32));
      const seed = keychain.items.get(keychainAccount(agentId, 'seed')) as Uint8Array;
      const needles = [encodeHex(seed), encodeBase64url(seed)];
      const files = await readdir(home, { recursive: true, withFileTypes: true });
      for (const file of files.filter((f) => f.isFile())) {
        const bytes = await readFile(join(file.parentPath, file.name));
        expect(Buffer.from(bytes).includes(Buffer.from(seed))).toBe(false);
        for (const needle of needles) expect(bytes.toString('latin1')).not.toContain(needle);
      }
    } finally {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('KeychainKeyStore (KeyStore contract, 04 §3.1.1)', () => {
  let keychain: FakeKeychain;
  let store: KeychainKeyStore;

  beforeEach(async () => {
    keychain = new FakeKeychain();
    keychain.put(ID_A, SEED_A);
    keychain.put(ID_B, SEED_B);
    store = await KeychainKeyStore.open(keychain, ID_A, { keyEpoch: 2 });
  });

  afterEach(async () => {
    await store.close();
  });

  it('returns the public bundle the seed derives, at the current and an older epoch', async () => {
    expect(await store.getPublicBundle()).toEqual(derivePublicIdentity(SEED_A, 2));
    expect(await store.getPublicBundle({ epoch: 1 })).toEqual(derivePublicIdentity(SEED_A, 1));
    expect(await codeOf(() => store.getPublicBundle({ epoch: 3 }))).toBe('epoch_unavailable');
  });

  it('signs envelope hashes under the envelope tag with the current Nostr key', async () => {
    const hash = new Uint8Array(32).fill(1);
    const sig = await store.signEnvelopeHash(hash);
    const nostr = derivePublicIdentity(SEED_A, 2).agentNostr;
    expect(bip340Verify(nostr, envelopeSignatureInput(hash), decodeHex(sig))).toBe(true);
    expect(await codeOf(() => store.signEnvelopeHash(new Uint8Array(31)))).toBe('invalid_length');
  });

  it('signs Nostr events with the current Nostr key', async () => {
    const event = await store.signNostr({
      kind: 13,
      created_at: 1,
      tags: [['p', 'x']],
      content: 'c',
    });
    expect(verifyNostrEvent(event)).toBe(true);
    expect(event.pubkey).toBe(encodeHex(derivePublicIdentity(SEED_A, 2).agentNostr));
    expect(Object.isFrozen(event)).toBe(true);
    const bad = { kind: -1, created_at: 1, tags: [], content: '' };
    expect(await codeOf(() => store.signNostr(bad))).toBe('invalid_argument');
  });

  it('NIP-44 round trip with a peer, and decryption at an older epoch', async () => {
    const peer = await KeychainKeyStore.open(keychain, ID_B);
    const peerHex = encodeHex(derivePublicIdentity(SEED_B, 0).agentNostr);
    const payload = await store.nip44Encrypt(peerHex, 'hello');
    expect(
      await peer.nip44Decrypt(encodeHex(derivePublicIdentity(SEED_A, 2).agentNostr), payload),
    ).toBe('hello');
    const old = await peer.nip44Encrypt(
      encodeHex(derivePublicIdentity(SEED_A, 1).agentNostr),
      'old',
    );
    expect(await store.nip44Decrypt(peerHex, old, { epoch: 1 })).toBe('old');
    expect(await codeOf(() => store.nip44Decrypt(peerHex, old, { epoch: 3 }))).toBe(
      'epoch_unavailable',
    );
  });

  it('unwraps a CEK sealed to its enc key, at the current and an older epoch only', async () => {
    const current = await wrapCek(derivePublicIdentity(SEED_A, 2).agentEnc, ENVELOPE_ID, CEK);
    expect(await store.unwrapCek(current, ENVELOPE_ID)).toEqual(CEK);
    const older = await wrapCek(derivePublicIdentity(SEED_A, 0).agentEnc, ENVELOPE_ID, CEK);
    expect(await store.unwrapCek(older, ENVELOPE_ID, { epoch: 0 })).toEqual(CEK);
    expect(await codeOf(() => store.unwrapCek(older, ENVELOPE_ID))).toBe('open_failed');
  });

  it('signs EIP-712 with the epoch-0 EVM key, whose address is the agent ID', async () => {
    const sig = await store.sign712(TYPED);
    const signer = recoverEvmAddress(hashTypedData(TYPED).digest, decodeEcdsaSignature(sig));
    expect(`0x${encodeHex(signer)}`).toBe(ID_A);
  });

  it('reads the seed for every operation and wipes it afterwards', async () => {
    const before = keychain.reads;
    await store.getPublicBundle();
    await store.signEnvelopeHash(new Uint8Array(32));
    await store.sign712(TYPED);
    expect(keychain.reads - before).toBe(3);
    expect(keychain.handedOut.length).toBeGreaterThan(0);
    expect(keychain.handedOut.every(allZero)).toBe(true);
  });

  it('close refuses every later call with keystore_closed', async () => {
    await store.close();
    expect(await codeOf(() => store.getPublicBundle())).toBe('keystore_closed');
    expect(await codeOf(() => store.sign712(TYPED))).toBe('keystore_closed');
    expect(await codeOf(() => store.withStoreKey(() => undefined))).toBe('keystore_closed');
  });

  it('hands the store key to a callback and wipes it afterwards', async () => {
    let seen: Uint8Array | undefined;
    const length = await store.withStoreKey((key) => {
      seen = key;
      return key.length;
    });
    expect(length).toBe(32);
    expect(allZero(seen as Uint8Array)).toBe(true);
  });

  it('refuses a store key of the wrong length with its own code (IR-M1-8a-1 L-6)', async () => {
    keychain.items.set(keychainAccount(ID_A, 'store-key'), new Uint8Array(31));
    expect(await codeOf(() => store.withStoreKey(() => undefined))).toBe('store_key_invalid');
  });

  it('a keychain call that does not answer fails with keychain_failed (IR-M1-8a-1 L-4)', async () => {
    const slow = await KeychainKeyStore.open(keychain, ID_A, { timeoutMs: 20 });
    keychain.hanging = true;
    expect(await codeOf(() => slow.getPublicBundle())).toBe('keychain_failed');
    expect(await codeOf(() => slow.withStoreKey(() => undefined))).toBe('keychain_failed');
  });
});

describe('KeychainKeyStore.open (04 §2.9: the seed must derive the agent ID)', () => {
  let keychain: FakeKeychain;
  beforeEach(() => {
    keychain = new FakeKeychain();
  });

  it('refuses a missing item with a fix, and never creates one', async () => {
    expect(await codeOf(() => KeychainKeyStore.open(keychain, ID_A))).toBe('identity_missing');
    expect(keychain.items.size).toBe(0);
  });

  it("refuses another agent's seed under this account", async () => {
    keychain.items.set(keychainAccount(ID_A, 'seed'), SEED_B.slice());
    expect(await codeOf(() => KeychainKeyStore.open(keychain, ID_A))).toBe('identity_mismatch');
    expect(keychain.handedOut.every(allZero)).toBe(true);
  });

  it('refuses a seed of the wrong length', async () => {
    keychain.items.set(keychainAccount(ID_A, 'seed'), SEED_A.slice(0, 31));
    expect(await codeOf(() => KeychainKeyStore.open(keychain, ID_A))).toBe('identity_mismatch');
  });

  it('refuses a seed swapped after open, on the next operation', async () => {
    keychain.put(ID_A, SEED_A);
    const store = await KeychainKeyStore.open(keychain, ID_A);
    keychain.items.set(keychainAccount(ID_A, 'seed'), SEED_B.slice());
    expect(await codeOf(() => store.signEnvelopeHash(new Uint8Array(32)))).toBe(
      'identity_mismatch',
    );
  });

  it('refuses a checksummed or malformed agent ID without touching the keychain', async () => {
    keychain.put(ID_A, SEED_A);
    expect(await codeOf(() => KeychainKeyStore.open(keychain, ID_A.toUpperCase()))).toBe(
      'agent_id_invalid',
    );
    expect(keychain.reads).toBe(0);
  });

  it('reports a native failure as a fixed sentence that carries none of its text', async () => {
    keychain.put(ID_A, SEED_A);
    keychain.failing = true;
    const error = await KeychainKeyStore.open(keychain, ID_A).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NodeKeyStoreError);
    expect((error as NodeKeyStoreError).code).toBe('keychain_failed');
    expect((error as Error).message).not.toContain('deadbeef');
    expect((error as Error).cause).toBeUndefined();
  });

  it('opens only the recorded backend, never falling back (07 §9.1)', async () => {
    keychain.put(ID_A, SEED_A);
    const store = await openRecordedKeyStore('keychain', ID_A, { keychain });
    expect((await store.getPublicBundle()).agentId).toBe(ID_A);
    // Only the KeyStore interface: no store key, no backend, nothing to reach a seed (M-2).
    expect(Object.keys(store).sort()).toEqual([
      'close',
      'getPublicBundle',
      'nip44Decrypt',
      'nip44Encrypt',
      'sign712',
      'signEnvelopeHash',
      'signNostr',
      'unwrapCek',
    ]);
    expect(Object.isFrozen(store)).toBe(true);
    await store.close();
    expect(await codeOf(() => store.getPublicBundle())).toBe('keystore_closed');
    expect(await codeOf(() => openRecordedKeyStore('file', ID_A, { keychain }))).toBe(
      'backend_unavailable',
    );
    const unknown = 'other' as 'file';
    expect(await codeOf(() => openRecordedKeyStore(unknown, ID_A, { keychain }))).toBe(
      'backend_unavailable',
    );
  });
});

describe('probeKeychain and backend selection at init (04 §2.8, 07 §9.1)', () => {
  it('writes, reads and deletes a probe item, leaving nothing behind', async () => {
    const keychain = new FakeKeychain();
    expect(await probeKeychain(keychain)).toEqual({ ok: true });
    expect(keychain.items.size).toBe(0);
  });

  it('a failing keychain is unavailable, with a fix for the platform', async () => {
    const keychain = new FakeKeychain();
    keychain.failing = true;
    const probe = await probeKeychain(keychain, { platform: 'darwin' });
    expect(probe).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(probe.ok ? '' : probe.fix).toContain('security unlock-keychain');
  });

  it('a keychain that does not answer times out', async () => {
    const keychain = new FakeKeychain();
    keychain.hanging = true;
    const probe = await probeKeychain(keychain, { timeoutMs: 20, platform: 'linux' });
    expect(probe).toMatchObject({ ok: false, reason: 'timeout' });
    expect(probe.ok ? '' : probe.fix).toContain('Secret Service');
  });

  it('a keychain that returns other bytes is unavailable', async () => {
    const keychain = new FakeKeychain();
    keychain.get = () => Promise.resolve(new Uint8Array(16));
    expect(await probeKeychain(keychain)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(keychain.items.size).toBe(0);
  });

  it('deletes the probe item before answering, even when the read fails', async () => {
    const keychain = new FakeKeychain();
    keychain.get = () => Promise.resolve([1, 2] as unknown as Uint8Array);
    expect(await probeKeychain(keychain)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(keychain.items.size).toBe(0);
    keychain.get = () => Promise.reject(new Error('locked'));
    expect(await probeKeychain(keychain)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(keychain.items.size).toBe(0);
  });

  it('selects the keychain whenever the probe succeeds, and refuses the file KeyStore then', () => {
    expect(selectKeyStoreBackend({ ok: true }, { fileOptIn: false })).toEqual({
      ok: true,
      backend: 'keychain',
    });
    expect(selectKeyStoreBackend({ ok: true }, { fileOptIn: true })).toEqual({
      ok: false,
      status: 'refused',
      reason: 'keychain_available',
      message: 'This machine has a system keychain. AgentLink uses it.',
    });
  });

  it('without a keychain: needs_setup unless the user opted in to the file KeyStore', () => {
    const failed = { ok: false, reason: 'timeout', fix: 'Fix it.' } as const;
    const result = selectKeyStoreBackend(failed, { fileOptIn: false });
    expect(result).toMatchObject({ ok: false, status: 'needs_setup', reason: 'no_keychain' });
    expect(result.ok ? '' : result.message).toContain('agentlink init --keystore file');
    expect(result).toMatchObject({ fix: 'Fix it.' });
    expect(selectKeyStoreBackend(failed, { fileOptIn: true })).toEqual({
      ok: true,
      backend: 'file',
    });
  });
});
