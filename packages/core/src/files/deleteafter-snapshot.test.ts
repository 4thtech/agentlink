// M1-1g-i: the effective `files.deleteAfter` is recorded with each sent file at send time
// (`files.delete_after`), and the delete-on-receipt pass honours that snapshot, so switching the
// policy to `receipt` later never deletes files sent earlier under `expiry` (04 §4 retention, I-9;
// 06 §3). A row stored before the column existed (null) is kept until it expires. Also the rotating
// window of the pass (IR-M1-1g-h-2): it is keyed on the last envelope ID visited, not on a list
// position, so a candidate removed between passes never makes the next pass skip another one.
import type { JsonObject } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { defaultPolicy, type Policy } from '@4thtech-io/types';
import { describe, expect, it, vi } from 'vitest';
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
import { newNonce, ownerHex, signWith } from '../testing/owner.js';
import { MAX_RECEIPT_RETENTION_PER_PASS } from './retention.js';

// Two real cores with notarize and receipts, as receipt-retention.test.ts.
vi.setConfig({ testTimeout: 60_000 });

const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);
const ownerA = new MemoryOwnerKeyStore(seed(233), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(234), passphrase());

let clock: FakeClock;
let chain: FakeNotary;
let own: MemoryOwnStorage;
let a: FileAgent;
let b: FileAgent;

async function agents(edit: (p: Policy) => void): Promise<void> {
  clock = new FakeClock();
  chain = new FakeNotary(clock.now);
  own = new MemoryOwnStorage();
  a = await openFileAgent(clock, new MemoryKeyStore(seed(43)), ownerA, 'alice', {
    relays: RELAYS_A,
    own,
    proofs: chain.platform(),
  });
  b = await openFileAgent(clock, new MemoryKeyStore(seed(44)), ownerB, 'bob', {
    relays: RELAYS_B,
    own,
    proofs: chain.platform(),
  });
  await pairForFiles(clock, a, b, edit);
  chain.fund(a.id, 10n * FEE_UNITS);
}

/** The owner of A signs a newer policy (version 2) with `deleteAfter` switched. */
async function switchPolicy(deleteAfter: 'expiry' | 'receipt'): Promise<void> {
  const policy = defaultPolicy();
  policy.files.allowedFolders = ['~/Work'];
  policy.files.deleteAfter = deleteAfter;
  policy.receipts.autoDelivered = true;
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
  expect(applied.status).toBe('applied');
}

/** A sends one stored (not inline) file to B; B receives it. */
async function sendFile(): Promise<string> {
  const sent = await a.client.sendMessage({
    to: b.id,
    text: 'file',
    files: [outgoing('report.bin', fileBytes(50_000, 'SNAPSHOT-PLAINTEXT'))],
  });
  expect(sent).toMatchObject({ status: 'ok', files: [{ index: 0, delivery: 'own' }] });
  if (sent.status !== 'ok') throw new Error('not sent');
  await deliver(a, b);
  return sent.envelopeId;
}

/** A notarizes the envelope and B receives the proof envelope (DELIVERED per B's policy). */
async function notarize(envelopeId: string): Promise<void> {
  const proof = await a.client.notarize({ envelopeId });
  expect(proof).toMatchObject({ status: 'ok' });
  await deliver(a, b);
  const recordId = (proof as { recordId: string }).recordId;
  expect(chain.records.get(recordId)?.receiptAt[0]).not.toBe(0n);
}

const fileRow = (envelopeId: string) =>
  a.store.transaction((tx) => tx.get('files', { envelope_id: envelopeId, idx: 0 }));

const both = (p: Policy, deleteAfter: 'expiry' | 'receipt') => {
  p.files.deleteAfter = deleteAfter;
  p.receipts.autoDelivered = true;
};

describe('files.deleteAfter is snapshotted per file at send time (M1-1g-i)', () => {
  it('a file sent under expiry is not deleted on receipt after the owner switches to receipt', async () => {
    await agents((p) => both(p, 'expiry'));
    const envelopeId = await sendFile();
    expect((await fileRow(envelopeId))?.delete_after).toBe('expiry');
    await notarize(envelopeId);
    await switchPolicy('receipt');

    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 0, failed: 0 });
    expect(own.objects.size).toBe(1);
    expect(own.deleted).toHaveLength(0);
    expect((await fileRow(envelopeId))?.deleted_at).toBeNull();
  });

  it('a file sent under receipt still is deleted on receipt', async () => {
    await agents((p) => both(p, 'receipt'));
    const envelopeId = await sendFile();
    expect((await fileRow(envelopeId))?.delete_after).toBe('receipt');
    await notarize(envelopeId);

    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 1, failed: 0 });
    expect(own.objects.size).toBe(0);
    expect(await fileRow(envelopeId)).toBeUndefined();
  });

  it('after the switch, a new send under receipt is deleted and the older expiry send is kept', async () => {
    await agents((p) => both(p, 'expiry'));
    const older = await sendFile();
    await notarize(older);
    await switchPolicy('receipt');
    const newer = await sendFile();
    expect((await fileRow(newer))?.delete_after).toBe('receipt');
    await notarize(newer);

    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 1, failed: 0 });
    expect((await fileRow(older))?.deleted_at).toBeNull();
    expect(await fileRow(newer)).toBeUndefined();
    expect(own.objects.size).toBe(1);
  });

  it('a file sent under receipt is kept when the owner switches back to expiry (both must say receipt)', async () => {
    await agents((p) => both(p, 'receipt'));
    const envelopeId = await sendFile();
    await notarize(envelopeId);
    await switchPolicy('expiry');

    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 0, failed: 0 });
    expect(own.objects.size).toBe(1);
    expect((await fileRow(envelopeId))?.deleted_at).toBeNull();
  });

  it('a row stored before the snapshot existed (delete_after null) is kept until it expires', async () => {
    await agents((p) => both(p, 'receipt'));
    const envelopeId = await sendFile();
    await notarize(envelopeId);
    // As the migration leaves an older row: no recorded value.
    await a.store.transaction((tx) =>
      tx.update('files', { envelope_id: envelopeId, idx: 0 }, { delete_after: null }),
    );

    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 0, failed: 0 });
    expect(own.objects.size).toBe(1);
    expect((await fileRow(envelopeId))?.deleted_at).toBeNull();
  });

  it('an inline file records the snapshot too', async () => {
    await agents((p) => both(p, 'receipt'));
    const sent = await a.client.sendMessage({
      to: b.id,
      text: 'small',
      files: [outgoing('small.txt', fileBytes(100))],
    });
    if (sent.status !== 'ok') throw new Error('not sent');
    expect((await fileRow(sent.envelopeId))?.delete_after).toBe('receipt');
  });
});

describe('the rotating window is keyed on the last envelope ID (IR-M1-1g-h-2)', () => {
  it('more than 50 notarized candidates: every one is visited across passes, even as some are deleted', async () => {
    await agents((p) => both(p, 'receipt'));
    const total = MAX_RECEIPT_RETENTION_PER_PASS + 10;
    const ids: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const sent = await a.client.sendMessage({
        to: b.id,
        text: `file ${String(i)}`,
        files: [outgoing(`f-${String(i)}.bin`, fileBytes(13_000))],
      });
      if (sent.status !== 'ok') throw new Error('not sent');
      ids.push(sent.envelopeId);
    }
    expect(own.objects.size).toBe(total);
    // Each send as recorded on-chain by A (only the status and the envelope ID make a candidate);
    // the chain read is the spy below, so no real record is needed.
    const recordId = (i: number) => `0x${i.toString(16).padStart(64, '0')}`;
    const salts = await Promise.all(
      ids.map((_, i) =>
        a.cipher.seal(
          { table: 'proofs', column: 'salt', rowKey: JSON.stringify([recordId(i)]) },
          '',
        ),
      ),
    );
    await a.store.transaction((tx) => {
      ids.forEach((envelopeId, i) =>
        tx.insert('proofs', {
          record_id: recordId(i),
          envelope_id: envelopeId,
          chain_id: 84532,
          record_json: '{}',
          tx_hash: null,
          status: 'recorded',
          fee_token: null,
          fee_amount: null,
          salt: salts[i] as (typeof salts)[number],
          created_at: clock.t,
        }),
      );
    });
    const sorted = [...ids].sort();
    // The first five in candidate order are delivered: pass 1 deletes them, so the list shrinks.
    const deliveredIds = new Set(sorted.slice(0, 5));
    const visits: string[][] = [];
    let pass: string[] = [];
    vi.spyOn(a.client.proofs, 'deliveredReceiptOnChain').mockImplementation((envelopeId) => {
      pass.push(envelopeId);
      return Promise.resolve(deliveredIds.has(envelopeId));
    });

    for (let i = 0; i < 2; i += 1) {
      pass = [];
      const result = await a.client.deleteFilesOnReceipt();
      visits.push(pass);
      expect(result.failed).toBe(0);
    }
    expect(visits[0]).toHaveLength(MAX_RECEIPT_RETENTION_PER_PASS);
    expect(visits[1]).toHaveLength(MAX_RECEIPT_RETENTION_PER_PASS);
    // Pass 2 starts right after the last envelope pass 1 visited, whatever pass 1 deleted.
    expect(visits[1]?.slice(0, 10)).toEqual(sorted.slice(MAX_RECEIPT_RETENTION_PER_PASS));
    const seen = new Set([...(visits[0] ?? []), ...(visits[1] ?? [])]);
    for (const id of ids) expect(seen.has(id), id).toBe(true);
    expect(own.objects.size).toBe(total - 5);
  });
});
