// SEC-REFUSED-UPLOAD-CLEANUP: a send with stored files that is refused after the ciphertext was
// uploaded (in the transaction that stores the envelope: a cap, the contact, the policy, the final
// payload size) deletes the uploaded objects. Deletes run in parallel, each request has a timeout,
// only transient failures are tried again, and the whole cleanup is bounded in time. An object whose
// delete still fails is queued for the retention pass, which backs off and never holds up the expiry
// of other files; the send stays refused. The cheap refusals run before anything is uploaded.
// Nothing about an object (locator, URL) reaches a log line (I-7).
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import type { JsonObject } from '@4thtech-io/crypto';
import { createLogger } from '@4thtech-io/log';
import {
  StorageError,
  type PutOptions,
  type StorageAdapter,
  type StoredObject,
} from '@4thtech-io/storage';
import { defaultPolicy, type Policy } from '@4thtech-io/types';
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
import { newNonce, ownerHex, signWith } from '../testing/owner.js';
import { deleteUploaded } from './outgoing.js';
import { openFileObject } from './records.js';

const DAY = 86_400;
const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);

const ownerA = new MemoryOwnerKeyStore(seed(231), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(232), passphrase());

/** Own storage that can run a step after each upload and refuse or stall the next deletes. */
class HookedOwnStorage extends MemoryOwnStorage {
  puts = 0;
  deleteCalls = 0;
  /** How many of the next deletes fail (Infinity: all of them). */
  failDeletes = 0;
  /** What a failing delete throws (default: a transport-style error naming the object). */
  failWith: ((obj: StoredObject) => unknown) | undefined;
  /** Locators whose delete always fails with `unavailable`. */
  readonly unavailable = new Set<string>();
  /** Deletes never answer. */
  stall = false;
  /** Presigned URLs this long (a link longer than the packing plan allowed for). */
  urlLength = 0;
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

  override async presignGet(obj: StoredObject): Promise<string> {
    const url = await super.presignGet(obj);
    if (this.urlLength <= url.length) return url;
    const long = `${url}&pad=${'a'.repeat(this.urlLength - url.length - 5)}`;
    this.urls.push(long);
    return long;
  }

  override delete(obj: StoredObject): Promise<void> {
    this.deleteCalls += 1;
    if (this.stall) return new Promise<void>(() => {});
    if (this.unavailable.has(obj.locator)) {
      return Promise.reject(new StorageError('unavailable', 'storage unavailable', 503));
    }
    if (this.failDeletes > 0) {
      this.failDeletes -= 1;
      return Promise.reject(
        this.failWith?.(obj) ?? new Error(`refused ${obj.locator} ${this.urls.join(' ')}`),
      );
    }
    return super.delete(obj);
  }
}

let clock: FakeClock;
let own: HookedOwnStorage;
let a: FileAgent;
let b: FileAgent;
/** Outbound envelopes of the pairing (counted after pairing). */
let pairingOut = 0;

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

/** Applies an owner-signed policy to `a`, edited from the files test policy. */
async function applyPolicy(edit: (p: Policy) => void): Promise<void> {
  const policy = defaultPolicy();
  policy.files.allowedFolders = ['~/Work'];
  edit(policy);
  const signed = await signWith(a.owner, {
    v: 1,
    agent: a.id,
    owner: await ownerHex(a.owner),
    op: 'policy.set',
    params: { version: 2, policy: policy as unknown as JsonObject },
    nonce: newNonce(),
    issuedAt: clock.t,
    expiresAt: clock.t + 600,
  });
  const applied = await a.client.ownerActions.apply(JSON.stringify(signed));
  if (applied.status !== 'applied') throw new Error('policy not applied');
}

/** Fills the outgoing caps while the file uploads, so the check in the store transaction refuses. */
function capReachedDuringUpload(): void {
  own.onPut = async () => {
    await a.store.transaction((tx) => {
      if (tx.get('outgoing_log', { envelope_id: 'f'.repeat(64) }) !== undefined) return;
      tx.insert('outgoing_log', {
        envelope_id: 'f'.repeat(64),
        contact_id: b.id,
        t: clock.t,
        files: 100_000,
        bytes: 1,
      });
    });
  };
}

const sendStored = (count = 1) =>
  a.client.sendMessage({
    to: b.id,
    text: 'the file',
    files: Array.from({ length: count }, (_, i) =>
      outgoing(`report-${String(i)}.pdf`, fileBytes(200_000), { mime: 'application/pdf' }),
    ),
  });

const outEnvelopes = async () =>
  (
    await a.store.transaction((tx) => tx.select('envelopes').filter((e) => e.direction === 'out'))
  ).slice(pairingOut);

const fileRows = () => a.store.transaction((tx) => tx.select('files'));

function expectNoSecretsInLogs(locators: readonly string[]): void {
  for (const line of a.lines) {
    for (const locator of locators) expect(line).not.toContain(locator);
    for (const url of own.urls) expect(line).not.toContain(url);
  }
}

const cleanupWarnings = () => a.lines.filter((l) => l.includes('cleanup')).length;

describe('a send refused after upload deletes what it uploaded', () => {
  it('a cap reached during the upload: SEND_LIMIT, the object is deleted, no row points to it', async () => {
    capReachedDuringUpload();
    const result = await sendStored();
    expect(result).toMatchObject({ status: 'rejected', code: 'SEND_LIMIT' });
    expect(own.puts).toBe(1);
    expect(own.objects.size).toBe(0);
    expect(await outEnvelopes()).toHaveLength(0);
    expect(await fileRows()).toHaveLength(0);
  });

  it('the contact waits for the owner after the upload: refused, the object is deleted', async () => {
    own.onPut = async () => {
      await a.store.transaction((tx) =>
        tx.update('contacts', { contact_id: b.id }, { waiting_owner: 1 }),
      );
    };
    await expect(sendStored()).rejects.toMatchObject({ code: 'contact_waiting_owner' });
    expect(own.objects.size).toBe(0);
    expect(await fileRows()).toHaveLength(0);
  });

  it('the policy denies the finished envelope: POLICY_DENIED, the object is deleted', async () => {
    await applyPolicy((p) => {
      p.envelopes.maxEnvelopeKB = 1;
    });
    const result = await sendStored();
    expect(result).toMatchObject({ status: 'rejected', code: 'POLICY_DENIED' });
    expect(own.puts).toBe(1);
    expect(own.objects.size).toBe(0);
    expect(await outEnvelopes()).toHaveLength(0);
    expect(await fileRows()).toHaveLength(0);
  });

  it('the payload is too large once the links are in: PAYLOAD_TOO_LARGE, the object is deleted', async () => {
    own.urlLength = 20_000;
    const result = await sendStored();
    expect(result).toMatchObject({ status: 'rejected', code: 'PAYLOAD_TOO_LARGE' });
    expect(own.puts).toBe(1);
    expect(own.objects.size).toBe(0);
    expect(await fileRows()).toHaveLength(0);
  });

  it('a delete that fails once with a transient error is tried again, and the object is gone', async () => {
    capReachedDuringUpload();
    own.failDeletes = 1;
    const result = await sendStored();
    expect(result).toMatchObject({ status: 'rejected', code: 'SEND_LIMIT' });
    expect(own.deleteCalls).toBe(2);
    expect(own.objects.size).toBe(0);
    expect(await fileRows()).toHaveLength(0);
  });

  it('a 4xx refusal is not tried again: the object is queued at once', async () => {
    capReachedDuringUpload();
    own.failDeletes = Number.POSITIVE_INFINITY;
    own.failWith = () => new StorageError('delete_failed', 'storage delete failed', 403);
    const result = await sendStored();
    expect(result).toMatchObject({ status: 'rejected', code: 'SEND_LIMIT' });
    expect(own.deleteCalls).toBe(1);
    expect(await fileRows()).toHaveLength(1);
  });

  it('deletes that never answer: the refusal returns within the time bound, all objects queued', async () => {
    capReachedDuringUpload();
    own.stall = true;
    const started = Date.now();
    const result = await sendStored(3);
    const took = Date.now() - started;
    expect(result).toMatchObject({ status: 'rejected', code: 'SEND_LIMIT' });
    expect(took).toBeLessThan(4_000);
    // In parallel: each object got at least one try inside the bound.
    expect(own.deleteCalls).toBeGreaterThanOrEqual(3);
    expect(await fileRows()).toHaveLength(3);
  }, 15_000);

  it('a delete that keeps failing: still refused, queued, removed on a later pass', async () => {
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

    // One queued cleanup entry: no envelope behind it, no link kept, due now.
    const queued = await fileRows();
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
    expect(cleanupWarnings()).toBe(1);

    // Storage still refuses: the entry stays and backs off, with one warning for the row.
    expect(await a.client.deleteExpiredFiles()).toEqual({ deleted: 0, failed: 1 });
    const after = await fileRows();
    expect(after).toHaveLength(1);
    expect(after[0]?.expires_at).toBeGreaterThan(clock.t);
    expect(await a.client.deleteExpiredFiles()).toEqual({ deleted: 0, failed: 0 });
    clock.t += DAY;
    expect(await a.client.deleteExpiredFiles()).toEqual({ deleted: 0, failed: 1 });
    expect(cleanupWarnings()).toBe(2);

    // Storage is back: the next due pass deletes the object and the entry.
    own.failDeletes = 0;
    clock.t += DAY;
    expect(await a.client.deleteExpiredFiles()).toEqual({ deleted: 1, failed: 0 });
    expect(own.objects.size).toBe(0);
    expect(await fileRows()).toHaveLength(0);
    expectNoSecretsInLogs(locators);
  });

  it('a queued own-storage object is still tried after the drop window', async () => {
    capReachedDuringUpload();
    own.failDeletes = Number.POSITIVE_INFINITY;
    await sendStored();
    clock.t += 9 * DAY;
    expect(await a.client.deleteExpiredFiles()).toEqual({ deleted: 0, failed: 1 });
    own.failDeletes = 0;
    clock.t += 2 * DAY;
    expect(await a.client.deleteExpiredFiles()).toEqual({ deleted: 1, failed: 0 });
    expect(own.objects.size).toBe(0);
  });

  it('a queued object that storage keeps refusing never holds up the expiry of other files', async () => {
    capReachedDuringUpload();
    own.failDeletes = Number.POSITIVE_INFINITY;
    await sendStored();
    const stuck = [...own.objects.keys()][0] as string;
    own.unavailable.add(stuck);
    own.failDeletes = 0;
    own.onPut = undefined;
    await a.store.transaction((tx) => tx.delete('outgoing_log', {}));
    const sent = await sendStored();
    expect(sent.status).toBe('ok');
    clock.t += 8 * DAY;
    const pass = await a.client.deleteExpiredFiles();
    expect(pass).toEqual({ deleted: 1, failed: 1 });
    expect([...own.objects.keys()]).toEqual([stuck]);
  });
});

describe('the cheap refusals run before any upload', () => {
  it('a blocked contact: contact_not_active, nothing is uploaded', async () => {
    await a.store.transaction((tx) =>
      tx.update('contacts', { contact_id: b.id }, { status: 'blocked' }),
    );
    await expect(sendStored()).rejects.toMatchObject({ code: 'contact_not_active' });
    expect(own.puts).toBe(0);
  });
});

describe('deleteUploaded: what it deletes and what the queued entry keeps', () => {
  const failingDrop = (): StorageAdapter =>
    ({
      kind: 'drop',
      put: () => Promise.reject(new Error('no')),
      presignGet: () => Promise.reject(new Error('no')),
      delete: () => Promise.reject(new StorageError('delete_failed', 'drop delete failed', 403)),
    }) as unknown as StorageAdapter;
  const dropObject: StoredObject = {
    kind: 'drop',
    locator: 'https://drop.example/o/abc?sig=secret',
    size: 1234,
    sha256: 'a'.repeat(64),
    keyEpoch: 2,
  };

  it('a drop object keeps its upload key epoch, so the later delete signs with it', async () => {
    const ctx = ctxOf(a);
    await deleteUploaded(ctx, [{ object: dropObject, adapter: failingDrop() }]);
    const rows = await fileRows();
    expect(rows).toHaveLength(1);
    const stored = await openFileObject(ctx, rows[0]!);
    expect(stored).toEqual({ kind: 'drop', object: { ...dropObject } });
    expect(JSON.stringify(rows)).not.toContain('secret');
  });

  it('a queued drop object is given up a day after the drop itself expires it', async () => {
    await deleteUploaded(ctxOf(a), [{ object: dropObject, adapter: failingDrop() }]);
    // This agent has no drop configured: every try fails.
    expect(await a.client.deleteExpiredFiles()).toEqual({ deleted: 0, failed: 1 });
    clock.t += 7 * DAY;
    await a.client.deleteExpiredFiles();
    expect(await fileRows()).toHaveLength(1);
    clock.t += 2 * DAY;
    await a.client.deleteExpiredFiles();
    expect(await fileRows()).toHaveLength(0);
  });

  it('an object of another kind is still deleted', async () => {
    const deleted: string[] = [];
    const adapter = {
      kind: 'other',
      delete: (o: StoredObject) => {
        deleted.push(o.locator);
        return Promise.resolve();
      },
    } as unknown as StorageAdapter;
    const object: StoredObject = { kind: 'other', locator: 'x', size: 1, sha256: 'b'.repeat(64) };
    await deleteUploaded(ctxOf(a), [{ object, adapter }]);
    expect(deleted).toEqual(['x']);
    expect(await fileRows()).toHaveLength(0);
  });
});
