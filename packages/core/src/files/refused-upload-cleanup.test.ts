// SEC-REFUSED-UPLOAD-CLEANUP: a send with stored files that is refused after the ciphertext was
// uploaded (in the transaction that stores the envelope: a cap, the contact, the policy) deletes the
// uploaded objects, with a few retries. An object whose delete still fails is queued for the next
// retention pass instead of being left behind, and the send stays refused. The cheap refusals run
// before anything is uploaded. Nothing about an object (locator, URL) reaches a log line (I-7).
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import type { PutOptions, StorageAdapter, StoredObject } from '@4thtech-io/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CoreContext } from '../context.js';
import { FakeClock, passphrase, seed } from '../testing/fixtures.js';
import {
  MemoryOwnStorage,
  fileBytes,
  openFileAgent,
  outgoing,
  pairForFiles,
  type FileAgent,
} from '../testing/files.js';
import { deleteUploaded } from './outgoing.js';
import { openFileObject } from './records.js';

const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);

const ownerA = new MemoryOwnerKeyStore(seed(231), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(232), passphrase());

/** Own storage that can run a step after each upload and refuse the next deletes. */
class HookedOwnStorage extends MemoryOwnStorage {
  puts = 0;
  deleteCalls = 0;
  /** How many of the next deletes fail (Infinity: all of them). */
  failDeletes = 0;
  onPut: (() => Promise<void>) | undefined;

  override async put(
    ciphertext: ReadableStream<Uint8Array> | Uint8Array,
    opts: PutOptions,
  ): Promise<StoredObject> {
    this.puts += 1;
    const object = await super.put(ciphertext, opts);
    await this.onPut?.();
    return object;
  }

  override delete(obj: StoredObject): Promise<void> {
    this.deleteCalls += 1;
    if (this.failDeletes > 0) {
      this.failDeletes -= 1;
      return Promise.reject(new Error(`refused ${obj.locator} ${this.urls.join(' ')}`));
    }
    return super.delete(obj);
  }
}

let clock: FakeClock;
let own: HookedOwnStorage;
let a: FileAgent;
let b: FileAgent;

beforeEach(async () => {
  clock = new FakeClock();
  own = new HookedOwnStorage();
  a = await openFileAgent(clock, new MemoryKeyStore(seed(31)), ownerA, 'alice', {
    relays: RELAYS_A,
    own,
  });
  b = await openFileAgent(clock, new MemoryKeyStore(seed(32)), ownerB, 'bob', {
    relays: RELAYS_B,
    own,
  });
  await pairForFiles(clock, a, b);
  pairingOut = (
    await a.store.transaction((tx) => tx.select('envelopes').filter((e) => e.direction === 'out'))
  ).length;
});

const ctxOf = (agent: FileAgent): CoreContext => ({
  keyStore: agent.keyStore,
  store: agent.store,
  cipher: agent.cipher,
  now: clock.now,
  log: createLogger({ name: 'core', level: 'debug', sink: () => {} }),
});

/** Fills the outgoing caps while the file uploads, so the check in the store transaction refuses. */
function capReachedDuringUpload(): void {
  own.onPut = async () => {
    await a.store.transaction((tx) =>
      tx.insert('outgoing_log', {
        envelope_id: 'f'.repeat(64),
        contact_id: b.id,
        t: clock.t,
        files: 100_000,
        bytes: 1,
      }),
    );
  };
}

const sendStored = () =>
  a.client.sendMessage({
    to: b.id,
    text: 'the file',
    files: [outgoing('report.pdf', fileBytes(200_000), { mime: 'application/pdf' })],
  });

/** Outbound envelopes other than the pairing ones (taken after pairing). */
let pairingOut = 0;
const outEnvelopes = async () =>
  (
    await a.store.transaction((tx) => tx.select('envelopes').filter((e) => e.direction === 'out'))
  ).slice(pairingOut);

function expectNoSecretsInLogs(locators: readonly string[]): void {
  for (const line of a.lines) {
    for (const locator of locators) expect(line).not.toContain(locator);
    for (const url of own.urls) expect(line).not.toContain(url);
  }
}

describe('a send refused after upload deletes what it uploaded', () => {
  it('a cap reached during the upload: SEND_LIMIT, the object is deleted, no row points to it', async () => {
    capReachedDuringUpload();
    const result = await sendStored();
    expect(result).toMatchObject({ status: 'rejected', code: 'SEND_LIMIT' });
    expect(own.puts).toBe(1);
    expect(own.objects.size).toBe(0);
    expect(await outEnvelopes()).toHaveLength(0);
    expect(await a.store.transaction((tx) => tx.select('files'))).toHaveLength(0);
  });

  it('the contact waits for the owner after the upload: refused, the object is deleted', async () => {
    own.onPut = async () => {
      await a.store.transaction((tx) =>
        tx.update('contacts', { contact_id: b.id }, { waiting_owner: 1 }),
      );
    };
    await expect(sendStored()).rejects.toMatchObject({ code: 'contact_waiting_owner' });
    expect(own.objects.size).toBe(0);
    expect(await a.store.transaction((tx) => tx.select('files'))).toHaveLength(0);
  });

  it('a delete that fails once is retried, and the object is gone', async () => {
    capReachedDuringUpload();
    own.failDeletes = 1;
    const result = await sendStored();
    expect(result).toMatchObject({ status: 'rejected', code: 'SEND_LIMIT' });
    expect(own.deleteCalls).toBe(2);
    expect(own.objects.size).toBe(0);
    expect(await a.store.transaction((tx) => tx.select('files'))).toHaveLength(0);
  });

  it('a delete that keeps failing: still refused, queued for cleanup, removed on the next pass', async () => {
    capReachedDuringUpload();
    own.failDeletes = Number.POSITIVE_INFINITY;
    const result = await sendStored();
    // A failed cleanup never turns the refusal into a success.
    expect(result).toMatchObject({ status: 'rejected', code: 'SEND_LIMIT' });
    expect(own.deleteCalls).toBeGreaterThan(1);
    expect(own.deleteCalls).toBeLessThanOrEqual(5);
    const locators = [...own.objects.keys()];
    expect(locators).toHaveLength(1);
    expect(await outEnvelopes()).toHaveLength(0);

    // One queued cleanup entry: no envelope behind it, no file key or link kept, due now.
    const queued = await a.store.transaction((tx) => tx.select('files'));
    expect(queued).toHaveLength(1);
    const entry = queued[0];
    expect(entry?.url).toBeNull();
    expect(entry?.expires_at).toBeLessThanOrEqual(clock.t);
    expect(
      await a.store.transaction((tx) =>
        tx.get('envelopes', { envelope_id: entry?.envelope_id ?? '' }),
      ),
    ).toBeUndefined();
    expectNoSecretsInLogs(locators);
    expect(a.lines.some((l) => l.includes('cleanup'))).toBe(true);

    // Storage still refuses: the entry stays for the pass after.
    expect(await a.client.deleteExpiredFiles()).toEqual({ deleted: 0, failed: 1 });
    expect(await a.store.transaction((tx) => tx.select('files'))).toHaveLength(1);

    // Storage is back: the next pass deletes the object and the entry.
    own.failDeletes = 0;
    expect(await a.client.deleteExpiredFiles()).toEqual({ deleted: 1, failed: 0 });
    expect(own.objects.size).toBe(0);
    expect(await a.store.transaction((tx) => tx.select('files'))).toHaveLength(0);
    expectNoSecretsInLogs(locators);
  });
});

describe('the cheap refusals run before any upload', () => {
  it('a contact that is no longer active: nothing is uploaded', async () => {
    await a.store.transaction((tx) =>
      tx.update('contacts', { contact_id: b.id }, { status: 'blocked' }),
    );
    await expect(sendStored()).rejects.toBeDefined();
    expect(own.puts).toBe(0);
  });
});

describe('deleteUploaded: the queued entry keeps what the delete needs', () => {
  it('a drop object keeps its upload key epoch, so the later delete signs with it', async () => {
    const ctx = ctxOf(a);
    const failing: StorageAdapter = {
      kind: 'drop',
      put: () => Promise.reject(new Error('no')),
      presignGet: () => Promise.reject(new Error('no')),
      delete: () => Promise.reject(new Error('refused')),
    } as unknown as StorageAdapter;
    const object: StoredObject = {
      kind: 'drop',
      locator: 'https://drop.example/o/abc?sig=secret',
      size: 1234,
      sha256: 'a'.repeat(64),
      keyEpoch: 2,
    };
    await deleteUploaded(ctx, [{ object, adapter: failing }]);
    const rows = await a.store.transaction((tx) => tx.select('files'));
    expect(rows).toHaveLength(1);
    const stored = await openFileObject(ctx, rows[0]!);
    expect(stored).toEqual({ kind: 'drop', object: { ...object } });
    expect(JSON.stringify(rows)).not.toContain('secret');
  });
});
