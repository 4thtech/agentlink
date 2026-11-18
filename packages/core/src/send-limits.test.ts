// SEC-OUTBOUND-CAPS (D-156; 06 §3 `outgoing`, 07 §3.2): `agentlink_send` counts the messages and
// files this agent sent over the rolling 24 h window, per contact and in all, in the transaction that
// stores the envelope. Over a cap: SEND_LIMIT, nothing stored or published, and the refusal is not
// kept under the clientRequestId. Acks, receipts, pairing and owner-channel envelopes are not counted.
import { type JsonObject, type KeyStore } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { defaultPolicy, type Policy } from '@4thtech-io/types';
import { wrapEnvelope, type PublishOutcome } from '@4thtech-io/transport-nostr';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { outgoingUsage, recordOutgoing } from './outgoing-limits.js';
import { MemoryStore } from './store/memory-store.js';
import type { Row } from './store/schema.js';
import {
  FakeClock,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import { pairWith, type TestAgent } from './testing/envelopes.js';
import {
  MemoryOwnStorage,
  fileBytes,
  openFileAgent,
  outgoing,
  pairForFiles,
} from './testing/files.js';
import { MemoryPolicyMark, newNonce, ownerHex, signWith } from './testing/owner.js';
import type { TransportFactory } from './transport.js';

const DAY = 86_400;
let clock: FakeClock;
let published = 0;

const factory: TransportFactory = (deps) => ({
  relayStatus: (relays) =>
    Promise.resolve({ connected: new Set(relays).size, total: new Set(relays).size }),
  wrap: (envelope, recipients, keys) => wrapEnvelope(envelope, recipients, keys, { now: deps.now }),
  publish: (_event, relays) => {
    published += 1;
    return Promise.resolve({
      results: relays.map((relay) => ({ relay, ok: true, reason: 'ok' as const })),
      acked: [...relays],
      sent: true,
    } as PublishOutcome);
  },
});

const ownerA = new MemoryOwnerKeyStore(seed(211), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(212), passphrase());
const ownerC = new MemoryOwnerKeyStore(seed(213), passphrase());

async function openAgent(
  n: number,
  owner: MemoryOwnerKeyStore,
  name: string,
  mark?: MemoryPolicyMark,
): Promise<TestAgent> {
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const keyStore: KeyStore = new MemoryKeyStore(seed(n));
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    transport: factory,
    ...(mark === undefined ? {} : { policyMark: mark }),
  });
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name,
    relays: ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'],
  });
  return { client, store, cipher, keyStore, owner, id: client.agentId };
}

async function pair(a: TestAgent, b: TestAgent): Promise<void> {
  await pairWith(clock, a, b);
  await pairWith(clock, b, a);
}

/** Applies an owner-signed policy with these outgoing caps (the only way to change them, I-4). */
async function applyCaps(a: TestAgent, caps: Partial<NonNullable<Policy['outgoing']>>) {
  const policy = defaultPolicy();
  policy.outgoing = { ...policy.outgoing!, ...caps };
  const signed = await signWith(a.owner, {
    v: 1,
    agent: a.id,
    owner: await ownerHex(a.owner),
    op: 'policy.set',
    params: { version: 1, policy: policy as unknown as JsonObject },
    nonce: newNonce(),
    issuedAt: clock.t,
    expiresAt: clock.t + 600,
  });
  expect(await a.client.ownerActions.apply(JSON.stringify(signed))).toMatchObject({
    status: 'applied',
  });
}

const sentRows = (a: TestAgent) =>
  a.store.transaction((tx) =>
    tx.select('envelopes', { direction: 'out', type: { in: ['text', 'note'] } }),
  );

beforeEach(() => {
  clock = new FakeClock();
  published = 0;
});

describe('outgoing message caps in the send pipeline (D-156)', () => {
  it('refuses the message over the per-contact cap; nothing stored or published', async () => {
    const mark = new MemoryPolicyMark();
    const a = await openAgent(21, ownerA, 'alice', mark);
    const b = await openAgent(22, ownerB, 'bob');
    await pair(a, b);
    await applyCaps(a, { messagesPerContactPerDay: 2 });

    expect((await a.client.sendMessage({ to: b.id, text: 'one' })).status).toBe('ok');
    expect((await a.client.sendMessage({ to: b.id, text: 'two' })).status).toBe('ok');
    const before = published;
    const refused = await a.client.sendMessage({ to: b.id, text: 'three' });
    expect(refused).toMatchObject({
      status: 'rejected',
      code: 'SEND_LIMIT',
      limit: 'messages_contact',
      max: 2,
    });
    if (refused.status === 'rejected' && 'retryAt' in refused) {
      expect(refused.retryAt).toBe(
        new Date((clock.t + DAY) * 1000).toISOString().replace('.000Z', 'Z'),
      );
    }
    expect(published).toBe(before);
    expect(await sentRows(a)).toHaveLength(2);
  });

  it('the per-day cap counts every contact', async () => {
    const mark = new MemoryPolicyMark();
    const a = await openAgent(23, ownerA, 'alice', mark);
    const b = await openAgent(24, ownerB, 'bob');
    const c = await openAgent(25, ownerC, 'carol');
    await pair(a, b);
    await pair(a, c);
    await applyCaps(a, { messagesPerDay: 2 });
    expect((await a.client.sendMessage({ to: b.id, text: 'one' })).status).toBe('ok');
    expect((await a.client.sendMessage({ to: c.id, text: 'two' })).status).toBe('ok');
    expect(await a.client.sendMessage({ to: c.id, text: 'three' })).toMatchObject({
      status: 'rejected',
      code: 'SEND_LIMIT',
      limit: 'messages_day',
    });
  });

  it('the window rolls: after 24 h the oldest message no longer counts', async () => {
    const mark = new MemoryPolicyMark();
    const a = await openAgent(26, ownerA, 'alice', mark);
    const b = await openAgent(27, ownerB, 'bob');
    await pair(a, b);
    await applyCaps(a, { messagesPerContactPerDay: 1 });
    expect((await a.client.sendMessage({ to: b.id, text: 'one' })).status).toBe('ok');
    clock.t += DAY - 1;
    expect((await a.client.sendMessage({ to: b.id, text: 'two' })).status).toBe('rejected');
    clock.t += 1;
    expect((await a.client.sendMessage({ to: b.id, text: 'two' })).status).toBe('ok');
  });

  it('acks, receipts and pairing envelopes are not counted', async () => {
    const mark = new MemoryPolicyMark();
    const a = await openAgent(28, ownerA, 'alice', mark);
    const b = await openAgent(29, ownerB, 'bob');
    await pair(a, b);
    await applyCaps(a, { messagesPerContactPerDay: 1, messagesPerDay: 1 });
    await a.store.transaction((tx) => {
      for (const [i, type] of ['ack', 'proof', 'card-update', 'handshake'].entries()) {
        tx.insert('envelopes', outRow(id22(`x${i}`, 'X'), b.id, type, clock.t));
      }
    });
    expect((await a.client.sendMessage({ to: b.id, text: 'one' })).status).toBe('ok');
  });

  it('a refusal is not kept under the clientRequestId: the same id runs once the window rolls', async () => {
    const mark = new MemoryPolicyMark();
    const a = await openAgent(30, ownerA, 'alice', mark);
    const b = await openAgent(31, ownerB, 'bob');
    await pair(a, b);
    await applyCaps(a, { messagesPerContactPerDay: 1 });
    expect((await a.client.sendMessage({ to: b.id, text: 'one' })).status).toBe('ok');
    const id = 'req-limit-1';
    expect(
      (await a.client.sendMessage({ to: b.id, text: 'two', clientRequestId: id })).status,
    ).toBe('rejected');
    clock.t += DAY;
    expect(
      (await a.client.sendMessage({ to: b.id, text: 'two', clientRequestId: id })).status,
    ).toBe('ok');
  });
});

/** A 22-character base64url ID (16 bytes), as envelope and thread IDs are. */
const id22 = (id: string, pad: string): string => id.slice(0, 21).padEnd(21, pad) + 'A';

function outRow(id: string, contact: string, type: string, at: number): Row<'envelopes'> {
  return {
    envelope_id: id,
    envelope_hash: `h${id}`,
    thread_id: id22(id, 'T'),
    direction: 'out',
    contact_id: contact,
    from_key: 'self',
    type,
    state: 'ok',
    refused_reason: null,
    created_at: at,
    envelope_json: null,
    payload_json: null,
    read_at: null,
    delivery: 'sent',
    refused_at: null,
    request_accepted_at: null,
    deleted_at: null,
  };
}

const NOW = 1_800_000_000;
const ANA = '0x' + '3d'.repeat(20);
const BEN = '0x' + '4e'.repeat(20);

const logRow = (id: string, contact: string, t: number, files = 0, bytes = 0) => ({
  envelope_id: id,
  contact_id: contact,
  t,
  files,
  bytes,
});

describe('outgoingUsage: what the store counts (D-156)', () => {
  it('counts logged messages and their files per contact and in all, inside the window only', async () => {
    const store = new MemoryStore();
    await store.transaction((tx) => {
      tx.insert('outgoing_log', logRow('m1', ANA, NOW - 10, 2, 300));
      tx.insert('outgoing_log', logRow('m2', ANA, NOW - 20));
      tx.insert('outgoing_log', logRow('m3', BEN, NOW - 30, 1, 400));
      tx.insert('outgoing_log', logRow('old', ANA, NOW - DAY, 1, 800));
    });
    const usage = await store.transaction((tx) => outgoingUsage(tx, ANA, NOW));
    expect(usage).toMatchObject({
      contactMessages: 2,
      messages: 3,
      contactFiles: 2,
      files: 3,
      bytes: 700,
      contactOldestAt: NOW - 20,
      fileOldestAt: NOW - 30,
    });
  });

  it('recording drops the rows that left the window', async () => {
    const store = new MemoryStore();
    await store.transaction((tx) => {
      tx.insert('outgoing_log', logRow('old', ANA, NOW - DAY));
      recordOutgoing(tx, { envelopeId: 'new', contact: ANA, now: NOW, files: 1, bytes: 5 });
    });
    const rows = await store.transaction((tx) => tx.select('outgoing_log'));
    expect(rows.map((r) => r.envelope_id)).toEqual(['new']);
  });
});

describe('a deleted file never frees a cap (IR M1; D-156)', () => {
  it('send a file, delete its row as retention does: the next file is still over the cap', async () => {
    const own = new MemoryOwnStorage();
    const a = await openFileAgent(clock, new MemoryKeyStore(seed(61)), ownerA, 'alice', {
      relays: ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'],
      own,
    });
    const b = await openFileAgent(clock, new MemoryKeyStore(seed(62)), ownerB, 'bob', {
      relays: ['wss://one.relay-beta.net', 'wss://two.relay-beta.net'],
      own,
    });
    await pairForFiles(clock, a, b, (p) => {
      p.outgoing = { ...p.outgoing!, filesPerContactPerDay: 1 };
    });
    const first = await a.client.sendMessage({
      to: b.id,
      text: 'file',
      files: [outgoing('one.bin', fileBytes(64))],
    });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    const before = await a.store.transaction((tx) => outgoingUsage(tx, b.id, clock.t));
    // What delete on receipt and expiry do (files/retention.ts): the row goes, with its key.
    await a.store.transaction((tx) => tx.delete('files', { envelope_id: first.envelopeId }));
    const after = await a.store.transaction((tx) => outgoingUsage(tx, b.id, clock.t));
    expect(after).toEqual(before);
    expect(after.contactFiles).toBe(1);
    expect(
      await a.client.sendMessage({
        to: b.id,
        text: 'file',
        files: [outgoing('two.bin', fileBytes(64))],
      }),
    ).toMatchObject({ status: 'rejected', code: 'SEND_LIMIT', limit: 'files_contact' });
  });
});

describe('two concurrent sends at the cap (L5; D-156)', () => {
  it('exactly one passes: the count and the stored envelope are one transaction', async () => {
    const mark = new MemoryPolicyMark();
    const a = await openAgent(32, ownerA, 'alice', mark);
    const b = await openAgent(33, ownerB, 'bob');
    await pair(a, b);
    await applyCaps(a, { messagesPerContactPerDay: 1 });
    const results = await Promise.all([
      a.client.sendMessage({ to: b.id, text: 'one' }),
      a.client.sendMessage({ to: b.id, text: 'two' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['ok', 'rejected']);
    expect(await sentRows(a)).toHaveLength(1);
  });
});
