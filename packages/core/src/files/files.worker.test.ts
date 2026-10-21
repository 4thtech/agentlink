// M1-7f: a file through the encrypted drop (D-48) between two in-process agents, with no own storage
// configured: the real drop Worker (apps/drop, M1-27a) under Miniflare (workerd), as in
// packages/storage's drop.worker.test.ts. The sender's core signs every drop request with its
// KeyStore's drop key (KeyStore.signDropRequest, M1-1g-e); the recipient downloads the signed GET
// URL from the payload. Test limits (vitest.config.ts, project `drop-worker`): 8 MiB per file.
import { SELF } from 'cloudflare:test';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { decodeBase64url, encodeHex, sha256, type JsonObject } from '@4thtech-io/crypto';
import type { FetchLike } from '@4thtech-io/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@4thtech-io/log';
import type { CoreContext } from '../context.js';
import { rowKeyOf } from '../store/store.js';
import { deleteFileObject } from './records.js';
import type { Sealed } from '../store/schema.js';
import { FakeNotary, FEE_UNITS } from '../testing/chain.js';
import { FakeClock, passphrase, seed } from '../testing/fixtures.js';
import {
  INBOX,
  deliver,
  fileBytes,
  openFileAgent,
  outgoing,
  pairForFiles,
  type FileAgent,
} from '../testing/files.js';

const ORIGIN = 'https://drop.test';
const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);
const ownerA = new MemoryOwnerKeyStore(seed(221), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(222), passphrase());

/** Every request that reached the drop, as the drop saw it. */
const seen: { method: string; url: string; body: string; headers: string }[] = [];

let ip = 0;
function dropFetch(): FetchLike {
  ip += 1;
  const addr = `203.0.113.${String(ip)}`;
  return async (request) => {
    const body = new Uint8Array(await request.clone().arrayBuffer());
    seen.push({
      method: request.method,
      url: request.url,
      body: new TextDecoder('utf-8', { fatal: false }).decode(body),
      headers: JSON.stringify([...request.headers]),
    });
    const headers = new Headers(request.headers);
    headers.set('cf-connecting-ip', addr);
    return SELF.fetch(
      new Request(request.url, {
        method: request.method,
        headers,
        ...(request.method === 'GET' ? {} : { body }),
        redirect: 'manual',
      }),
    );
  };
}

let clock: FakeClock;
let a: FileAgent;
let b: FileAgent;

beforeEach(async () => {
  seen.length = 0;
  // The drop Worker checks request times against its own clock: the agents use the real one.
  clock = new FakeClock(Math.floor(Date.now() / 1000));
  a = await openFileAgent(clock, new MemoryKeyStore(seed(21)), ownerA, 'alice', {
    relays: RELAYS_A,
    drop: { endpoint: ORIGIN, fetch: dropFetch() },
  });
  b = await openFileAgent(clock, new MemoryKeyStore(seed(22)), ownerB, 'bob', {
    relays: RELAYS_B,
    drop: { endpoint: ORIGIN, fetch: dropFetch() },
    // The recipient's download: the signed GET URL from the payload, read to the byte cap.
    download: (url) => async (maxBytes, onChunk) => {
      const response = await SELF.fetch(new Request(url, { redirect: 'manual' }));
      if (response.status !== 200 || response.body === null) throw new Error('download failed');
      const reader = response.body.getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        await onChunk(value);
        if (total > maxBytes) break;
      }
    },
  });
  await pairForFiles(clock, a, b);
});

describe('a file through the encrypted drop, no own storage (D-48, 07 §5.6)', () => {
  it('a 5 MB file: ciphertext only at the drop, verified and saved by the recipient', async () => {
    const bytes = fileBytes(5_000_000, 'DROP-PLAINTEXT-MARKER-7f');
    const sent = await a.client.sendMessage({
      to: b.id,
      text: 'big file',
      files: [outgoing('big.bin', bytes)],
    });
    expect(sent).toMatchObject({ status: 'ok', files: [{ index: 0, delivery: 'drop' }] });
    if (sent.status !== 'ok') return;

    // Zero access: the drop saw no name, no plaintext, no file key.
    for (const r of seen) {
      expect(r.url.startsWith(`${ORIGIN}/v1/`)).toBe(true);
      expect(r.body).not.toContain('big.bin');
      expect(r.body).not.toContain('DROP-PLAINTEXT-MARKER-7f');
    }

    await deliver(a, b);
    const fetched = await b.client.fetchFile({ envelopeId: sent.envelopeId });
    expect(fetched).toEqual({
      status: 'ok',
      savedTo: `${INBOX}/big.bin`,
      name: 'big.bin',
      size: 5_000_000,
      integrity: 'verified',
    });
    const saved = b.inbox.files().get('big.bin') as Uint8Array;
    expect(encodeHex(sha256(saved))).toBe(encodeHex(sha256(bytes)));
  }, 120_000);

  it('the drop locator (a signed GET URL) is stored sealed and never logged (I-7)', async () => {
    const sent = await a.client.sendMessage({
      to: b.id,
      text: 'file',
      files: [outgoing('note.txt', fileBytes(40_000, 'DROP-CANARY-PLAINTEXT-7f'))],
    });
    if (sent.status !== 'ok') throw new Error('not sent');
    await deliver(a, b);
    expect((await b.client.fetchFile({ envelopeId: sent.envelopeId })).status).toBe('ok');

    const row = (await a.store.transaction((tx) => tx.select('files')))[0];
    const locator = JSON.parse(
      await a.cipher.open(
        { table: 'files', column: 'locator', rowKey: rowKeyOf([sent.envelopeId, 0]) },
        row?.locator as Sealed,
      ),
    ) as JsonObject;
    expect(locator.kind).toBe('drop');
    const url = locator.locator as string;
    expect(url).toMatch(
      /^https:\/\/drop\.test\/v1\/get\/[A-Za-z0-9_-]{22}\?e=\d+&m=[A-Za-z0-9_-]{43}$/,
    );
    const objectId = /\/v1\/get\/([A-Za-z0-9_-]{22})/.exec(url)?.[1] as string;
    const mac = /&m=([A-Za-z0-9_-]{43})/.exec(url)?.[1] as string;

    // Zero access (I-2, IR-M1-7f-1 L3): the file key, in any spelling, the name and the plaintext
    // never reach the drop, in a URL, a header or a body.
    const fileKey = await a.cipher.open(
      { table: 'files', column: 'file_key', rowKey: rowKeyOf([sent.envelopeId, 0]) },
      row?.file_key as Sealed,
    );
    const keyHex = encodeHex(decodeBase64url(fileKey));
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) {
      for (const part of [r.url, r.headers, r.body]) {
        for (const canary of [fileKey, keyHex, 'note.txt', 'DROP-CANARY-PLAINTEXT-7f']) {
          expect(part).not.toContain(canary);
        }
      }
    }

    for (const line of [...a.lines, ...b.lines]) {
      for (const canary of [url, objectId, mac]) expect(line).not.toContain(canary);
    }
    for (const agent of [a, b]) {
      const raw = await agent.store.transaction((tx) =>
        JSON.stringify([tx.select('envelopes'), tx.select('files'), tx.select('outbox')]),
      );
      for (const canary of [url, objectId, mac]) expect(raw).not.toContain(canary);
    }
  });
});

// M1-1g-g (04 §2.1, 07 §5.4): the sender's `files` row records the drop key epoch of the upload, so
// a delete after a key rotation is signed with the drop key the object was uploaded under.
describe('a drop object stays deletable after a key rotation (M1-1g-g)', () => {
  function contextOf(agent: FileAgent, lines: string[]): CoreContext {
    return {
      keyStore: agent.keyStore,
      store: agent.store,
      cipher: agent.cipher,
      now: clock.now,
      log: createLogger({ name: 'core', level: 'debug', sink: (_l, line) => lines.push(line) }),
    };
  }

  async function sendViaDrop(): Promise<string> {
    const sent = await a.client.sendMessage({
      to: b.id,
      text: 'file',
      files: [outgoing('rotate.bin', fileBytes(30_000, 'DROP-EPOCH-PLAINTEXT'))],
    });
    expect(sent).toMatchObject({ status: 'ok', files: [{ index: 0, delivery: 'drop' }] });
    if (sent.status !== 'ok') throw new Error('not sent');
    return sent.envelopeId;
  }

  async function locatorOf(envelopeId: string): Promise<JsonObject> {
    const row = (await a.store.transaction((tx) => tx.select('files')))[0];
    return JSON.parse(
      await a.cipher.open(
        { table: 'files', column: 'locator', rowKey: rowKeyOf([envelopeId, 0]) },
        row?.locator as Sealed,
      ),
    ) as JsonObject;
  }

  it('the sealed locator records the upload epoch', async () => {
    const envelopeId = await sendViaDrop();
    expect(await locatorOf(envelopeId)).toMatchObject({ kind: 'drop', keyEpoch: 0 });
  });

  it('after the epoch advance, the delete is signed at the upload epoch and the drop accepts it', async () => {
    const envelopeId = await sendViaDrop();
    const url = (await locatorOf(envelopeId)).locator as string;
    expect((await SELF.fetch(url)).status).toBe(200);

    await ownerA
      .epochControl(a.keyStore as MemoryKeyStore)
      .advanceEpoch(0, await ownerA.unlock(passphrase()));
    expect((await a.keyStore.getPublicBundle()).keyEpoch).toBe(1);

    const lines: string[] = [];
    const row = (await a.store.transaction((tx) => tx.select('files')))[0]!;
    seen.length = 0;
    await deleteFileObject(contextOf(a, lines), a.platform, row);
    expect(seen.map((r) => r.method)).toEqual(['DELETE']);
    expect((await SELF.fetch(url)).status).not.toBe(200);

    // I-7: no drop URL, object ID or signature in any log line.
    const objectId = /\/v1\/get\/([A-Za-z0-9_-]{22})/.exec(url)?.[1] as string;
    const auth = (JSON.parse(seen[0]!.headers) as [string, string][]).find(
      ([k]) => k === 'authorization',
    )?.[1] as string;
    expect(auth).toMatch(/^Nostr /);
    for (const line of lines) {
      for (const canary of [url, objectId, auth]) expect(line).not.toContain(canary);
    }
  });

  it('a recorded epoch above the current one is refused with the fixed error, nothing sent', async () => {
    const envelopeId = await sendViaDrop();
    const locator = await locatorOf(envelopeId);
    const rowKey = rowKeyOf([envelopeId, 0]);
    const tampered = await a.cipher.seal(
      { table: 'files', column: 'locator', rowKey },
      JSON.stringify({ ...locator, keyEpoch: 5 }),
    );
    await a.store.transaction((tx) =>
      tx.update('files', { envelope_id: envelopeId, idx: 0 }, { locator: tampered }),
    );
    const row = (await a.store.transaction((tx) => tx.select('files')))[0]!;
    seen.length = 0;
    const lines: string[] = [];
    const error = await deleteFileObject(contextOf(a, lines), a.platform, row).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'storage_failed' });
    expect(String((error as Error).message)).not.toContain(locator.locator as string);
    expect(seen).toHaveLength(0);
    expect((await SELF.fetch(locator.locator as string)).status).toBe(200);
  });
});

// M1-1g-h (04 §2.1, §4; 06 §3 "Delivery receipts"; 07 §5.4): with `files.deleteAfter: receipt`, the
// contact's DELIVERED receipt deletes the drop object. The receipt is seen after the sender's key
// epoch moved on, so the DELETE must be signed with the drop key of the upload epoch, and the real
// drop Worker must accept it.
describe('delete on receipt after a key rotation (M1-1g-h)', () => {
  let chain: FakeNotary;

  beforeEach(async () => {
    chain = new FakeNotary(clock.now);
    a = await openFileAgent(clock, new MemoryKeyStore(seed(23)), ownerA, 'alice', {
      relays: RELAYS_A,
      drop: { endpoint: ORIGIN, fetch: dropFetch() },
      proofs: chain.platform(),
    });
    b = await openFileAgent(clock, new MemoryKeyStore(seed(24)), ownerB, 'bob', {
      relays: RELAYS_B,
      drop: { endpoint: ORIGIN, fetch: dropFetch() },
      proofs: chain.platform(),
    });
    await pairForFiles(clock, a, b, (p) => {
      p.files.deleteAfter = 'receipt';
      p.receipts.autoDelivered = true;
    });
    chain.fund(a.id, 10n * FEE_UNITS);
  });

  async function locatorOf(envelopeId: string): Promise<JsonObject> {
    const row = (await a.store.transaction((tx) => tx.select('files')))[0];
    return JSON.parse(
      await a.cipher.open(
        { table: 'files', column: 'locator', rowKey: rowKeyOf([envelopeId, 0]) },
        row?.locator as Sealed,
      ),
    ) as JsonObject;
  }

  it('after an epoch advance, the DELIVERED receipt deletes the object uploaded under the older epoch', async () => {
    const sent = await a.client.sendMessage({
      to: b.id,
      text: 'file',
      files: [outgoing('receipt.bin', fileBytes(30_000, 'DROP-RECEIPT-PLAINTEXT'))],
    });
    expect(sent).toMatchObject({ status: 'ok', files: [{ index: 0, delivery: 'drop' }] });
    if (sent.status !== 'ok') throw new Error('not sent');
    await deliver(a, b);
    const locator = await locatorOf(sent.envelopeId);
    expect(locator).toMatchObject({ kind: 'drop', keyEpoch: 0 });
    const url = locator.locator as string;

    // Notarized; B receives the proof and its DELIVERED receipt goes on-chain (B's policy).
    const proof = await a.client.notarize({ envelopeId: sent.envelopeId });
    expect(proof).toMatchObject({ status: 'ok' });
    await deliver(a, b);
    const recordId = (proof as { recordId: string }).recordId;
    expect(chain.records.get(recordId)?.receiptAt[0]).not.toBe(0n);
    expect((await SELF.fetch(url)).status).toBe(200);

    // The sender's key epoch moves on before its core sees the receipt.
    await ownerA
      .epochControl(a.keyStore as MemoryKeyStore)
      .advanceEpoch(0, await ownerA.unlock(passphrase()));
    expect((await a.keyStore.getPublicBundle()).keyEpoch).toBe(1);

    seen.length = 0;
    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 1, failed: 0 });
    expect(seen.map((r) => r.method)).toEqual(['DELETE']);
    expect((await SELF.fetch(url)).status).not.toBe(200);
    const row = (await a.store.transaction((tx) => tx.select('files')))[0];
    expect(row?.deleted_at).toBe(clock.t);

    // Done once: the next pass sends nothing.
    seen.length = 0;
    expect(await a.client.deleteFilesOnReceipt()).toEqual({ deleted: 0, failed: 0 });
    expect(seen).toHaveLength(0);

    // I-7: no drop URL or object ID in any log line.
    const objectId = /\/v1\/get\/([A-Za-z0-9_-]{22})/.exec(url)?.[1] as string;
    for (const line of a.lines) {
      for (const canary of [url, objectId]) expect(line).not.toContain(canary);
    }
  });
});
