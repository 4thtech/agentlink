// W4-RENAME-REACHES-CONTACTS (S2; D-141; 04 §2.6, §3.1.1 "Epoch advance"; 08 §1): the Node
// KeyStore's key epoch and its owner-only epoch control.
//
// - The epoch is the agent item `key-epoch` (canonical ASCII decimal; absent = 0), next to the seed
//   in the keychain or the `ALKS` file. A KeyStore opened without an explicit epoch reads it at open,
//   and again whenever its current public bundle is asked for, so a process that has the agent open
//   (an AI app's `agentlink mcp`) moves to the new epoch once another process advanced it, and never
//   signs under the old one after that.
// - KeyEpochControl (crypto keystore-api.ts): previewEpoch(n + 1) gives public keys only and moves
//   nothing; advanceEpoch(n, owner) is a compare-and-set on the item that takes only a session the
//   control accepts (presence_required otherwise, owner_locked once it ended).
// - The control is reached only through an AgentEpochKeys token of a KeyStore this package opened.
import { KeyStoreError, encodeHex0x, type OwnerSession } from '@4thtech-io/crypto';
import { deriveAgentId } from '@4thtech-io/crypto/keystore';
import { describe, expect, it } from 'vitest';
import {
  KEY_EPOCH_ITEM,
  decodeKeyEpoch,
  encodeKeyEpoch,
  epochKeysOf,
  keyEpochControlFor,
} from './key-epoch.js';
import { KeychainKeyStore, openRecordedKeyStore } from './keychain-keystore.js';
import { agentEraseAccounts, keychainAccount, type KeychainBackend } from './keychain.js';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 3);
const AGENT_ID = deriveAgentId(SEED);
const ascii = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

class MemoryKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  constructor() {
    this.items.set(keychainAccount(AGENT_ID, 'seed'), SEED.slice());
    this.items.set(keychainAccount(AGENT_ID, 'store-key'), new Uint8Array(32).fill(7));
  }
  get(account: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.items.get(account)?.slice() ?? null);
  }
  set(account: string, value: Uint8Array): Promise<void> {
    this.items.set(account, value.slice());
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    return Promise.resolve(this.items.delete(account));
  }
}

const epochAccount = keychainAccount(AGENT_ID, 'key-epoch');

/** A live session double: what the control accepts is decided by identity, never by shape. */
function session(active = true): OwnerSession {
  return { isActive: () => active, expiresAt: 0 } as unknown as OwnerSession;
}

describe('the key-epoch item (04 §2.6)', () => {
  it('is named key-epoch, canonical ASCII decimal, and part of the erase list', () => {
    expect(KEY_EPOCH_ITEM).toBe('key-epoch');
    expect(encodeKeyEpoch(0)).toEqual(ascii('0'));
    expect(encodeKeyEpoch(12)).toEqual(ascii('12'));
    expect(decodeKeyEpoch(ascii('7'))).toBe(7);
    for (const bad of ['', '01', '-1', '1.0', ' 1', '4294967296']) {
      expect(() => decodeKeyEpoch(ascii(bad))).toThrow();
    }
    expect(agentEraseAccounts(AGENT_ID, [])).toContain(epochAccount);
  });

  it('a KeyStore opened without an epoch reads the item (absent = 0)', async () => {
    const keychain = new MemoryKeychain();
    const at0 = await openRecordedKeyStore('keychain', AGENT_ID, { keychain });
    expect((await at0.getPublicBundle()).keyEpoch).toBe(0);
    await keychain.set(epochAccount, ascii('2'));
    const at2 = await openRecordedKeyStore('keychain', AGENT_ID, { keychain });
    expect((await at2.getPublicBundle()).keyEpoch).toBe(2);
  });

  it('a damaged item never reads as 0: the open fails', async () => {
    const keychain = new MemoryKeychain();
    await keychain.set(epochAccount, ascii('x'));
    await expect(openRecordedKeyStore('keychain', AGENT_ID, { keychain })).rejects.toThrow();
  });

  it('an explicit epoch stays fixed (the conformance suite opens stores at an epoch)', async () => {
    const keychain = new MemoryKeychain();
    await keychain.set(epochAccount, ascii('5'));
    const fixed = await KeychainKeyStore.open(keychain, AGENT_ID, { keyEpoch: 1 });
    expect((await fixed.getPublicBundle()).keyEpoch).toBe(1);
  });
});

describe('KeyEpochControl over the item (owner flows only)', () => {
  it('previews the next epoch without moving; advances with a compare-and-set', async () => {
    const keychain = new MemoryKeychain();
    const keys = await openRecordedKeyStore('keychain', AGENT_ID, { keychain });
    const token = epochKeysOf(keys);
    expect(token).toBeDefined();
    if (token === undefined) return;
    const owner = session();
    const control = keyEpochControlFor(token, (s) => s === owner);
    const next = await control.previewEpoch(1);
    expect(next.keyEpoch).toBe(1);
    expect(next.agentId).toBe(AGENT_ID);
    // Previewed only: nothing moved.
    expect((await keys.getPublicBundle()).keyEpoch).toBe(0);
    expect(keychain.items.has(epochAccount)).toBe(false);
    await expect(control.previewEpoch(0)).rejects.toMatchObject({ code: 'epoch_conflict' });
    await expect(control.previewEpoch(2)).rejects.toMatchObject({ code: 'epoch_unavailable' });

    const advanced = await control.advanceEpoch(0, owner);
    expect(advanced.keyEpoch).toBe(1);
    expect(encodeHex0x(advanced.agentNostr)).toBe(encodeHex0x(next.agentNostr));
    expect(keychain.items.get(epochAccount)).toEqual(ascii('1'));
    // The KeyStore the agent path uses follows the item.
    const bundle = await keys.getPublicBundle();
    expect(bundle.keyEpoch).toBe(1);
    expect(encodeHex0x(bundle.agentNostr)).toBe(encodeHex0x(next.agentNostr));
    // A second advance from 0 lost the race: nothing changes.
    await expect(control.advanceEpoch(0, owner)).rejects.toMatchObject({
      code: 'epoch_conflict',
    });
    expect(keychain.items.get(epochAccount)).toEqual(ascii('1'));
  });

  it('refuses a session it does not accept, and an ended one; nothing moves', async () => {
    const keychain = new MemoryKeychain();
    const keys = await openRecordedKeyStore('keychain', AGENT_ID, { keychain });
    const token = epochKeysOf(keys);
    if (token === undefined) throw new Error('test: no token');
    const owner = session();
    const control = keyEpochControlFor(token, (s) => s === owner);
    const lookAlike = session();
    const refused = await control.advanceEpoch(0, lookAlike).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(KeyStoreError);
    expect(refused).toMatchObject({ code: 'presence_required' });
    const ended = session(false);
    const endedControl = keyEpochControlFor(token, (s) => s === ended);
    await expect(endedControl.advanceEpoch(0, ended)).rejects.toMatchObject({
      code: 'owner_locked',
    });
    expect(keychain.items.has(epochAccount)).toBe(false);
    expect((await keys.getPublicBundle()).keyEpoch).toBe(0);
  });

  it('another process with the agent open moves with the item and never goes back', async () => {
    const keychain = new MemoryKeychain();
    const host = await openRecordedKeyStore('keychain', AGENT_ID, { keychain });
    // An AI app's `agentlink mcp` has the same agent open.
    const mcp = await openRecordedKeyStore('keychain', AGENT_ID, { keychain });
    const token = epochKeysOf(host);
    if (token === undefined) throw new Error('test: no token');
    const owner = session();
    await keyEpochControlFor(token, (s) => s === owner).advanceEpoch(0, owner);
    expect((await mcp.getPublicBundle()).keyEpoch).toBe(1);
    // Signing uses the new epoch's key from then on.
    const bundle = await mcp.getPublicBundle();
    const event = await mcp.signNostr({
      kind: 1,
      created_at: 1_800_000_000,
      tags: [],
      content: 'x',
    } as never);
    expect(event.pubkey).toBe(encodeHex0x(bundle.agentNostr).slice(2));
    // A lowered item (a same-user edit) never moves a KeyStore back.
    await keychain.set(epochAccount, ascii('0'));
    expect((await mcp.getPublicBundle()).keyEpoch).toBe(1);
  });

  it('gives no token for a KeyStore this package did not open', () => {
    expect(epochKeysOf({})).toBeUndefined();
    expect(epochKeysOf(undefined)).toBeUndefined();
  });
});
