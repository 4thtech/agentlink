// NET-OWNER-SET (S2; D-158 (2), (3), (5), (7); 07 §4.3 "Use your own servers"; 04 §2.6; I-4): the
// core list builder and the core side of a server-list change.
//
// - The list. The owner's own servers (1 to 6 with the mix-in, 2 to 8 without), each passing the
//   relay URL rule, unique. At least 2 of the owner's own must be ready (slow counts as ready); a
//   refused own server refuses the list; a `sign_in` server needs 2 other ready ones.
// - The mix-in adds up to 2 ready default servers that the owner did not list; they count toward 8.
// - Leaving servers: at most 16; a change that needs more is refused with the time it fits from.
// - The change itself is a rotation (identity.rotate({relays, announceDefault})): contacts get a
//   card-update with the new list, an interrupted change finishes on the next open with the list
//   and the announce choice, a restore keeps both, and the progress read counts sent and waiting.
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import type { KeyStore, JsonValue } from '@4thtech-io/crypto';
import { DEFAULT_RELAYS, wrapEnvelope, type PublishOutcome } from '@4thtech-io/transport-nostr';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { LEAVING_SERVER_SECONDS, type LeavingServer } from './leaving-servers.js';
import {
  AUTOMATIC_SERVERS,
  buildServerList,
  parseOwnServers,
  planLeaving,
  type TestedServer,
} from './server-list.js';
import { MemoryStore } from './store/memory-store.js';
import { rowKeyOf } from './store/store.js';
import {
  FakeClock,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
  RELAYS,
} from './testing/fixtures.js';
import { pairWith, type TestAgent, type TestOwner } from './testing/envelopes.js';
import { MemoryPolicyMark } from './testing/owner.js';
import type { TransportFactory } from './transport.js';

const own = (n: number, tag = 'own'): string[] =>
  Array.from({ length: n }, (_, i) => `wss://${tag}${i + 1}.example.org`);
const tested = (
  urls: readonly string[],
  outcome: TestedServer['outcome'] = 'ready',
): TestedServer[] => urls.map((url) => ({ url, outcome }));
const defaults = (outcome: TestedServer['outcome'] = 'ready') => tested(DEFAULT_RELAYS, outcome);

describe('parseOwnServers: 1 to 6 with the mix-in, 2 to 8 without, unique, the URL rule', () => {
  it('accepts the counts the switch allows and refuses the others', () => {
    expect(parseOwnServers(own(1), true)).toEqual(own(1));
    expect(parseOwnServers(own(6), true)).toEqual(own(6));
    expect(parseOwnServers(own(7), true)).toBeUndefined();
    expect(parseOwnServers(own(1), false)).toBeUndefined();
    expect(parseOwnServers(own(8), false)).toEqual(own(8));
    expect(parseOwnServers(own(9), false)).toBeUndefined();
    expect(parseOwnServers([], true)).toBeUndefined();
    expect(parseOwnServers('wss://a.example.org', true)).toBeUndefined();
  });

  it('refuses a duplicate, an IP literal, a private name, ws:// and a non-string', () => {
    const [a, b] = own(2) as [string, string];
    expect(parseOwnServers([a, a], false)).toBeUndefined();
    expect(parseOwnServers([a, `${a}/`], false)).toBeUndefined();
    expect(parseOwnServers([a, 'wss://10.0.0.1'], false)).toBeUndefined();
    expect(parseOwnServers([a, 'wss://localhost'], false)).toBeUndefined();
    expect(parseOwnServers([a, 'ws://b.example.org'], false)).toBeUndefined();
    expect(parseOwnServers([a, 7], false)).toBeUndefined();
    expect(parseOwnServers([a, b], false)).toEqual([a, b]);
  });
});

describe('buildServerList: tested again, at least 2 own ready, the mix-in within 8', () => {
  it('the mix-in adds 2 ready default servers after the own ones, and they count toward 8', () => {
    const out = buildServerList({
      own: tested(own(6)),
      automatic: true,
      announce: true,
      defaults: defaults(),
    });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.plan.servers).toHaveLength(8);
    expect(out.plan.servers.slice(0, 6).map((s) => s.role)).toEqual(Array(6).fill('own'));
    expect(out.plan.servers.slice(6).map((s) => s.role)).toEqual(['automatic', 'automatic']);
    expect(out.plan.servers.slice(6).map((s) => s.url)).toEqual(DEFAULT_RELAYS.slice(0, 2));
    expect(out.plan.relays).toEqual([...own(6), ...DEFAULT_RELAYS.slice(0, 2)]);
  });

  it('the mix-in picks only ready default servers the owner did not list already', () => {
    const [first, second, third, fourth] = DEFAULT_RELAYS as unknown as [
      string,
      string,
      string,
      string,
    ];
    const out = buildServerList({
      own: tested([...own(2), first]),
      automatic: true,
      announce: true,
      defaults: [
        { url: first, outcome: 'ready' },
        { url: second, outcome: 'refused' },
        { url: third, outcome: 'slow' },
        { url: fourth, outcome: 'ready' },
      ],
    });
    expect(out.status === 'ok' && out.plan.relays).toEqual([...own(2), first, third, fourth]);
    expect(out.status === 'ok' && out.plan.servers[2]?.role).toBe('own');
  });

  it('without the mix-in: only the own servers, with a warning', () => {
    const out = buildServerList({
      own: tested(own(8)),
      automatic: false,
      announce: true,
      defaults: [],
    });
    expect(out.status === 'ok' && out.plan.relays).toEqual(own(8));
    expect(out.status === 'ok' && out.plan.warnings).toContain('mix_in_off');
  });

  it('refuses fewer than 2 own ready (slow counts as ready), and a refused own server', () => {
    const [a, b, c] = own(3) as [string, string, string];
    const ok = (list: TestedServer[]) =>
      buildServerList({ own: list, automatic: true, announce: true, defaults: defaults() }).status;
    expect(ok([{ url: a, outcome: 'ready' }])).toBe('refused');
    expect(
      ok([
        { url: a, outcome: 'ready' },
        { url: b, outcome: 'slow' },
      ]),
    ).toBe('ok');
    expect(
      ok([
        { url: a, outcome: 'ready' },
        { url: b, outcome: 'ready' },
        { url: c, outcome: 'refused' },
      ]),
    ).toBe('refused');
    // The mixed-in default servers never make up for the owner's own (D-158 (2)).
    expect(
      buildServerList({
        own: [
          { url: a, outcome: 'ready' },
          { url: b, outcome: 'sign_in' },
        ],
        automatic: true,
        announce: true,
        defaults: defaults(),
      }),
    ).toEqual({ status: 'refused', reason: 'not_ready' });
  });

  it('a sign_in server needs 2 other ready servers of the list', () => {
    const [a, b, c] = own(3) as [string, string, string];
    const list = (third: TestedServer['outcome']) =>
      buildServerList({
        own: [
          { url: a, outcome: 'ready' },
          { url: b, outcome: third },
          { url: c, outcome: 'sign_in' },
        ],
        automatic: false,
        announce: true,
        defaults: [],
      });
    expect(list('ready').status).toBe('ok');
    expect(list('ready').status === 'ok' && list('ready')).toMatchObject({
      plan: { warnings: expect.arrayContaining(['sign_in']) as unknown },
    });
    expect(list('sign_in')).toEqual({ status: 'refused', reason: 'not_ready' });
  });

  it('the announce opt-out is refused while the mix-in is on', () => {
    expect(
      buildServerList({
        own: tested(own(2)),
        automatic: true,
        announce: false,
        defaults: defaults(),
      }),
    ).toEqual({ status: 'refused', reason: 'mix_in_on' });
    const off = buildServerList({
      own: tested(own(2)),
      automatic: false,
      announce: false,
      defaults: [],
    });
    expect(off.status === 'ok' && off.plan.announceDefault).toBe(false);
    expect(off.status === 'ok' && off.plan.warnings).toContain('announce_off');
  });

  it('IR L3: the opt-out is refused while an own server is a default one', () => {
    expect(
      buildServerList({
        own: tested([...own(2), DEFAULT_RELAYS[0] as string]),
        automatic: false,
        announce: false,
        defaults: [],
      }),
    ).toEqual({ status: 'refused', reason: 'mix_in_on' });
  });

  it('the automatic list is the release default set', () => {
    expect(AUTOMATIC_SERVERS).toEqual(DEFAULT_RELAYS);
  });
});

describe('planLeaving: every server that leaves is read for 30 days, at most 16', () => {
  const now = 1_800_000_000;
  it('answers the leaving servers with their ends', () => {
    const out = planLeaving([], own(3, 'old'), own(2), now);
    expect(out).toEqual({
      status: 'ok',
      leaving: own(3, 'old').map((url) => ({ url, until: now + LEAVING_SERVER_SECONDS })),
    });
  });

  it('refuses past 16 with the time from which the change fits', () => {
    const prev: LeavingServer[] = own(14, 'prev').map((url, i) => ({ url, until: now + 100 + i }));
    const out = planLeaving(prev, own(3, 'old'), own(2), now);
    // 14 + 3 = 17: the earliest of the kept entries must end first.
    expect(out).toEqual({ status: 'refused', reason: 'too_many_previous', fitsAt: now + 100 });
  });
});

// --- the change through the core ---------------------------------------------------------------

const clock = new FakeClock();

class RelaySpy {
  readonly factory: TransportFactory = (deps) => ({
    wrap: (envelope, recipients, keys) =>
      wrapEnvelope(envelope, recipients, keys, { now: deps.now }),
    publish: (_event, relays) =>
      Promise.resolve({
        results: relays.map((relay) => ({ relay, ok: true, reason: 'ok' as const })),
        acked: [...relays],
        sent: true,
      } as PublishOutcome),
    sync: () =>
      Promise.resolve({
        partial: false,
        delivered: 0,
        duplicates: 0,
        dropped: 0,
        deferred: 0,
        relays: [],
      }),
  });
}

async function agent(n: number, owner: MemoryOwnerKeyStore, name: string): Promise<TestAgent> {
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const keyStore: KeyStore = new MemoryKeyStore(seed(n), { nowSeconds: () => clock.now() });
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    transport: new RelaySpy().factory,
    policyMark: new MemoryPolicyMark(),
  });
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name,
    relays: RELAYS,
  });
  return {
    client,
    store,
    cipher,
    keyStore,
    owner: owner as unknown as TestOwner,
    id: client.agentId,
  };
}

async function change(x: TestAgent, relays: readonly string[], announceDefault?: boolean) {
  await x.client.identity.rotate({
    owner: await x.owner.unlock(passphrase()),
    ownerKeys: await x.owner.getPublicKeys(),
    epochControl: x.owner.epochControl(x.keyStore),
    relays,
    ...(announceDefault === undefined ? {} : { announceDefault }),
  });
}

async function cardUpdateBodies(x: TestAgent): Promise<Record<string, JsonValue>[]> {
  const rows = await x.store.transaction((tx) =>
    tx
      .select('envelopes', { direction: 'out', type: 'card-update' })
      .filter((row) => row.contact_id !== null),
  );
  const out: Record<string, JsonValue>[] = [];
  for (const row of rows) {
    if (row.payload_json == null) throw new Error('test: no payload');
    const text = await x.cipher.open(
      { table: 'envelopes', column: 'payload_json', rowKey: rowKeyOf([row.envelope_id]) },
      row.payload_json,
    );
    out.push((JSON.parse(text) as { body: Record<string, JsonValue> }).body);
  }
  return out;
}

const ownerA = new MemoryOwnerKeyStore(seed(181), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(182), passphrase());
let a: TestAgent;
let b: TestAgent;

beforeEach(async () => {
  a = await agent(81, ownerA, 'alice');
  b = await agent(82, ownerB, 'bob');
  await pairWith(clock, a, b);
  await pairWith(clock, b, a);
});

describe('a server-list change through the core (07 §4.3; 04 §2.6)', () => {
  it('contacts receive a card-update with the new list; the progress read counts them', async () => {
    expect((await a.client.cardUpdates.progress()).changedAt).toBeNull();
    const list = [...own(2), ...DEFAULT_RELAYS.slice(0, 2)];
    await change(a, list, true);
    const before = await a.client.cardUpdates.progress();
    expect(before.changedAt).toBe(clock.now());
    expect(before).toMatchObject({ total: 1, sent: 0, waiting: 1 });
    expect(before.items).toEqual([{ contactId: b.id, state: 'waiting' }]);
    expect(await a.client.sendCardUpdates()).toMatchObject({ sent: 1 });
    const bodies = await cardUpdateBodies(a);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.relays).toEqual(list);
    const after = await a.client.cardUpdates.progress();
    expect(after).toMatchObject({ total: 1, sent: 1, waiting: 0 });
    expect(after.items).toEqual([{ contactId: b.id, state: 'sent' }]);
  });

  it('a restore of the store keeps the list and the announce choice', async () => {
    await change(a, own(3), false);
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
      clock: clock.now,
      policyMark: new MemoryPolicyMark(),
    });
    expect(await client.identity.relays()).toEqual(own(3));
    expect(await client.identity.announceDefault()).toBe(false);
  });
});

describe('an interrupted server-list change finishes on the next open', () => {
  it('commits the signed list and the announce choice with the card', async () => {
    const owner = new MemoryOwnerKeyStore(seed(183), passphrase());
    const inner = new MemoryKeyStore(seed(83));
    let failPop = false;
    const keyStore: KeyStore = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'signCardPop' && failPop) {
          return () => Promise.reject(new Error('test: interrupted after the advance'));
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...x: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const store = new MemoryStore();
    const cipher = new TestStoreCipher();
    const mark = new MemoryPolicyMark();
    const open = () =>
      AgentLinkClient.create({
        keyStore,
        store,
        cipher,
        approvals: new RecordingApprovalChannel(),
        clock: clock.now,
        transport: new RelaySpy().factory,
        policyMark: mark,
      });
    const first = await open();
    await first.identity.init({
      owner: await owner.unlock(passphrase()),
      ownerKeys: await owner.getPublicKeys(),
      name: 'Dora',
      relays: RELAYS,
    });
    failPop = true;
    await expect(
      first.identity.rotate({
        owner: await owner.unlock(passphrase()),
        ownerKeys: await owner.getPublicKeys(),
        epochControl: owner.epochControl(inner),
        relays: own(3),
        announceDefault: false,
      }),
    ).rejects.toThrow();
    expect(await first.identity.sendState()).toBe('rotation_pending');
    expect(await first.identity.relays()).toEqual(RELAYS);
    failPop = false;
    const next = await open();
    expect((await next.identity.get())?.keyEpoch).toBe(1);
    expect(await next.identity.relays()).toEqual(own(3));
    expect(await next.identity.announceDefault()).toBe(false);
    expect(await next.identity.leavingServers()).toEqual(
      RELAYS.map((url) => ({ url, until: clock.now() + LEAVING_SERVER_SECONDS })),
    );
    expect(await next.identity.sendState()).toBe('ready');
  });
});
