// M1-7f-2: retention at expiry and crypto-shredding on both sides (04 §4 "Retention and
// crypto-shredding", D-98; 06 §3 `files.deleteAfter`; 07 §3 `files`).
// - Receiver side (D-98): at ingest the core moves each `fileKey` out of the stored payload into a
//   sealed local `files` row; fetchFile reads the key from that row.
// - At `expiresAt` the sender deletes the stored object (own storage here; the drop path is
//   deleteFileObject, covered in files.worker.test.ts) and both sides delete their `files` rows,
//   under `expiry` and, without a DELIVERED receipt, under `receipt` (M1-33d).
// - Before `expiresAt`, nothing is deleted (I-9: the owner keeps access until then).
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { describe, expect, it } from 'vitest';
import type { Policy } from '@4thtech-io/types';
import { createLogger } from '@4thtech-io/log';
import { payloadSchema } from '@4thtech-io/types';
import type { CoreContext } from '../context.js';
import { rowKeyOf } from '../store/store.js';
import { receivedFileRows } from './received.js';
import type { Sealed } from '../store/schema.js';
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

const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);
const ownerA = new MemoryOwnerKeyStore(seed(241), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(242), passphrase());
const DAY = 86_400;

let clock: FakeClock;
let own: MemoryOwnStorage;
let a: FileAgent;
let b: FileAgent;

async function agents(edit: (p: Policy) => void = () => {}): Promise<void> {
  clock = new FakeClock();
  own = new MemoryOwnStorage();
  a = await openFileAgent(clock, new MemoryKeyStore(seed(51)), ownerA, 'alice', {
    relays: RELAYS_A,
    own,
  });
  b = await openFileAgent(clock, new MemoryKeyStore(seed(52)), ownerB, 'bob', {
    relays: RELAYS_B,
    own,
  });
  await pairForFiles(clock, a, b, edit);
}

async function send(size: number): Promise<string> {
  const sent = await a.client.sendMessage({
    to: b.id,
    text: 'file',
    files: [outgoing('report.bin', fileBytes(size, 'SHRED-PLAINTEXT'))],
  });
  expect(sent.status).toBe('ok');
  if (sent.status !== 'ok') throw new Error('not sent');
  await deliver(a, b);
  return sent.envelopeId;
}

const rows = (agent: FileAgent) => agent.store.transaction((tx) => tx.select('files'));

async function sealedKey(agent: FileAgent, envelopeId: string): Promise<string> {
  const row = (await rows(agent)).find((r) => r.envelope_id === envelopeId);
  return agent.cipher.open(
    { table: 'files', column: 'file_key', rowKey: rowKeyOf([envelopeId, 0]) },
    row?.file_key as Sealed,
  );
}

async function storedPayload(agent: FileAgent, envelopeId: string): Promise<string> {
  const row = await agent.store.transaction((tx) =>
    tx.get('envelopes', { envelope_id: envelopeId }),
  );
  return agent.cipher.open(
    { table: 'envelopes', column: 'payload_json', rowKey: rowKeyOf([envelopeId]) },
    row?.payload_json as Sealed,
  );
}

describe('receiver side: the file key leaves the stored payload at ingest (D-98)', () => {
  it.each([
    ['stored', 50_000],
    ['inline', 1_000],
  ])(
    'a %s file: sealed files row with the key, payload without it, fetch still works',
    async (_kind, size) => {
      await agents();
      const envelopeId = await send(size);
      const key = await sealedKey(a, envelopeId);
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const bRows = await rows(b);
      expect(bRows).toHaveLength(1);
      expect(bRows[0]).toMatchObject({ envelope_id: envelopeId, idx: 0, size, deleted_at: null });
      expect(bRows[0]?.file_key).toMatch(/^test-sealed:/);
      expect(await sealedKey(b, envelopeId)).toBe(key);
      expect(await storedPayload(b, envelopeId)).not.toContain(key);

      expect(await b.client.fetchFile({ envelopeId })).toMatchObject({ status: 'ok', size });
    },
  );
});

describe('retention at expiry, both sides (04 §4, 06 §3)', () => {
  it('before expiresAt nothing is deleted on either side (I-9)', async () => {
    await agents();
    const envelopeId = await send(50_000);
    clock.t += 7 * DAY - 1;
    expect(await a.client.deleteExpiredFiles()).toEqual({ deleted: 0, failed: 0 });
    expect(await b.client.deleteExpiredFiles()).toEqual({ deleted: 0, failed: 0 });
    expect(own.objects.size).toBe(1);
    expect(await rows(a)).toHaveLength(1);
    expect(await rows(b)).toHaveLength(1);
    expect(await b.client.fetchFile({ envelopeId })).toMatchObject({ status: 'ok' });
  });

  it.each(['expiry', 'receipt'] as const)(
    'deleteAfter %s: at expiresAt the object is deleted and both files rows are gone',
    async (deleteAfter) => {
      await agents((p) => {
        p.files.deleteAfter = deleteAfter;
      });
      const envelopeId = await send(50_000);
      clock.t += 7 * DAY;
      // The receiver's pass first: it discards its own key row and never touches the object.
      expect(await b.client.deleteExpiredFiles()).toEqual({ deleted: 1, failed: 0 });
      expect(await rows(b)).toHaveLength(0);
      expect(own.objects.size).toBe(1);
      expect(own.deleted).toHaveLength(0);

      expect(await a.client.deleteExpiredFiles()).toEqual({ deleted: 1, failed: 0 });
      expect(own.objects.size).toBe(0);
      expect(own.deleted).toHaveLength(1);
      expect(await rows(a)).toHaveLength(0);
      expect(await b.client.fetchFile({ envelopeId })).toEqual({
        status: 'rejected',
        code: 'LINK_EXPIRED',
      });

      // Idempotent.
      expect(await a.client.deleteExpiredFiles()).toEqual({ deleted: 0, failed: 0 });
      expect(own.deleted).toHaveLength(1);
    },
  );

  it('an inline file: no storage call, both rows gone, and the key cannot be used after', async () => {
    await agents();
    const envelopeId = await send(1_000);
    clock.t += 7 * DAY;
    expect(await a.client.deleteExpiredFiles()).toEqual({ deleted: 1, failed: 0 });
    expect(await b.client.deleteExpiredFiles()).toEqual({ deleted: 1, failed: 0 });
    expect(own.deleted).toHaveLength(0);
    expect(await rows(a)).toHaveLength(0);
    expect(await rows(b)).toHaveLength(0);
    expect(await b.client.fetchFile({ envelopeId })).toEqual({
      status: 'rejected',
      code: 'LINK_EXPIRED',
    });
  });

  it('a failed delete keeps the row for the next pass and logs no locator or URL (I-7)', async () => {
    await agents();
    await send(50_000);
    clock.t += 7 * DAY;
    const locator = [...own.objects.keys()][0] as string;
    const original = own.delete.bind(own);
    own.delete = () => Promise.reject(new Error(`refused ${locator} ${own.urls.join(' ')}`));
    expect(await a.client.deleteExpiredFiles()).toEqual({ deleted: 0, failed: 1 });
    expect(await rows(a)).toHaveLength(1);
    for (const line of a.lines) {
      expect(line).not.toContain(locator);
      for (const url of own.urls) expect(line).not.toContain(url);
    }
    own.delete = original;
    expect(await a.client.deleteExpiredFiles()).toEqual({ deleted: 1, failed: 0 });
    expect(own.objects.size).toBe(0);
  });
});

describe('receiver rows: expiresAt is capped at receive time + 7 days (04 §4, IR-M1-7f-2-1 L4)', () => {
  it('a sender-stated expiresAt beyond 7 days is cut to now + 7 days; a nearer one is kept', async () => {
    await agents();
    const envelopeId = await send(1_000);
    const text = await storedPayload(b, envelopeId);
    const ctx: CoreContext = {
      keyStore: b.keyStore,
      store: b.store,
      cipher: b.cipher,
      now: clock.now,
      log: createLogger({ name: 'core', level: 'debug', sink: () => {} }),
    };
    const far = JSON.parse(text) as { files: { expiresAt: number }[] };
    (far.files[0] as { expiresAt: number }).expiresAt = clock.t + 365 * DAY;
    const farText = JSON.stringify(far);
    const farRows = await receivedFileRows(ctx, envelopeId, payloadSchema.parse(far), farText);
    expect(farRows.rows[0]?.expires_at).toBe(clock.t + 7 * DAY);

    const near = JSON.parse(text) as { files: { expiresAt: number }[] };
    (near.files[0] as { expiresAt: number }).expiresAt = clock.t + DAY;
    const nearRows = await receivedFileRows(
      ctx,
      envelopeId,
      payloadSchema.parse(near),
      JSON.stringify(near),
    );
    expect(nearRows.rows[0]?.expires_at).toBe(clock.t + DAY);
  });
});
