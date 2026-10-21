// M1-1g-h: delete on receipt (`files.deleteAfter: receipt`; 04 §4 retention, 06 §3 "Delivery
// receipts", 07 §5.4). When the contact's DELIVERED receipt for a sent envelope is on-chain, the
// sender's core deletes the stored object of every file of that envelope through deleteFileObject
// (own storage here; the drop, after a key rotation, in files.worker.test.ts) and marks the row
// deleted. Without a DELIVERED receipt, or with `deleteAfter: expiry`, nothing is deleted: the
// object stays until it expires (the expiry runtime is M1-7f-2's).
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import type { Policy } from '@4thtech-io/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeNotary, FEE_UNITS } from '../testing/chain.js';
import { FakeClock, passphrase, seed } from '../testing/fixtures.js';
import {
  MemoryOwnStorage,
  deliver,
  fileBytes,
  openFileAgent,
  outgoing,
  pairForFiles,
  type FileAgent,
} from '../testing/files.js';

// Two real cores with notarize and receipts, as proofs.test.ts (which allows 60 s on CI).
vi.setConfig({ testTimeout: 60_000 });

const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);
const ownerA = new MemoryOwnerKeyStore(seed(231), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(232), passphrase());

let clock: FakeClock;
let chain: FakeNotary;
let own: MemoryOwnStorage;
let a: FileAgent;
let b: FileAgent;

async function agents(edit: (p: Policy) => void): Promise<void> {
  clock = new FakeClock();
  chain = new FakeNotary(clock.now);
  own = new MemoryOwnStorage();
  a = await openFileAgent(clock, new MemoryKeyStore(seed(41)), ownerA, 'alice', {
    relays: RELAYS_A,
    own,
    proofs: chain.platform(),
  });
  b = await openFileAgent(clock, new MemoryKeyStore(seed(42)), ownerB, 'bob', {
    relays: RELAYS_B,
    own,
    proofs: chain.platform(),
  });
  await pairForFiles(clock, a, b, edit);
  chain.fund(a.id, 10n * FEE_UNITS);
}

/** A sends one stored (not inline) file to B; B receives it. */
async function sendFile(): Promise<string> {
  const sent = await a.client.sendMessage({
    to: b.id,
    text: 'file',
    files: [outgoing('report.bin', fileBytes(50_000, 'RETENTION-PLAINTEXT'))],
  });
  expect(sent).toMatchObject({ status: 'ok', files: [{ index: 0, delivery: 'own' }] });
  if (sent.status !== 'ok') throw new Error('not sent');
  await deliver(a, b);
  return sent.envelopeId;
}

/** A notarizes the envelope and B receives the proof envelope (DELIVERED per B's policy). */
async function notarize(envelopeId: string): Promise<string> {
  const proof = await a.client.notarize({ envelopeId });
  expect(proof).toMatchObject({ status: 'ok' });
  await deliver(a, b);
  return (proof as { recordId: string }).recordId;
}

const fileRows = () => a.store.transaction((tx) => tx.select('files'));

describe('files.deleteAfter: receipt, the DELIVERED receipt deletes the stored object (M1-1g-h)', () => {
  beforeEach(async () => {
    await agents((p) => {
      p.files.deleteAfter = 'receipt';
      p.receipts.autoDelivered = true;
    });
  });

  it('a DELIVERED receipt on-chain: the object is deleted once and the row is marked deleted', async () => {
    const envelopeId = await sendFile();
    const recordId = await notarize(envelopeId);
    expect(chain.records.get(recordId)?.receiptAt[0]).not.toBe(0n);
    expect(own.objects.size).toBe(1);

    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 1, failed: 0 });
    expect(own.objects.size).toBe(0);
    expect(own.deleted).toHaveLength(1);
    expect((await fileRows())[0]?.deleted_at).toBe(clock.t);

    // Idempotent: a deleted row is never deleted again.
    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 0, failed: 0 });
    expect(own.deleted).toHaveLength(1);
  });

  it('no record and no receipt yet: nothing is deleted (the object stays until it expires)', async () => {
    await sendFile();
    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 0, failed: 0 });
    expect(own.objects.size).toBe(1);
    expect((await fileRows())[0]?.deleted_at).toBeNull();
  });

  it('a failed chain read deletes nothing and never throws', async () => {
    const envelopeId = await sendFile();
    await notarize(envelopeId);
    chain.stateReadsFail = true;
    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 0, failed: 0 });
    expect(own.objects.size).toBe(1);
    chain.stateReadsFail = false;
    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 1, failed: 0 });
  });

  it('a failed delete keeps the row for the next pass, and logs no locator or URL (I-7)', async () => {
    const envelopeId = await sendFile();
    await notarize(envelopeId);
    const locator = [...own.objects.keys()][0] as string;
    const original = own.delete.bind(own);
    own.delete = () => Promise.reject(new Error(`refused ${locator} ${own.urls.join(' ')}`));
    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 0, failed: 1 });
    expect((await fileRows())[0]?.deleted_at).toBeNull();
    for (const line of a.lines) {
      expect(line).not.toContain(locator);
      for (const url of own.urls) expect(line).not.toContain(url);
    }
    own.delete = original;
    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 1, failed: 0 });
    expect(own.objects.size).toBe(0);
  });

  it('a received file is never touched, even with its DELIVERED on-chain', async () => {
    // B sends a file to A and notarizes it; A receives both and signs DELIVERED (A's policy).
    const sent = await b.client.sendMessage({
      to: a.id,
      text: 'back',
      files: [outgoing('back.bin', fileBytes(50_000))],
    });
    if (sent.status !== 'ok') throw new Error('not sent');
    await deliver(b, a);
    chain.fund(b.id, 10n * FEE_UNITS);
    const proof = await b.client.notarize({ envelopeId: sent.envelopeId });
    expect(proof).toMatchObject({ status: 'ok' });
    await deliver(b, a);
    const recordId = (proof as { recordId: string }).recordId;
    expect(chain.records.get(recordId)?.receiptAt[0]).not.toBe(0n);
    // A holds the inbound envelope and a `received` record of it. Inbound `files` rows arrive with
    // M1-7f-2; one is planted here (sealed under A's store key, naming B's object) so a pass that
    // selected inbound rows would delete B's object.
    const inbound = await a.store.transaction((tx) =>
      tx.get('envelopes', { envelope_id: sent.envelopeId }),
    );
    expect(inbound?.direction).toBe('in');
    const objectKey = [...own.objects.keys()][0] as string;
    const sealed = (column: string, text: string) =>
      a.cipher.seal({ table: 'files', column, rowKey: JSON.stringify([sent.envelopeId, 0]) }, text);
    const row = {
      envelope_id: sent.envelopeId,
      idx: 0,
      name: await sealed('name', 'back.bin'),
      size: 50_000,
      sha256: '00'.repeat(32),
      locator: await sealed('locator', JSON.stringify({ kind: 's3', locator: objectKey })),
      url: null,
      file_key: await sealed('file_key', 'AAAA'),
      expires_at: clock.t + 86_400,
      deleted_at: null,
    };
    await a.store.transaction((tx) => tx.insert('files', row));

    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 0, failed: 0 });
    expect(own.deleted).toHaveLength(0);
    expect(own.objects.has(objectKey)).toBe(true);
    const after = await a.store.transaction((tx) =>
      tx.get('files', { envelope_id: sent.envelopeId, idx: 0 }),
    );
    expect(after?.deleted_at).toBeNull();
  });

  it('60 sends never notarized do not hold the window: a notarized send after them is deleted', async () => {
    for (let i = 0; i < 60; i += 1) {
      const sent = await a.client.sendMessage({
        to: b.id,
        text: `plain ${String(i)}`,
        files: [outgoing(`plain-${String(i)}.bin`, fileBytes(13_000))],
      });
      expect(sent.status).toBe('ok');
    }
    expect(own.objects.size).toBe(60);
    const envelopeId = await sendFile();
    const recordId = await notarize(envelopeId);
    expect(chain.records.get(recordId)?.receiptAt[0]).not.toBe(0n);

    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 1, failed: 0 });
    expect(own.objects.size).toBe(60);
    const row = await a.store.transaction((tx) =>
      tx.get('files', { envelope_id: envelopeId, idx: 0 }),
    );
    expect(row?.deleted_at).toBe(clock.t);
  });
});

describe('a forged receipt or proof from the contact deletes nothing (M1-1g-h)', () => {
  beforeEach(async () => {
    // B never signs DELIVERED, so the chain has no receipt for A's record.
    await agents((p) => {
      p.files.deleteAfter = 'receipt';
      p.receipts.autoDelivered = false;
    });
  });

  it('a receipt row in the local store, without the receipt on-chain, deletes nothing', async () => {
    const envelopeId = await sendFile();
    const recordId = await notarize(envelopeId);
    expect(chain.records.get(recordId)?.receiptAt[0]).toBe(0n);
    // A forged local DELIVERED for A's own record: only the chain counts.
    await a.store.transaction((tx) =>
      tx.insert('receipts', {
        record_id: recordId,
        type: 1,
        signer: b.id,
        tx_hash: null,
        at: clock.t,
      }),
    );
    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 0, failed: 0 });
    expect(own.objects.size).toBe(1);
  });

  it("the contact's proof naming A's envelope, with a DELIVERED on that contact's record, deletes nothing", async () => {
    const envelopeId = await sendFile();
    // B records a message of its own and A's agent receives the proof; A confirms delivery.
    const reply = await b.client.sendMessage({ to: a.id, text: 'reply' });
    if (reply.status !== 'ok') throw new Error('not sent');
    await deliver(b, a);
    chain.fund(b.id, 10n * FEE_UNITS);
    const proof = await b.client.notarize({ envelopeId: reply.envelopeId });
    expect(proof).toMatchObject({ status: 'ok' });
    await deliver(b, a);
    const recordId = (proof as { recordId: string }).recordId;
    expect(
      await a.client.acknowledge({ envelopeId: reply.envelopeId, type: 'delivered' }),
    ).toMatchObject({ status: 'ok' });
    expect(chain.records.get(recordId)?.receiptAt[0]).not.toBe(0n);
    // The contact's record as A stores it, pointed at A's own sent envelope (a forged `proof`
    // body naming it): a record A did not make never counts.
    await a.store.transaction((tx) =>
      tx.update('proofs', { record_id: recordId }, { envelope_id: envelopeId }),
    );
    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 0, failed: 0 });
    expect(own.objects.size).toBe(1);
    expect(own.deleted).toHaveLength(0);
  });
});

describe('files.deleteAfter: expiry (the default) or no DELIVERED receipt: nothing is deleted', () => {
  it('expiry: a DELIVERED receipt deletes nothing', async () => {
    await agents((p) => {
      p.files.deleteAfter = 'expiry';
      p.receipts.autoDelivered = true;
    });
    const envelopeId = await sendFile();
    const recordId = await notarize(envelopeId);
    expect(chain.records.get(recordId)?.receiptAt[0]).not.toBe(0n);
    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 0, failed: 0 });
    expect(own.objects.size).toBe(1);
  });

  it('receipt, but the recipient signs no DELIVERED: nothing is deleted', async () => {
    await agents((p) => {
      p.files.deleteAfter = 'receipt';
      p.receipts.autoDelivered = false;
    });
    const envelopeId = await sendFile();
    const recordId = await notarize(envelopeId);
    expect(chain.records.get(recordId)?.receiptAt[0]).toBe(0n);
    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 0, failed: 0 });
    expect(own.objects.size).toBe(1);
  });
});
