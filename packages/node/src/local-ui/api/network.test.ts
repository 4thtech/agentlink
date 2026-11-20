// NET-ROUTE (08 §1 `GET /api/ui/network`; 07 §4.3; 04 §4; 06 §4; I-5, I-7; owner D1, 19 Nov 2026):
// the Message network view's read, for Advanced › Message network (Under the hood only).
//
// - A read route (presence: false) behind the same gate as every /api/ui/ read; not an MCP tool.
// - One fixed, allowlisted answer built field by field (the exact shape is pinned below as
//   NETWORK_SHAPE: the UI card NET-UI-A builds against it).
// - Server hostnames: the origin host only (no scheme, path, query or credentials; a port only when
//   it is not 443). Contacts' hosts only with `?contacts=hosts`, treated as inbound content: plain
//   lowercase DNS text that passes the relay rule, length-capped, anything else left out.
// - Counters only: no message, event or contact identifier but the contact `ref` the Contacts page
//   already uses, and only in the expanded answer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalUiContext } from '../context.js';
import type { LocalUiReadRoute } from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import {
  NETWORK_MAX_CONTACT_HOSTS,
  NETWORK_MAX_HOST_LENGTH,
  networkBody,
  networkHost,
  networkRoutes,
  type LocalUiNetworkSnapshot,
} from './network.js';
import {
  NETWORK_PROBE_MS,
  NETWORK_PROBE_WAIT_MS,
  createNetworkReader,
  type NetworkViewClient,
} from '../network-view.js';

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const REF = `0x${'ab'.repeat(20)}`;

/** The exact answer shape (the contract NET-UI-A builds against). */
const NETWORK_SHAPE = {
  agent: 'running',
  mode: 'automatic',
  checking: false,
  checkedAt: NOW,
  servers: [
    {
      host: 'relay.primal.net',
      roles: ['send', 'read'],
      kind: 'own',
      state: 'ready',
      connectMs: 42,
      roundTripMs: 48,
      signInRequired: false,
      paymentRequired: false,
      publishedOk: 3,
      publishedFailed: 1,
      received: 7,
      countsSince: NOW - 3600,
      lastOkAt: NOW - 60,
      lastError: 'ok_timeout',
      contacts: 4,
    },
    {
      host: 'nos.lol',
      roles: ['read'],
      kind: 'legacy',
      state: 'unknown',
      connectMs: null,
      roundTripMs: null,
      signInRequired: null,
      paymentRequired: null,
      publishedOk: 0,
      publishedFailed: 0,
      received: 0,
      countsSince: null,
      lastOkAt: null,
      lastError: null,
      contacts: 0,
    },
  ],
  legacyReadUntil: 1_803_945_600,
  contacts: { total: 2, sharing: 1 },
  updateWouldDrop: 2,
  // 0.5.15 (08 §1 additions; D-158): the mix-in, the announce choice, the change state, the overlap.
  mixIn: true,
  announceDefault: true,
  change: null,
  previousUntil: null,
} as const;

const snapshot = (over: Partial<LocalUiNetworkSnapshot> = {}): LocalUiNetworkSnapshot => ({
  agent: 'running',
  mode: 'automatic',
  checking: false,
  checkedAt: NOW,
  servers: [
    {
      relay: 'wss://relay.primal.net',
      kind: 'own',
      contacts: 4,
      probe: {
        state: 'ready',
        connectMs: 42,
        roundTripMs: 48,
        authRequired: false,
        paymentRequired: false,
      },
      stats: {
        origin: 'wss://relay.primal.net',
        since: NOW - 3600,
        publishedOk: 3,
        publishedFailed: 1,
        received: 7,
        lastOkAt: NOW - 60,
        lastError: 'ok_timeout',
      },
    },
    { relay: 'wss://nos.lol', kind: 'legacy' },
  ],
  legacyReadUntil: 1_803_945_600,
  contacts: { total: 2, sharing: 1 },
  updateDrops: 2,
  mixIn: true,
  announceDefault: true,
  change: null,
  ...over,
});

describe('networkHost (D1: origin host only)', () => {
  it('keeps the host, and the port only when it is not 443', () => {
    expect(networkHost('wss://relay.primal.net')).toBe('relay.primal.net');
    expect(networkHost('wss://relay.primal.net/')).toBe('relay.primal.net');
    expect(networkHost('wss://relay.example.org/secret/token')).toBe('relay.example.org');
    expect(networkHost('wss://relay.example.org:443')).toBe('relay.example.org');
    expect(networkHost('wss://relay.example.org:8443/x')).toBe('relay.example.org:8443');
  });

  it('answers null for anything that is not a plain relay URL (inbound content, I-5)', () => {
    for (const bad of [
      'wss://user:pw@relay.example.org',
      'wss://relay.example.org?token=1',
      'wss://relay.example.org#x',
      'wss://Relay.Example.org',
      'ws://relay.example.org',
      'https://relay.example.org',
      'wss://<script>alert(1)</script>',
      'wss://relay.example.org‮',
      'wss://10.0.0.1',
      'wss://localhost',
      `wss://${'a'.repeat(NETWORK_MAX_HOST_LENGTH)}.org`,
      'wss://relay.example.org:0',
      'wss://relay.example.org:99999',
      '',
      42,
      null,
    ]) {
      expect(networkHost(bad)).toBeNull();
    }
  });
});

describe('networkBody (NET-ROUTE)', () => {
  it('answers exactly the pinned shape', () => {
    expect(networkBody(snapshot(), NOW_MS, false)).toEqual(NETWORK_SHAPE);
  });

  it('0.5.15 additions: custom with the mix-in off and the opt-out, a change finishing, the overlap', () => {
    const body = networkBody(
      snapshot({
        mode: 'custom',
        mixIn: false,
        announceDefault: false,
        change: 'rotation_pending',
        previousUntil: NOW + 30 * 86_400,
      }),
      NOW_MS,
      false,
    );
    expect(body).toMatchObject({
      mode: 'custom',
      mixIn: false,
      announceDefault: false,
      change: 'rotation_pending',
      previousUntil: NOW + 30 * 86_400,
    });
    // Paused always says so; anything else is the fixed default.
    expect(networkBody(snapshot({ agent: 'paused' }), NOW_MS, false).change).toBe('paused');
    const odd = networkBody(
      snapshot({
        mixIn: 'yes' as never,
        announceDefault: 0 as never,
        change: 'later' as never,
        previousUntil: -1,
      }),
      NOW_MS,
      false,
    );
    expect(odd).toMatchObject({
      mixIn: false,
      announceDefault: true,
      change: null,
      previousUntil: null,
    });
    // Absent (an older reader): the defaults.
    const { mixIn: _m, announceDefault: _a, change: _c, ...older } = snapshot();
    void _m;
    void _a;
    void _c;
    expect(networkBody(older, NOW_MS, false)).toMatchObject({
      mixIn: false,
      announceDefault: true,
      change: null,
      previousUntil: null,
    });
  });

  it('maps the probe states to the view states', () => {
    const state = (probe: Record<string, unknown>): unknown =>
      networkBody(
        snapshot({
          servers: [
            {
              relay: 'wss://a.example.org',
              kind: 'own',
              probe: {
                connectMs: null,
                roundTripMs: null,
                authRequired: null,
                paymentRequired: null,
                ...probe,
              },
            } as never,
          ],
        }),
        NOW_MS,
        false,
      ).servers[0]?.state;
    expect(state({ state: 'ready', connectMs: 1, roundTripMs: 2 })).toBe('ready');
    expect(state({ state: 'timeout', connectMs: 10 })).toBe('slow');
    expect(state({ state: 'timeout' })).toBe('unreachable');
    // NET-VIEW-0514-1: a probe over the pool's open connection that got no answer in time is slow:
    // the connection is up (the pool holds it), so it is never "can't reach".
    expect(state({ state: 'timeout', reused: true })).toBe('slow');
    expect(state({ state: 'timeout', reused: 'yes' })).toBe('unreachable');
    expect(state({ state: 'unreachable' })).toBe('unreachable');
    expect(state({ state: 'blocked' })).toBe('blocked');
    expect(state({ state: 'invalid' })).toBe('unknown');
    expect(state({ state: 'something-else' })).toBe('unknown');
  });

  it('drops a server whose URL is not showable, and fields it does not know', () => {
    const body = networkBody(
      snapshot({
        servers: [
          { relay: 'wss://x.example.org/some/path', kind: 'own', extra: 'leak' } as never,
          { relay: 'wss://y.example.org/<b>', kind: 'own' },
          { relay: 'wss://user@bad.example.org', kind: 'own' },
          { relay: 'wss://ok.example.org', kind: 'weird' } as never,
        ],
      }),
      NOW_MS,
      false,
    );
    expect(body.servers.map((s) => s.host)).toEqual(['x.example.org']);
    expect(JSON.stringify(body)).not.toContain('leak');
    expect(JSON.stringify(body)).not.toContain('<b>');
    expect(JSON.stringify(body)).not.toContain('some/path');
  });

  it('caps the server list and refuses bad numbers and error text', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      relay: `wss://r${i}.example.org`,
      kind: 'own' as const,
      probe: {
        state: 'ready' as const,
        connectMs: -1,
        roundTripMs: 1.5,
        authRequired: 'yes' as never,
        paymentRequired: true,
      },
      stats: {
        origin: `wss://r${i}.example.org`,
        since: NOW + 99_999,
        publishedOk: -3,
        publishedFailed: Number.NaN,
        received: 2 ** 60,
        lastOkAt: 'x' as never,
        lastError: 'relay said: <b>hi</b>' as never,
      },
    }));
    const body = networkBody(snapshot({ servers: many }), NOW_MS, false);
    expect(body.servers.length).toBeLessThanOrEqual(26);
    const s = body.servers[0];
    expect(s).toMatchObject({
      connectMs: null,
      roundTripMs: null,
      signInRequired: null,
      paymentRequired: true,
      publishedOk: 0,
      publishedFailed: 0,
      received: 0,
      countsSince: null,
      lastOkAt: null,
      lastError: null,
    });
  });

  it('contacts: counts by default; hosts only when asked, plain text, capped', () => {
    const contactLists = [
      {
        contactId: REF,
        relays: [
          'wss://relay.primal.net',
          'wss://their.example.net/path/secret-token',
          'wss://<img src=x onerror=alert(1)>',
          ...Array.from({ length: 30 }, (_, i) => `wss://h${i}.example.net`),
        ],
        shared: 1,
      },
      { contactId: 'not-a-ref', relays: ['wss://x.example.net'], shared: 0 },
    ];
    const plain = networkBody(snapshot({ contactLists }), NOW_MS, false);
    expect(plain).not.toHaveProperty('contactHosts');
    expect(JSON.stringify(plain)).not.toContain('their.example.net');
    const expanded = networkBody(snapshot({ contactLists }), NOW_MS, true);
    expect(expanded.contactHosts).toHaveLength(1);
    const [row] = expanded.contactHosts ?? [];
    expect(Object.keys(row ?? {}).sort()).toEqual(['hosts', 'ref', 'servers', 'shared']);
    expect(row?.ref).toBe(REF);
    expect(row?.servers).toBe(33);
    expect(row?.shared).toBe(1);
    expect(row?.hosts.slice(0, 2)).toEqual(['relay.primal.net', 'their.example.net']);
    expect(row?.hosts.length).toBe(NETWORK_MAX_CONTACT_HOSTS);
    const text = JSON.stringify(expanded);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('<img');
    expect(text).not.toContain('wss://');
  });

  it('a paused agent: servers listed, no probe facts', () => {
    const body = networkBody(snapshot({ agent: 'paused' }), NOW_MS, false);
    expect(body.agent).toBe('paused');
  });
});

describe('GET /api/ui/network (NET-ROUTE)', () => {
  const ctx = (network?: LocalUiContext['network']): LocalUiContext => ({
    client: undefined,
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: () => Promise.reject(new Error('never called')),
    now: () => NOW_MS,
    ...(network === undefined ? {} : { network }),
  });
  const route = networkRoutes[0] as LocalUiReadRoute;

  it('is one GET read route without presence, registered with the others', () => {
    expect(networkRoutes).toHaveLength(1);
    expect(route).toMatchObject({ method: 'GET', path: '/api/ui/network', presence: false });
    const all = createLocalUiRoutes().routes();
    expect(all.some((r) => r.path === '/api/ui/network' && r.method === 'GET')).toBe(true);
  });

  it('answers needs_setup without a network source', async () => {
    const res = await route?.handler(ctx(), { params: {}, query: new URLSearchParams() });
    expect(res?.status).toBe(200);
    expect(res?.body).toEqual({
      agent: 'needs_setup',
      mode: null,
      checking: false,
      checkedAt: null,
      servers: [],
      legacyReadUntil: null,
      contacts: { total: 0, sharing: 0 },
      updateWouldDrop: 0,
      mixIn: false,
      announceDefault: true,
      change: null,
      previousUntil: null,
    });
  });

  it('passes the expand choice on; any other query is 400 invalid_query', async () => {
    const seen: boolean[] = [];
    const network: LocalUiContext['network'] = (options) => {
      seen.push(options.contactHosts);
      return Promise.resolve(networkBody(snapshot(), NOW_MS, options.contactHosts));
    };
    const call = (q: string) =>
      route?.handler(ctx(network), { params: {}, query: new URLSearchParams(q) });
    expect((await call(''))?.status).toBe(200);
    expect((await call('contacts=hosts'))?.status).toBe(200);
    expect(seen).toEqual([false, true]);
    for (const bad of [
      'contacts=all',
      'contacts=hosts&contacts=hosts',
      'x=1',
      'contacts=hosts&x=1',
    ]) {
      const res = await call(bad);
      expect(res?.status).toBe(400);
      expect(res?.body).toEqual({ error: 'invalid_query' });
    }
    expect(seen).toEqual([false, true]);
  });

  it('a failing source answers 503 unavailable, never its text', async () => {
    const res = await route?.handler(
      ctx(() => Promise.reject(new Error('wss://secret.example.org boom'))),
      { params: {}, query: new URLSearchParams() },
    );
    expect(res?.status).toBe(503);
    expect(JSON.stringify(res?.body)).not.toContain('secret');
  });
});

describe('the network reader (NET-PROBE bounds)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeClient(options: { paused?: boolean; probeMs?: number } = {}) {
    let probes = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let lists = 0;
    let statsMark = 'm1';
    const client: NetworkViewClient = {
      network: {
        servers: () =>
          Promise.resolve({
            paused: options.paused === true,
            mode: 'automatic',
            own: ['wss://relay.primal.net'],
            legacy: ['wss://nos.lol'],
            legacyReadUntil: 1_803_945_600,
          }),
        probe: async () => {
          probes += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, options.probeMs ?? 10));
          inFlight -= 1;
          return [
            {
              relay: 'wss://relay.primal.net',
              result: {
                state: 'ready',
                connectMs: 5,
                roundTripMs: 6,
                authRequired: false,
                paymentRequired: false,
              },
            },
          ];
        },
        stats: () => Promise.resolve([]),
        contactReach: (o) => {
          if (o.lists) lists += 1;
          return Promise.resolve({
            total: 1,
            sharing: 1,
            perServer: { 'wss://relay.primal.net': 1, 'wss://nos.lol': 0 },
            ...(o.lists
              ? { lists: [{ contactId: REF, relays: ['wss://relay.primal.net'], shared: 1 }] }
              : {}),
          });
        },
        statsMark: () => Promise.resolve(statsMark),
      },
    };
    return {
      client,
      probes: () => probes,
      maxInFlight: () => maxInFlight,
      lists: () => lists,
      setMark: (m: string) => {
        statsMark = m;
      },
    };
  }

  it('probes at most once per window, never two at once, and answers within the wait bound', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fake = fakeClient({ probeMs: 5_000 });
    const reader = createNetworkReader(fake.client, { now: () => Date.now() });
    const first = reader.read({ contactHosts: false });
    await vi.advanceTimersByTimeAsync(NETWORK_PROBE_WAIT_MS);
    const a = await first;
    expect(a.checking).toBe(true);
    expect(a.servers[0]?.state).toBe('unknown');
    // A second read while the probe runs starts no other.
    const b = await reader.read({ contactHosts: false });
    expect(b.checking).toBe(true);
    expect(fake.probes()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    const c = await reader.read({ contactHosts: false });
    expect(c.checking).toBe(false);
    expect(c.servers[0]?.state).toBe('ready');
    expect(Number.isInteger(c.checkedAt)).toBe(true);
    expect(fake.probes()).toBe(1);
    await vi.advanceTimersByTimeAsync(NETWORK_PROBE_MS);
    const pending = reader.read({ contactHosts: false });
    await vi.advanceTimersByTimeAsync(NETWORK_PROBE_WAIT_MS);
    await pending;
    expect(fake.probes()).toBe(2);
    expect(fake.maxInFlight()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it('reads the contacts lists only for the expanded answer', async () => {
    const fake = fakeClient();
    const reader = createNetworkReader(fake.client, { now: () => Date.now() });
    const plain = await reader.read({ contactHosts: false });
    expect(plain).not.toHaveProperty('contactHosts');
    expect(fake.lists()).toBe(0);
    const expanded = await reader.read({ contactHosts: true });
    expect(expanded.contactHosts?.[0]?.hosts).toEqual(['relay.primal.net']);
    // Per-server contact counts are always there, also without the expand.
    expect(plain.servers.map((s) => [s.host, s.contacts])).toEqual([
      ['relay.primal.net', 1],
      ['nos.lol', 0],
    ]);
    expect(expanded.servers[0]?.contacts).toBe(1);
    expect(fake.lists()).toBe(1);
  });

  it('a paused agent is never probed', async () => {
    const fake = fakeClient({ paused: true });
    const reader = createNetworkReader(fake.client, { now: () => Date.now() });
    const body = await reader.read({ contactHosts: false });
    expect(body.agent).toBe('paused');
    expect(body.checking).toBe(false);
    expect(fake.probes()).toBe(0);
  });

  it('the mark changes with the counters and with a finished probe, and names nothing', async () => {
    const fake = fakeClient({ probeMs: 1 });
    const reader = createNetworkReader(fake.client, { now: () => Date.now() });
    const m0 = await reader.mark();
    expect(await reader.mark()).toBe(m0);
    fake.setMark('m2');
    const m1 = await reader.mark();
    expect(m1).not.toBe(m0);
    await reader.read({ contactHosts: false });
    await new Promise((r) => setTimeout(r, 20));
    const m2 = await reader.mark();
    expect(m2).not.toBe(m1);
    expect(m2).not.toContain('relay');
  });

  it('an unreadable own list rejects with fixed text (the route answers 503); other faults do not', async () => {
    const client: NetworkViewClient = {
      network: {
        servers: () => Promise.reject(new Error('wss://secret.example.org')),
        probe: () => Promise.reject(new Error('x')),
        stats: () => Promise.reject(new Error('x')),
        contactReach: () => Promise.reject(new Error('x')),
        statsMark: () => Promise.reject(new Error('x')),
      },
    };
    const reader = createNetworkReader(client, { now: () => Date.now() });
    const err = await reader.read({ contactHosts: true }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain('secret');
    expect(await reader.mark()).toBeUndefined();
    const route = networkRoutes[0] as LocalUiReadRoute;
    const res = await route.handler(
      {
        client: undefined,
        ownerContext: () => Promise.resolve(undefined),
        applyOwnerAction: () => Promise.reject(new Error('never called')),
        now: () => NOW_MS,
        network: (o) => reader.read(o),
      },
      { params: {}, query: new URLSearchParams() },
    );
    expect(res).toEqual({ status: 503, body: { error: 'unavailable' } });
    // Only the own list is a read failure: stats, contacts and probe faults still answer.
    const partial = createNetworkReader(
      {
        network: {
          ...client.network,
          servers: () =>
            Promise.resolve({
              paused: false,
              mode: 'custom',
              own: ['wss://a.example.org', 'wss://b.example.org'],
              legacy: [],
              legacyReadUntil: 1,
            }),
        },
      },
      { now: () => Date.now() },
    );
    const body = await partial.read({ contactHosts: true });
    expect(body.agent).toBe('running');
    expect(body.servers.map((s) => s.host)).toEqual(['a.example.org', 'b.example.org']);
    expect(body.updateWouldDrop).toBe(0);
  });
});
