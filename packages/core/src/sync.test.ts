// M1-7h: inbox sync, delivery acknowledgements and the fetch-only catch-up (07 §2 `syncInbox`,
// §3.2 `seen`, `sync_cursors`, `rate_counters`, §4.2 "Sync", §4.3; 04 §3.1.1; 06 §2.0, §2.1, §4, §6;
// 02 F-21, F-23, F-65; D-73).
//
// The real transport runs end to end: nostrTransport's RelayPool and transport-nostr's SyncEngine
// (cursor, paging, dedup by gift-wrap id) over an in-memory relay network that speaks the NIP-01
// frames they use (EVENT/OK, REQ/EVENT/EOSE, CLOSE). Wraps are real NIP-59 gift wraps. Every key is
// derived at runtime from fixed test seeds.
import {
  encodeHex,
  type Envelope,
  type JsonObject,
  type KeyStore,
  type NostrEvent,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import { POLICY_DEFAULTS } from '@4thtech-io/types';
import {
  wrapEnvelope,
  type RelayConnector,
  type RelaySocket,
  type RelaySocketHandlers,
  type RelayTarget,
} from '@4thtech-io/transport-nostr';
import { beforeEach, describe, expect, it } from 'vitest';
import { ACK_KIND_RECEIVED } from './acks.js';
import { AgentLinkClient } from './client.js';
import { CoreError } from './errors.js';
import { MemoryStore } from './store/memory-store.js';
import { StoreSyncPersistence } from './sync.js';
import {
  FakeClock,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import {
  agentEnc,
  agentSigner,
  cardUpdatePayload,
  craft,
  ownerEnc,
  ownerSigner,
  pairWith,
  rotate,
  textPayload,
} from './testing/envelopes.js';
import type { TestAgent, TestOwner } from './testing/envelopes.js';
import { newNonce, ownerHex, signWith } from './testing/owner.js';
import { nostrTransport } from './transport.js';

const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);
const RELAYS_C = Object.freeze(['wss://one.relay-gamma.net', 'wss://two.relay-gamma.net']);

let clock: FakeClock;

// --- An in-memory relay network (NIP-01 as far as RelayPool and SyncEngine use it) -------------

interface Filter {
  kinds?: number[];
  '#p'?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

class RelayNetwork implements RelayConnector {
  /** relay URL → stored events, in arrival order. */
  readonly stored = new Map<string, NostrEvent[]>();
  /** REQ filters seen, by relay. */
  readonly reqs: { relay: string; filter: Filter }[] = [];

  inject(relay: string, event: NostrEvent): void {
    const list = this.stored.get(relay) ?? [];
    if (!list.some((e) => e.id === event.id)) list.push(event);
    this.stored.set(relay, list);
  }

  open(target: RelayTarget, handlers: RelaySocketHandlers): RelaySocket {
    let closed = false;
    const push = (frame: unknown): void => {
      void Promise.resolve().then(() => {
        if (!closed) handlers.onMessage(JSON.stringify(frame));
      });
    };
    void Promise.resolve().then(() => handlers.onOpen());
    return {
      send: (text: string) => {
        const frame = JSON.parse(text) as unknown[];
        if (frame[0] === 'EVENT') {
          const event = frame[1] as NostrEvent;
          this.inject(target.url, event);
          push(['OK', event.id, true, '']);
        } else if (frame[0] === 'REQ') {
          const subId = frame[1] as string;
          const filter = frame[2] as Filter;
          this.reqs.push({ relay: target.url, filter });
          let events = (this.stored.get(target.url) ?? []).filter((e) => matches(filter, e));
          events = events
            .sort((x, y) => y.created_at - x.created_at)
            .slice(0, filter.limit ?? events.length);
          for (const e of events) push(['EVENT', subId, e]);
          push(['EOSE', subId]);
        }
      },
      close: () => {
        closed = true;
      },
    };
  }
}

function matches(filter: Filter, event: NostrEvent): boolean {
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) return false;
  const wanted = filter['#p'];
  if (
    wanted !== undefined &&
    !event.tags.some((t) => t[0] === 'p' && wanted.includes(t[1] ?? ''))
  ) {
    return false;
  }
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  return filter.until === undefined || event.created_at <= filter.until;
}

// --- Agents --------------------------------------------------------------------------------------

interface Agent extends TestAgent {
  readonly relays: readonly string[];
  readonly lines: string[];
  readonly nostr: string;
  /** Calls to EnvelopeService.receive: each one runs the signature check (04 §3.1.1 step 4). */
  readonly receives: { count: number };
}

const owners = new Map<number, TestOwner>();
const ownerFor = (n: number): TestOwner => {
  let owner = owners.get(n);
  if (owner === undefined) {
    owner = new MemoryOwnerKeyStore(seed(n), passphrase()) as unknown as TestOwner;
    owners.set(n, owner);
  }
  return owner;
};

interface OpenOptions {
  readonly store?: MemoryStore;
  readonly keyStore?: KeyStore;
  readonly deliveryAcks?: boolean;
  readonly init?: false;
}

async function openAgent(
  n: number,
  name: string,
  relays: readonly string[],
  net: RelayNetwork,
  options: OpenOptions = {},
): Promise<Agent> {
  const store = options.store ?? new MemoryStore();
  const cipher = new TestStoreCipher();
  const keyStore: KeyStore = options.keyStore ?? new MemoryKeyStore(seed(n));
  const owner = ownerFor(200 + n);
  const lines: string[] = [];
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    transport: nostrTransport({ connector: net, addressCheck: 'platform' }),
    logger: createLogger({ name: 'core', level: 'debug', sink: (_l, line) => lines.push(line) }),
    ...(options.deliveryAcks === undefined ? {} : { deliveryAcks: options.deliveryAcks }),
  });
  if (options.init !== false) {
    await client.identity.init({
      owner: await owner.unlock(passphrase()),
      ownerKeys: await owner.getPublicKeys(),
      name,
      relays,
    });
  }
  const receives = { count: 0 };
  const receive = client.envelopes.receive.bind(client.envelopes);
  client.envelopes.receive = (input) => {
    receives.count += 1;
    return receive(input);
  };
  return {
    client,
    store,
    cipher,
    keyStore,
    owner,
    id: client.agentId,
    relays,
    lines,
    nostr: encodeHex((await keyStore.getPublicBundle()).agentNostr),
    receives,
  };
}

async function pair(a: Agent, b: Agent): Promise<void> {
  await pairWith(clock, a, b);
  await pairWith(clock, b, a);
}

/** Wraps `envelope` for `to`'s agent key, signed by `from`, and puts it on `to`'s relays. */
async function deliverRaw(
  net: RelayNetwork,
  from: Agent,
  to: Agent,
  envelope: Envelope,
  relays: readonly string[] = to.relays,
): Promise<NostrEvent> {
  const wrapped = await wrapEnvelope(envelope, [to.nostr], from.keyStore, { now: clock.now });
  const event = wrapped.wraps[0]?.event as NostrEvent;
  for (const relay of relays) net.inject(relay, event);
  return event;
}

const rowsOf = (agent: Agent) =>
  agent.store.transaction((tx) => ({
    envelopes: tx.select('envelopes'),
    contacts: tx.select('contacts'),
    outbox: tx.select('outbox'),
    seen: tx.select('seen'),
    cursors: tx.select('sync_cursors'),
    receipts: tx.select('receipts'),
    rate: tx.select('rate_counters'),
    pairings: tx.select('pairings'),
    invites: tx.select('invites'),
  }));

const inboundText = async (agent: Agent) =>
  (await rowsOf(agent)).envelopes.filter((r) => r.direction === 'in' && r.type === 'text');

beforeEach(() => {
  clock = new FakeClock();
});

// --- syncInbox ----------------------------------------------------------------------------------

describe('syncInbox (07 §2, §4.2): fetch, verify once, store, process', () => {
  it('returns a contact message with the wrapper metadata, and nothing new on the next pass', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    await pair(a, b);
    const sent = await a.client.sendMessage({ to: b.id, text: 'hello bob' });
    expect(sent.status).toBe('ok');
    if (sent.status !== 'ok') return;

    const first = await b.client.syncInbox();
    expect(first.partial).toBe(false);
    expect(first.items).toHaveLength(1);
    const item = first.items[0];
    expect(item?.envelopeId).toBe(sent.envelopeId);
    expect(item?.type).toBe('text');
    expect(item?.payload.body).toBe('hello bob');
    expect(item?.read).toBe(false);
    const view = await b.client.contacts.get(a.id);
    expect(item?.from).toEqual({
      contactId: a.id,
      display: view.display,
      ownerFingerprint: view.ownerFingerprint.short,
      safetyCodeChecked: view.safetyCodeChecked,
      declaredName: 'alice',
    });
    // The label is the contact's identity label (11 §5.2), never "verified" alone (06 §4).
    expect(item?.from.display.label).not.toBe('verified');
    expect(first.requests).toBe(0);
    expect(first.stored).toBe(1);
    // Only the agent's own relays were read, with #p = its own keys (07 §4.2, §4.3).
    const reqRelays = new Set(net.reqs.map((r) => r.relay));
    expect(reqRelays).toEqual(new Set(RELAYS_B));
    for (const r of net.reqs) {
      expect(r.filter.kinds).toEqual([1059]);
      expect(r.filter['#p']).toEqual([b.nostr]);
    }
    const state = await rowsOf(b);
    expect(state.cursors.map((c) => c.relay_url).sort()).toEqual([...RELAYS_B].sort());

    const second = await b.client.syncInbox();
    expect(second.items).toEqual([]);
    expect(second.stored).toBe(0);
    expect(await inboundText(b)).toHaveLength(1);
  });

  it('verifies each envelope once: copies on several relays and a second gift wrap are skipped on the seen-set', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    await pair(a, b);
    const built = await a.client.envelopes.build({ to: { contact: b.id }, payload: textPayload() });
    // The same wrap on both relays, then another gift wrap of the same envelope.
    await deliverRaw(net, a, b, built.envelope);
    const first = await b.client.syncInbox();
    expect(first.items.map((i) => i.envelopeId)).toEqual([built.envelope.id]);
    expect(b.receives.count).toBe(1);

    await deliverRaw(net, a, b, built.envelope, [RELAYS_B[0] as string]);
    const second = await b.client.syncInbox();
    expect(second.items).toEqual([]);
    expect(b.receives.count).toBe(1);
    expect(await inboundText(b)).toHaveLength(1);
    // The second wrap is now recorded too, so it is not opened again (07 §3.2).
    const wraps = (await rowsOf(b)).seen.filter((s) => s.kind === 'wrap');
    expect(wraps).toHaveLength(2);
  });

  it('is idempotent across a restart: a new client over the same store neither re-verifies nor re-delivers', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    await pair(a, b);
    await a.client.sendMessage({ to: b.id, text: 'once' });
    expect((await b.client.syncInbox()).items).toHaveLength(1);

    clock.t += 600;
    const again = await openAgent(2, 'bob', RELAYS_B, net, {
      store: b.store,
      keyStore: b.keyStore,
      init: false,
    });
    const result = await again.client.syncInbox();
    expect(result.items).toEqual([]);
    expect(again.receives.count).toBe(0);
    expect(await inboundText(b)).toHaveLength(1);
  });

  it('processes a card-update before the same contact envelopes from the new key, whatever the arrival order (04 §3.1.1 step 7)', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    await pair(a, b);
    await rotate(a);
    const text = await a.client.envelopes.build({ to: { contact: b.id }, payload: textPayload() });
    clock.t += 5;
    const update = await a.client.envelopes.build({
      to: { contact: b.id },
      payload: await cardUpdatePayload(a),
    });
    // The text arrives first, with the earlier createdAt.
    await deliverRaw(net, a, b, text.envelope);
    await deliverRaw(net, a, b, update.envelope);
    const result = await b.client.syncInbox();
    expect(result.items.map((i) => i.envelopeId)).toEqual([text.envelope.id]);
    expect(result.reports.map((r) => [r.envelopeId, r.outcome])).toEqual([
      [update.envelope.id, 'ok'],
      [text.envelope.id, 'ok'],
    ]);
    expect((await b.client.contacts.get(a.id)).keyEpoch).toBe(1);
  });

  it('rejects a card-update with the same epoch: the contact card does not change', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    await pair(a, b);
    const before = await b.client.contacts.get(a.id);
    const update = await a.client.envelopes.build({
      to: { contact: b.id },
      payload: await cardUpdatePayload(a),
    });
    await deliverRaw(net, a, b, update.envelope);
    const result = await b.client.syncInbox();
    expect(result.reports.find((r) => r.envelopeId === update.envelope.id)?.outcome).not.toBe('ok');
    const after = await b.client.contacts.get(a.id);
    expect(after.keyEpoch).toBe(before.keyEpoch);
    expect(after.card).toEqual(before.card);
  });

  it('drops a revoked contact later envelopes (07 §3.4)', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    await pair(a, b);
    await b.store.transaction((tx) => {
      tx.insert('revoked_agents', {
        agent_evm: a.id,
        nostr_keys: JSON.stringify([a.nostr]),
        signed_json: null,
        reason: 'compromised',
        source: 'registry',
        chain_id: null,
        registry_ref: null,
        applied_at: clock.t,
      });
    });
    await a.client.sendMessage({ to: b.id, text: 'after revoke' });
    const result = await b.client.syncInbox();
    expect(result.items).toEqual([]);
    expect(await inboundText(b)).toHaveLength(0);
  });

  it('logs counts only: no relay URL, envelope ID, key or text (I-7)', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    await pair(a, b);
    const sent = await a.client.sendMessage({ to: b.id, text: 'canary-text-7f3a' });
    if (sent.status !== 'ok') throw new Error('test: not sent');
    b.lines.length = 0;
    await b.client.syncInbox();
    expect(b.lines.length).toBeGreaterThan(0);
    const all = b.lines.join('\n');
    expect(all).not.toContain('canary-text-7f3a');
    expect(all).not.toContain(sent.envelopeId);
    expect(all).not.toContain(a.nostr);
    expect(all).not.toContain('relay-beta');
  });

  it('refuses a budget outside 1 to 60 000 ms', async () => {
    const net = new RelayNetwork();
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    for (const budgetMs of [0, -1, 1.5, 60_001]) {
      await expect(b.client.syncInbox({ budgetMs })).rejects.toBeInstanceOf(CoreError);
      await expect(b.client.catchUp({ budgetMs })).rejects.toMatchObject({
        code: 'sync_budget_invalid',
      });
    }
  });

  it('without a transport it fails with transport_unavailable', async () => {
    const client = await AgentLinkClient.create({
      keyStore: new MemoryKeyStore(seed(9)),
      store: new MemoryStore(),
      cipher: new TestStoreCipher(),
      approvals: new RecordingApprovalChannel(),
      clock: clock.now,
    });
    await expect(client.syncInbox()).rejects.toMatchObject({ code: 'transport_unavailable' });
    await expect(client.catchUp()).rejects.toMatchObject({ code: 'transport_unavailable' });
  });
});

// --- Rate limit -----------------------------------------------------------------------------------

describe('per-contact rate limit (07 §3.2 rate_counters; 06 §3)', () => {
  it('500 envelopes from one contact are limited without delaying another contact', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    const c = await openAgent(3, 'carol', RELAYS_C, net);
    await pair(a, b);
    await pair(c, b);
    const limit = POLICY_DEFAULTS.contacts.rateLimitPerContactPerHour;
    for (let i = 0; i < 500; i += 1) {
      const built = await a.client.envelopes.build({
        to: { contact: b.id },
        payload: textPayload(`flood ${i}`),
      });
      await deliverRaw(net, a, b, built.envelope, [RELAYS_B[0] as string]);
    }
    const fromC = await c.client.envelopes.build({
      to: { contact: b.id },
      payload: textPayload('from carol'),
    });
    await deliverRaw(net, c, b, fromC.envelope);

    const result = await b.client.syncInbox({ budgetMs: 60_000 });
    expect(result.partial).toBe(false);
    expect(result.rateLimited).toEqual([{ contactId: a.id, dropped: 500 - limit }]);
    const fromA = result.items.filter((i) => i.from.contactId === a.id);
    expect(fromA).toHaveLength(limit);
    expect(result.items.filter((i) => i.from.contactId === c.id).map((i) => i.envelopeId)).toEqual([
      fromC.envelope.id,
    ]);
    const state = await rowsOf(b);
    expect(
      state.envelopes.filter(
        (r) => r.direction === 'in' && r.contact_id === a.id && r.type === 'text',
      ),
    ).toHaveLength(limit);
    // A dropped envelope keeps its seen rows, so it is not fetched and verified again.
    const receivesBefore = b.receives.count;
    const again = await b.client.syncInbox({ budgetMs: 60_000 });
    expect(again.items).toEqual([]);
    expect(b.receives.count).toBe(receivesBefore);
    // An hour later the window has room again for new envelopes.
    clock.t += 3_601;
    const later = await a.client.envelopes.build({ to: { contact: b.id }, payload: textPayload() });
    await deliverRaw(net, a, b, later.envelope);
    expect((await b.client.syncInbox()).items.map((i) => i.envelopeId)).toEqual([
      later.envelope.id,
    ]);
    expect((await rowsOf(b)).rate.every((r) => r.bucket > clock.t - 3_600)).toBe(true);
  }, 120_000);
});

// --- Fetch-only catch-up --------------------------------------------------------------------------

describe('catchUp (M1-7h addendum, D-73; 06 §2.0): fetch-only', () => {
  it('stores and counts by sender, and processes nothing: no ack, card update, read mark or receipt', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net, { deliveryAcks: true });
    await pair(a, b);
    await a.client.sendMessage({ to: b.id, text: 'one' });
    await a.client.sendMessage({ to: b.id, text: 'two' });
    await rotate(a);
    const update = await a.client.envelopes.build({
      to: { contact: b.id },
      payload: await cardUpdatePayload(a),
    });
    await deliverRaw(net, a, b, update.envelope);
    const before = await rowsOf(b);

    const counts = await b.client.catchUp();
    expect(counts).toEqual({
      partial: false,
      inbox: [{ contactId: a.id, unread: 2 }],
      requests: 0,
    });
    const after = await rowsOf(b);
    const inbound = after.envelopes.filter(
      (r) => r.direction === 'in' && !r.type.startsWith('handshake'),
    );
    expect(inbound).toHaveLength(3);
    expect(inbound.every((r) => r.state === 'received' && r.payload_json === null)).toBe(true);
    expect(inbound.every((r) => r.read_at === null)).toBe(true);
    expect(after.outbox).toEqual(before.outbox); // no ack, no handshake-ack
    expect(after.contacts).toEqual(before.contacts); // no card update applied
    expect(after.receipts).toEqual([]);
    expect((await b.client.contacts.get(a.id)).keyEpoch).toBe(0);

    // The next syncInbox processes them, the card update first: the two messages signed by the
    // now superseded key are refused (04 §3.1.1 step 7), so nothing is shown or acked.
    const sync = await b.client.syncInbox();
    expect(sync.items).toEqual([]);
    expect(sync.acksSent).toBe(0);
    expect((await b.client.contacts.get(a.id)).keyEpoch).toBe(1);
  });

  it('leaves messages for the next syncInbox, which shows and acks them once', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net, { deliveryAcks: true });
    await pair(a, b);
    await a.client.sendMessage({ to: b.id, text: 'one' });
    await a.client.sendMessage({ to: b.id, text: 'two' });
    expect((await b.client.catchUp()).inbox).toEqual([{ contactId: a.id, unread: 2 }]);
    expect((await b.client.catchUp()).inbox).toEqual([{ contactId: a.id, unread: 2 }]);
    expect((await rowsOf(b)).outbox).toEqual([]);
    expect(b.receives.count).toBe(2);

    const sync = await b.client.syncInbox();
    expect(sync.items.map((i) => i.payload.body).sort()).toEqual(['one', 'two']);
    expect(sync.acksSent).toBe(2);
    expect(b.receives.count).toBe(2);
    // Still unread until a reader marks them (agentlink_inbox, M1-9): the counts now come from `ok`.
    expect((await b.client.catchUp()).inbox).toEqual([{ contactId: a.id, unread: 2 }]);
  });

  it('M1-9c read-only test: a handshake pending in the relay stays unprocessed', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    const invite = await a.client.pairing.createInvite();
    const accepted = await b.client.pairing.acceptInvite({ link: invite.inviteUrl, allowed: true });
    if (accepted.status !== 'pending') throw new Error('test: not accepted');
    await deliverRaw(net, b, a, accepted.handshake.envelope);
    const before = await rowsOf(a);

    const counts = await a.client.catchUp();
    expect(counts).toEqual({ partial: false, inbox: [], requests: 0 });
    const after = await rowsOf(a);
    expect(after.contacts).toEqual([]);
    expect(after.outbox).toEqual([]);
    expect(after.invites).toEqual(before.invites);
    expect(after.pairings).toEqual(before.pairings);
    expect(after.receipts).toEqual([]);
    const stored = after.envelopes.filter((r) => r.direction === 'in');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ state: 'received', read_at: null, payload_json: null });

    // syncInbox then completes the inviter side and stages the handshake-ack.
    await a.client.syncInbox();
    const done = await rowsOf(a);
    expect(done.contacts.map((c) => c.contact_id)).toEqual([b.id]);
    expect(done.envelopes.some((r) => r.direction === 'out' && r.type === 'handshake-ack')).toBe(
      true,
    );
  });

  it('counts unknown senders as requests only, never by name', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    const stranger = await openAgent(4, 'mallory', RELAYS_C, net);
    await pair(a, b);
    const envelope = await craft({
      signer: await agentSigner(stranger.keyStore),
      entries: [
        { pk: await agentEnc(b) },
        { pk: await ownerEnc(b.owner) },
        { pk: await ownerEnc(stranger.owner) },
        { pk: await agentEnc(stranger) },
      ],
      payload: textPayload('mallory here'),
      createdAt: clock.t,
    });
    await deliverRaw(net, stranger, b, envelope);
    const synced = await b.client.syncInbox();
    expect(synced.items).toEqual([]);
    expect(synced.requests).toBe(1);
    const counts = await b.client.catchUp();
    expect(counts).toEqual({ partial: false, inbox: [], requests: 1 });
    expect(JSON.stringify(counts)).not.toContain('mallory');
  });
});

// --- Delivery acknowledgements --------------------------------------------------------------------

describe('delivery acknowledgements (02 F-23, behind a flag)', () => {
  it('off by default: no ack is sent', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    await pair(a, b);
    await a.client.sendMessage({ to: b.id, text: 'hi' });
    const result = await b.client.syncInbox();
    expect(result.items).toHaveLength(1);
    expect(result.acksSent).toBe(0);
    expect((await rowsOf(b)).outbox).toEqual([]);
  });

  it('with the flag, the contact acks each message once, the sender sees it, and an ack is never acked', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net, { deliveryAcks: true });
    const b = await openAgent(2, 'bob', RELAYS_B, net, { deliveryAcks: true });
    await pair(a, b);
    const sent = await a.client.sendMessage({ to: b.id, text: 'please confirm' });
    if (sent.status !== 'ok') throw new Error('test: not sent');
    expect(await a.client.acks.status(sent.envelopeId)).toMatchObject({ received: false });

    const atB = await b.client.syncInbox();
    expect(atB.acksSent).toBe(1);
    const ackRow = (await rowsOf(b)).envelopes.find(
      (r) => r.direction === 'out' && r.type === 'ack',
    );
    expect(ackRow).toBeDefined();
    expect(
      (await rowsOf(b)).outbox.filter((r) => r.envelope_id === ackRow?.envelope_id),
    ).toHaveLength(4);

    const atA = await a.client.syncInbox();
    // The ack is not an inbox item, and A sends no ack for it.
    expect(atA.items).toEqual([]);
    expect(atA.acksSent).toBe(0);
    const status = await a.client.acks.status(sent.envelopeId);
    expect(status.received).toBe(true);
    expect(status.receivedAt).toBeTypeOf('number');
    // B's next pass sends nothing more.
    expect((await b.client.syncInbox()).acksSent).toBe(0);
  });

  it('an ack from another contact, or one naming another envelope, does not count', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    const c = await openAgent(3, 'carol', RELAYS_C, net);
    await pair(a, b);
    await pair(a, c);
    const sent = await a.client.sendMessage({ to: b.id, text: 'for bob' });
    if (sent.status !== 'ok') throw new Error('test: not sent');
    const forged = await c.client.envelopes.build({
      to: { contact: a.id },
      payload: {
        type: 'ack',
        body: { kind: ACK_KIND_RECEIVED, envelopeId: sent.envelopeId },
        replyTo: sent.envelopeId,
        files: [],
      },
    });
    await deliverRaw(net, c, a, forged.envelope);
    const mismatched = await b.client.envelopes.build({
      to: { contact: a.id },
      payload: {
        type: 'ack',
        body: { kind: ACK_KIND_RECEIVED, envelopeId: forged.envelope.id },
        replyTo: sent.envelopeId,
        files: [],
      },
    });
    await deliverRaw(net, b, a, mismatched.envelope);
    await a.client.syncInbox();
    expect((await a.client.acks.status(sent.envelopeId)).received).toBe(false);
    await expect(a.client.acks.status(forged.envelope.id)).rejects.toMatchObject({
      code: 'envelope_not_found',
    });
  });
});

// --- Persistence ------------------------------------------------------------------------------------

describe('StoreSyncPersistence (07 §3.2)', () => {
  it('upserts cursors and never answers an envelope-id lookup (the id is sender-chosen)', async () => {
    const net = new RelayNetwork();
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    const store = b.store;
    const p = new StoreSyncPersistence({
      store,
      keyStore: b.keyStore,
      cipher: b.cipher,
      now: clock.now,
      log: createLogger({ name: 'test' }),
    });
    expect(await p.getCursor(RELAYS_B[0] as string)).toBeUndefined();
    await p.setCursor(RELAYS_B[0] as string, 100);
    await p.setCursor(RELAYS_B[0] as string, 200);
    expect(await p.getCursor(RELAYS_B[0] as string)).toBe(200);
    const wrap = 'ab'.repeat(32);
    await store.transaction((tx) =>
      tx.insert('seen', { kind: 'wrap', id: wrap, first_seen_at: 1 }),
    );
    expect(await p.isSeen('wrap', wrap)).toBe(true);
    expect(await p.isSeen('wrap', 'cd'.repeat(32))).toBe(false);
    await store.transaction((tx) =>
      tx.insert('seen', { kind: 'envelope', id: 'AAAAAAAAAAAAAAAAAAAAAA', first_seen_at: 1 }),
    );
    expect(await p.isSeen('envelope', 'AAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
  });
});

// --- IR-M1-7h-1 F01: revocation (04 §2.5.1, §3.4.1; 07 §3.4) --------------------------------------

/** An `agent.revoke` signed by `owner` for `agent` (04 §2.5.1: expiresAt 0). */
async function revokeObject(owner: TestOwner, agent: string, issuedAt: number) {
  const body: JsonObject = {
    v: 1,
    agent,
    owner: await ownerHex(owner),
    op: 'agent.revoke',
    params: { reason: 'compromised' },
    nonce: newNonce(),
    issuedAt,
    expiresAt: 0,
  };
  return signWith(owner, body);
}

/** Wraps an owner-signed envelope with an owner session and puts it on `to`'s relays. */
async function deliverFromOwner(
  net: RelayNetwork,
  owner: TestOwner,
  to: Agent,
  envelope: Envelope,
): Promise<void> {
  const session = await owner.unlock(passphrase());
  try {
    const wrapped = await wrapEnvelope(envelope, [to.nostr], session, { now: clock.now });
    const event = wrapped.wraps[0]?.event as NostrEvent;
    for (const relay of to.relays) net.inject(relay, event);
  } finally {
    await session.close();
  }
}

const revokePayload = (signed: unknown) =>
  ({ type: 'revoke', body: { signed }, replyTo: null, files: [] }) as unknown as JsonObject;

describe('IR-M1-7h-1 F01: revoke envelopes are applied or dropped, never parked', () => {
  it('a contact owner-signed revoke is applied: revoked_agents, status revoked, outbox stopped, later envelopes dropped', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    await pair(a, b);
    // A pending delivery from B to A, which the revoke must stop (07 §3.2 "Revocation").
    const pending = await b.client.sendMessage({ to: a.id, text: 'pending' });
    if (pending.status !== 'ok') throw new Error('test: not sent');
    await b.store.transaction((tx) =>
      tx.update('outbox', { envelope_id: pending.envelopeId }, { state: 'pending' }),
    );
    // 04 §3.4.1: recipients per §3.2 with the owner as sender.
    const envelope = await craft({
      signer: await ownerSigner(a.owner),
      entries: [
        { pk: await agentEnc(b) },
        { pk: await ownerEnc(b.owner) },
        { pk: await ownerEnc(a.owner) },
        { pk: await agentEnc(a) },
      ],
      payload: revokePayload(await revokeObject(a.owner, a.id, clock.t)),
      createdAt: clock.t,
    });
    await deliverFromOwner(net, a.owner, b, envelope);
    const result = await b.client.syncInbox();
    expect(result.items).toEqual([]);
    const state = await rowsOf(b);
    expect(state.envelopes.filter((r) => r.state === 'received')).toEqual([]);
    expect(state.contacts.find((c) => c.contact_id === a.id)?.status).toBe('revoked');
    const revoked = await b.store.transaction((tx) =>
      tx.get('revoked_agents', { agent_evm: a.id }),
    );
    expect(revoked).toMatchObject({ source: 'envelope', reason: 'compromised' });
    expect(JSON.parse(revoked?.nostr_keys ?? '[]')).toContain(a.nostr);
    const toA = state.outbox.filter(
      (r) => r.envelope_id === pending.envelopeId && r.recipient_key === a.nostr,
    );
    expect(toA.length).toBeGreaterThan(0);
    for (const row of toA) {
      expect(row).toMatchObject({ state: 'not_delivered', reason: 'revoked', wrap_json: null });
    }

    clock.t += 10;
    const later = await a.client.envelopes.build({
      to: { contact: b.id },
      payload: textPayload('after revoke'),
    });
    await deliverRaw(net, a, b, later.envelope);
    expect((await b.client.syncInbox()).items).toEqual([]);
    expect(await inboundText(b)).toHaveLength(0);
    // A re-published copy is a no-op (07 §3.4).
    await deliverFromOwner(net, a.owner, b, envelope);
    await b.client.syncInbox();
    expect((await rowsOf(b)).envelopes.filter((r) => r.state === 'received')).toEqual([]);
  });

  it('revokes that do not verify (wrong owner) are dropped: none is left received to fill the cap', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    const c = await openAgent(3, 'carol', RELAYS_C, net);
    await pair(a, b);
    await pair(c, b);
    // The contact's agent key sends revoke-typed envelopes with objects signed by another owner.
    for (let i = 0; i < 5; i += 1) {
      const built = await craft({
        signer: { from: a.nostr, sign: (h) => a.keyStore.signEnvelopeHash(h) },
        entries: [
          { pk: await agentEnc(b) },
          { pk: await ownerEnc(b.owner) },
          { pk: await ownerEnc(a.owner) },
          { pk: await agentEnc(a) },
        ],
        payload: revokePayload(await revokeObject(c.owner, a.id, clock.t)),
        createdAt: clock.t,
      });
      await deliverRaw(net, a, b, built);
    }
    const fromC = await c.client.envelopes.build({
      to: { contact: b.id },
      payload: textPayload('still here'),
    });
    await deliverRaw(net, c, b, fromC.envelope);
    const result = await b.client.syncInbox();
    expect(result.items.map((i) => i.envelopeId)).toEqual([fromC.envelope.id]);
    const state = await rowsOf(b);
    expect(state.envelopes.filter((r) => r.state === 'received')).toEqual([]);
    expect(state.contacts.find((x) => x.contact_id === a.id)?.status).toBe('active');
    expect((await b.client.catchUp()).inbox).toEqual([{ contactId: c.id, unread: 1 }]);
  });

  it('the own owner revoke stops the agent from sending (07 §3.4)', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    await pair(a, b);
    const envelope = await craft({
      signer: await ownerSigner(b.owner),
      entries: [{ pk: await agentEnc(b) }, { pk: await ownerEnc(b.owner) }],
      payload: revokePayload(await revokeObject(b.owner, b.id, clock.t)),
      createdAt: clock.t,
    });
    await deliverFromOwner(net, b.owner, b, envelope);
    await b.client.syncInbox();
    expect(await b.client.identity.sendState()).toBe('revoked');
    expect((await rowsOf(b)).envelopes.filter((r) => r.state === 'received')).toEqual([]);
  });
});

// --- IR-M1-7h-1 F02: the rate limit counts where the contact envelope is stored (07 §3.2) ---------

describe('IR-M1-7h-1 F02: rate limit at processing time', () => {
  it('a card-update with 300 texts from the new key in one pass delivers no more than the limit', async () => {
    const net = new RelayNetwork();
    const a = await openAgent(1, 'alice', RELAYS_A, net);
    const b = await openAgent(2, 'bob', RELAYS_B, net);
    await pair(a, b);
    await rotate(a);
    const limit = POLICY_DEFAULTS.contacts.rateLimitPerContactPerHour;
    const update = await a.client.envelopes.build({
      to: { contact: b.id },
      payload: await cardUpdatePayload(a),
    });
    await deliverRaw(net, a, b, update.envelope, [RELAYS_B[0] as string]);
    // The texts are dated after the card-update, so the pass applies it before any of them and none
    // is held (the held pool keeps at most 100 per owner kid, 07 §3.2, which would evict the rest).
    clock.t += 1;
    for (let i = 0; i < 300; i += 1) {
      const built = await a.client.envelopes.build({
        to: { contact: b.id },
        payload: textPayload(`new key ${i}`),
      });
      await deliverRaw(net, a, b, built.envelope, [RELAYS_B[0] as string]);
    }
    const result = await b.client.syncInbox({ budgetMs: 60_000 });
    expect((await b.client.contacts.get(a.id)).keyEpoch).toBe(1);
    // The card-update is the contact's envelope too, so it counts toward the hour.
    expect(result.items).toHaveLength(limit - 1);
    expect(result.rateLimited).toEqual([{ contactId: a.id, dropped: 300 - (limit - 1) }]);
    const okFromA = (await rowsOf(b)).envelopes.filter(
      (r) =>
        r.direction === 'in' &&
        r.contact_id === a.id &&
        r.state === 'ok' &&
        (r.type === 'text' || r.type === 'card-update'),
    );
    expect(okFromA).toHaveLength(limit);
  }, 120_000);
});
