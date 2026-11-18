// SEC-RELAY-READBACK (D-156 (7); 07 §4.2, §4.3): RelayPool.checkServed asks one relay, on a fresh
// connection and without logging in, whether it serves an event by its id. Mock relays only: no
// network. Fake timers drive the 5 s bound.
import { createLogger, type Level } from '@4thtech-io/log';
import { MemoryKeyStore } from '@4thtech-io/crypto/testing';
import { encodeHex, randomBytes, type EnvelopeKeys } from '@4thtech-io/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_READBACKS,
  READBACK_TIMEOUT_MS,
  RelayPool,
  type RelayPoolOptions,
} from './relay-pool.js';
import { MockNetwork, makeWrapEvent, relayUrls } from './testing/mock-network.js';

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

const frames = (net: MockNetwork, relay: string, kind: string): unknown[][] =>
  net.received
    .filter((r) => r.relay === relay)
    .map((r) => JSON.parse(r.frame) as unknown[])
    .filter((f) => f[0] === kind);

describe('checkServed', () => {
  it('is served when the relay returns the event by its id on a fresh connection', async () => {
    const { net, pool } = setup();
    const [relay] = relayUrls('rb', 1) as [string];
    net.configure(relay);
    const event = makeWrapEvent();
    expect((await pool.publish(event, [relay, relay])).acked).toEqual([relay]);
    const sockets = net.sockets.length;
    expect(await pool.checkServed(relay, event.id)).toBe('served');
    // A new socket, not the one that published.
    expect(net.sockets.length).toBe(sockets + 1);
    const reqs = net.reqs(relay);
    expect(reqs).toHaveLength(1);
    // Only the id, no key, no kind, no author: nothing that names who asks.
    expect(reqs[0]?.filter).toEqual({ ids: [event.id], limit: 1 });
    // The check's socket is closed afterwards and never pooled.
    expect(net.sockets.at(-1)?.closed).toBe(true);
    expect(pool.connectionCount).toBe(1);
  });

  it('is missing when the relay answered OK but does not serve the event', async () => {
    const { net, pool } = setup();
    const [relay] = relayUrls('never', 1) as [string];
    net.configure(relay, { neverServes: true });
    const event = makeWrapEvent();
    await pool.publish(event, [relay]);
    expect(await pool.checkServed(relay, event.id)).toBe('missing');
  });

  it('is missing when the relay serves the event only to the connection that published it', async () => {
    const { net, pool } = setup();
    const [relay] = relayUrls('same', 1) as [string];
    net.configure(relay, { sameSocketOnly: true });
    const event = makeWrapEvent();
    await pool.publish(event, [relay]);
    expect(await pool.checkServed(relay, event.id)).toBe('missing');
  });

  it('never logs in: a relay that wants a login for reading is unchecked, and no AUTH is sent', async () => {
    const keys = new MemoryKeyStore(randomBytes(32)) as EnvelopeKeys;
    const { net, pool } = setup({ authKeys: keys, mayAuthenticate: () => true });
    const [relay] = relayUrls('gated', 1) as [string];
    net.configure(relay, { reqNeedsAuth: true });
    const event = makeWrapEvent();
    await pool.publish(event, [relay]);
    const before = frames(net, relay, 'AUTH').length;
    expect(await pool.checkServed(relay, event.id)).toBe('unchecked');
    expect(frames(net, relay, 'AUTH').length).toBe(before);
  });

  it('is unchecked on a relay that demands a login for everything', async () => {
    const keys = new MemoryKeyStore(randomBytes(32)) as EnvelopeKeys;
    const { net, pool } = setup({ authKeys: keys, mayAuthenticate: () => true });
    const [relay] = relayUrls('authall', 1) as [string];
    net.configure(relay, { requireAuth: true });
    const event = makeWrapEvent();
    expect((await pool.publish(event, [relay])).acked).toEqual([relay]);
    const before = frames(net, relay, 'AUTH').length;
    expect(await pool.checkServed(relay, event.id)).toBe('unchecked');
    expect(frames(net, relay, 'AUTH').length).toBe(before);
  });

  it('does not count another event, or a forged copy, as served', async () => {
    const { net, pool } = setup();
    const [other, forged] = relayUrls('fake', 2) as [string, string];
    const event = makeWrapEvent();
    net.configure(other, { serveInstead: makeWrapEvent() });
    const copy = { ...event, sig: '0'.repeat(128) };
    net.configure(forged, { serveInstead: copy });
    expect(await pool.checkServed(other, event.id)).toBe('missing');
    expect(await pool.checkServed(forged, event.id)).toBe('missing');
  });

  it('is unchecked within the time bound on a relay that never answers or never connects', async () => {
    const { net, pool } = setup();
    const [quiet, hole] = relayUrls('slow', 2) as [string, string];
    net.configure(quiet, { silentIdsReq: true });
    net.configure(hole, { blackHole: true });
    const event = makeWrapEvent();
    const results: string[] = [];
    void pool.checkServed(quiet, event.id).then((r) => results.push(r));
    void pool.checkServed(hole, event.id).then((r) => results.push(r));
    await vi.advanceTimersByTimeAsync(READBACK_TIMEOUT_MS - 1);
    expect(results).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(results).toEqual(['unchecked', 'unchecked']);
    expect(net.sockets.every((s) => s.closed)).toBe(true);
  });

  it('applies the relay address rule: a relay that resolves to a private address is never opened', async () => {
    const { net, pool } = setup();
    const [relay] = relayUrls('private', 1) as [string];
    net.dns.set(relay.slice('wss://'.length), ['10.0.0.7']);
    expect(await pool.checkServed(relay, encodeHex(randomBytes(32)))).toBe('unchecked');
    expect(net.opens).toHaveLength(0);
  });

  it('refuses a bad relay URL or a bad id without opening anything', async () => {
    const { net, pool } = setup();
    expect(await pool.checkServed('ws://plain.example.com', encodeHex(randomBytes(32)))).toBe(
      'unchecked',
    );
    const [relay] = relayUrls('badid', 1) as [string];
    expect(await pool.checkServed(relay, 'not-an-id')).toBe('unchecked');
    expect(net.opens).toHaveLength(0);
  });

  it('bounds the checks open at once', async () => {
    const { net, pool } = setup();
    const relays = relayUrls('many', MAX_READBACKS + 1);
    for (const url of relays) net.configure(url, { silentIdsReq: true });
    const id = encodeHex(randomBytes(32));
    const results: string[] = [];
    for (const url of relays) void pool.checkServed(url, id).then((r) => results.push(r));
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual(['unchecked']); // the one over the bound, at once
    expect(net.opens).toHaveLength(MAX_READBACKS);
    await vi.advanceTimersByTimeAsync(READBACK_TIMEOUT_MS);
    expect(results).toHaveLength(MAX_READBACKS + 1);
  });

  it('is unchecked after the pool is closed, and logs no relay address or event id', async () => {
    const { net, pool, lines } = setup();
    const [relay] = relayUrls('log', 1) as [string];
    net.configure(relay, { neverServes: true });
    const event = makeWrapEvent();
    await pool.checkServed(relay, event.id);
    for (const line of lines) expect(line).not.toContain(event.id);
    pool.close();
    expect(await pool.checkServed(relay, event.id)).toBe('unchecked');
  });
});
