// M1-5b-c: transport hardening follow-ups (IR-M1-5b-1 L-2, L-6, I-1 to I-3). Fake clock, mock relays.
import { createLogger, type Level } from '@4thtech-io/log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NIP11_MAX_BYTES, NIP11_TIMEOUT_MS, RelayPool } from './relay-pool.js';
import { MockNetwork, makeWrapEvent, relayUrls } from './testing/mock-network.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const net = new MockNetwork();
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    sink: (_l: Level, line: string) => lines.push(line),
  });
  const pool = new RelayPool({
    connector: net,
    addressCheck: { resolver: net },
    nip11: net,
    logger,
  });
  return { net, pool, lines };
}

describe('NIP-11 bound', () => {
  it('has its own time bound, well inside the 10 s connect budget', () => {
    expect(NIP11_TIMEOUT_MS).toBeGreaterThan(0);
    expect(NIP11_TIMEOUT_MS).toBeLessThan(10_000);
  });

  it('publishes to a working relay although its NIP-11 fetch never answers', async () => {
    const { net, pool } = setup();
    const [a, b] = relayUrls('hang', 2) as [string, string];
    net.configure(a, { nip11Hang: true });
    net.configure(b);
    const pending = pool.publish(makeWrapEvent(), [a, b]);
    await vi.advanceTimersByTimeAsync(NIP11_TIMEOUT_MS);
    const outcome = await pending;
    expect(outcome.results.map((r) => r.reason)).toEqual(['ok', 'ok']);
    expect(outcome.sent).toBe(true);
  });

  it('uses the default limits for that attempt and asks again only after the failure cache', async () => {
    const { net, pool } = setup();
    const [a] = relayUrls('hang2', 1) as [string];
    net.configure(a, { nip11Hang: true });
    const pending = pool.publish(makeWrapEvent(), [a]);
    await vi.advanceTimersByTimeAsync(NIP11_TIMEOUT_MS);
    await pending;
    expect(pool.relayHealth().find((h) => h.relay === a)?.maxMessageLength).toBeUndefined();
    await pool.publish(makeWrapEvent(), [a]);
    expect(net.nip11Fetches).toHaveLength(1);
  });

  it('passes the size bound to the fetcher', async () => {
    const { net, pool } = setup();
    const [a] = relayUrls('opt', 1) as [string];
    net.configure(a, { maxMessageLength: 5000 });
    await pool.publish(makeWrapEvent(), [a]);
    expect(net.nip11Options[0]).toMatchObject({ maxBytes: NIP11_MAX_BYTES });
  });

  it('never logs the relay URL path or query for a NIP-11 failure', async () => {
    const { net, pool, lines } = setup();
    const url = 'wss://nip11-log.nostr-test.dev/secret-path?token=abc';
    net.configure(url, { nip11Hang: true });
    const pending = pool.publish(makeWrapEvent(), [url]);
    await vi.advanceTimersByTimeAsync(NIP11_TIMEOUT_MS);
    await pending;
    const text = lines.join('\n');
    expect(text).not.toContain('secret-path');
    expect(text).not.toContain('token=abc');
  });
});

describe('closed pool', () => {
  it('reports its own code on publish and connect, not invalid_url', async () => {
    const { net, pool } = setup();
    const [a] = relayUrls('closed', 1) as [string];
    net.configure(a);
    pool.close();
    expect((await pool.publish(makeWrapEvent(), [a])).results[0]?.reason).toBe('pool_closed');
    expect(await pool.connect(a)).toBe('pool_closed');
  });
});

describe('health output', () => {
  it('names a relay by origin only: no path, query or fragment', async () => {
    const { net, pool } = setup();
    const url = 'wss://health-0.nostr-test.dev:8443/secret-path?token=abc';
    net.configure(url);
    await pool.publish(makeWrapEvent(), [url]);
    const health = pool.relayHealth();
    expect(health).toHaveLength(1);
    expect(health[0]?.relay).toBe('wss://health-0.nostr-test.dev:8443');
    expect(JSON.stringify(health)).not.toContain('secret-path');
    expect(JSON.stringify(health)).not.toContain('token');
  });
});
