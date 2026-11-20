// M1-7j (S2; D-158 (5); 07 §3 `identity.prev_relays`, `announce_default`, §4.3 "Leaving servers stay
// readable for 30 days", owner `card-update`; 04 §2.6): every server that leaves the own list stays
// readable for 30 days, each with its own end; at most 16; reads use own + leaving + legacy; only
// card-updates are published to the leaving servers; the owner card-update is re-published every
// 24 h while any runs. The announce choice is only stored, restored and exposed here.
import { encodeHex, type Envelope, type KeyStore } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import {
  DEFAULT_RELAYS,
  LEGACY_READ_RELAYS,
  wrapEnvelope,
  type PublishOutcome,
  type SyncItem,
} from '@4thtech-io/transport-nostr';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import {
  LEAVING_SERVER_SECONDS,
  MAX_LEAVING_SERVERS,
  TooManyPreviousError,
  nextLeaving,
} from './leaving-servers.js';
import { MemoryStore } from './store/memory-store.js';
import type { Store } from './store/store.js';
import { rowKeyOf } from './store/store.js';
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
  craft,
  ownerEnc,
  pairWith,
  textPayload,
  type TestAgent,
  type TestOwner,
} from './testing/envelopes.js';
import { MemoryPolicyMark } from './testing/owner.js';
import type { TransportFactory } from './transport.js';

const DAY = 86_400;
const clock = new FakeClock();
const START = clock.t;

const list = (tag: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `wss://${tag}${i + 1}.example.org`);
const A = list('a', 3);
const B = list('b', 2);
const C = list('c', 2);

/** While true, the clock reads one second later inside a store transaction than outside it. */
let skew = false;
let inTx = false;
const now = (): number => (skew && inTx ? clock.t + 1 : clock.t);

/** A store whose transactions mark `inTx`, so the clock can tell where it is read. */
function watchedStore(inner: MemoryStore): Store {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return <R>(body: Parameters<Store['transaction']>[0]) =>
          target.transaction((tx) => {
            inTx = true;
            try {
              return body(tx) as R;
            } finally {
              inTx = false;
            }
          });
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as unknown as Store;
}

interface Agent extends TestAgent {
  /** The relays of every `sync` call, in order. */
  readonly reads: string[][];
  /** The relays of every `subscribe` call. */
  readonly live: string[][];
  /** Items the fake relays serve, by relay. */
  readonly served: Map<string, SyncItem[]>;
}

async function agent(n: number, owner: MemoryOwnerKeyStore, relays: readonly string[]) {
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const keyStore: KeyStore = new MemoryKeyStore(seed(n), { nowSeconds: now });
  const reads: string[][] = [];
  const live: string[][] = [];
  const served = new Map<string, SyncItem[]>();
  const factory: TransportFactory = (deps) => ({
    wrap: (envelope, recipients, keys) =>
      wrapEnvelope(envelope, recipients, keys, { now: deps.now }),
    publish: (_event, to) =>
      Promise.resolve({
        results: to.map((relay) => ({ relay, ok: true, reason: 'ok' as const })),
        acked: [...to],
        sent: to.length > 0,
      } as PublishOutcome),
    sync: async (options) => {
      reads.push([...options.relays]);
      let delivered = 0;
      for (const relay of options.relays) {
        for (const item of served.get(relay) ?? []) {
          await options.onEnvelope(item);
          delivered += 1;
        }
      }
      return { partial: false, delivered, duplicates: 0, dropped: 0, deferred: 0, relays: [] };
    },
    subscribe: (options) => {
      live.push([...options.relays]);
      return () => undefined;
    },
  });
  const client = await AgentLinkClient.create({
    keyStore,
    store: watchedStore(store),
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: now,
    transport: factory,
    policyMark: new MemoryPolicyMark(),
  });
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name: `agent${n}`,
    relays,
  });
  const testOwner = owner as unknown as TestOwner;
  return {
    client,
    store,
    cipher,
    keyStore,
    owner: testOwner,
    id: client.agentId,
    reads,
    live,
    served,
  } satisfies Agent;
}

async function change(x: Agent, relays: readonly string[], announceDefault?: boolean) {
  await x.client.identity.rotate({
    owner: await x.owner.unlock(passphrase()),
    ownerKeys: await x.owner.getPublicKeys(),
    epochControl: x.owner.epochControl(x.keyStore),
    relays,
    ...(announceDefault === undefined ? {} : { announceDefault }),
  });
}

/** The stored (sealed) leaving list, opened; null when the column is null. */
async function storedLeaving(x: Agent): Promise<unknown> {
  const row = await x.store.transaction((tx) => tx.select('identity')[0]);
  if (row?.prev_relays === null || row?.prev_relays === undefined) return null;
  return JSON.parse(
    await x.cipher.open(
      { table: 'identity', column: 'prev_relays', rowKey: rowKeyOf([row.agent_id]) },
      row.prev_relays,
    ),
  );
}

/** Every outbox row of `x` with its opened relays and its envelope's type and contact. */
async function outboxRows(x: Agent) {
  const rows = await x.store.transaction((tx) =>
    tx.select('outbox').map((r) => ({ row: r, env: tx.get('envelopes', { envelope_id: r.envelope_id }) })),
  );
  const out: {
    envelopeId: string;
    type: string | undefined;
    contact: string | null | undefined;
    role: string;
    attempt: number;
    createdAt: number;
    relays: string[];
  }[] = [];
  for (const { row, env } of rows) {
    const text = await x.cipher.open(
      { table: 'outbox', column: 'relays', rowKey: rowKeyOf([row.wrap_id]) },
      row.relays,
    );
    out.push({
      envelopeId: row.envelope_id,
      type: env?.type,
      contact: env?.contact_id,
      role: row.role,
      attempt: row.attempt,
      createdAt: row.created_at,
      relays: JSON.parse(text) as string[],
    });
  }
  return out;
}

const ownerA = new MemoryOwnerKeyStore(seed(181), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(182), passphrase());
let a: Agent;

beforeEach(async () => {
  clock.t = START;
  skew = false;
  a = await agent(81, ownerA, A);
});

describe('nextLeaving (the rule)', () => {
  it('moves leaving servers in with their own end, takes returning ones out, prunes ended ones', () => {
    const t0 = 1_000;
    const one = nextLeaving([], A, B, t0);
    expect(one).toEqual(A.map((url) => ({ url, until: t0 + LEAVING_SERVER_SECONDS })));
    const t1 = t0 + 10 * DAY;
    const two = nextLeaving(one, B, [A[0] as string, ...C], t1);
    expect(two).toEqual([
      { url: A[1], until: t0 + LEAVING_SERVER_SECONDS },
      { url: A[2], until: t0 + LEAVING_SERVER_SECONDS },
      ...B.map((url) => ({ url, until: t1 + LEAVING_SERVER_SECONDS })),
    ]);
    expect(nextLeaving(two, C, C, t0 + LEAVING_SERVER_SECONDS)).toEqual(
      B.map((url) => ({ url, until: t1 + LEAVING_SERVER_SECONDS })),
    );
  });

  it(`refuses more than ${MAX_LEAVING_SERVERS} with the time from which the change fits`, () => {
    const x = list('x', 8);
    const y = list('y', 8);
    const z = list('z', 8);
    const p1 = nextLeaving([], x, y, 0);
    const p2 = nextLeaving(p1, y, z, 5 * DAY);
    expect(p2).toHaveLength(16);
    let error: unknown;
    try {
      nextLeaving(p2, z, B, 6 * DAY);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TooManyPreviousError);
    expect(error).toMatchObject({ code: 'too_many_previous', fitsAt: LEAVING_SERVER_SECONDS });
    expect(nextLeaving(p2, z, B, LEAVING_SERVER_SECONDS)).toHaveLength(16);
  });
});

describe('rotate({relays}) keeps the leaving servers (07 §4.3)', () => {
  it('one change, a second change and a reset within 30 days: lists combine, each entry keeps its end', async () => {
    const t0 = clock.t;
    await change(a, B);
    expect(await a.client.identity.leavingServers()).toEqual(
      A.map((url) => ({ url, until: t0 + LEAVING_SERVER_SECONDS })),
    );
    clock.t = t0 + 10 * DAY;
    const t1 = clock.t;
    await change(a, C);
    clock.t = t0 + 20 * DAY;
    const t2 = clock.t;
    const reset = DEFAULT_RELAYS.slice(0, 3);
    await change(a, reset, true);
    expect(await a.client.identity.leavingServers()).toEqual([
      ...A.map((url) => ({ url, until: t0 + LEAVING_SERVER_SECONDS })),
      ...B.map((url) => ({ url, until: t1 + LEAVING_SERVER_SECONDS })),
      ...C.map((url) => ({ url, until: t2 + LEAVING_SERVER_SECONDS })),
    ]);
    expect(await a.client.identity.relays()).toEqual(reset);
  });

  it('a server that comes back into the list leaves the leaving servers', async () => {
    const t0 = clock.t;
    await change(a, B);
    clock.t += DAY;
    await change(a, [A[0] as string, B[0] as string]);
    expect(await a.client.identity.leavingServers()).toEqual([
      { url: A[1], until: t0 + LEAVING_SERVER_SECONDS },
      { url: A[2], until: t0 + LEAVING_SERVER_SECONDS },
      { url: B[1], until: clock.t + LEAVING_SERVER_SECONDS },
    ]);
  });

  it('a rotation that keeps the list (a rename) leaves them unchanged', async () => {
    await change(a, B);
    const before = await storedLeaving(a);
    clock.t += DAY;
    await a.client.identity.rotate({
      owner: await a.owner.unlock(passphrase()),
      ownerKeys: await a.owner.getPublicKeys(),
      epochControl: a.owner.epochControl(a.keyStore),
      name: 'renamed',
    });
    expect(await storedLeaving(a)).toEqual(before);
  });

  it('refuses a change that needs a 17th entry before anything is signed, with the date it fits', async () => {
    const x = await agent(82, ownerB, list('x', 8));
    const t0 = clock.t;
    await change(x, list('y', 8));
    clock.t = t0 + 5 * DAY;
    await change(x, list('z', 8));
    clock.t = t0 + 6 * DAY;
    const epoch = (await x.client.identity.signedCard()).card.keyEpoch;
    const keyEpoch = (await x.keyStore.getPublicBundle()).keyEpoch;
    await expect(change(x, B)).rejects.toMatchObject({
      code: 'too_many_previous',
      fitsAt: t0 + LEAVING_SERVER_SECONDS,
    });
    expect((await x.client.identity.signedCard()).card.keyEpoch).toBe(epoch);
    expect((await x.keyStore.getPublicBundle()).keyEpoch).toBe(keyEpoch);
    expect(await x.client.identity.leavingServers()).toHaveLength(16);
    clock.t = t0 + LEAVING_SERVER_SECONDS;
    await change(x, B);
    expect(await x.client.identity.leavingServers()).toHaveLength(16);
  });
});

describe('pruning at expiry (clock read in the transaction)', () => {
  it('an ended entry is no longer read, and the sync pass prunes it from the row', async () => {
    const t0 = clock.t;
    await change(a, B);
    clock.t = t0 + LEAVING_SERVER_SECONDS - 1;
    expect(await a.client.identity.leavingServers()).toHaveLength(3);
    clock.t = t0 + LEAVING_SERVER_SECONDS;
    expect(await a.client.identity.leavingServers()).toEqual([]);
    expect(await storedLeaving(a)).not.toBeNull();
    await a.client.syncInbox();
    expect(await storedLeaving(a)).toBeNull();
  });

  it('prune uses the clock read inside the store transaction', async () => {
    const t0 = clock.t;
    await change(a, B);
    // Outside a transaction the entries still run (one second left); inside it they have ended.
    clock.t = t0 + LEAVING_SERVER_SECONDS - 1;
    skew = true;
    await a.client.identity.pruneLeavingServers();
    skew = false;
    expect(await storedLeaving(a)).toBeNull();
  });

  it('a change commits the leaving list as of the clock read in its commit transaction', async () => {
    const t0 = clock.t;
    await change(a, B);
    clock.t = t0 + LEAVING_SERVER_SECONDS - 1;
    skew = true;
    await change(a, C);
    skew = false;
    // A's entries ended inside the commit transaction: only B's are stored.
    const stored = (await storedLeaving(a)) as { url: string }[];
    expect(stored.map((e) => e.url)).toEqual(B);
  });
});

describe('the read set (own + leaving + legacy)', () => {
  it('catch-up and the live subscription read the leaving servers too', async () => {
    await change(a, B);
    await a.client.syncInbox();
    const read = a.reads.at(-1) ?? [];
    for (const r of [...B, ...A, ...LEGACY_READ_RELAYS]) expect(read).toContain(r);
    await a.client.subscribeInbox();
    const live = a.live.at(-1) ?? [];
    for (const r of [...B, ...A, ...LEGACY_READ_RELAYS]) expect(live).toContain(r);
  });

  it('after the end, a leaving server is no longer read', async () => {
    const t0 = clock.t;
    await change(a, B);
    clock.t = t0 + LEAVING_SERVER_SECONDS;
    await a.client.syncInbox();
    const read = a.reads.at(-1) ?? [];
    for (const r of A) expect(read).not.toContain(r);
    for (const r of B) expect(read).toContain(r);
  });

  it('an old card: a contact still publishing to the old list is received through it for 30 days', async () => {
    const peer = await agent(83, ownerB, list('p', 2));
    await pairWith(clock, a, peer);
    const t0 = clock.t;
    await change(a, B);
    const message = async (body: string): Promise<Envelope> =>
      craft({
        signer: await agentSigner(peer.keyStore),
        entries: [
          { pk: await agentEnc(a, 0) },
          { pk: await ownerEnc(a.owner) },
          { pk: await ownerEnc(peer.owner) },
          { pk: await agentEnc(peer) },
        ],
        payload: textPayload(body),
        createdAt: clock.t,
      });
    const serveOn = (relay: string, envelope: Envelope, recipient: string, n: number) =>
      a.served.set(relay, [
        {
          envelope,
          giftWrapId: n.toString(16).padStart(64, '0'),
          giftWrapCreatedAt: clock.t,
          relay,
          recipient,
          envelopeSeen: false,
        },
      ]);
    // Day 29: the contact (still on the old card) publishes to an old server: received.
    const oldKey = encodeHex((await a.keyStore.getPublicBundle({ epoch: 0 })).agentNostr);
    clock.t = t0 + 29 * DAY;
    serveOn(A[0] as string, await message('day 29'), oldKey, 1);
    const day29 = await a.client.syncInbox();
    expect(day29.items.map((i) => i.payload.body)).toContain('day 29');
    // Day 31: that server is no longer read.
    clock.t = t0 + 31 * DAY;
    serveOn(A[0] as string, await message('day 31'), oldKey, 2);
    const day31 = await a.client.syncInbox();
    expect(day31.items.map((i) => i.payload.body)).not.toContain('day 31');
  });
});

describe('what is published to the leaving servers', () => {
  it('only card-updates: never a message to a contact; the owner card-update goes to new + leaving + default', async () => {
    const peer = await agent(84, ownerB, list('q', 2));
    await pairWith(clock, a, peer);
    await pairWith(clock, peer, a);
    await change(a, B);
    await a.client.sendCardUpdates();
    await a.client.sendMessage({ to: peer.id, text: 'after the change' });
    const rows = await outboxRows(a);
    for (const r of rows.filter((x) => x.type !== 'card-update')) {
      for (const old of A) expect(r.relays, `${r.type} ${r.role}`).not.toContain(old);
    }
    // The own copies of the contact card-update go to the leaving servers too.
    const contactUpdate = rows.filter(
      (x) => x.type === 'card-update' && x.contact === peer.id && x.role === 'owner',
    );
    expect(contactUpdate.length).toBeGreaterThan(0);
    for (const r of contactUpdate) for (const old of A) expect(r.relays).toContain(old);
    // The owner card-update: the new list, the leaving servers and the default set.
    const ownerUpdate = rows.filter((x) => x.type === 'card-update' && x.contact === null);
    expect(ownerUpdate.length).toBe(2);
    for (const r of ownerUpdate) {
      for (const relay of [...B, ...A, ...DEFAULT_RELAYS]) expect(r.relays).toContain(relay);
      expect(r.role).toBe('owner');
    }
  });

  it('the owner card-update is re-published every 24 h while a leaving server runs, then every 7 days', async () => {
    const t0 = clock.t;
    await change(a, B);
    const owned = async () =>
      (await outboxRows(a)).filter((x) => x.type === 'card-update' && x.contact === null);
    await a.client.cardUpdates.announceToOwner();
    const first = await owned();
    expect(first).toHaveLength(2);
    const envelopeId = first[0]?.envelopeId;
    await a.client.cardUpdates.announceToOwner();
    expect(await owned()).toHaveLength(2); // not due yet
    clock.t = t0 + DAY - 1;
    await a.client.cardUpdates.announceToOwner();
    expect(await owned()).toHaveLength(2);
    clock.t = t0 + DAY;
    await a.client.cardUpdates.announceToOwner();
    const second = await owned();
    expect(second).toHaveLength(4);
    // A new gift wrap of the same stored envelope (07 §4.3), as the next attempt.
    expect(new Set(second.map((x) => x.envelopeId))).toEqual(new Set([envelopeId]));
    expect(Math.max(...second.map((x) => x.attempt))).toBe(2);
    // After every leaving server ended: every 7 days.
    clock.t = t0 + LEAVING_SERVER_SECONDS + DAY;
    await a.client.cardUpdates.announceToOwner();
    const n = (await owned()).length;
    clock.t += 2 * DAY;
    await a.client.cardUpdates.announceToOwner();
    expect(await owned()).toHaveLength(n);
    clock.t += 5 * DAY;
    await a.client.cardUpdates.announceToOwner();
    expect((await owned()).length).toBeGreaterThan(n);
  });
});

describe('announce_default (stored, restored, exposed; its behaviour is NET-ANNOUNCE-OPTOUT)', () => {
  it('defaults to true, is written with the card, and a later change without it keeps it', async () => {
    expect(await a.client.identity.announceDefault()).toBe(true);
    await change(a, B, false);
    expect(await a.client.identity.announceDefault()).toBe(false);
    clock.t += DAY;
    await change(a, C);
    expect(await a.client.identity.announceDefault()).toBe(false);
  });

  it('a restore of the store keeps the leaving servers and the choice', async () => {
    const t0 = clock.t;
    await change(a, B, false);
    // A restore brings the same store rows back under the same store key (04 §2.3.3).
    const restored = new MemoryStore();
    const rows = await a.store.transaction((tx) => tx.select('identity'));
    await restored.transaction((tx) => {
      for (const row of rows) tx.insert('identity', row);
    });
    const client = await AgentLinkClient.create({
      keyStore: a.keyStore,
      store: restored,
      cipher: a.cipher,
      approvals: new RecordingApprovalChannel(),
      clock: now,
      policyMark: new MemoryPolicyMark(),
    });
    expect(await client.identity.leavingServers()).toEqual(
      A.map((url) => ({ url, until: t0 + LEAVING_SERVER_SECONDS })),
    );
    expect(await client.identity.announceDefault()).toBe(false);
  });
});
