// M1-7k: the send pipeline (07 §2 `sendMessage`, §3.2 `outbox`, §3.3, §4.1, §4.2, §4.3; 03 §4.1;
// 04 §3.1, §3.2, §3.5; 06 §1 rules 3 and 6, §2.2; D-70). A relay spy stands in for the RelayPool:
// the wraps are real NIP-59 gift wraps (transport-nostr's wrapEnvelope), only publishing is faked.
import {
  encodeHex,
  type EnvelopeKeys,
  type JsonObject,
  type KeyStore,
  type NostrEvent,
} from '@agentlink/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@agentlink/crypto/testing';
import { createLogger } from '@agentlink/log';
import { defaultPolicy } from '@agentlink/types';
import { unwrapGiftWrap, wrapEnvelope, type PublishOutcome } from '@agentlink/transport-nostr';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { CoreError } from './errors.js';
import { OUTBOX_CLAIM_SECONDS } from './outbox.js';
import { MemoryStore } from './store/memory-store.js';
import type { StoreTx } from './store/store.js';
import {
  FakeClock,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import { pairWith, type TestAgent, type TestOwner } from './testing/envelopes.js';
import { sleep } from './testing/platform.js';
import { MemoryPolicyMark, newNonce, ownerHex, signWith } from './testing/owner.js';
import type { TransportFactory } from './transport.js';

const RELAYS_A = Object.freeze([
  'wss://one.relay-alpha.net',
  'wss://two.relay-alpha.net',
  'wss://shared.relay-common.net',
]);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);
const RELAYS_C = Object.freeze(['wss://one.relay-gamma.net', 'wss://shared.relay-common.net']);

let clock: FakeClock;

/** A relay spy: records every publish; acks all relays, none, or never answers. */
class RelaySpy {
  readonly published: { event: NostrEvent; relays: string[] }[] = [];
  mode: 'ack' | 'none' | 'hang' = 'ack';
  readonly factory: TransportFactory = (deps) => ({
    wrap: (envelope, recipients, keys) =>
      wrapEnvelope(envelope, recipients, keys, { now: deps.now }),
    publish: (event, relays) => {
      this.published.push({ event, relays: [...relays] });
      if (this.mode === 'hang') return new Promise<PublishOutcome>(() => {});
      const acked = this.mode === 'ack' ? [...relays] : [];
      return Promise.resolve({
        results: relays.map((relay) => ({
          relay,
          ok: this.mode === 'ack',
          reason: this.mode === 'ack' ? ('ok' as const) : ('rejected' as const),
        })),
        acked,
        sent: acked.length >= 2,
      } as PublishOutcome);
    },
  });
  get ids(): string[] {
    return this.published.map((p) => p.event.id);
  }
  recipients(): string[] {
    return this.published.map((p) => pTag(p.event));
  }
}

const pTag = (event: NostrEvent): string =>
  (event.tags.find((t) => t[0] === 'p') as string[])[1] as string;

interface Agent extends TestAgent {
  readonly relays: readonly string[];
  readonly spy: RelaySpy;
  readonly mark: MemoryPolicyMark | undefined;
}

interface AgentOptions {
  readonly store?: MemoryStore;
  readonly spy?: RelaySpy;
  readonly mark?: MemoryPolicyMark;
  readonly lines?: string[];
  readonly transport?: false;
  readonly init?: false;
}

async function openAgent(
  n: number,
  owner: TestOwner,
  name: string,
  relays: readonly string[],
  options: AgentOptions = {},
): Promise<Agent> {
  const store = options.store ?? new MemoryStore();
  const cipher = new TestStoreCipher();
  const keyStore: KeyStore = new MemoryKeyStore(seed(n));
  const spy = options.spy ?? new RelaySpy();
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    ...(options.transport === false ? {} : { transport: spy.factory }),
    ...(options.mark === undefined ? {} : { policyMark: options.mark }),
    ...(options.lines === undefined
      ? {}
      : {
          logger: createLogger({
            name: 'core',
            level: 'debug',
            sink: (_l, line) => options.lines?.push(line),
          }),
        }),
  });
  if (options.init !== false) {
    await client.identity.init({
      owner: await owner.unlock(passphrase()),
      ownerKeys: await owner.getPublicKeys(),
      name,
      relays,
    });
  }
  return {
    client,
    store,
    cipher,
    keyStore,
    owner,
    id: client.agentId,
    relays,
    spy,
    mark: options.mark,
  };
}

const ownerA = new MemoryOwnerKeyStore(seed(201), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(202), passphrase());

async function nostrOf(keyStore: KeyStore): Promise<string> {
  return encodeHex((await keyStore.getPublicBundle()).agentNostr);
}

async function pair(a: Agent, b: Agent): Promise<void> {
  await pairWith(clock, a, b);
  await pairWith(clock, b, a);
}

const rows = (store: MemoryStore) =>
  store.transaction((tx) => ({
    // Without the pairing evidence rows that pairWith stores (testing/pairing.ts).
    out: tx
      .select('envelopes', { direction: 'out' })
      .filter((r) => r.type !== 'handshake' && r.type !== 'handshake-ack'),
    outbox: tx.select('outbox'),
    idempotency: tx.select('idempotency'),
  }));

/** Waits until `check` holds (a hanging publish leaves work in flight). */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) {
    await sleep(0);
  }
  expect(check()).toBe(true);
}

beforeEach(() => {
  clock = new FakeClock();
});

describe('sendMessage: recipients and relays (04 §3.2, §3.5; 07 §4.1, §4.3)', () => {
  it('publishes one wrap per distinct recipient key, exactly the 04 §3.2 set, each to the list of the agent it concerns', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);

    const result = await a.client.sendMessage({ to: b.id, text: 'hello bob' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.envelopeId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(result.thread).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(result.sentAt).toBe(new Date(clock.t * 1000).toISOString().replace('.000Z', 'Z'));

    const bAgent = await nostrOf(b.keyStore);
    const aAgent = await nostrOf(a.keyStore);
    const bOwner = await ownerHex(ownerB);
    const aOwner = await ownerHex(ownerA);
    const relaysFor = new Map(a.spy.published.map((p) => [pTag(p.event), p.relays]));
    expect(a.spy.published).toHaveLength(4);
    expect(new Set(a.spy.recipients())).toEqual(new Set([bAgent, bOwner, aOwner, aAgent]));
    expect(relaysFor.get(bAgent)).toEqual([...RELAYS_B]);
    expect(relaysFor.get(bOwner)).toEqual([...RELAYS_B]);
    expect(relaysFor.get(aOwner)).toEqual([...RELAYS_A]);
    expect(relaysFor.get(aAgent)).toEqual([...RELAYS_A]);
    for (const p of a.spy.published) expect(p.event.kind).toBe(1059);

    // The contact's agent can open its wrap: it carries the stored envelope.
    const forB = a.spy.published.find((p) => pTag(p.event) === bAgent);
    const opened = await unwrapGiftWrap(forB?.event, b.keyStore as EnvelopeKeys);
    expect(opened.envelope.id).toBe(result.envelopeId);

    const stored = await rows(a.store);
    expect(stored.out).toHaveLength(1);
    expect(stored.out[0]).toMatchObject({
      envelope_id: result.envelopeId,
      contact_id: b.id,
      type: 'text',
      delivery: 'sent',
    });
    expect(stored.outbox).toHaveLength(4);
    const roles = new Map(stored.outbox.map((r) => [r.recipient_key, r.role]));
    expect(roles.get(bAgent)).toBe('contact');
    expect(roles.get(bOwner)).toBe('owner');
    expect(roles.get(aOwner)).toBe('owner');
    for (const r of stored.outbox) {
      expect(r).toMatchObject({ state: 'sent', wrap_json: null, attempt: 1, reason: null });
      expect(a.spy.ids).toContain(r.wrap_id);
    }
  });

  it('sends one wrap to the union of both lists when one owner owns both agents', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const c = await openAgent(3, ownerA, 'carol', RELAYS_C);
    await pair(a, c);
    await a.client.sendMessage({ to: c.id, text: 'hi' });
    const aOwner = await ownerHex(ownerA);
    expect(a.spy.published).toHaveLength(3);
    const ownerWrap = a.spy.published.find((p) => pTag(p.event) === aOwner);
    expect(new Set(ownerWrap?.relays)).toEqual(new Set([...RELAYS_C, ...RELAYS_A]));
    expect(ownerWrap?.relays).toHaveLength(4);
  });

  it('publishes and stores nothing when the policy denies the contact', async () => {
    const mark = new MemoryPolicyMark();
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A, { mark });
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    const policy = defaultPolicy();
    (policy.contacts as { allowed: unknown }).allowed = [
      '0x00000000000000000000000000000000000000aa',
    ];
    const signed = await signWith(ownerA, {
      v: 1,
      agent: a.id,
      owner: await ownerHex(ownerA),
      op: 'policy.set',
      params: { version: 1, policy: policy as unknown as JsonObject },
      nonce: newNonce(),
      issuedAt: clock.t,
      expiresAt: clock.t + 600,
    });
    expect(await a.client.ownerActions.apply(JSON.stringify(signed))).toMatchObject({
      status: 'applied',
    });

    expect(await a.client.sendMessage({ to: b.id, text: 'hello' })).toEqual({
      status: 'rejected',
      code: 'POLICY_DENIED',
    });
    expect(a.spy.published).toHaveLength(0);
    const stored = await rows(a.store);
    expect(stored.out).toHaveLength(0);
    expect(stored.outbox).toHaveLength(0);
  });

  it('lets a paired contact Talk while the policy fails closed (D-70)', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A); // no mark: the policy fails closed
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    expect((await a.client.ownerActions.loadPolicy()).mode).toBe('fail_closed');
    expect((await a.client.sendMessage({ to: b.id, text: 'hello' })).status).toBe('ok');
    expect(a.spy.published).toHaveLength(4);
  });

  it('publishes and stores nothing when the agent cannot send', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    await a.store.transaction((tx) => tx.update('identity', {}, { revoked_at: clock.t }));
    await expect(a.client.sendMessage({ to: b.id, text: 'hello' })).rejects.toMatchObject({
      code: 'identity_revoked',
    });
    expect(a.spy.published).toHaveLength(0);
    expect((await rows(a.store)).out).toHaveLength(0);
  });

  it('publishes and stores nothing to a blocked contact', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    await a.client.contacts.block(b.id);
    await expect(a.client.sendMessage({ to: b.id, text: 'hello' })).rejects.toBeInstanceOf(
      CoreError,
    );
    expect(a.spy.published).toHaveLength(0);
    expect((await rows(a.store)).outbox).toHaveLength(0);
  });

  it('refuses to send without a transport, before anything is stored', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A, { transport: false });
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    await expect(a.client.sendMessage({ to: b.id, text: 'hello' })).rejects.toMatchObject({
      code: 'transport_unavailable',
    });
    expect((await rows(a.store)).out).toHaveLength(0);
  });
});

describe('sendMessage: input (06 §2.2)', () => {
  it('returns USE_TERMS_TOOLS for a body with a terms key and stores nothing', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    for (const clientRequestId of [undefined, 'req-terms']) {
      expect(
        await a.client.sendMessage({
          to: b.id,
          type: 'request',
          body: { terms: { price: '1' } },
          ...(clientRequestId === undefined ? {} : { clientRequestId }),
        }),
      ).toEqual({ status: 'rejected', code: 'USE_TERMS_TOOLS' });
    }
    expect(a.spy.published).toHaveLength(0);
    const stored = await rows(a.store);
    expect(stored.out).toHaveLength(0);
    expect(stored.outbox).toHaveLength(0);
    expect(stored.idempotency).toHaveLength(0);
  });

  it('sends a JSON body with its type and keeps replyTo in the thread', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    const first = await a.client.sendMessage({ to: b.id, type: 'note', body: { k: 'v' } });
    if (first.status !== 'ok') throw new Error('expected ok');
    const reply = await a.client.sendMessage({
      to: b.id,
      type: 'request',
      text: 'and?',
      replyTo: first.envelopeId,
    });
    if (reply.status !== 'ok') throw new Error('expected ok');
    expect(reply.thread).toBe(first.thread);
    const types = (await rows(a.store)).out.map((r) => r.type).sort();
    expect(types).toEqual(['note', 'request']);
  });

  it('refuses a type the send tool does not accept, and a message with neither text nor body', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    await expect(
      a.client.sendMessage({ to: b.id, type: 'offer' as 'text', text: 'x' }),
    ).rejects.toMatchObject({ code: 'type_not_sendable' });
    await expect(a.client.sendMessage({ to: b.id })).rejects.toMatchObject({
      code: 'payload_invalid',
    });
    expect(a.spy.published).toHaveLength(0);
  });
});

describe('sendMessage: clientRequestId (06 §1 rule 6, 07 §3.3)', () => {
  it('returns the identical result for a repeat and publishes nothing again', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    const input = { to: b.id, text: 'once', clientRequestId: 'req-1' };
    const first = await a.client.sendMessage(input);
    expect(first.status).toBe('ok');
    const published = a.spy.published.length;
    clock.t += 5;
    const again = await a.client.sendMessage(input);
    expect(again).toEqual(first);
    expect(a.spy.published).toHaveLength(published);
    expect((await rows(a.store)).out).toHaveLength(1);
  });

  it('rejects a different request under the same key with IDEMPOTENCY_KEY_REUSED', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    await a.client.sendMessage({ to: b.id, text: 'once', clientRequestId: 'req-2' });
    const published = a.spy.published.length;
    expect(
      await a.client.sendMessage({ to: b.id, text: 'twice', clientRequestId: 'req-2' }),
    ).toEqual({ status: 'rejected', code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(a.spy.published).toHaveLength(published);
    expect((await rows(a.store)).out).toHaveLength(1);
  });
});

/** A MemoryStore whose transactions throw on an `outbox` insert. */
class OutboxFailingStore extends MemoryStore {
  override transaction<R>(body: (tx: StoreTx) => R): Promise<R> {
    return super.transaction((tx) =>
      body(
        new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop === 'insert') {
              return (table: string, row: unknown) => {
                if (table === 'outbox') throw new Error('disk full');
                return (target.insert as (t: string, r: unknown) => void)(table, row);
              };
            }
            const value = Reflect.get(target, prop, receiver) as unknown;
            return typeof value === 'function'
              ? (value as (...args: unknown[]) => unknown).bind(target)
              : value;
          },
        }),
      ),
    );
  }
}

describe('sendMessage: store before publish (07 §3.2 "Transaction", "On failure")', () => {
  it('stores the envelope and every outbox row before the first publish', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    const seenAtPublish: number[] = [];
    const real = a.spy.factory;
    const store = a.store;
    // A second client over the same store whose spy reads the store at its first publish.
    const spy = new RelaySpy();
    const watching: TransportFactory = (deps) => {
      const inner = real(deps);
      return {
        wrap: inner.wrap,
        publish: async (event, relays) => {
          seenAtPublish.push(await store.transaction((tx) => tx.count('outbox')));
          return spy.factory(deps).publish(event, relays);
        },
      };
    };
    const client = await AgentLinkClient.create({
      keyStore: a.keyStore,
      store,
      cipher: a.cipher,
      approvals: new RecordingApprovalChannel(),
      clock: clock.now,
      transport: watching,
    });
    await client.sendMessage({ to: b.id, text: 'hello' });
    expect(seenAtPublish.length).toBe(4);
    expect(seenAtPublish.every((n) => n === 4)).toBe(true);
  });

  it('publishes nothing and keeps no envelope when the outbox write fails', async () => {
    const store = new OutboxFailingStore();
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A, { store });
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    await expect(a.client.sendMessage({ to: b.id, text: 'hello' })).rejects.toThrow();
    expect(a.spy.published).toHaveLength(0);
    expect((await rows(store)).out).toHaveLength(0);
  });

  it('keeps rows pending through a relay outage and later republishes the same stored wraps', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    a.spy.mode = 'none';
    const result = await a.client.sendMessage({ to: b.id, text: 'hello' });
    expect(result.status).toBe('ok');
    const firstIds = [...a.spy.ids].sort();
    let stored = await rows(a.store);
    expect(stored.out[0]?.delivery).toBe('queued');
    expect(stored.outbox.every((r) => r.state === 'pending' && r.wrap_json !== null)).toBe(true);

    a.spy.mode = 'ack';
    expect((await a.client.outbox.processDue()).sent).toBe(0); // backing off: nothing due yet
    clock.t += 30;
    const summary = await a.client.outbox.processDue();
    expect(summary.sent).toBe(4);
    expect([...a.spy.ids.slice(4)].sort()).toEqual(firstIds);
    stored = await rows(a.store);
    expect(stored.out[0]?.delivery).toBe('sent');
  });
});

describe('outbox: one publisher per pending row (07 §3.2; M1-9 plan finding 4)', () => {
  it('two clients over one store: only one republishes a row, and the other takes over within one retry interval', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    a.spy.mode = 'none';
    await a.client.sendMessage({ to: b.id, text: 'hello' });
    clock.t += 30;

    const spy1 = new RelaySpy();
    spy1.mode = 'hang'; // this process stalls (or dies) mid-publish
    const spy2 = new RelaySpy();
    const open = (spy: RelaySpy) =>
      AgentLinkClient.create({
        keyStore: a.keyStore,
        store: a.store,
        cipher: a.cipher,
        approvals: new RecordingApprovalChannel(),
        clock: clock.now,
        transport: spy.factory,
      });
    const one = await open(spy1);
    const two = await open(spy2);

    void one.outbox.processDue();
    await until(() => spy1.published.length === 4);
    expect((await two.outbox.processDue()).sent).toBe(0);
    expect(spy2.published).toHaveLength(0);

    expect(OUTBOX_CLAIM_SECONDS).toBeLessThanOrEqual(30); // the first retry interval (07 §4.2)
    clock.t += OUTBOX_CLAIM_SECONDS;
    expect((await two.outbox.processDue()).sent).toBe(4);
    expect([...spy2.ids].sort()).toEqual([...spy1.ids].sort());
  });
});

describe('outbox: staged pairing messages (04 §3.6; M1-7c)', () => {
  it('publishes a staged handshake once through the outbox, and it survives a restart', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    const invite = await a.client.pairing.createInvite();
    const accepted = await b.client.pairing.acceptInvite({
      link: invite.inviteUrl,
      allowed: true,
    });
    if (accepted.status !== 'pending') throw new Error('expected a staged pairing');

    b.spy.mode = 'none';
    await b.client.outbox.processDue();
    expect(b.spy.published).toHaveLength(4);
    const aAgent = await nostrOf(a.keyStore);
    const aOwner = await ownerHex(ownerA);
    const relaysFor = new Map(b.spy.published.map((p) => [pTag(p.event), p.relays]));
    expect(relaysFor.get(aAgent)).toEqual([...RELAYS_A]);
    expect(relaysFor.get(aOwner)).toEqual([...RELAYS_A]);
    let stored = await rows(b.store);
    expect(stored.outbox).toHaveLength(4);
    expect(stored.outbox.every((r) => r.envelope_id === accepted.pairingId)).toBe(true);
    const ids = [...b.spy.ids].sort();

    // Restart: a new client over the same store finds the pending rows and republishes them.
    const spy = new RelaySpy();
    const restarted = await AgentLinkClient.create({
      keyStore: new MemoryKeyStore(seed(2)),
      store: b.store,
      cipher: b.cipher,
      approvals: new RecordingApprovalChannel(),
      clock: clock.now,
      transport: spy.factory,
    });
    clock.t += 30;
    expect((await restarted.outbox.processDue()).sent).toBe(4);
    expect([...spy.ids].sort()).toEqual(ids);
    clock.t += 3_600;
    await restarted.outbox.processDue();
    expect(spy.published).toHaveLength(4); // once: nothing is wrapped or published again
    stored = await rows(b.store);
    expect(stored.outbox).toHaveLength(4);
    const handshake = await b.store.transaction((tx) =>
      tx.get('envelopes', { envelope_id: accepted.pairingId }),
    );
    expect(handshake?.delivery).toBe('sent');

    // The inviter answers through the same path: its handshake-ack goes to the invitee's list.
    const forA = b.spy.published.find((p) => pTag(p.event) === aAgent);
    const opened = await unwrapGiftWrap(forA?.event, a.keyStore as EnvelopeKeys);
    await a.client.envelopes.receive({ envelope: opened.envelope, giftWrapId: opened.giftWrapId });
    await a.client.envelopes.processReceived();
    await a.client.outbox.processDue();
    const bAgent = await nostrOf(b.keyStore);
    const ackRelays = new Map(a.spy.published.map((p) => [pTag(p.event), p.relays]));
    expect(a.spy.published).toHaveLength(4);
    expect(ackRelays.get(bAgent)).toEqual([...RELAYS_B]);
  });
});

describe('logs (I-7)', () => {
  it('carry counts only: no relay URL, message text, key or envelope id', async () => {
    const lines: string[] = [];
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A, { lines });
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    lines.length = 0;
    a.spy.mode = 'none';
    const result = await a.client.sendMessage({ to: b.id, text: 'secret words here' });
    clock.t += 30;
    a.spy.mode = 'ack';
    await a.client.outbox.processDue();
    if (result.status !== 'ok') throw new Error('expected ok');
    const text = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const needle of [
      'secret words',
      'relay-alpha',
      'relay-beta',
      result.envelopeId,
      b.id.slice(2),
      await nostrOf(b.keyStore),
      ...a.spy.ids,
    ]) {
      expect(text).not.toContain(needle);
    }
  });
});
