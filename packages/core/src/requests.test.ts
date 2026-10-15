// M1-7e: the requests queue for unknown senders (02 F-65; 06 §3 `unknownSenders: queue`; 07 §3.2).
// Limits: 5 per unknown sender key and 200 in total, counting `refused` rows from unknown keys; the
// count and the insert in one store transaction; a refusal is not stored, nothing goes to the
// sender, and the owner gets one aggregated count. Held envelopes keep their own pool. A request
// never becomes a contact (04 §2.9: contacts come only from a completed pairing; I-4).
import {
  decodeHex,
  encodeHex,
  formatFingerprint,
  randomBytes,
  senderCode,
} from '@agentlink/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@agentlink/crypto/testing';
import { createLogger } from '@agentlink/log';
import { describe, expect, it } from 'vitest';
import { MAX_REQUESTS_PER_SENDER, MAX_REQUESTS_TOTAL } from './constants.js';
import type { InboundReport } from './envelopes.js';
import { queueRefusals } from './requests.js';
import { FakeClock, passphrase, seed } from './testing/fixtures.js';
import {
  agentEnc,
  agentSigner,
  craft,
  giftWrapId,
  makeAgent,
  ownerEnc,
  pairWith,
  textPayload,
  type TestAgent,
} from './testing/envelopes.js';

const SECRET = 'SECRET-REQUEST-TEXT-7e';
const clock = new FakeClock();
const ownerA = new MemoryOwnerKeyStore(seed(211), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(212), passphrase());

async function agentA(lines?: string[]) {
  const logger =
    lines === undefined
      ? undefined
      : createLogger({ name: 'core', level: 'debug', sink: (_l, line) => lines.push(line) });
  return makeAgent(clock, new MemoryKeyStore(seed(21)), ownerA, 'alice', logger);
}

let strangerSeed = 40;
async function stranger(): Promise<TestAgent> {
  strangerSeed += 1;
  const owner = new MemoryOwnerKeyStore(seed(strangerSeed + 100), passphrase());
  return makeAgent(clock, new MemoryKeyStore(seed(strangerSeed)), owner, 'stranger');
}

/** An envelope from `s` to `a` with the 04 §3.2 entries a stranger can make (no contact owner kid). */
async function fromStranger(
  a: TestAgent,
  s: TestAgent,
  opts: { withOwnEntry?: boolean; extraKid?: Uint8Array; body?: string } = {},
) {
  const entries = [{ pk: await agentEnc(a) }];
  if (opts.withOwnEntry !== false) entries.push({ pk: await ownerEnc(ownerA) });
  entries.push({ pk: await agentEnc(s) });
  if (opts.extraKid !== undefined) entries.push({ pk: opts.extraKid });
  return craft({
    signer: await agentSigner(s.keyStore),
    entries,
    payload: textPayload(opts.body ?? SECRET),
    createdAt: clock.t,
  });
}

async function deliver(to: TestAgent, envelope: unknown): Promise<InboundReport[]> {
  const received = await to.client.envelopes.receive({ envelope, giftWrapId: giftWrapId() });
  expect(received.status).toBe('verified');
  return to.client.envelopes.processReceived();
}

const requestRows = (a: TestAgent) =>
  a.store.transaction((tx) => tx.select('envelopes', { state: 'request' }));
const rowOf = (a: TestAgent, id: string) =>
  a.store.transaction((tx) => tx.get('envelopes', { envelope_id: id }));

/** Synthetic rows from unknown keys (the store is the agent's own; no crypto needed to fill it). */
async function fill(a: TestAgent, n: number, state: 'request' | 'refused', fromKey?: string) {
  await a.store.transaction((tx) => {
    for (let i = 0; i < n; i += 1) {
      const id = encodeHex(randomBytes(16));
      tx.insert('envelopes', {
        envelope_id: id,
        envelope_hash: `0x${encodeHex(randomBytes(32))}`,
        thread_id: 'thread',
        direction: 'in',
        contact_id: null,
        from_key: fromKey ?? encodeHex(randomBytes(32)),
        type: 'text',
        state,
        refused_reason: state === 'refused' ? 'owner_entry_missing' : null,
        created_at: clock.t,
        envelope_json: state === 'request' ? '{}' : null,
        payload_json: null,
        read_at: null,
        delivery: null,
        refused_at: state === 'refused' ? clock.t : null,
        request_accepted_at: null,
      });
    }
  });
}

describe('requests-queue limits (07 §3.2)', () => {
  it('queues 5 requests from one unknown key and refuses the 6th: not stored, seen recorded', async () => {
    const a = await agentA();
    const s = await stranger();
    for (let i = 0; i < MAX_REQUESTS_PER_SENDER; i += 1) {
      expect(await deliver(a, await fromStranger(a, s))).toMatchObject([{ outcome: 'request' }]);
    }
    const sixth = await fromStranger(a, s);
    expect(await deliver(a, sixth)).toEqual([
      { envelopeId: sixth.id, outcome: 'dropped', reason: 'requests_full', flagged: false },
    ]);
    expect(await rowOf(a, sixth.id)).toBeUndefined();
    expect(await requestRows(a)).toHaveLength(MAX_REQUESTS_PER_SENDER);
    // Its seen rows stay, so the same item is not fetched and evaluated again.
    const seen = await a.store.transaction((tx) => tx.select('seen'));
    expect(seen.length).toBeGreaterThanOrEqual(6);
    // Nothing is sent to the sender (no notice, no outbox row).
    expect(await a.store.transaction((tx) => tx.count('outbox'))).toBe(0);
    expect(await a.store.transaction((tx) => tx.count('envelopes', { direction: 'out' }))).toBe(0);
  });

  it('another unknown key still gets in while one key is at its limit', async () => {
    const a = await agentA();
    const s = await stranger();
    const t = await stranger();
    const key = encodeHex((await s.keyStore.getPublicBundle()).agentNostr);
    await fill(a, MAX_REQUESTS_PER_SENDER, 'request', key);
    expect(await deliver(a, await fromStranger(a, s))).toMatchObject([
      { outcome: 'dropped', reason: 'requests_full' },
    ]);
    expect(await deliver(a, await fromStranger(a, t))).toMatchObject([{ outcome: 'request' }]);
  });

  it('holds 200 in total and refuses the 201st, from a fresh key', async () => {
    const a = await agentA();
    await fill(a, MAX_REQUESTS_TOTAL - 1, 'request');
    expect(await deliver(a, await fromStranger(a, await stranger()))).toMatchObject([
      { outcome: 'request' },
    ]);
    const over = await fromStranger(a, await stranger());
    expect(await deliver(a, over)).toMatchObject([
      { envelopeId: over.id, outcome: 'dropped', reason: 'requests_full' },
    ]);
    expect(await requestRows(a)).toHaveLength(MAX_REQUESTS_TOTAL);
  });

  it('counts refused rows from unknown keys toward both limits', async () => {
    const a = await agentA();
    const s = await stranger();
    const key = encodeHex((await s.keyStore.getPublicBundle()).agentNostr);
    await fill(a, MAX_REQUESTS_PER_SENDER, 'refused', key);
    expect(await deliver(a, await fromStranger(a, s))).toMatchObject([
      { outcome: 'dropped', reason: 'requests_full' },
    ]);
    const b = await agentA();
    await fill(b, MAX_REQUESTS_TOTAL, 'refused');
    expect(await deliver(b, await fromStranger(b, await stranger()))).toMatchObject([
      { outcome: 'dropped', reason: 'requests_full' },
    ]);
  });

  it('a step 8 refusal from an unknown key at its limit is dropped, not stored', async () => {
    const a = await agentA();
    const s = await stranger();
    const key = encodeHex((await s.keyStore.getPublicBundle()).agentNostr);
    // Under the limit a missing own-owner entry is a stored refusal (04 §3.1.1 step 8).
    const first = await fromStranger(a, s, { withOwnEntry: false });
    expect(await deliver(a, first)).toMatchObject([
      { outcome: 'refused', reason: 'owner_entry_missing' },
    ]);
    await fill(a, MAX_REQUESTS_PER_SENDER - 1, 'request', key);
    const over = await fromStranger(a, s, { withOwnEntry: false });
    expect(await deliver(a, over)).toMatchObject([
      { envelopeId: over.id, outcome: 'dropped', reason: 'requests_full' },
    ]);
    expect(await rowOf(a, over.id)).toBeUndefined();
  });

  it('a contact is never limited by the requests queue', async () => {
    const a = await agentA();
    const b = await makeAgent(clock, new MemoryKeyStore(seed(22)), ownerB, 'bob');
    await pairWith(clock, a, b);
    await fill(a, MAX_REQUESTS_TOTAL, 'request');
    const env = await craft({
      signer: await agentSigner(b.keyStore),
      entries: [
        { pk: await agentEnc(a) },
        { pk: await ownerEnc(ownerA) },
        { pk: await ownerEnc(ownerB) },
        { pk: await agentEnc(b) },
      ],
      payload: textPayload('hi'),
      createdAt: clock.t,
    });
    expect(await deliver(a, env)).toMatchObject([{ outcome: 'ok', contactId: b.id }]);
  });

  it('held envelopes keep their own pool: a full queue does not stop holding', async () => {
    const a = await agentA();
    const b = await makeAgent(clock, new MemoryKeyStore(seed(23)), ownerB, 'bob');
    await pairWith(clock, a, b);
    await fill(a, MAX_REQUESTS_TOTAL, 'request');
    // A stranger that names the contact owner's kid is held, not refused (04 §3.1.1 step 7).
    const s = await stranger();
    const env = await fromStranger(a, s, { extraKid: await ownerEnc(ownerB) });
    expect(await deliver(a, env)).toMatchObject([{ outcome: 'held' }]);
  });

  it('the count and the insert are one transaction: concurrent passes never exceed the limit', async () => {
    const a = await agentA();
    const s = await stranger();
    const envs = [];
    for (let i = 0; i < MAX_REQUESTS_PER_SENDER + 3; i += 1) envs.push(await fromStranger(a, s));
    for (const e of envs) {
      expect(
        (await a.client.envelopes.receive({ envelope: e, giftWrapId: giftWrapId() })).status,
      ).toBe('verified');
    }
    const reports = (
      await Promise.all([
        a.client.envelopes.processReceived(),
        a.client.envelopes.processReceived(),
        a.client.envelopes.processReceived(),
      ])
    ).flat();
    expect(await requestRows(a)).toHaveLength(MAX_REQUESTS_PER_SENDER);
    expect(queueRefusals(reports)).toBe(3);
  });

  it('never puts inbound text in a report or a log line (I-5)', async () => {
    const lines: string[] = [];
    const a = await agentA(lines);
    const s = await stranger();
    const reports: InboundReport[] = [];
    for (let i = 0; i <= MAX_REQUESTS_PER_SENDER; i += 1) {
      reports.push(...(await deliver(a, await fromStranger(a, s))));
    }
    expect(JSON.stringify(reports)).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});

describe('the owner view: count, list and ignore (02 F-65, 11 §5.2)', () => {
  it('aggregates refusals into one count for the activity line', () => {
    const reports: InboundReport[] = [
      { outcome: 'dropped', reason: 'requests_full', flagged: false },
      { outcome: 'request', flagged: false },
      { outcome: 'dropped', reason: 'requests_full', flagged: false },
      { outcome: 'dropped', reason: 'blocked', flagged: false },
    ];
    expect(queueRefusals(reports)).toBe(2);
  });

  it('lists requests by sender key with no inbound content', async () => {
    const a = await agentA();
    const s = await stranger();
    const key = encodeHex((await s.keyStore.getPublicBundle()).agentNostr);
    const e1 = await fromStranger(a, s);
    await deliver(a, e1);
    clock.t += 5;
    const e2 = await fromStranger(a, s);
    await deliver(a, e2);
    expect(await a.client.requests.count()).toBe(2);
    const list = await a.client.requests.list();
    expect(list).toEqual([
      { envelopeId: e1.id, fromKey: key, type: 'text', createdAt: e1.createdAt, acceptedAt: null },
      { envelopeId: e2.id, fromKey: key, type: 'text', createdAt: e2.createdAt, acceptedAt: null },
    ]);
    expect(JSON.stringify(list)).not.toContain(SECRET);
  });

  it('ignore removes one sender’s requests and frees its slots; its items stay seen', async () => {
    const a = await agentA();
    const s = await stranger();
    const t = await stranger();
    const key = encodeHex((await s.keyStore.getPublicBundle()).agentNostr);
    for (let i = 0; i < MAX_REQUESTS_PER_SENDER; i += 1) await deliver(a, await fromStranger(a, s));
    await deliver(a, await fromStranger(a, t));
    const seenBefore = await a.store.transaction((tx) => tx.count('seen'));
    expect(await a.client.requests.ignore(key)).toBe(MAX_REQUESTS_PER_SENDER);
    expect(await a.client.requests.count()).toBe(1);
    expect(await a.store.transaction((tx) => tx.count('seen'))).toBe(seenBefore);
    expect(await deliver(a, await fromStranger(a, s))).toMatchObject([{ outcome: 'request' }]);
  });

  it('ignore never touches a contact’s envelopes or another key', async () => {
    const a = await agentA();
    await fill(a, 2, 'request', 'aa'.repeat(32));
    expect(await a.client.requests.ignore('bb'.repeat(32))).toBe(0);
    expect(await a.client.requests.ignore('not-a-key')).toBe(0);
    expect(await a.client.requests.count()).toBe(2);
  });

  it('a request never becomes a contact: queueing, listing and ignoring write no contact (I-4)', async () => {
    const a = await agentA();
    const s = await stranger();
    const key = encodeHex((await s.keyStore.getPublicBundle()).agentNostr);
    await deliver(a, await fromStranger(a, s));
    await a.client.requests.list();
    await a.client.requests.ignore(key);
    expect(await a.store.transaction((tx) => tx.count('contacts'))).toBe(0);
    expect(await a.store.transaction((tx) => tx.count('pairings'))).toBe(0);
    expect(await a.client.contacts.list()).toEqual([]);
  });
});

/** Two distinct 32-byte keys (hex) whose sender codes share the short form (a birthday search: ~2^16 tries). */
function collidingKeys(): readonly [string, string] {
  const seen = new Map<string, string>();
  for (let i = 0; ; i += 1) {
    const bytes = new Uint8Array(32);
    new DataView(bytes.buffer).setUint32(0, i);
    const code = formatFingerprint(senderCode(bytes), 'short');
    const prior = seen.get(code);
    if (prior !== undefined) return [prior, encodeHex(bytes)];
    seen.set(code, encodeHex(bytes));
  }
}

describe('the sender code of a request (04 §2.9, D-72; M1-9c-b)', () => {
  const shortOf = (key: string) => formatFingerprint(senderCode(decodeHex(key)), 'short');
  const extendedOf = (key: string) => formatFingerprint(senderCode(decodeHex(key)), 'extended');

  it('is on every entry, in the short form from the crypto helper, never from sender-chosen data', async () => {
    const a = await agentA();
    const key = 'aa'.repeat(32);
    await fill(a, 2, 'request', key);
    const entries = await a.client.requests.list();
    expect(entries).toHaveLength(2);
    // Two requests from one sender share one code and do not collide with themselves.
    for (const entry of entries) expect(entry.senderCode).toBe(shortOf(key));
    expect(entries[0]?.senderCode).toMatch(/^[0-9A-F]{4}·[0-9A-F]{4}$/);
  });

  it('shows two colliding senders in the extended form, and the others in the short form', async () => {
    const a = await agentA();
    const [x, y] = collidingKeys();
    const other = 'cc'.repeat(32);
    expect(shortOf(x)).toBe(shortOf(y));
    expect(extendedOf(x)).not.toBe(extendedOf(y));
    await fill(a, 1, 'request', x);
    await fill(a, 1, 'request', y);
    await fill(a, 1, 'request', other);
    const byKey = new Map((await a.client.requests.list()).map((e) => [e.fromKey, e.senderCode]));
    expect(byKey.get(x)).toBe(extendedOf(x));
    expect(byKey.get(y)).toBe(extendedOf(y));
    expect(byKey.get(other)).toBe(shortOf(other));
  });

  it('returns to the short form once the colliding sender is ignored', async () => {
    const a = await agentA();
    const [x, y] = collidingKeys();
    await fill(a, 1, 'request', x);
    await fill(a, 1, 'request', y);
    await a.client.requests.ignore(y);
    const [entry] = await a.client.requests.list();
    expect(entry?.senderCode).toBe(shortOf(x));
  });

  it('counts a refused row from an unknown key toward a collision', async () => {
    const a = await agentA();
    const [x, y] = collidingKeys();
    await fill(a, 1, 'request', x);
    await fill(a, 1, 'refused', y);
    const [entry] = await a.client.requests.list();
    expect(entry?.senderCode).toBe(extendedOf(x));
  });
});
