// M1-5b acceptance: publish to a relay list, "sent" only with at least 2 OK, NIP-11 size skip, NIP-42,
// routing, the connect-time SSRF check and the pool bounds (07 §4.2, §4.3). Mock relays only: no
// network. Fake timers drive the 10 s, 5 min and OK timeouts.
import { createLogger, type Level } from '@4thtech-io/log';
import { encodeHex, encodeUtf8, randomBytes, type EnvelopeKeys } from '@4thtech-io/crypto';
import { MemoryKeyStore } from '@4thtech-io/crypto/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportError } from './errors.js';
import {
  CONNECT_TIMEOUT_MS,
  IDLE_CLOSE_MS,
  MAX_CONNECTIONS,
  OK_TIMEOUT_MS,
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

const wrapBytes = (event: unknown): number => encodeUtf8(JSON.stringify(['EVENT', event])).length;

describe('publish and "sent"', () => {
  it('is sent when at least 2 relays return OK', async () => {
    const { net, pool } = setup();
    const [a, b, c] = relayUrls('ok', 3) as [string, string, string];
    for (const url of [a, b, c]) net.configure(url);
    const event = makeWrapEvent();
    const outcome = await pool.publish(event, [a, b, c]);
    expect(outcome.sent).toBe(true);
    expect(outcome.acked).toEqual([a, b, c]);
    expect(outcome.results.every((r) => r.ok && r.reason === 'ok')).toBe(true);
    expect(net.storedOn(event.id).sort()).toEqual([a, b, c].sort());
  });

  it('is not sent with a single OK, whichever way the others fail', async () => {
    const { net, pool } = setup();
    const [ok, no, hole] = relayUrls('mix', 3) as [string, string, string];
    net.configure(ok);
    net.configure(no, { reject: true });
    net.configure(hole, { blackHole: true });
    const pending = pool.publish(makeWrapEvent(), [ok, no, hole]);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    const outcome = await pending;
    expect(outcome.sent).toBe(false);
    expect(outcome.acked).toEqual([ok]);
    const reasons = Object.fromEntries(outcome.results.map((r) => [r.relay, r.reason]));
    expect(reasons).toEqual({ [ok]: 'ok', [no]: 'rejected', [hole]: 'connect_timeout' });
  });

  it('is not sent when one relay of a one-relay list acknowledges', async () => {
    const { net, pool } = setup();
    const [only] = relayUrls('solo', 1) as [string];
    net.configure(only);
    expect((await pool.publish(makeWrapEvent(), [only])).sent).toBe(false);
  });

  it('counts a duplicate: OK as an acknowledgement and reports a silent relay as ok_timeout', async () => {
    const { net, pool } = setup();
    const [dup, quiet] = relayUrls('dup', 2) as [string, string];
    net.configure(dup, { okMessage: 'duplicate: already have it' });
    net.configure(quiet, { silent: true });
    const pending = pool.publish(makeWrapEvent(), [dup, quiet]);
    await vi.advanceTimersByTimeAsync(OK_TIMEOUT_MS);
    const outcome = await pending;
    expect(outcome.acked).toEqual([dup]);
    expect(outcome.results.find((r) => r.relay === quiet)?.reason).toBe('ok_timeout');
  });

  it('deduplicates the list and refuses an empty list or one over 32 relays', async () => {
    const { net, pool } = setup();
    const [a, b] = relayUrls('dd', 2) as [string, string];
    net.configure(a);
    net.configure(b);
    const outcome = await pool.publish(makeWrapEvent(), [a, b, a, b]);
    expect(outcome.results).toHaveLength(2);
    await expect(pool.publish(makeWrapEvent(), [])).rejects.toMatchObject({
      code: 'invalid_relays',
    });
    await expect(pool.publish(makeWrapEvent(), relayUrls('many', 33))).rejects.toBeInstanceOf(
      TransportError,
    );
    expect(net.opens.filter((t) => t.url.includes('many'))).toHaveLength(0);
  });

  it('skips a URL that fails the relay URL rule without connecting', async () => {
    const { net, pool } = setup();
    const [good] = relayUrls('good', 1) as [string];
    net.configure(good);
    const bad = [
      'ws://relay.nostr-test.dev',
      'wss://127.0.0.1',
      'wss://localhost',
      'wss://a.nostr-test.dev/%2e',
    ];
    const outcome = await pool.publish(makeWrapEvent(), [good, ...bad]);
    expect(outcome.results.filter((r) => r.reason === 'invalid_url')).toHaveLength(bad.length);
    expect(net.resolves).toEqual(['good-0.nostr-test.dev']);
    expect(outcome.sent).toBe(false);
  });

  it('records per-relay health without any event content', async () => {
    const { net, pool } = setup();
    const [a, b] = relayUrls('hl', 2) as [string, string];
    net.configure(a, { maxMessageLength: 5000 });
    net.configure(b, { reject: true });
    await pool.publish(makeWrapEvent(), [a, b]);
    const health = pool.relayHealth();
    const ha = health.find((h) => h.relay === a);
    const hb = health.find((h) => h.relay === b);
    expect(ha).toMatchObject({
      connected: true,
      successes: 1,
      failures: 0,
      maxMessageLength: 5000,
    });
    expect(ha?.lastOkAt).toBeTypeOf('number');
    expect(hb).toMatchObject({ successes: 0, failures: 1, lastFailure: 'rejected' });
  });
});

describe('NIP-11 size limits', () => {
  it('skips a relay whose max_message_length is below the frame size, without sending to it', async () => {
    const { net, pool } = setup();
    const [big, small, other] = relayUrls('sz', 3) as [string, string, string];
    const event = makeWrapEvent({ content: 'A'.repeat(3000) });
    const bytes = wrapBytes(event);
    net.configure(big);
    net.configure(small, { maxMessageLength: bytes - 1 });
    net.configure(other, { maxMessageLength: bytes });
    const outcome = await pool.publish(event, [big, small, other]);
    const reasons = Object.fromEntries(outcome.results.map((r) => [r.relay, r.reason]));
    expect(reasons).toEqual({ [big]: 'ok', [small]: 'too_large', [other]: 'ok' });
    expect(outcome.sent).toBe(true);
    expect(
      net.received.filter((f) => f.relay === small && f.frame.startsWith('["EVENT"')),
    ).toHaveLength(0);
  });

  it('does not connect again to a relay already known to be too small', async () => {
    const { net, pool } = setup();
    const [small] = relayUrls('tiny', 1) as [string];
    net.configure(small, { maxMessageLength: 100 });
    await pool.publish(makeWrapEvent(), [small]);
    const socketsBefore = net.sockets.length;
    const second = await pool.publish(makeWrapEvent(), [small]);
    expect(second.results[0]?.reason).toBe('too_large');
    expect(net.sockets.length).toBe(socketsBefore);
  });

  it.each([
    ['not JSON', 'not json'],
    ['a string limit', JSON.stringify({ limitation: { max_message_length: '10' } })],
    ['a negative limit', JSON.stringify({ limitation: { max_message_length: -1 } })],
    ['a fractional limit', JSON.stringify({ limitation: { max_message_length: 0.5 } })],
    ['an unsafe limit', '{"limitation":{"max_message_length":1e300}}'],
    ['an array', '[1,2,3]'],
    [
      'a document over 64 KiB',
      JSON.stringify({ pad: 'x'.repeat(70_000), limitation: { max_message_length: 10 } }),
    ],
  ])('ignores a hostile NIP-11 document: %s', async (_name, body) => {
    const { net, pool } = setup();
    const [a, b] = relayUrls('hostile', 2) as [string, string];
    net.configure(a, { nip11Body: body });
    net.configure(b);
    const outcome = await pool.publish(makeWrapEvent(), [a, b]);
    expect(outcome.sent).toBe(true);
    expect(pool.relayHealth().find((h) => h.relay === a)?.maxMessageLength).toBeUndefined();
  });

  it('publishes anyway when the NIP-11 fetch fails', async () => {
    const { net, pool } = setup();
    const [a, b] = relayUrls('nofetch', 2) as [string, string];
    net.configure(a, { nip11Body: null });
    net.configure(b, { nip11Body: null });
    expect((await pool.publish(makeWrapEvent(), [a, b])).sent).toBe(true);
  });

  it('caches the document and fetches it again after an hour', async () => {
    const { net, pool } = setup();
    const [a] = relayUrls('cache', 1) as [string];
    net.configure(a, { maxMessageLength: 100_000 });
    await pool.publish(makeWrapEvent(), [a]);
    await pool.publish(makeWrapEvent(), [a]);
    expect(net.nip11Fetches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS); // the idle connection closes
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await pool.publish(makeWrapEvent(), [a]);
    expect(net.nip11Fetches).toHaveLength(2);
  });
});

describe('NIP-42 AUTH', () => {
  async function keys(): Promise<EnvelopeKeys> {
    return new MemoryKeyStore(randomBytes(32));
  }

  it('logs in when a relay asks for it, then publishes', async () => {
    const authKeys = await keys();
    const { net, pool } = setup({ authKeys, mayAuthenticate: () => true });
    const [gated, open] = relayUrls('auth', 2) as [string, string];
    net.configure(gated, { requireAuth: true });
    net.configure(open);
    const event = makeWrapEvent();
    const outcome = await pool.publish(event, [gated, open]);
    expect(outcome.sent).toBe(true);
    expect(net.storedOn(event.id).sort()).toEqual([gated, open].sort());
    const authFrames = net.received.filter(
      (f) => f.relay === gated && f.frame.startsWith('["AUTH"'),
    );
    expect(authFrames).toHaveLength(1);
    // The login event is the NIP-42 kind, bound to this relay and its challenge.
    const login = (
      JSON.parse(authFrames[0]?.frame ?? '[]') as [
        string,
        { kind: number; pubkey: string; tags: string[][] },
      ]
    )[1];
    expect(login.kind).toBe(22242);
    expect(login.tags).toContainEqual(['relay', gated]);
    // Signed by the configured key, over the challenge this relay actually sent.
    const bundle = await (authKeys as MemoryKeyStore).getPublicBundle();
    expect(login.pubkey).toBe(encodeHex(bundle.agentNostr));
    expect(login.tags).toContainEqual(['challenge', net.socket(gated)?.challenge]);
    expect(net.socket(gated)?.challenge).toMatch(/^challenge-/);
  });

  it('never signs a login for a relay that does not ask for one', async () => {
    const authKeys = await keys();
    const sign = vi.spyOn(authKeys, 'signNostr');
    const { net, pool } = setup({ authKeys, mayAuthenticate: () => true });
    const [a, b] = relayUrls('noauth', 2) as [string, string];
    net.configure(a);
    net.configure(b, { requireAuth: false });
    await pool.publish(makeWrapEvent(), [a, b]);
    expect(sign).not.toHaveBeenCalled();
  });

  it('fails the relay when there are no keys, or the policy forbids logging in there', async () => {
    const withoutKeys = setup();
    const [gated] = relayUrls('gate', 1) as [string];
    withoutKeys.net.configure(gated, { requireAuth: true });
    expect((await withoutKeys.pool.publish(makeWrapEvent(), [gated])).results[0]?.reason).toBe(
      'auth_failed',
    );

    const authKeys = await keys();
    const sign = vi.spyOn(authKeys, 'signNostr');
    const forbidden = setup({ authKeys, mayAuthenticate: () => false });
    forbidden.net.configure(gated, { requireAuth: true });
    expect((await forbidden.pool.publish(makeWrapEvent(), [gated])).results[0]?.reason).toBe(
      'auth_failed',
    );
    expect(sign).not.toHaveBeenCalled();
  });

  it('denies login by default: keys without a mayAuthenticate hook are never used', async () => {
    const authKeys = await keys();
    const sign = vi.spyOn(authKeys, 'signNostr');
    const { net, pool } = setup({ authKeys });
    const [gated] = relayUrls('deny', 1) as [string];
    net.configure(gated, { requireAuth: true });
    expect((await pool.publish(makeWrapEvent(), [gated])).results[0]?.reason).toBe('auth_failed');
    expect(sign).not.toHaveBeenCalled();
    expect(net.received.some((f) => f.frame.startsWith('["AUTH"'))).toBe(false);
  });

  it('removes a timed-out challenge waiter from a long-lived connection', async () => {
    const authKeys = await keys();
    const { net, pool } = setup({ authKeys, mayAuthenticate: () => true });
    const [gated] = relayUrls('stale', 1) as [string];
    net.configure(gated, { requireAuth: true, noChallenge: true });
    const waiters = (): number =>
      (pool as unknown as { conns: Map<string, { challengeWaiters: unknown[] }> }).conns.get(gated)
        ?.challengeWaiters.length ?? -1;
    const pending = pool.publish(makeWrapEvent(), [gated]);
    await vi.advanceTimersByTimeAsync(0);
    expect(waiters()).toBe(1);
    await vi.advanceTimersByTimeAsync(OK_TIMEOUT_MS);
    expect((await pending).results[0]?.reason).toBe('auth_failed');
    expect(waiters()).toBe(0);
    // Repeated failures on the same connection do not accumulate waiters either.
    for (let i = 0; i < 3; i += 1) {
      const again = pool.publish(makeWrapEvent(), [gated]);
      await vi.advanceTimersByTimeAsync(OK_TIMEOUT_MS);
      await again;
    }
    expect(waiters()).toBe(0);
  });

  it('fails the relay, without throwing, when signing the login fails', async () => {
    const authKeys = await keys();
    vi.spyOn(authKeys, 'signNostr').mockRejectedValue(new Error('locked'));
    const { net, pool } = setup({ authKeys, mayAuthenticate: () => true });
    const [gated] = relayUrls('locked', 1) as [string];
    net.configure(gated, { requireAuth: true });
    expect((await pool.publish(makeWrapEvent(), [gated])).results[0]?.reason).toBe('auth_failed');
  });

  it('ignores an oversized or non-string challenge', async () => {
    const authKeys = await keys();
    const sign = vi.spyOn(authKeys, 'signNostr');
    const { net, pool } = setup({ authKeys, mayAuthenticate: () => true });
    const [gated] = relayUrls('chal', 1) as [string];
    net.configure(gated, { silent: true });
    const pending = pool.publish(makeWrapEvent(), [gated]);
    await vi.advanceTimersByTimeAsync(0);
    const socket = net.socket(gated);
    socket?.push(JSON.stringify(['AUTH', 'x'.repeat(257)]));
    socket?.push(JSON.stringify(['AUTH', 42]));
    await vi.advanceTimersByTimeAsync(OK_TIMEOUT_MS);
    await pending;
    expect(sign).not.toHaveBeenCalled();
  });
});

describe('routing (07 §4.3)', () => {
  it('publishes a wrap only to the relays of its own list', async () => {
    const { net, pool } = setup();
    const recipientList = relayUrls('recipient', 3);
    const senderList = relayUrls('sender', 3);
    for (const url of [...recipientList, ...senderList]) net.configure(url);
    const recipientWrap = makeWrapEvent();
    const senderWrap = makeWrapEvent();
    await pool.publish(recipientWrap, recipientList);
    await pool.publish(senderWrap, senderList);
    expect(net.storedOn(recipientWrap.id).sort()).toEqual([...recipientList].sort());
    expect(net.storedOn(senderWrap.id).sort()).toEqual([...senderList].sort());
    for (const frame of net.received) {
      const holds = frame.frame.includes(recipientWrap.id)
        ? recipientList
        : frame.frame.includes(senderWrap.id)
          ? senderList
          : [];
      if (frame.frame.startsWith('["EVENT"')) expect(holds).toContain(frame.relay);
    }
  });
});

describe('connect-time SSRF check (04 §4, 07 §4.2)', () => {
  const [relay] = relayUrls('ssrf', 1) as [string];
  const host = 'ssrf-0.nostr-test.dev';

  it.each([
    ['loopback', ['127.0.0.1']],
    ['metadata', ['169.254.169.254']],
    ['private', ['10.0.0.8']],
    ['CGNAT', ['100.64.1.1']],
    ['link-local IPv6', ['fe80::1']],
    ['unique-local IPv6', ['fd00::1']],
    ['IPv4-mapped IPv6', ['::ffff:127.0.0.1']],
    ['6to4', ['2002:7f00:1::1']],
    ['NAT64', ['64:ff9b::7f00:1']],
    ['Teredo', ['2001:0:4136:e378:8000:63bf:3fff:fdd2']],
    ['a mixed public and private answer', ['93.184.216.34', '10.0.0.8']],
    ['a mixed IPv6 answer', ['2606:4700:4700::1111', '::1']],
    ['no answer', []],
  ])('skips a relay that resolves to %s, and never connects', async (_name, answers) => {
    const { net, pool, lines } = setup();
    net.configure(relay);
    net.dns.set(host, answers);
    const outcome = await pool.publish(makeWrapEvent(), [relay]);
    expect(outcome.results[0]?.ok).toBe(false);
    expect(['blocked_address', 'resolve_failed']).toContain(outcome.results[0]?.reason);
    expect(net.opens).toHaveLength(0);
    expect(net.nip11Fetches).toHaveLength(0);
    // The activity log names the relay, never the address.
    for (const address of answers) for (const line of lines) expect(line).not.toContain(address);
  });

  it('connects to the checked address itself, and fetches NIP-11 from the same one', async () => {
    const { net, pool } = setup();
    net.configure(relay);
    net.dns.set(host, ['93.184.216.34', '2606:4700:4700::1111']);
    await pool.publish(makeWrapEvent(), [relay]);
    expect(net.opens).toHaveLength(1);
    expect(net.opens[0]).toMatchObject({ url: relay, host, port: 443, address: '93.184.216.34' });
    expect(net.nip11Fetches[0]).toMatchObject({ host, address: '93.184.216.34' });
  });

  it('uses the port of the URL', async () => {
    const { net, pool } = setup();
    const url = 'wss://ported.nostr-test.dev:8443/path';
    net.configure(url);
    await pool.publish(makeWrapEvent(), [url]);
    expect(net.opens[0]).toMatchObject({ host: 'ported.nostr-test.dev', port: 8443 });
  });

  it('repeats the check on every reconnect (DNS rebinding)', async () => {
    const { net, pool } = setup();
    net.configure(relay);
    net.dnsSequence.set(host, [['93.184.216.34'], ['169.254.169.254']]);
    expect((await pool.publish(makeWrapEvent(), [relay])).results[0]?.ok).toBe(true);
    net.socket(relay)?.dropFromRelay();
    await vi.advanceTimersByTimeAsync(0);
    const second = await pool.publish(makeWrapEvent(), [relay]);
    expect(second.results[0]?.reason).toBe('blocked_address');
    expect(net.resolves).toEqual([host, host]);
    expect(net.opens).toHaveLength(1);
  });

  it('skips a relay whose resolution fails or hangs, within the 10 s budget', async () => {
    const failing = setup({
      addressCheck: { resolver: { resolve: () => Promise.reject(new Error('NXDOMAIN')) } },
    });
    failing.net.configure(relay);
    expect((await failing.pool.publish(makeWrapEvent(), [relay])).results[0]?.reason).toBe(
      'resolve_failed',
    );

    const hanging = setup({
      addressCheck: { resolver: { resolve: () => new Promise<never>(() => undefined) } },
    });
    const pending = hanging.pool.publish(makeWrapEvent(), [relay]);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect((await pending).results[0]?.reason).toBe('connect_timeout');
    expect(hanging.net.opens).toHaveLength(0);
    expect(hanging.pool.connectionCount).toBe(0);
  });

  it('does not open a socket if the connect budget ran out while resolving', async () => {
    let release: (answers: readonly string[]) => void = () => undefined;
    const { net, pool } = setup({
      addressCheck: {
        resolver: { resolve: () => new Promise((resolve) => (release = resolve)) },
      },
    });
    net.configure(relay);
    const pending = pool.publish(makeWrapEvent(), [relay]);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect((await pending).results[0]?.reason).toBe('connect_timeout');
    release(['93.184.216.34']);
    await vi.advanceTimersByTimeAsync(0);
    expect(net.opens).toHaveLength(0);
  });

  it('with the platform check it passes no address and trusts the schema and the platform', async () => {
    const { net, pool } = setup({ addressCheck: 'platform' });
    net.configure(relay);
    await pool.publish(makeWrapEvent(), [relay]);
    expect(net.resolves).toHaveLength(0);
    expect(net.opens[0]?.address).toBeUndefined();
  });
});

describe('pool bounds (07 §4.3)', () => {
  it('keeps at most 64 open connections: an idle one is evicted, a busy pool refuses the 65th', async () => {
    const { net, pool } = setup();
    const first = relayUrls('first', 32);
    const second = relayUrls('second', 32);
    const spare = relayUrls('spare', 2);
    for (const url of [...first, ...second, ...spare]) net.configure(url, { silent: true });

    // 64 connections, each with an unanswered EVENT: all busy.
    const a = pool.publish(makeWrapEvent(), first);
    const b = pool.publish(makeWrapEvent(), second);
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.connectionCount).toBe(MAX_CONNECTIONS);

    const refused = await pool.publish(makeWrapEvent(), [spare[0] as string]);
    expect(refused.results[0]?.reason).toBe('pool_full');
    expect(pool.connectionCount).toBe(MAX_CONNECTIONS);

    await vi.advanceTimersByTimeAsync(OK_TIMEOUT_MS);
    await Promise.all([a, b]);

    // Now all 64 are idle: a new relay evicts the least recently used one.
    net.configure(spare[1] as string);
    const evicting = await pool.publish(makeWrapEvent(), [spare[1] as string]);
    expect(evicting.results[0]?.ok).toBe(true);
    expect(pool.connectionCount).toBe(MAX_CONNECTIONS);
    expect(net.closedCount).toBe(1);
  });

  it('closes a connection that has been idle for 5 minutes, and only then', async () => {
    const { net, pool } = setup();
    const [a] = relayUrls('idle', 1) as [string];
    net.configure(a);
    await pool.publish(makeWrapEvent(), [a]);
    expect(pool.connectionCount).toBe(1);
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS - 1);
    expect(pool.connectionCount).toBe(1);
    expect(net.closedCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pool.connectionCount).toBe(0);
    expect(net.closedCount).toBe(1);
    // The next publish reconnects (and checks the address again).
    await pool.publish(makeWrapEvent(), [a]);
    expect(net.resolves).toHaveLength(2);
  });

  it('keeps a connection with a request in flight past the idle limit', async () => {
    const { net, pool } = setup();
    const [a] = relayUrls('busy', 1) as [string];
    net.configure(a, { silent: true });
    const pending = pool.publish(makeWrapEvent(), [a]);
    await vi.advanceTimersByTimeAsync(0);
    net.socket(a)?.push(JSON.stringify(['NOTICE', 'hello']));
    await vi.advanceTimersByTimeAsync(OK_TIMEOUT_MS);
    await pending;
    expect(pool.connectionCount).toBe(1);
  });

  it('skips a relay that does not connect within 10 s, and 16 black holes do not stall other sends', async () => {
    const { net, pool } = setup();
    const holes = relayUrls('hole', 16);
    const healthy = relayUrls('fine', 2);
    for (const url of holes) net.configure(url, { blackHole: true });
    for (const url of healthy) net.configure(url);

    const stalled = pool.publish(makeWrapEvent(), holes);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    // Another send, to other relays, completes while the black holes are still pending.
    const other = await pool.publish(makeWrapEvent(), healthy);
    expect(other.sent).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    const outcome = await stalled;
    expect(outcome.sent).toBe(false);
    expect(outcome.results.every((r) => r.reason === 'connect_timeout')).toBe(true);
    expect(pool.connectionCount).toBe(2);
  });

  it('closes everything on close() and then refuses to publish', async () => {
    const { net, pool } = setup();
    const [a] = relayUrls('shut', 1) as [string];
    net.configure(a);
    await pool.publish(makeWrapEvent(), [a]);
    pool.close();
    expect(pool.connectionCount).toBe(0);
    expect((await pool.publish(makeWrapEvent(), [a])).results[0]?.reason).toBe('invalid_url');
  });

  it('ends an unanswered request as closed when the relay drops the connection', async () => {
    const { net, pool } = setup();
    const [a] = relayUrls('drop', 1) as [string];
    net.configure(a, { silent: true });
    const pending = pool.publish(makeWrapEvent(), [a]);
    await vi.advanceTimersByTimeAsync(0);
    net.socket(a)?.dropFromRelay();
    expect((await pending).results[0]?.reason).toBe('closed');
  });
});

describe('inbound OK frames are untrusted (I-5)', () => {
  it('ignores malformed OK frames and OKs for other events', async () => {
    const { net, pool } = setup();
    const [a] = relayUrls('badok', 1) as [string];
    net.configure(a, { silent: true });
    const event = makeWrapEvent();
    const pending = pool.publish(event, [a]);
    await vi.advanceTimersByTimeAsync(0);
    const socket = net.socket(a);
    for (const frame of [
      ['OK', event.id],
      ['OK', event.id, 'true', ''],
      ['OK', event.id, 1, ''],
      ['OK', 'zz', true, ''],
      ['OK', 'a'.repeat(64), true, ''],
      ['OK', event.id.toUpperCase(), true, ''],
      { not: 'an array' },
      'text',
      [42],
    ]) {
      socket?.push(JSON.stringify(frame));
    }
    socket?.push('{not json');
    await vi.advanceTimersByTimeAsync(OK_TIMEOUT_MS);
    expect((await pending).results[0]?.reason).toBe('ok_timeout');
  });

  it('never returns or logs relay-supplied text, event content or the relay URL path', async () => {
    const { net, pool, lines } = setup();
    const canary = `CANARY-${Math.random().toString(36).slice(2)}`;
    const secretPath = `/token-${Math.random().toString(36).slice(2)}`;
    const urls = [`wss://leak-0.nostr-test.dev${secretPath}`, 'wss://leak-1.nostr-test.dev'];
    net.configure(urls[0] as string, { reject: true, okMessage: `blocked: ${canary}` });
    net.configure(urls[1] as string, { okMessage: canary });
    const outcome = await pool.publish(makeWrapEvent({ content: canary }), urls);
    const serialised =
      JSON.stringify(outcome) +
      JSON.stringify(pool.relayHealth().map((h) => ({ ...h, relay: '' })));
    expect(serialised).not.toContain(canary);
    expect(lines.join('\n')).not.toContain(canary);
    expect(lines.join('\n')).not.toContain(secretPath);
  });

  it('logs a skipped relay by host only', async () => {
    const { net, pool, lines } = setup();
    const url = 'wss://private.nostr-test.dev/secret-path';
    net.configure(url);
    net.dns.set('private.nostr-test.dev', ['10.1.2.3']);
    await pool.publish(makeWrapEvent(), [url]);
    const text = lines.join('\n');
    expect(text).toContain('private.nostr-test.dev');
    expect(text).not.toContain('secret-path');
    expect(text).not.toContain('10.1.2.3');
  });
});
