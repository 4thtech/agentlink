// NET-PROBE (07 §4.2, §4.3; 04 §4; I-5, I-7): RelayPool.probe asks one relay, on a fresh connection
// and without logging in, how fast it connects and answers one empty REQ, and whether it wants a
// sign-in (NIP-42 auth-required) or a payment (NIP-11). Mock relays only: no network. Fake timers
// drive the bounds.
import { createLogger, type Level } from '@4thtech-io/log';
import { MemoryKeyStore } from '@4thtech-io/crypto/testing';
import { randomBytes, type EnvelopeKeys } from '@4thtech-io/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_READBACKS,
  PROBE_TIMEOUT_MS,
  RelayPool,
  relayOrigin,
  type RelayPoolOptions,
  type RelayProbeResult,
} from './relay-pool.js';
import { MockNetwork, relayUrls } from './testing/mock-network.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(options: Partial<RelayPoolOptions> = {}) {
  const net = new MockNetwork();
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    sink: (_level: Level, line: string) => lines.push(line),
  });
  const pool = new RelayPool({
    connector: net,
    addressCheck: { resolver: net },
    nip11: net,
    logger,
    ...options,
  });
  return { net, pool, lines };
}

const KEYS = ['authRequired', 'connectMs', 'paymentRequired', 'reused', 'roundTripMs', 'state'];

const frames = (net: MockNetwork, relay: string, kind: string): unknown[][] =>
  net.received
    .filter((r) => r.relay === relay)
    .map((r) => JSON.parse(r.frame) as unknown[])
    .filter((f) => f[0] === kind);

describe('RelayPool.probe (NET-PROBE)', () => {
  it('a working relay is ready, with whole-millisecond connect and round-trip times', async () => {
    const { net, pool } = setup();
    const [relay] = relayUrls('fast', 1) as [string];
    net.configure(relay, { reqDelayMs: 40 });
    const pending = pool.probe(relay);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(Object.keys(result).sort()).toEqual(KEYS);
    expect(result.state).toBe('ready');
    expect(Number.isInteger(result.connectMs)).toBe(true);
    expect(result.roundTripMs).toBeGreaterThanOrEqual(40);
    expect(result.roundTripMs).toBeLessThan(100);
    expect(result.authRequired).toBe(false);
    expect(result.paymentRequired).toBe(false);
    // One REQ, by one random id only: nothing that names who asks.
    const reqs = net.reqs(relay);
    expect(reqs).toHaveLength(1);
    expect(Object.keys(reqs[0]?.filter ?? {}).sort()).toEqual(['ids', 'limit']);
    expect(reqs[0]?.filter.ids?.[0]).toMatch(/^[0-9a-f]{64}$/);
    // A fresh socket, closed afterwards and never pooled.
    expect(net.sockets.every((s) => s.closed)).toBe(true);
    expect(pool.connectionCount).toBe(0);
    // Two probes never send the same id.
    const again = pool.probe(relay);
    await vi.advanceTimersByTimeAsync(100);
    await again;
    const ids = net.reqs(relay).map((r) => r.filter.ids?.[0]);
    expect(new Set(ids).size).toBe(2);
  });

  it('flags a relay that wants a sign-in to read, and never logs in', async () => {
    const keys = new MemoryKeyStore(randomBytes(32)) as EnvelopeKeys;
    const { net, pool } = setup({ authKeys: keys, mayAuthenticate: () => true });
    const [relay] = relayUrls('gated', 1) as [string];
    net.configure(relay, { reqNeedsAuth: true });
    const result = await pool.probe(relay);
    expect(result.state).toBe('ready');
    expect(result.authRequired).toBe(true);
    expect(frames(net, relay, 'AUTH')).toHaveLength(0);
  });

  it('reads the sign-in and payment flags of the NIP-11 document', async () => {
    const { net, pool } = setup();
    const [paid, open] = relayUrls('paid', 2) as [string, string];
    net.configure(paid, {
      nip11Body: JSON.stringify({ limitation: { auth_required: true, payment_required: true } }),
    });
    net.configure(open, {
      nip11Body: JSON.stringify({ limitation: { auth_required: 'yes', payment_required: 1 } }),
    });
    const a = await pool.probe(paid);
    expect(a).toMatchObject({ state: 'ready', authRequired: true, paymentRequired: true });
    // Anything but a JSON `true` is not a flag.
    const b = await pool.probe(open);
    expect(b).toMatchObject({ state: 'ready', authRequired: false, paymentRequired: false });
  });

  it('a missing, hanging or oversized NIP-11 document leaves the payment flag unknown', async () => {
    const { net, pool } = setup();
    const [none, hang, huge] = relayUrls('nodoc', 3) as [string, string, string];
    net.configure(none, { nip11Body: null });
    net.configure(hang, { nip11Hang: true });
    net.configure(huge, {
      nip11Body: JSON.stringify({
        limitation: { payment_required: true },
        pad: 'x'.repeat(70_000),
      }),
    });
    const results: RelayProbeResult[] = [];
    for (const relay of [none, hang, huge]) {
      const pending = pool.probe(relay);
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
      results.push(await pending);
    }
    for (const r of results) {
      expect(r.state).toBe('ready');
      expect(r.paymentRequired).toBeNull();
    }
  });

  it('ends within its bound on a relay that never connects or never answers', async () => {
    const { net, pool } = setup();
    const [hole, quiet] = relayUrls('slow', 2) as [string, string];
    net.configure(hole, { blackHole: true });
    net.configure(quiet, { silentReq: true });
    const out: RelayProbeResult[] = [];
    void pool.probe(hole).then((r) => out.push(r));
    void pool.probe(quiet).then((r) => out.push(r));
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(out).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(out).toHaveLength(2);
    const byConnect = out.sort((a, b) =>
      a.connectMs === null ? -1 : b.connectMs === null ? 1 : 0,
    );
    expect(byConnect[0]).toMatchObject({ state: 'timeout', connectMs: null, roundTripMs: null });
    expect(byConnect[1]?.state).toBe('timeout');
    expect(byConnect[1]?.connectMs).not.toBeNull();
    expect(byConnect[1]?.roundTripMs).toBeNull();
    expect(net.sockets.every((s) => s.closed)).toBe(true);
  });

  it('applies the relay address rule: a private DNS answer is blocked and never opened or fetched', async () => {
    const { net, pool } = setup();
    const [relay] = relayUrls('private', 1) as [string];
    net.dns.set(relay.slice('wss://'.length), ['127.0.0.1']);
    const result = await pool.probe(relay);
    expect(result).toEqual({
      state: 'blocked',
      connectMs: null,
      roundTripMs: null,
      authRequired: null,
      paymentRequired: null,
      reused: false,
    });
    expect(net.opens).toHaveLength(0);
    expect(net.nip11Fetches).toHaveLength(0);
  });

  it('refuses a URL outside the relay rule without resolving anything', async () => {
    const { net, pool } = setup();
    for (const bad of [
      'ws://plain.example.com',
      'wss://user:pw@relay.example.com',
      'wss://relay.example.com/?token=1',
      'wss://10.0.0.1',
      'https://relay.example.com',
    ]) {
      expect((await pool.probe(bad)).state).toBe('invalid');
    }
    expect(net.resolves).toHaveLength(0);
    expect(net.opens).toHaveLength(0);
  });

  it('a relay that cannot be resolved is unreachable', async () => {
    const { net, pool } = setup();
    const [relay] = relayUrls('gone', 1) as [string];
    net.dns.set(relay.slice('wss://'.length), []);
    expect((await pool.probe(relay)).state).toBe('unreachable');
  });

  it('shares the read-back slots and never queues: over the bound it is unknown at once', async () => {
    const { net, pool } = setup();
    const relays = relayUrls('busy', MAX_READBACKS + 1);
    for (const url of relays) net.configure(url, { silentReq: true });
    for (const url of relays.slice(0, MAX_READBACKS)) void pool.probe(url);
    const last = await pool.probe(relays[MAX_READBACKS] as string);
    expect(last.state).toBe('unknown');
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
  });

  it('after close() it opens nothing', async () => {
    const { net, pool } = setup();
    const [relay] = relayUrls('closed', 1) as [string];
    pool.close();
    expect((await pool.probe(relay)).state).toBe('unknown');
    expect(net.opens).toHaveLength(0);
  });

  it('logs nothing and returns no relay text', async () => {
    const { net, pool, lines } = setup();
    const [relay] = relayUrls('hostile', 1) as [string];
    net.configure(relay, {
      reqNeedsAuth: true,
      nip11Body: JSON.stringify({ name: '<img src=x onerror=alert(1)>', limitation: {} }),
    });
    // Nor for a server that does not resolve or resolves to a private address (no host in a log).
    const [gone, priv] = relayUrls('quiet', 2) as [string, string];
    net.dns.set(gone.slice('wss://'.length), []);
    net.dns.set(priv.slice('wss://'.length), ['10.0.0.7']);
    expect((await pool.probe(gone)).state).toBe('unreachable');
    expect((await pool.probe(priv)).state).toBe('blocked');
    const result = await pool.probe(relay);
    expect(JSON.stringify(result)).not.toContain('img');
    expect(JSON.stringify(result)).not.toContain('log in');
    expect(lines).toEqual([]);
  });
});

// NET-VIEW-0514-1: the owner's 0.5.14 view showed offchain.pub as "Can't reach" next to "Last worked
// just now". The relay limits connections from one address: the agent's pooled connection was up,
// and the probe's extra fresh connection was refused at once (ECONNREFUSED). A probe now asks over
// the pool's open connection when there is one, so it never needs a second connection to that relay.
describe('RelayPool.probe over an open pooled connection (NET-VIEW-0514-1)', () => {
  it('a relay that allows one connection per address is ready while the pool holds it', async () => {
    const { net, pool } = setup();
    const [relay] = relayUrls('limited', 1) as [string];
    net.configure(relay, { maxConnections: 1, reqDelayMs: 30 });
    const link = await pool.connect(relay);
    expect(typeof link).not.toBe('string');
    const opens = net.opens.length;
    const pending = pool.probe(relay);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.state).toBe('ready');
    expect(result.reused).toBe(true);
    expect(result.connectMs).toBeNull();
    expect(result.roundTripMs).toBeGreaterThanOrEqual(30);
    // No second connection was opened, the pooled one stays open, and the probe's REQ is closed.
    expect(net.opens.length).toBe(opens);
    expect(pool.connectionCount).toBe(1);
    expect(frames(net, relay, 'CLOSE')).toHaveLength(1);
    // Never a login on the probe's behalf.
    expect(frames(net, relay, 'AUTH')).toHaveLength(0);
    if (typeof link !== 'string') link.release();
  });

  it('without a pooled connection, the same relay still gets a fresh one', async () => {
    const { net, pool } = setup();
    const [relay] = relayUrls('limited', 1) as [string];
    net.configure(relay, { maxConnections: 1 });
    const result = await pool.probe(relay);
    expect(result).toMatchObject({ state: 'ready', reused: false });
    expect(net.sockets.every((s) => s.closed)).toBe(true);
  });

  it('a pooled connection that never answers is slow, not unreachable', async () => {
    const { net, pool } = setup();
    const [relay] = relayUrls('quietpool', 1) as [string];
    net.configure(relay, { silentReq: true });
    const link = await pool.connect(relay);
    const out: RelayProbeResult[] = [];
    void pool.probe(relay).then((r) => out.push(r));
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect(out[0]).toMatchObject({ state: 'timeout', reused: true, roundTripMs: null });
    if (typeof link !== 'string') link.release();
  });

  it('a pooled connection that drops mid-probe is unreachable at once, not at the bound', async () => {
    const { net, pool } = setup();
    const [relay] = relayUrls('droppool', 1) as [string];
    net.configure(relay, { silentReq: true });
    const link = await pool.connect(relay);
    const out: RelayProbeResult[] = [];
    void pool.probe(relay).then((r) => out.push(r));
    await vi.advanceTimersByTimeAsync(10);
    net.sockets.find((s) => !s.closed)?.dropFromRelay();
    await vi.advanceTimersByTimeAsync(10);
    expect(out[0]).toMatchObject({ state: 'unreachable', reused: true });
    if (typeof link !== 'string') link.release();
  });

  it('does not need a read-back slot when it reuses the pooled connection', async () => {
    const { net, pool } = setup();
    const relays = relayUrls('busy2', MAX_READBACKS + 1);
    for (const url of relays.slice(0, MAX_READBACKS)) net.configure(url, { silentReq: true });
    const pooled = relays[MAX_READBACKS] as string;
    const link = await pool.connect(pooled);
    for (const url of relays.slice(0, MAX_READBACKS)) void pool.probe(url);
    const result = await pool.probe(pooled);
    expect(result).toMatchObject({ state: 'ready', reused: true });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    if (typeof link !== 'string') link.release();
  });
});

describe('relayOrigin', () => {
  it('keeps the scheme, host and port only', () => {
    expect(relayOrigin('wss://relay.example.com/secret/path')).toBe('wss://relay.example.com');
    expect(relayOrigin('wss://relay.example.com:8443/x')).toBe('wss://relay.example.com:8443');
    expect(relayOrigin('not a url')).toBe('wss://invalid');
  });
});
