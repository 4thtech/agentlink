// M1-7e-2 (D-72; IR-M1-7e-1 F01; IR-D-72-1 F01, F03, F05, F10): the owner's answers to a request
// (Accept, Ignore, Ignore all, Block, Unblock), refused-row retention on the local clock, and the
// blocked-key drop at the start of 04 §3.1.1 step 5. A request never becomes a contact (04 §2.9):
// none of these actions writes a contact or a pairing (07 §3.2).
import { encodeBase64url, encodeHex, randomBytes } from '@agentlink/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@agentlink/crypto/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_REQUESTS_PER_SENDER,
  MAX_REQUESTS_TOTAL,
  REFUSED_RETENTION_SECONDS,
} from './constants.js';
import type { InboundReport } from './envelopes.js';
import { requestsFullTx } from './requests.js';
import { FakeClock, passphrase, seed } from './testing/fixtures.js';
import {
  agentEnc,
  agentSigner,
  cardUpdatePayload,
  craft,
  giftWrapId,
  makeAgent,
  ownerEnc,
  pairWith,
  rotate,
  textPayload,
  type Signer,
  type TestAgent,
} from './testing/envelopes.js';

const START = 1_800_000_000;
const clock = new FakeClock(START);
const ownerA = new MemoryOwnerKeyStore(seed(221), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(222), passphrase());
const ownerS = new MemoryOwnerKeyStore(seed(229), passphrase());
const HOLD_SECONDS = 172_800;

afterEach(() => {
  clock.t = START;
  vi.restoreAllMocks();
});

const agentA = () => makeAgent(clock, new MemoryKeyStore(seed(31)), ownerA, 'alice');

let strangerSeed = 60;
/** A stranger with its own owner (default) or with `owner`. */
async function stranger(owner?: MemoryOwnerKeyStore): Promise<TestAgent> {
  strangerSeed += 1;
  const o = owner ?? new MemoryOwnerKeyStore(seed(strangerSeed + 100), passphrase());
  return makeAgent(clock, new MemoryKeyStore(seed(strangerSeed)), o, 'stranger');
}

const keyOf = async (agent: TestAgent): Promise<string> =>
  encodeHex((await agent.keyStore.getPublicBundle()).agentNostr);

/** An envelope from `s` (or `signer`) to `a`: A's agent and owner entries, the sender's own entry. */
async function fromKey(
  a: TestAgent,
  s: TestAgent | { readonly signer: Signer; readonly enc: Uint8Array },
  opts: {
    withOwnEntry?: boolean;
    extraKid?: Uint8Array;
    createdAt?: number;
    id?: string;
    payload?: Parameters<typeof craft>[0]['payload'];
  } = {},
) {
  const signer = 'signer' in s ? s.signer : await agentSigner(s.keyStore);
  const enc = 'signer' in s ? s.enc : await agentEnc(s);
  const entries = [{ pk: await agentEnc(a) }];
  if (opts.withOwnEntry !== false) entries.push({ pk: await ownerEnc(ownerA) });
  entries.push({ pk: enc });
  if (opts.extraKid !== undefined) entries.push({ pk: opts.extraKid });
  return craft({
    signer,
    entries,
    payload: opts.payload ?? textPayload('request text'),
    createdAt: opts.createdAt ?? clock.t,
    ...(opts.id === undefined ? {} : { id: opts.id }),
  });
}

async function deliver(to: TestAgent, envelope: unknown): Promise<InboundReport[]> {
  const received = await to.client.envelopes.receive({ envelope, giftWrapId: giftWrapId() });
  expect(received.status).toBe('verified');
  return to.client.envelopes.processReceived();
}

const rowOf = (a: TestAgent, id: string) =>
  a.store.transaction((tx) => tx.get('envelopes', { envelope_id: id }));
const heldOf = (a: TestAgent, id: string) =>
  a.store.transaction((tx) => tx.get('held_envelopes', { envelope_id: id }));
const countWhere = (a: TestAgent, state: 'request' | 'refused', fromKeyHex?: string) =>
  a.store.transaction((tx) =>
    tx.count('envelopes', { state, ...(fromKeyHex === undefined ? {} : { from_key: fromKeyHex }) }),
  );
const noContactWrites = async (a: TestAgent) => {
  expect(await a.store.transaction((tx) => tx.count('contacts'))).toBe(0);
  expect(await a.store.transaction((tx) => tx.count('pairings'))).toBe(0);
};
const spyUnwrap = (a: TestAgent) => vi.spyOn(a.keyStore, 'unwrapCek');

/** A fresh key that only signs: a sender with no agent of its own (cheap; 200 of them per test). */
async function freshKey(): Promise<{ signer: Signer; enc: Uint8Array }> {
  const ks = new MemoryKeyStore(randomBytes(32));
  return { signer: await agentSigner(ks), enc: (await ks.getPublicBundle()).agentEnc };
}

/** Puts A at a request from `s`, returning the request's id. */
async function requestFrom(a: TestAgent, s: TestAgent): Promise<string> {
  const env = await fromKey(a, s);
  expect(await deliver(a, env)).toMatchObject([{ outcome: 'request' }]);
  return env.id;
}

describe('recovery from a flood of refusals (IR-M1-7e-1 F01)', () => {
  it('200 refusals from 200 fresh keys fill the queue; Ignore all lets a new request in', async () => {
    const a = await agentA();
    const flood = [];
    for (let i = 0; i < MAX_REQUESTS_TOTAL; i += 1) {
      flood.push(await fromKey(a, await freshKey(), { withOwnEntry: false }));
    }
    for (const env of flood) {
      expect((await a.client.envelopes.receive({ envelope: env })).status).toBe('verified');
    }
    const reports = await a.client.envelopes.processReceived();
    expect(reports.filter((r) => r.outcome === 'refused')).toHaveLength(MAX_REQUESTS_TOTAL);
    expect(await countWhere(a, 'refused')).toBe(MAX_REQUESTS_TOTAL);
    const s = await stranger();
    expect(await deliver(a, await fromKey(a, s))).toMatchObject([
      { outcome: 'dropped', reason: 'requests_full' },
    ]);
    expect(await a.client.requests.ignoreAll()).toBe(MAX_REQUESTS_TOTAL);
    const next = await fromKey(a, s);
    expect(await deliver(a, next)).toMatchObject([{ envelopeId: next.id, outcome: 'request' }]);
    await noContactWrites(a);
  });

  it('refusals stop counting at refused_at + 604 800 s with no owner action, and are pruned', async () => {
    const a = await agentA();
    const flood = [];
    for (let i = 0; i < MAX_REQUESTS_TOTAL; i += 1) {
      flood.push(await fromKey(a, await freshKey(), { withOwnEntry: false }));
    }
    for (const env of flood) await a.client.envelopes.receive({ envelope: env });
    await a.client.envelopes.processReceived();
    const refused = await a.store.transaction((tx) => tx.select('envelopes', { state: 'refused' }));
    expect(refused).toHaveLength(MAX_REQUESTS_TOTAL);
    expect(refused.every((r) => r.refused_at === START)).toBe(true);
    const probe = encodeHex(randomBytes(32));
    // One second before expiry they still count; at expiry the count ignores them at once, in the
    // count-and-insert transaction, before any prune.
    expect(await a.store.transaction((tx) => requestsFullTx(tx, probe, START + 604_799))).toBe(
      true,
    );
    expect(
      await a.store.transaction((tx) =>
        requestsFullTx(tx, probe, START + REFUSED_RETENTION_SECONDS),
      ),
    ).toBe(false);
    clock.t = START + REFUSED_RETENTION_SECONDS;
    const s = await stranger();
    const next = await fromKey(a, s);
    expect(await deliver(a, next)).toMatchObject([{ envelopeId: next.id, outcome: 'request' }]);
    // The pass pruned them; their seen rows stay.
    expect(await countWhere(a, 'refused')).toBe(0);
    const seen = await a.store.transaction((tx) => tx.count('seen'));
    expect(seen).toBeGreaterThanOrEqual(MAX_REQUESTS_TOTAL);
  });

  it('a refused_at later than now + S is expired, so a clock moved back keeps nothing counted (F05)', async () => {
    const a = await agentA();
    const s = await stranger();
    const key = await keyOf(s);
    // Refused while the clock read far ahead; the clock then moved back to START.
    clock.t = START + 10_000;
    for (let i = 0; i < MAX_REQUESTS_PER_SENDER; i += 1) {
      expect(await deliver(a, await fromKey(a, s, { withOwnEntry: false }))).toMatchObject([
        { outcome: 'refused' },
      ]);
    }
    clock.t = START;
    expect(await a.store.transaction((tx) => requestsFullTx(tx, key, START))).toBe(false);
    // At exactly now + S they still count.
    expect(await a.store.transaction((tx) => requestsFullTx(tx, key, START + 10_000 - 300))).toBe(
      true,
    );
    expect(await deliver(a, await fromKey(a, s))).toMatchObject([{ outcome: 'request' }]);
    expect(await countWhere(a, 'refused', key)).toBe(0);
  });

  it('a sender-chosen createdAt far in the future does not extend a refused row’s life', async () => {
    const a = await agentA();
    const s = await stranger();
    const key = await keyOf(s);
    const env = await fromKey(a, s, { createdAt: START + 50 * REFUSED_RETENTION_SECONDS });
    expect(await deliver(a, env)).toMatchObject([
      { outcome: 'refused', reason: 'future_created_at' },
    ]);
    expect(await rowOf(a, env.id)).toMatchObject({ state: 'refused', refused_at: START });
    clock.t = START + REFUSED_RETENTION_SECONDS;
    expect(await a.store.transaction((tx) => requestsFullTx(tx, key, clock.t))).toBe(false);
    await a.client.envelopes.processReceived();
    expect(await rowOf(a, env.id)).toBeUndefined();
  });

  it('a contact’s refused rows survive ignore, ignore all and pruning', async () => {
    const a = await agentA();
    const b = await makeAgent(clock, new MemoryKeyStore(seed(32)), ownerB, 'bob');
    await pairWith(clock, a, b);
    const bKey = await keyOf(b);
    // B leaves out A's owner entry: a refusal kept as the contact's record (04 §3.1.1 step 8).
    const env = await craft({
      signer: await agentSigner(b.keyStore),
      entries: [
        { pk: await agentEnc(a) },
        { pk: await ownerEnc(ownerB) },
        { pk: await agentEnc(b) },
      ],
      payload: textPayload(),
      createdAt: clock.t,
    });
    expect(await deliver(a, env)).toMatchObject([
      { outcome: 'refused', reason: 'owner_entry_missing', contactId: b.id },
    ]);
    expect(await a.client.requests.ignore(bKey)).toBe(0);
    expect(await a.client.requests.ignoreAll()).toBe(0);
    clock.t = START + 3 * REFUSED_RETENTION_SECONDS;
    await a.client.envelopes.processReceived();
    expect(await rowOf(a, env.id)).toMatchObject({ state: 'refused', contact_id: b.id });
  });
});

describe('Ignore and Ignore all (D-72)', () => {
  it('ignore(key) removes that key’s request and unknown-key refused rows and no other key’s', async () => {
    const a = await agentA();
    const s = await stranger();
    const t = await stranger();
    const sKey = await keyOf(s);
    const tKey = await keyOf(t);
    await requestFrom(a, s);
    await deliver(a, await fromKey(a, s, { withOwnEntry: false }));
    await requestFrom(a, t);
    await deliver(a, await fromKey(a, t, { withOwnEntry: false }));
    expect(await a.client.requests.ignore(sKey)).toBe(2);
    expect(await countWhere(a, 'request', sKey)).toBe(0);
    expect(await countWhere(a, 'refused', sKey)).toBe(0);
    expect(await countWhere(a, 'request', tKey)).toBe(1);
    expect(await countWhere(a, 'refused', tKey)).toBe(1);
    expect(await a.client.requests.ignoreAll()).toBe(2);
    expect(await a.client.requests.count()).toBe(0);
    await noContactWrites(a);
  });
});

describe('Accept (D-72; 04 §2.9)', () => {
  it('sets the flag on one row only, creates no contact or pairing, and still counts', async () => {
    const a = await agentA();
    const s = await stranger();
    const key = await keyOf(s);
    const first = await requestFrom(a, s);
    const second = await requestFrom(a, s);
    clock.t = START + 7;
    expect(await a.client.requests.accept(first)).toBe(true);
    expect(await rowOf(a, first)).toMatchObject({
      state: 'request',
      request_accepted_at: START + 7,
    });
    expect(await rowOf(a, second)).toMatchObject({ request_accepted_at: null });
    await noContactWrites(a);
    expect(await a.client.contacts.list()).toEqual([]);
    const listed = new Map((await a.client.requests.list()).map((r) => [r.envelopeId, r]));
    expect(listed.get(first)?.acceptedAt).toBe(START + 7);
    expect(listed.get(second)?.acceptedAt).toBeNull();
    // The accepted row keeps counting toward the per-key limit.
    for (let i = 2; i < MAX_REQUESTS_PER_SENDER; i += 1) await requestFrom(a, s);
    expect(await deliver(a, await fromKey(a, s))).toMatchObject([
      { outcome: 'dropped', reason: 'requests_full' },
    ]);
    // A later envelope from the key is a new, unaccepted request.
    await a.client.requests.ignore(key);
    const later = await requestFrom(a, s);
    expect(await rowOf(a, later)).toMatchObject({ request_accepted_at: null });
  });

  it('accepts nothing but a queued request', async () => {
    const a = await agentA();
    const s = await stranger();
    const refused = await fromKey(a, s, { withOwnEntry: false });
    await deliver(a, refused);
    expect(await a.client.requests.accept(refused.id)).toBe(false);
    expect(await a.client.requests.accept(encodeBase64url(randomBytes(16)))).toBe(false);
    expect(await a.client.requests.accept('')).toBe(false);
    expect(await rowOf(a, refused.id)).toMatchObject({ request_accepted_at: null });
  });
});

describe('Block and Unblock (D-72; 04 §3.1.1 step 5)', () => {
  it('removes the key’s request, refused and held rows in one transaction and no other key’s', async () => {
    const a = await agentA();
    const b = await makeAgent(clock, new MemoryKeyStore(seed(33)), ownerB, 'bob');
    await pairWith(clock, a, b);
    const s = await stranger();
    const t = await stranger();
    const key = await keyOf(s);
    const request = await requestFrom(a, s);
    await deliver(a, await fromKey(a, s, { withOwnEntry: false }));
    const held = await fromKey(a, s, { extraKid: await ownerEnc(ownerB) });
    expect(await deliver(a, held)).toMatchObject([{ outcome: 'held' }]);
    const other = await requestFrom(a, t);
    expect(await a.client.requests.block(request)).toEqual({ status: 'blocked', removed: 3 });
    expect(await countWhere(a, 'request', key)).toBe(0);
    expect(await countWhere(a, 'refused', key)).toBe(0);
    expect(await heldOf(a, held.id)).toBeUndefined();
    expect(await rowOf(a, other)).toMatchObject({ state: 'request' });
    expect(await a.client.requests.listBlocked()).toEqual([
      { fromKey: key, blockedAt: START, viaEnvelopeId: request },
    ]);
    expect(await a.store.transaction((tx) => tx.count('contacts'))).toBe(1);
  });

  it('a later envelope from the key is dropped with no unwrapCek and no row besides its seen row', async () => {
    const a = await agentA();
    const s = await stranger();
    await a.client.requests.block(await requestFrom(a, s));
    const spy = spyUnwrap(a);
    const env = await fromKey(a, s);
    const seenBefore = await a.store.transaction((tx) => tx.count('seen'));
    expect(await deliver(a, env)).toEqual([
      { envelopeId: env.id, outcome: 'dropped', reason: 'sender_blocked', flagged: false },
    ]);
    expect(spy).not.toHaveBeenCalled();
    expect(await rowOf(a, env.id)).toBeUndefined();
    expect(await heldOf(a, env.id)).toBeUndefined();
    expect(await a.store.transaction((tx) => tx.count('seen'))).toBeGreaterThan(seenBefore);
  });

  it('a held envelope from the blocked key is dropped when due and never reaches the requests queue', async () => {
    const a = await agentA();
    const b = await makeAgent(clock, new MemoryKeyStore(seed(34)), ownerB, 'bob');
    await pairWith(clock, a, b);
    const s = await stranger();
    await a.client.requests.block(await requestFrom(a, s));
    // It names a contact owner's kid: the step 5 drop is skipped on its first run, and step 7 holds.
    const env = await fromKey(a, s, { extraKid: await ownerEnc(ownerB) });
    expect(await deliver(a, env)).toMatchObject([{ envelopeId: env.id, outcome: 'held' }]);
    clock.t = START + HOLD_SECONDS - 1;
    expect(await a.client.envelopes.processReceived()).toEqual([]);
    clock.t = START + HOLD_SECONDS;
    const spy = spyUnwrap(a);
    expect(await a.client.envelopes.processReceived()).toEqual([
      { envelopeId: env.id, outcome: 'dropped', reason: 'sender_blocked', flagged: false },
    ]);
    expect(spy).not.toHaveBeenCalled();
    expect(await heldOf(a, env.id)).toBeUndefined();
    expect(await rowOf(a, env.id)).toBeUndefined();
    expect(await a.client.requests.count()).toBe(0);
  });

  it('after unblock a new envelope is a request again, and nothing removed comes back', async () => {
    const a = await agentA();
    const s = await stranger();
    const key = await keyOf(s);
    const request = await requestFrom(a, s);
    await a.client.requests.block(request);
    await deliver(a, await fromKey(a, s));
    expect(await a.client.requests.unblock(key)).toBe(true);
    expect(await a.client.requests.unblock(key)).toBe(false);
    expect(await a.client.requests.listBlocked()).toEqual([]);
    expect(await rowOf(a, request)).toBeUndefined();
    const next = await fromKey(a, s);
    expect(await deliver(a, next)).toMatchObject([{ envelopeId: next.id, outcome: 'request' }]);
    expect(await a.client.requests.count()).toBe(1);
  });

  it('two blocked keys whose requests had the same envelope id unblock separately (F03)', async () => {
    const a = await agentA();
    const s = await stranger();
    const t = await stranger();
    const id = encodeBase64url(randomBytes(16));
    const fromS = await fromKey(a, s, { id });
    expect(await deliver(a, fromS)).toMatchObject([{ outcome: 'request' }]);
    await a.client.requests.block(id);
    // The row is gone, so another key can reuse the id.
    const fromT = await fromKey(a, t, { id });
    expect(await deliver(a, fromT)).toMatchObject([{ outcome: 'request' }]);
    await a.client.requests.block(id);
    const blocked = await a.client.requests.listBlocked();
    expect(blocked.map((b) => b.viaEnvelopeId)).toEqual([id, id]);
    expect(await a.client.requests.unblock(await keyOf(s))).toBe(true);
    expect(await a.client.requests.listBlocked()).toEqual([
      { fromKey: await keyOf(t), blockedAt: START, viaEnvelopeId: id },
    ]);
  });

  it('a forged envelope that names a blocked key in from fails step 4 and is not counted as the key’s', async () => {
    const a = await agentA();
    const s = await stranger();
    const m = await stranger();
    await a.client.requests.block(await requestFrom(a, s));
    const mSigner = await agentSigner(m.keyStore);
    const forged = await fromKey(a, {
      signer: { from: await keyOf(s), sign: mSigner.sign },
      enc: await agentEnc(m),
    });
    const seenBefore = await a.store.transaction((tx) => tx.count('seen'));
    const received = await a.client.envelopes.receive({
      envelope: forged,
      giftWrapId: giftWrapId(),
    });
    expect(received).toMatchObject({
      status: 'processed',
      report: { outcome: 'dropped', reason: 'invalid' },
    });
    expect(await a.store.transaction((tx) => tx.count('seen'))).toBe(seenBefore);
    expect(await rowOf(a, forged.id)).toBeUndefined();
  });

  it('block refuses anything but a queued request, and never writes a contact', async () => {
    const a = await agentA();
    const s = await stranger();
    const refused = await fromKey(a, s, { withOwnEntry: false });
    await deliver(a, refused);
    expect(await a.client.requests.block(refused.id)).toEqual({ status: 'request_not_found' });
    expect(await a.client.requests.block('')).toEqual({ status: 'request_not_found' });
    expect(await a.client.requests.listBlocked()).toEqual([]);
    expect(await a.client.requests.unblock('not-a-key')).toBe(false);
    await noContactWrites(a);
  });
});

describe('pairing through a block (D-72; IR-D-72-1 F10)', () => {
  it('a handshake from a blocked key is dropped before any open and completes no pairing', async () => {
    const a = await agentA();
    const s = await stranger();
    await a.client.requests.block(await requestFrom(a, s));
    const invite = await a.client.pairing.createInvite();
    const accepted = await s.client.pairing.acceptInvite({ link: invite.inviteUrl, allowed: true });
    if (accepted.status !== 'pending') throw new Error('test: not accepted');
    const spy = spyUnwrap(a);
    expect(await deliver(a, accepted.handshake.envelope)).toMatchObject([
      { outcome: 'dropped', reason: 'sender_blocked' },
    ]);
    expect(spy).not.toHaveBeenCalled();
    await noContactWrites(a);
    expect(await a.store.transaction((tx) => tx.count('envelopes', { direction: 'out' }))).toBe(0);
  });

  it('one whose recipients carry a contact owner’s kid is dropped after step 6', async () => {
    const a = await agentA();
    const s = await stranger(ownerS);
    // Blocked before A has a contact with S's owner, so the request is not held.
    await a.client.requests.block(await requestFrom(a, s));
    const c = await makeAgent(clock, new MemoryKeyStore(seed(35)), ownerS, 'carol');
    await pairWith(clock, a, c);
    const invite = await a.client.pairing.createInvite();
    const accepted = await s.client.pairing.acceptInvite({ link: invite.inviteUrl, allowed: true });
    if (accepted.status !== 'pending') throw new Error('test: not accepted');
    const pairingsBefore = await a.store.transaction((tx) => tx.select('pairings'));
    const outBefore = await a.store.transaction((tx) =>
      tx.count('envelopes', { direction: 'out' }),
    );
    const spy = spyUnwrap(a);
    expect(await deliver(a, accepted.handshake.envelope)).toMatchObject([
      { outcome: 'dropped', reason: 'sender_blocked' },
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await a.store.transaction((tx) => tx.count('contacts'))).toBe(1);
    expect(await a.store.transaction((tx) => tx.select('pairings'))).toEqual(pairingsBefore);
    const used = await a.store.transaction((tx) => tx.count('invites', { used_at: { gte: 0 } }));
    expect(used).toBe(0);
    expect(await a.store.transaction((tx) => tx.count('envelopes', { direction: 'out' }))).toBe(
      outBefore,
    );
  });

  it('a non-card-update envelope that skipped the drop and that step 7 does not hold is dropped', async () => {
    const a = await agentA();
    const s = await stranger(ownerS);
    await a.client.requests.block(await requestFrom(a, s));
    const c = await makeAgent(clock, new MemoryKeyStore(seed(36)), ownerS, 'carol');
    await pairWith(clock, a, c);
    // The only contact under that owner kid is blocked: step 7 does not hold it.
    await a.store.transaction((tx) =>
      tx.update('contacts', { contact_id: c.id }, { status: 'blocked' }),
    );
    const env = await fromKey(a, s, { extraKid: await ownerEnc(ownerS) });
    expect(await deliver(a, env)).toEqual([
      { envelopeId: env.id, outcome: 'dropped', reason: 'sender_blocked', flagged: false },
    ]);
    expect(await rowOf(a, env.id)).toBeUndefined();
    expect(await heldOf(a, env.id)).toBeUndefined();
  });
});

describe('a contact’s rotation through a block (IR-D-72-1 F01)', () => {
  it('a card-update from the blocked new epoch key is applied and removes the block', async () => {
    const a = await agentA();
    const b = await makeAgent(clock, new MemoryKeyStore(seed(37)), ownerB, 'bob');
    await pairWith(clock, a, b);
    await pairWith(clock, b, a);
    await rotate(b);
    const newKey = await keyOf(b);
    // B's first envelope under the new key is held, then released into the requests queue.
    const early = await b.client.envelopes.build({ to: { contact: a.id }, payload: textPayload() });
    expect(await deliver(a, early.envelope)).toMatchObject([{ outcome: 'held' }]);
    clock.t = START + HOLD_SECONDS;
    expect(await a.client.envelopes.processReceived()).toMatchObject([
      { envelopeId: early.envelope.id, outcome: 'request' },
    ]);
    // The owner blocks that key.
    expect(await a.client.requests.block(early.envelope.id)).toEqual({
      status: 'blocked',
      removed: 1,
    });
    // B's card-update from the new key (it carries B's owner kid, so the drop is skipped).
    const update = await b.client.envelopes.build({
      to: { contact: a.id },
      payload: await cardUpdatePayload(b),
    });
    expect(await deliver(a, update.envelope)).toEqual([
      { envelopeId: update.envelope.id, outcome: 'ok', contactId: b.id, flagged: false },
    ]);
    expect(await a.client.requests.listBlocked()).toEqual([]);
    const contact = await a.store.transaction((tx) => tx.get('contacts', { contact_id: b.id }));
    expect(contact).toMatchObject({ agent_nostr: newKey, key_epoch: 1 });
    // From then on B's envelopes are the contact's.
    const later = await b.client.envelopes.build({ to: { contact: a.id }, payload: textPayload() });
    expect(await deliver(a, later.envelope)).toEqual([
      { envelopeId: later.envelope.id, outcome: 'ok', contactId: b.id, flagged: false },
    ]);
  });

  it('a blocked key’s envelope held for a contact owner kid but never claimed is dropped when due', async () => {
    const a = await agentA();
    const b = await makeAgent(clock, new MemoryKeyStore(seed(38)), ownerB, 'bob');
    await pairWith(clock, a, b);
    const s = await stranger();
    await a.client.requests.block(await requestFrom(a, s));
    const env = await fromKey(a, s, { extraKid: await ownerEnc(ownerB) });
    expect(await deliver(a, env)).toMatchObject([{ outcome: 'held' }]);
    // A card-update from B (the contact) does not claim it.
    await rotate(b);
    await pairWith(clock, b, a);
    const update = await b.client.envelopes.build({
      to: { contact: a.id },
      payload: await cardUpdatePayload(b),
    });
    expect(await deliver(a, update.envelope)).toMatchObject([{ outcome: 'ok' }]);
    expect(await heldOf(a, env.id)).toBeDefined();
    clock.t = START + HOLD_SECONDS;
    expect(await a.client.envelopes.processReceived()).toEqual([
      { envelopeId: env.id, outcome: 'dropped', reason: 'sender_blocked', flagged: false },
    ]);
    expect(await a.client.requests.count()).toBe(0);
  });
});
