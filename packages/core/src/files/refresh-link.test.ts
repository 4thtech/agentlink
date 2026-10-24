// M1-7f-3: refresh-link (04 §4 "Delivery", 07 §5.2; the `request` body of @4thtech-io/types).
// - The recipient asks with a `request` envelope `{kind: "refresh-link", envelopeId, fileIndex}`.
// - The sender answers from its sealed `files` row with a fresh link from its own storage, in a
//   `file` envelope to the same contact whose body names the file again and whose one entry carries
//   the link (so the URL travels only inside the end-to-end-encrypted payload, in the `files[]` field
//   that no inbox item or tool result shows).
// - The recipient takes the answer only for a request it sent, from the contact it asked, for the
//   same ciphertext, and updates its row's URL; the refreshed link never extends retention.
// - Only the contact the file was sent to gets an answer; no URL reaches a log line (I-7).
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { describe, expect, it } from 'vitest';
import { payloadSchema } from '@4thtech-io/types';
import { CoreError } from '../errors.js';
import { rowKeyOf } from '../store/store.js';
import type { Sealed } from '../store/schema.js';
import { pairWith } from '../testing/envelopes.js';
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
const RELAYS_C = Object.freeze(['wss://one.relay-gamma.net', 'wss://two.relay-gamma.net']);
const ownerA = new MemoryOwnerKeyStore(seed(243), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(244), passphrase());
const ownerC = new MemoryOwnerKeyStore(seed(245), passphrase());
const DAY = 86_400;
const MARKER = 'REFRESH-PLAINTEXT';

let clock: FakeClock;
let own: MemoryOwnStorage;
let a: FileAgent;
let b: FileAgent;

async function agents(): Promise<void> {
  clock = new FakeClock();
  own = new MemoryOwnStorage();
  a = await openFileAgent(clock, new MemoryKeyStore(seed(61)), ownerA, 'alice', {
    relays: RELAYS_A,
    own,
  });
  b = await openFileAgent(clock, new MemoryKeyStore(seed(62)), ownerB, 'bob', {
    relays: RELAYS_B,
    own,
  });
  await pairForFiles(clock, a, b);
}

async function send(size: number): Promise<string> {
  const sent = await a.client.sendMessage({
    to: b.id,
    text: 'file',
    files: [outgoing('report.bin', fileBytes(size, MARKER))],
  });
  if (sent.status !== 'ok') throw new Error('not sent');
  await deliver(a, b);
  return sent.envelopeId;
}

const filesRow = (agent: FileAgent, envelopeId: string) =>
  agent.store.transaction((tx) => tx.get('files', { envelope_id: envelopeId, idx: 0 }));

async function rowUrl(agent: FileAgent, envelopeId: string): Promise<string | null> {
  const row = await filesRow(agent, envelopeId);
  if (row?.url === null || row?.url === undefined) return null;
  return agent.cipher.open(
    { table: 'files', column: 'url', rowKey: rowKeyOf([envelopeId, 0]) },
    row.url as Sealed,
  );
}

const publishedCount = (agent: FileAgent) => agent.spy.published.length;

/** Sends any payload to a contact, as a modified client could (no send-tool type check). */
async function sendRaw(from: FileAgent, to: string, payload: Record<string, unknown>) {
  const { built, row } = await from.client.envelopes.prepare({ to: { contact: to }, payload });
  const routes = await from.client.outbox.routes(await from.client.outbox.contactPeer(to));
  const rows = await from.client.outbox.prepareRows(built.envelope, routes);
  await from.store.transaction((tx) => {
    tx.insert('envelopes', row);
    for (const r of rows) tx.insert('outbox', r);
  });
  await from.client.outbox.publishEnvelope(built.envelope.id);
}

/** A forged answer entry: a link chosen by the sender, for `ciphertextSha256`. */
const forgedEntry = (ciphertextSha256: string) => ({
  name: 'report.bin',
  size: 50_000,
  mime: 'application/octet-stream',
  plaintextSha256: 'a'.repeat(64),
  ciphertextSha256,
  inline: null,
  url: 'https://evil.example.com/o/forged',
  fileKey: `${'Q'.repeat(42)}A`,
  expiresAt: clock.t + DAY,
});

/** b asks a for a fresh link; a answers; the answer reaches b. */
async function refresh(envelopeId: string): Promise<void> {
  const asked = await b.client.requestFileLink({ envelopeId });
  expect(asked).toMatchObject({ status: 'ok' });
  await deliver(b, a);
  await deliver(a, b);
}

describe('refresh-link: a link refused before expiresAt (04 §4, 07 §5.2)', () => {
  it('an expired link: refresh-link returns a working URL and the file is saved', async () => {
    await agents();
    const envelopeId = await send(50_000);
    // The storage no longer honours the first link (for example, short-lived credentials).
    const first = own.urls[0] as string;
    own.refused.add(first);
    const failed = await b.client.fetchFile({ envelopeId }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(CoreError);
    expect((failed as CoreError).code).toBe('file_download_failed');

    await refresh(envelopeId);
    expect(own.urls).toHaveLength(2);
    const fresh = own.urls[1] as string;
    expect(fresh).not.toBe(first);
    // The recipient's row now holds the fresh link, sealed.
    expect(await rowUrl(b, envelopeId)).toBe(fresh);
    expect((await filesRow(b, envelopeId))?.url).toMatch(/^test-sealed:/);

    const saved = await b.client.fetchFile({ envelopeId });
    expect(saved).toMatchObject({ status: 'ok', size: 50_000, integrity: 'verified' });
    const bytes = [...b.inbox.files().values()][0] as Uint8Array;
    expect(new TextDecoder().decode(bytes.subarray(0, MARKER.length))).toBe(MARKER);
  });

  it('the answer is a file message from the sender that names the file again', async () => {
    await agents();
    const envelopeId = await send(50_000);
    const asked = await b.client.requestFileLink({ envelopeId });
    if (asked.status !== 'ok') throw new Error('not asked');
    await deliver(b, a);
    await deliver(a, b);
    const answers = await b.store.transaction((tx) =>
      tx.select('envelopes', { direction: 'in', type: 'file' }),
    );
    expect(answers).toHaveLength(1);
    const answer = answers[0];
    const text = await b.cipher.open(
      {
        table: 'envelopes',
        column: 'payload_json',
        rowKey: rowKeyOf([answer?.envelope_id as string]),
      },
      answer?.payload_json as Sealed,
    );
    const payload = payloadSchema.parse(JSON.parse(text));
    expect(payload.replyTo).toBe(asked.requestId);
    expect(payload.body).toEqual({ kind: 'refresh-link', envelopeId, fileIndex: 0 });
    expect(payload.files).toHaveLength(1);
    // The answer can be fetched on its own too.
    expect(await b.client.fetchFile({ envelopeId: answer?.envelope_id as string })).toMatchObject({
      status: 'ok',
      size: 50_000,
    });
  });

  it('a refreshed link never extends retention: expiresAt stays on both sides', async () => {
    await agents();
    const envelopeId = await send(50_000);
    const before = (await filesRow(a, envelopeId))?.expires_at;
    const beforeB = (await filesRow(b, envelopeId))?.expires_at;
    clock.t += 3 * DAY;
    await refresh(envelopeId);
    expect((await filesRow(a, envelopeId))?.expires_at).toBe(before);
    expect((await filesRow(b, envelopeId))?.expires_at).toBe(beforeB);
    // At the original expiresAt both sides delete as before (04 §4 retention).
    clock.t = (before as number) + 0;
    expect(await b.client.deleteExpiredFiles()).toEqual({ deleted: 2, failed: 0 });
    expect(await a.client.deleteExpiredFiles()).toEqual({ deleted: 1, failed: 0 });
    expect(own.objects.size).toBe(0);
  });

  it('after retention the request is refused locally and nothing is sent', async () => {
    await agents();
    const envelopeId = await send(50_000);
    clock.t += 7 * DAY;
    await b.client.deleteExpiredFiles();
    const sent = publishedCount(b);
    expect(await b.client.requestFileLink({ envelopeId })).toEqual({
      status: 'rejected',
      code: 'LINK_EXPIRED',
    });
    expect(publishedCount(b)).toBe(sent);
  });

  it('a sender whose row is gone sends no answer', async () => {
    await agents();
    const envelopeId = await send(50_000);
    const asked = await b.client.requestFileLink({ envelopeId });
    expect(asked.status).toBe('ok');
    clock.t += 7 * DAY;
    await a.client.deleteExpiredFiles();
    const sent = publishedCount(a);
    await deliver(b, a);
    expect(publishedCount(a)).toBe(sent);
    expect(own.urls).toHaveLength(1);
  });

  it('an inline file is not refreshable and an unknown envelope is not found', async () => {
    await agents();
    const envelopeId = await send(1_000);
    expect(await b.client.requestFileLink({ envelopeId })).toEqual({
      status: 'rejected',
      code: 'NOT_REFRESHABLE',
    });
    expect(await b.client.requestFileLink({ envelopeId, fileIndex: 1 })).toEqual({
      status: 'not_found',
    });
    expect(await b.client.requestFileLink({ envelopeId: 'A'.repeat(22) })).toEqual({
      status: 'not_found',
    });
    // The sender cannot ask about its own envelope.
    expect(await a.client.requestFileLink({ envelopeId })).toEqual({ status: 'not_found' });
  });
});

describe('refresh-link: who may ask, and which answers count (I-5)', () => {
  it('a contact the file was not sent to gets no answer, and no link is made', async () => {
    await agents();
    const envelopeId = await send(50_000);
    const c = await openFileAgent(clock, new MemoryKeyStore(seed(63)), ownerC, 'carol', {
      relays: RELAYS_C,
      own,
    });
    await pairWith(clock, a, c);
    await pairWith(clock, c, a);
    const asked = await c.client.sendMessage({
      to: a.id,
      type: 'request',
      body: { kind: 'refresh-link', envelopeId, fileIndex: 0 },
    });
    expect(asked.status).toBe('ok');
    const sent = publishedCount(a);
    await deliver(c, a);
    expect(publishedCount(a)).toBe(sent);
    expect(own.urls).toHaveLength(1);
  });

  it('an answer that answers no request of ours changes nothing', async () => {
    await agents();
    const envelopeId = await send(50_000);
    const url = await rowUrl(b, envelopeId);
    const sha = (await filesRow(b, envelopeId))?.sha256 as string;
    // The sender (or a modified client) sends a "refresh" b never asked for, for the right file.
    await sendRaw(a, b.id, {
      type: 'file',
      body: { kind: 'refresh-link', envelopeId, fileIndex: 0 },
      replyTo: envelopeId,
      files: [forgedEntry(sha)],
    });
    await deliver(a, b);
    expect(await rowUrl(b, envelopeId)).toBe(url);
  });

  it('an answer to our request for another ciphertext changes nothing', async () => {
    await agents();
    const envelopeId = await send(50_000);
    const url = await rowUrl(b, envelopeId);
    const asked = await b.client.requestFileLink({ envelopeId });
    if (asked.status !== 'ok') throw new Error('not asked');
    await sendRaw(a, b.id, {
      type: 'file',
      body: { kind: 'refresh-link', envelopeId, fileIndex: 0 },
      replyTo: asked.requestId,
      files: [forgedEntry('c'.repeat(64))],
    });
    await deliver(a, b);
    expect(await rowUrl(b, envelopeId)).toBe(url);
  });

  it('an answer to our request from another contact changes nothing', async () => {
    await agents();
    const envelopeId = await send(50_000);
    const url = await rowUrl(b, envelopeId);
    const sha = (await filesRow(b, envelopeId))?.sha256 as string;
    const asked = await b.client.requestFileLink({ envelopeId });
    if (asked.status !== 'ok') throw new Error('not asked');
    const c = await openFileAgent(clock, new MemoryKeyStore(seed(64)), ownerC, 'carol', {
      relays: RELAYS_C,
      own,
    });
    await pairWith(clock, b, c);
    await pairWith(clock, c, b);
    await sendRaw(c, b.id, {
      type: 'file',
      body: { kind: 'refresh-link', envelopeId, fileIndex: 0 },
      replyTo: asked.requestId,
      files: [forgedEntry(sha)],
    });
    await deliver(c, b);
    expect(await rowUrl(b, envelopeId)).toBe(url);
  });

  it('a refreshed link to a refused host is still checked at fetch (SSRF, 04 §4)', async () => {
    await agents();
    const envelopeId = await send(50_000);
    own.host = '127.0.0.1';
    await refresh(envelopeId);
    expect(await rowUrl(b, envelopeId)).toContain('https://127.0.0.1/');
    expect(await b.client.fetchFile({ envelopeId })).toEqual({
      status: 'rejected',
      code: 'URL_REFUSED',
    });
  });

  it('no link, locator or file key reaches a log line on either side (I-7)', async () => {
    await agents();
    const envelopeId = await send(50_000);
    own.refused.add(own.urls[0] as string);
    await refresh(envelopeId);
    await b.client.fetchFile({ envelopeId });
    const locator = [...own.objects.keys()][0] as string;
    expect(own.urls).toHaveLength(2);
    for (const line of [...a.lines, ...b.lines]) {
      expect(line).not.toContain(locator);
      for (const url of own.urls) expect(line).not.toContain(url);
      expect(line).not.toContain('X-Amz-');
    }
  });
});
