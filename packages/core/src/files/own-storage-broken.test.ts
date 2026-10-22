// M1-9i-a (07 §5.6; D-115; IR-M1-9i-s-1): a broken own storage counts as configured. The runtime
// passes a stub that refuses every call (`brokenOwnStorageAdapter`), and a send that would store a
// file returns `needs_setup` with reason `storage_broken`, never the drop, under `files.storage`
// `auto` (the default) and `own`. A file small enough to travel inline still goes inline.
import type { FetchLike } from '@4thtech-io/storage';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { brokenOwnStorageAdapter, isBrokenOwnStorageAdapter } from '../own-storage.js';
import { FakeClock, passphrase, seed } from '../testing/fixtures.js';
import {
  fileBytes,
  openFileAgent,
  outgoing,
  pairForFiles,
  type FileAgent,
} from '../testing/files.js';

const RELAYS_A = ['wss://relay.agentlink.dev', 'wss://nos.lol'];
const RELAYS_B = ['wss://relay.damus.io', 'wss://nos.lol'];
const ownerA = new MemoryOwnerKeyStore(seed(221), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(222), passphrase());

let dropCalls: string[];
const dropFetch: FetchLike = (request) => {
  dropCalls.push(request.method);
  return Promise.reject(new Error('the drop must not be called'));
};

let clock: FakeClock;
let a: FileAgent;
let b: FileAgent;

async function open(storage: 'auto' | 'own' | 'drop'): Promise<void> {
  clock = new FakeClock();
  a = await openFileAgent(clock, new MemoryKeyStore(seed(31)), ownerA, 'alice', {
    relays: RELAYS_A,
    ownAdapter: brokenOwnStorageAdapter(),
    drop: { endpoint: 'https://drop.agentlink.dev', fetch: dropFetch },
  });
  b = await openFileAgent(clock, new MemoryKeyStore(seed(32)), ownerB, 'bob', {
    relays: RELAYS_B,
  });
  await pairForFiles(clock, a, b, (p) => {
    p.files.storage = storage;
  });
}

beforeEach(() => {
  dropCalls = [];
});

describe('a broken own storage (07 §5.6)', () => {
  for (const storage of ['auto', 'own'] as const) {
    it(`files.storage ${storage}: a stored file is needs_setup storage_broken, never the drop`, async () => {
      await open(storage);
      const result = await a.client.sendMessage({
        to: b.id,
        text: 'the file',
        files: [outgoing('big.bin', fileBytes(40_000))],
      });
      expect(result).toEqual({ status: 'needs_setup', reason: 'storage_broken' });
      expect(dropCalls).toEqual([]);
      expect(a.spy.published).toEqual([]);
    });
  }

  it('an inline file still goes inline (no storage is used)', async () => {
    await open('auto');
    const result = await a.client.sendMessage({
      to: b.id,
      text: 'small',
      files: [outgoing('small.txt', fileBytes(500))],
    });
    expect(result).toMatchObject({ status: 'ok', files: [{ index: 0, delivery: 'inline' }] });
    expect(dropCalls).toEqual([]);
  });

  it('the stub refuses every call with credentials_unavailable and is recognised', async () => {
    const stub = brokenOwnStorageAdapter();
    expect(isBrokenOwnStorageAdapter(stub)).toBe(true);
    expect(isBrokenOwnStorageAdapter({ ...stub })).toBe(false);
    const object = { kind: 's3', locator: 'x', size: 1, expiresAt: new Date(0) } as never;
    for (const call of [
      () => stub.put(new Uint8Array(1), { size: 1, expiresAt: new Date(Date.now() + 1e6) }),
      () => stub.presignGet(object, new Date(Date.now() + 1e6)),
      () => stub.delete(object),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'credentials_unavailable' });
    }
  });
});
