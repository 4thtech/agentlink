// NET-PRECHECK (04 §4 "SSRF protection"; 07 §4.2, §4.3 "Use your own servers"; I-5, I-7): the in-app
// server Test. Each owner-typed URL passes the relay URL rule, every DNS answer must be publicly
// routable before any socket opens, both connections and the NIP-11 fetch go to the one pinned
// address, a throwaway key publishes one tiny kind 1059 event and a fresh connection reads it back.
// Outcomes are a fixed enum; no server text. Mock relays and a stub resolver only: no network.
import { verifyNostrEvent, type NostrEvent } from '@4thtech-io/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRECHECK_MAX_SERVERS,
  PRECHECK_NIP11_TIMEOUT_MS,
  PRECHECK_RATE_LIMIT,
  PRECHECK_RATE_WINDOW_MS,
  PRECHECK_SLOW_MS,
  PRECHECK_TOTAL_MS,
  PrecheckRateLimit,
  precheckServers,
  type PrecheckOptions,
  type PrecheckResult,
} from './precheck.js';
import { TransportError } from './errors.js';
import { MockNetwork, PUBLIC_ADDRESS, relayUrls } from './testing/mock-network.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(options: Partial<PrecheckOptions> = {}) {
  const net = new MockNetwork();
  const run = async (urls: readonly unknown[], advanceMs = PRECHECK_TOTAL_MS + 1_000) => {
    const pending = precheckServers(urls, {
      resolver: net,
      connector: net,
      nip11: net,
      ...options,
    });
    await vi.advanceTimersByTimeAsync(advanceMs);
    return pending;
  };
  return { net, run };
}

const frames = (net: MockNetwork, kind: string): unknown[][] =>
  net.received.map((r) => JSON.parse(r.frame) as unknown[]).filter((f) => f[0] === kind);

const one = async (
  net: MockNetwork,
  run: (urls: readonly unknown[], ms?: number) => Promise<readonly PrecheckResult[]>,
  url: string,
): Promise<PrecheckResult> => {
  const [result] = await run([url]);
  return result as PrecheckResult;
};

const KEYS = ['host', 'outcome', 'reason', 'roundTripMs'];

describe('precheckServers (NET-PRECHECK)', () => {
  it('a working server is ready: throwaway event published, read back on a fresh connection', async () => {
    const { net, run } = setup();
    const [url] = relayUrls('good', 1) as [string];
    net.configure(url);
    const result = await one(net, run, url);
    expect(Object.keys(result).sort()).toEqual(KEYS);
    expect(result).toMatchObject({ host: 'good-0.nostr-test.dev', outcome: 'ready', reason: null });
    expect(Number.isInteger(result.roundTripMs)).toBe(true);
    expect(result.roundTripMs).toBeLessThan(PRECHECK_SLOW_MS);
    // One tiny kind 1059 event, signed by a throwaway key that tags itself.
    const events = frames(net, 'EVENT').map((f) => f[1] as NostrEvent);
    expect(events).toHaveLength(1);
    const event = events[0] as NostrEvent;
    expect(event.kind).toBe(1059);
    expect(verifyNostrEvent(event)).toBe(true);
    expect(event.tags).toEqual([['p', event.pubkey]]);
    expect(event.content.length).toBeLessThanOrEqual(64);
    // Read back on a second, fresh connection by id and by the sync filter (#p).
    const reqs = net.reqs(url);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.filter).toMatchObject({ ids: [event.id], kinds: [1059], '#p': [event.pubkey] });
    expect(net.sockets).toHaveLength(2);
    // Never logs in, every socket closed, one DNS answer used for everything.
    expect(frames(net, 'AUTH')).toHaveLength(0);
    expect(net.sockets.every((s) => s.closed)).toBe(true);
    expect(net.resolves).toEqual(['good-0.nostr-test.dev']);
    expect(net.opens.every((t) => t.address === PUBLIC_ADDRESS && t.host === 'good-0.nostr-test.dev')).toBe(true);
    expect(net.nip11Fetches.every((t) => t.address === PUBLIC_ADDRESS)).toBe(true);
    expect(net.nip11Options[0]?.maxBytes).toBe(65_536);
  });

  it('each test uses a new throwaway key', async () => {
    const { net, run } = setup();
    const [url] = relayUrls('keys', 1) as [string];
    net.configure(url);
    await run([url]);
    await run([url]);
    const keys = frames(net, 'EVENT').map((f) => (f[1] as NostrEvent).pubkey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it('a round trip over 1 s is slow (still usable)', async () => {
    const { net, run } = setup();
    const [url] = relayUrls('slow', 1) as [string];
    net.configure(url, { okDelayMs: 1_500 });
    const result = await one(net, run, url);
    expect(result.outcome).toBe('slow');
    expect(result.reason).toBeNull();
    expect(result.roundTripMs).toBeGreaterThanOrEqual(1_500);
  });

  it('a server that demands AUTH needs sign-in, and the challenge is never answered', async () => {
    const { net, run } = setup();
    const [url] = relayUrls('auth', 1) as [string];
    net.configure(url, { requireAuth: true });
    const result = await one(net, run, url);
    expect(result).toMatchObject({ outcome: 'needs_sign_in', reason: null });
    expect(frames(net, 'AUTH')).toHaveLength(0);
    expect(net.sockets.every((s) => s.authedKeys.size === 0)).toBe(true);
  });

  it('a server that wants sign-in to read needs sign-in', async () => {
    const { net, run } = setup();
    const [url] = relayUrls('readauth', 1) as [string];
    net.configure(url, { reqNeedsAuth: true });
    expect((await one(net, run, url)).outcome).toBe('needs_sign_in');
    expect(frames(net, 'AUTH')).toHaveLength(0);
  });

  it('NIP-11 auth_required (a JSON true) needs sign-in; payment_required needs payment', async () => {
    const { net, run } = setup();
    const [a, b, c] = relayUrls('nip', 3) as [string, string, string];
    net.configure(a, { nip11Body: JSON.stringify({ limitation: { auth_required: true } }) });
    net.configure(b, { nip11Body: JSON.stringify({ limitation: { payment_required: true } }) });
    net.configure(c, {
      reject: true,
      nip11Body: JSON.stringify({ limitation: { payment_required: true, auth_required: 'true' } }),
    });
    const results = await run([a, b, c]);
    expect(results.map((r) => r.outcome)).toEqual(['needs_sign_in', 'needs_payment', 'needs_payment']);
  });

  it('a server that refuses events, or drops them, is refused: rejected_events', async () => {
    const { net, run } = setup();
    const [rejects, drops] = relayUrls('drop', 2) as [string, string];
    net.configure(rejects, { reject: true, okMessage: 'blocked: <script>hostile</script>' });
    net.configure(drops, { neverServes: true, okMessage: 'saved, trust me' });
    const results = await run([rejects, drops]);
    expect(results.map((r) => [r.outcome, r.reason])).toEqual([
      ['refused', 'rejected_events'],
      ['refused', 'rejected_events'],
    ]);
    expect(JSON.stringify(results)).not.toMatch(/script|hostile|trust/);
  });

  it('a server that serves only to the session that published is refused', async () => {
    const { net, run } = setup();
    const [url] = relayUrls('same', 1) as [string];
    net.configure(url, { sameSocketOnly: true });
    expect(await one(net, run, url)).toMatchObject({ outcome: 'refused', reason: 'rejected_events' });
  });

  it('a forged event under the test id is not a read-back', async () => {
    const { net, run } = setup();
    const [url] = relayUrls('forge', 1) as [string];
    const forged = {
      id: '0'.repeat(64),
      pubkey: '1'.repeat(64),
      sig: '2'.repeat(128),
      kind: 1059,
      created_at: 1,
      tags: [],
      content: '',
    } as NostrEvent;
    net.configure(url, { serveInstead: forged });
    expect((await one(net, run, url)).reason).toBe('rejected_events');
  });

  it('ws://, http(s):// and other schemes are refused as not_wss, before any lookup', async () => {
    const { net, run } = setup();
    const results = await run([
      'ws://relay.nostr-test.dev',
      'https://relay.nostr-test.dev',
      'WSS://relay.nostr-test.dev',
      'relay.nostr-test.dev',
    ]);
    expect(results.map((r) => r.reason)).toEqual(['not_wss', 'not_wss', 'not_wss', 'not_wss']);
    expect(results.every((r) => r.outcome === 'refused' && r.host === null)).toBe(true);
    expect(net.resolves).toHaveLength(0);
    expect(net.opens).toHaveLength(0);
  });

  it('IP literals are refused, before any lookup', async () => {
    const { net, run } = setup();
    const results = await run([
      'wss://93.184.216.34',
      'wss://[2606:4700::1111]',
      'wss://127.1',
      'wss://0x7f000001',
      'wss://10.0.0.1:443/',
    ]);
    expect(results.map((r) => r.reason)).toEqual(Array(5).fill('ip_literal'));
    expect(net.resolves).toHaveLength(0);
  });

  it('local names are private addresses; other malformed URLs are invalid_url', async () => {
    const { net, run } = setup();
    const results = await run([
      'wss://localhost',
      'wss://relay.local',
      'wss://metadata.internal',
      'wss://user:pw@relay.nostr-test.dev',
      'wss://relay.nostr-test.dev/?q=1',
      'wss://relay.nostr-test.dev/#x',
      `wss://${'a'.repeat(300)}.dev`,
      42,
    ]);
    expect(results.map((r) => r.reason)).toEqual([
      'private_address',
      'private_address',
      'private_address',
      'invalid_url',
      'invalid_url',
      'invalid_url',
      'invalid_url',
      'invalid_url',
    ]);
    expect(net.resolves).toHaveLength(0);
  });

  it.each([
    ['10.0.0.1'],
    ['127.0.0.1'],
    ['169.254.169.254'],
    ['100.64.0.1'],
    ['192.168.1.1'],
    ['224.0.0.1'],
    ['0.0.0.0'],
    ['::1'],
    ['fe80::1'],
    ['fd00:ec2::254'],
    ['ff02::1'],
    ['::ffff:10.0.0.1'],
    ['64:ff9b::a00:1'],
  ])('a DNS answer %s is a private address: no socket, no NIP-11', async (address) => {
    const { net, run } = setup();
    const [url] = relayUrls('priv', 1) as [string];
    net.configure(url);
    net.dns.set('priv-0.nostr-test.dev', [address]);
    expect(await one(net, run, url)).toMatchObject({
      outcome: 'refused',
      reason: 'private_address',
      host: 'priv-0.nostr-test.dev',
    });
    expect(net.opens).toHaveLength(0);
    expect(net.nip11Fetches).toHaveLength(0);
  });

  it('mixed public and private answers are refused (every answer must be public)', async () => {
    const { net, run } = setup();
    const [url] = relayUrls('mixed', 1) as [string];
    net.configure(url);
    net.dns.set('mixed-0.nostr-test.dev', [PUBLIC_ADDRESS, '2606:4700::1111', '127.0.0.1']);
    expect((await one(net, run, url)).reason).toBe('private_address');
    expect(net.opens).toHaveLength(0);
  });

  it('DNS rebinding: the name is resolved once and both connections use the pinned address', async () => {
    const { net, run } = setup();
    const [url] = relayUrls('rebind', 1) as [string];
    net.configure(url);
    net.dnsSequence.set('rebind-0.nostr-test.dev', [[PUBLIC_ADDRESS], ['127.0.0.1']]);
    expect((await one(net, run, url)).outcome).toBe('ready');
    expect(net.resolves).toEqual(['rebind-0.nostr-test.dev']);
    expect(net.opens).toHaveLength(2);
    expect(net.opens.every((t) => t.address === PUBLIC_ADDRESS)).toBe(true);
    expect(net.nip11Fetches.every((t) => t.address === PUBLIC_ADDRESS)).toBe(true);
  });

  it('a failed or empty lookup is dns_failed', async () => {
    const { net, run } = setup();
    const [a, b] = relayUrls('nx', 2) as [string, string];
    net.dns.set('nx-0.nostr-test.dev', []);
    const failing = {
      resolve: (host: string) =>
        host === 'nx-1.nostr-test.dev' ? Promise.reject(new Error('ENOTFOUND nx-1')) : net.resolve(host),
    };
    const pending = precheckServers([a, b], { resolver: failing, connector: net, nip11: net });
    await vi.advanceTimersByTimeAsync(100);
    const results = await pending;
    expect(results.map((r) => r.reason)).toEqual(['dns_failed', 'dns_failed']);
    expect(JSON.stringify(results)).not.toContain('ENOTFOUND');
  });

  it('TLS, connect and upgrade failures map to tls_failed, connect_failed and not_nostr', async () => {
    const { net, run } = setup();
    const [tls, conn, up] = relayUrls('fail', 3) as [string, string, string];
    net.configure(tls, { failure: 'tls' });
    net.configure(conn, { failure: 'connect' });
    net.configure(up, { failure: 'upgrade' });
    const results = await run([tls, conn, up]);
    expect(results.map((r) => r.reason)).toEqual(['tls_failed', 'connect_failed', 'not_nostr']);
  });

  it('a server that never opens is a timeout, inside the overall cap', async () => {
    const { net } = setup();
    const [url] = relayUrls('hole', 1) as [string];
    net.configure(url, { blackHole: true, nip11Hang: true });
    let done = false;
    const pending = precheckServers([url], { resolver: net, connector: net, nip11: net }).then(
      (r) => {
        done = true;
        return r;
      },
    );
    await vi.advanceTimersByTimeAsync(PRECHECK_TOTAL_MS);
    expect(done).toBe(true);
    expect((await pending)[0]).toMatchObject({ outcome: 'refused', reason: 'timeout' });
    expect(net.sockets.every((s) => s.closed)).toBe(true);
  });

  it('an open socket that never speaks Nostr is not_nostr', async () => {
    const { net, run } = setup();
    const [url] = relayUrls('mute', 1) as [string];
    net.configure(url, { silent: true });
    expect((await one(net, run, url)).reason).toBe('not_nostr');
  });

  it('the whole test ends by the 15 s cap, whatever the servers do', async () => {
    const { net } = setup();
    const urls = relayUrls('cap', PRECHECK_MAX_SERVERS);
    for (const [i, url] of urls.entries()) {
      net.configure(url, i % 2 === 0 ? { okDelayMs: 60_000 } : { reqDelayMs: 60_000, nip11Hang: true });
    }
    let done = false;
    const pending = precheckServers(urls, { resolver: net, connector: net, nip11: net }).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(PRECHECK_TOTAL_MS);
    expect(done).toBe(true);
    const results = await pending;
    expect(results).toHaveLength(PRECHECK_MAX_SERVERS);
    expect(results.every((r) => r.outcome === 'refused' && r.reason === 'timeout')).toBe(true);
    expect(net.sockets.every((s) => s.closed)).toBe(true);
  });

  describe('hostile NIP-11 documents are ignored, never fatal and never echoed', () => {
    it.each([
      ['huge', { nip11Body: JSON.stringify({ name: 'x'.repeat(70_000), limitation: { auth_required: true } }) }],
      ['malformed', { nip11Body: '{"limitation": {"auth_required": tru' }],
      ['not an object', { nip11Body: '[1,2,3]' }],
      ['unavailable', { nip11Body: null }],
      ['string flags', { nip11Body: JSON.stringify({ limitation: { auth_required: 'yes' } }) }],
    ] as const)('%s', async (_name, config) => {
      const { net, run } = setup();
      const [url] = relayUrls('nip11', 1) as [string];
      net.configure(url, config);
      const result = await one(net, run, url);
      expect(result.outcome).toBe('ready');
      expect(JSON.stringify(result)).not.toContain('xxxx');
    });

    it('slow: the test does not wait for it past its own bound', async () => {
      const { net } = setup();
      const [url] = relayUrls('nip11slow', 1) as [string];
      net.configure(url, { nip11Hang: true });
      let done = false;
      const pending = precheckServers([url], { resolver: net, connector: net, nip11: net }).then(
        (r) => {
          done = true;
          return r;
        },
      );
      await vi.advanceTimersByTimeAsync(PRECHECK_NIP11_TIMEOUT_MS + 50);
      expect(done).toBe(true);
      expect((await pending)[0]?.outcome).toBe('ready');
    });
  });

  it('answers in input order, one result per URL; more than 8 or none is an argument error', async () => {
    const { net, run } = setup();
    const urls = relayUrls('order', 3);
    for (const url of urls) net.configure(url);
    net.configure(urls[1] as string, { reject: true });
    const results = await run(['ws://x.nostr-test.dev', ...urls]);
    expect(results.map((r) => r.outcome)).toEqual(['refused', 'ready', 'refused', 'ready']);
    await expect(
      precheckServers(relayUrls('many', PRECHECK_MAX_SERVERS + 1), { resolver: net, connector: net }),
    ).rejects.toBeInstanceOf(TransportError);
    await expect(precheckServers([], { resolver: net, connector: net })).rejects.toBeInstanceOf(
      TransportError,
    );
  });

  it('takes no key: its options carry only the I/O seams', async () => {
    // The signature is the guarantee (no EnvelopeKeys, no KeyStore, no signer): a test event is
    // always signed inside @4thtech-io/crypto by a key made for it and wiped.
    const { net, run } = setup();
    const [url] = relayUrls('nokey', 1) as [string];
    net.configure(url, { requireAuth: true });
    await run([url]);
    // A sign-in demand ends the test: one EVENT sent, no AUTH, nothing else.
    const sent = net.received.map((r) => JSON.parse(r.frame) as unknown[]);
    expect(sent.map((f) => f[0])).toEqual(['EVENT']);
    expect(precheckServers.length).toBe(2);
  });
});

describe('PrecheckRateLimit (NET-PRECHECK)', () => {
  it('allows 10 tests a minute, then answers how many seconds to wait', () => {
    let now = 1_000_000;
    const limit = new PrecheckRateLimit(() => now);
    for (let i = 0; i < PRECHECK_RATE_LIMIT; i += 1) expect(limit.take()).toBe(0);
    const wait = limit.take();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(PRECHECK_RATE_WINDOW_MS / 1000);
    now += PRECHECK_RATE_WINDOW_MS;
    expect(limit.take()).toBe(0);
  });
});
