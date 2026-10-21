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

  it('only the DELIVERED type triggers it: a received file of the contact is never touched', async () => {
    // B sends a file to A; A's own (sent) rows are the only ones a receipt can delete.
    const sent = await b.client.sendMessage({
      to: a.id,
      text: 'back',
      files: [outgoing('back.bin', fileBytes(50_000))],
    });
    expect(sent.status).toBe('ok');
    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 0, failed: 0 });
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
