// NET-PRECHECK (D-158 (4); 04 §4 "Servers the owner types"; 07 §4.3 "The test (pre-check)"; 08 §1
// `POST /api/ui/network/test`; I-5, I-7): the in-app server Test. Each owner-typed URL passes the
// relay URL rule, every DNS answer must be publicly routable before any socket opens, both
// connections and the NIP-11 fetch go to the one pinned address, a throwaway key publishes one tiny
// kind 1059 event (accepted without a login) and a fresh connection makes the two reads. Outcomes
// and reasons are the fixed sets of 07 §4.3; no server text. Mock relays and a stub resolver only.
import { verifyNostrEvent, type NostrEvent } from '@4thtech-io/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRECHECK_EVENT_EXPIRY_SECONDS,
  PRECHECK_MAX_SERVERS,
  PRECHECK_MIN_MESSAGE_LENGTH,
  PRECHECK_NIP11_TIMEOUT_MS,
  PRECHECK_RATE_LIMIT,
  PRECHECK_RATE_WINDOW_MS,
  PRECHECK_SERVER_TIMEOUT_MS,
  PRECHECK_SLOW_MS,
  PrecheckRateLimit,
  precheckServers,
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

function setup() {
  const net = new MockNetwork();
  const run = async (urls: readonly unknown[], advanceMs = PRECHECK_SERVER_TIMEOUT_MS + 1_000) => {
    const pending = precheckServers(urls, { resolver: net, connector: net, nip11: net });
    await vi.advanceTimersByTimeAsync(advanceMs);
    return pending;
  };
  const one = async (url: string): Promise<PrecheckResult> =>
    (await run([url]))[0] as PrecheckResult;
  return { net, run, one };
}

const frames = (net: MockNetwork, kind: string): unknown[][] =>
  net.received.map((r) => JSON.parse(r.frame) as unknown[]).filter((f) => f[0] === kind);

const KEYS = ['host', 'outcome', 'paymentRequired', 'reason', 'roundTripMs', 'signInRequired'];
const doc = (limitation: Record<string, unknown>) => ({
  nip11Body: JSON.stringify({ limitation }),
});

describe('precheckServers (NET-PRECHECK)', () => {
  it('a working server is ready: throwaway event accepted, both reads served on a fresh connection', async () => {
    const { net, one } = setup();
    const [url] = relayUrls('good', 1) as [string];
    net.configure(url);
    const result = await one(url);
    expect(Object.keys(result).sort()).toEqual(KEYS);
    expect(result).toMatchObject({
      host: 'good-0.nostr-test.dev',
      outcome: 'ready',
      reason: null,
      signInRequired: false,
      paymentRequired: false,
    });
    expect(Number.isInteger(result.roundTripMs)).toBe(true);
    expect(result.roundTripMs).toBeLessThan(PRECHECK_SLOW_MS);
    // One tiny kind 1059 event, signed by a throwaway key that tags itself, with a NIP-40 expiry.
    const events = frames(net, 'EVENT').map((f) => f[1] as NostrEvent);
    expect(events).toHaveLength(1);
    const event = events[0] as NostrEvent;
    expect(event.kind).toBe(1059);
    expect(verifyNostrEvent(event)).toBe(true);
    expect(event.tags).toEqual([
      ['p', event.pubkey],
      ['expiration', String(event.created_at + PRECHECK_EVENT_EXPIRY_SECONDS)],
    ]);
    expect(event.content.length).toBeLessThanOrEqual(64);
    // Two separate reads on a second, fresh connection: by id, and by the sync filter alone.
    const reqs = net.reqs(url);
    expect(reqs).toHaveLength(2);
    expect(reqs[0]?.filter).toEqual({ ids: [event.id], limit: 1 });
    expect(reqs[1]?.filter).toMatchObject({ kinds: [1059], '#p': [event.pubkey] });
    expect(reqs[1]?.filter.ids).toBeUndefined();
    expect(net.sockets).toHaveLength(2);
    // Never logs in, every socket closed, one DNS answer used for everything.
    expect(frames(net, 'AUTH')).toHaveLength(0);
    expect(net.sockets.every((s) => s.closed)).toBe(true);
    expect(net.resolves).toEqual(['good-0.nostr-test.dev']);
    expect(
      net.opens.every((t) => t.address === PUBLIC_ADDRESS && t.host === 'good-0.nostr-test.dev'),
    ).toBe(true);
    expect(net.nip11Fetches.every((t) => t.address === PUBLIC_ADDRESS)).toBe(true);
    expect(net.nip11Options[0]?.maxBytes).toBe(65_536);
  });

  it('host keeps a port that is not 443 (as the network view)', async () => {
    const { net, run } = setup();
    net.configure('wss://port.nostr-test.dev:8443');
    net.configure('wss://plain.nostr-test.dev:443');
    const results = await run(['wss://port.nostr-test.dev:8443', 'wss://plain.nostr-test.dev:443']);
    expect(results.map((r) => r.host)).toEqual([
      'port.nostr-test.dev:8443',
      'plain.nostr-test.dev',
    ]);
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

  it('the same address twice is tested once and answered twice', async () => {
    const { net, run } = setup();
    const [url] = relayUrls('dup', 1) as [string];
    net.configure(url);
    const results = await run([url, url, url]);
    expect(results.map((r) => r.outcome)).toEqual(['ready', 'ready', 'ready']);
    expect(frames(net, 'EVENT')).toHaveLength(1);
    expect(net.resolves).toHaveLength(1);
  });

  it('a round trip over 1 s is slow (still usable)', async () => {
    const { net, one } = setup();
    const [url] = relayUrls('slow', 1) as [string];
    net.configure(url, { okDelayMs: 1_500 });
    const result = await one(url);
    expect(result).toMatchObject({ outcome: 'slow', reason: null });
    expect(result.roundTripMs).toBeGreaterThanOrEqual(1_500);
  });

  it('a server that wants a login to WRITE is refused: not_accepted, and AUTH is never answered', async () => {
    const { net, run } = setup();
    const [auth, quiet] = relayUrls('auth', 2) as [string, string];
    net.configure(auth, { requireAuth: true });
    net.configure(quiet, { requireAuth: true, silent: true });
    const results = await run([auth, quiet]);
    expect(results.map((r) => [r.outcome, r.reason])).toEqual([
      ['refused', 'not_accepted'],
      ['refused', 'not_accepted'],
    ]);
    expect(frames(net, 'AUTH')).toHaveLength(0);
    expect(net.sockets.every((s) => s.authedKeys.size === 0)).toBe(true);
    // A write refusal ends the test: no read was made.
    expect(frames(net, 'REQ')).toHaveLength(0);
  });

  it('a server that wants a login only to READ is sign_in', async () => {
    const { net, one } = setup();
    const [url] = relayUrls('readauth', 1) as [string];
    net.configure(url, { reqNeedsAuth: true });
    expect(await one(url)).toMatchObject({
      outcome: 'sign_in',
      reason: null,
      signInRequired: true,
    });
    expect(frames(net, 'AUTH')).toHaveLength(0);
  });

  it('NIP-11 auth_required on a server that accepted and served is sign_in', async () => {
    const { net, one } = setup();
    const [url] = relayUrls('nipauth', 1) as [string];
    net.configure(url, doc({ auth_required: true }));
    expect(await one(url)).toMatchObject({ outcome: 'sign_in', signInRequired: true });
  });

  it('payment_required is a warning flag beside the outcome, never an outcome', async () => {
    const { net, run } = setup();
    const [ok, rejects] = relayUrls('paid', 2) as [string, string];
    net.configure(ok, doc({ payment_required: true }));
    net.configure(rejects, { reject: true, ...doc({ payment_required: true }) });
    const results = await run([ok, rejects]);
    expect(results.map((r) => [r.outcome, r.reason, r.paymentRequired])).toEqual([
      ['ready', null, true],
      ['refused', 'not_accepted', true],
    ]);
    expect(typeof results[0]?.roundTripMs).toBe('number');
  });

  it('a message limit below the largest wrap is too_small', async () => {
    const { net, run } = setup();
    const [small, enough] = relayUrls('size', 2) as [string, string];
    net.configure(small, doc({ max_message_length: 16_384 }));
    net.configure(enough, doc({ max_message_length: PRECHECK_MIN_MESSAGE_LENGTH }));
    const results = await run([small, enough]);
    expect(results.map((r) => [r.outcome, r.reason])).toEqual([
      ['refused', 'too_small'],
      ['ready', null],
    ]);
  });

  it('refusing the event is not_accepted; accepting but not serving it is not_kept', async () => {
    const { net, run } = setup();
    const [rejects, drops, same] = relayUrls('drop', 3) as [string, string, string];
    net.configure(rejects, { reject: true, okMessage: 'blocked: <script>hostile</script>' });
    net.configure(drops, { neverServes: true, okMessage: 'saved, trust me' });
    net.configure(same, { sameSocketOnly: true });
    const results = await run([rejects, drops, same]);
    expect(results.map((r) => [r.outcome, r.reason])).toEqual([
      ['refused', 'not_accepted'],
      ['refused', 'not_kept'],
      ['refused', 'not_kept'],
    ]);
    expect(JSON.stringify(results)).not.toMatch(/script|hostile|trust/);
  });

  it('a forged event under the test id is not a read-back', async () => {
    const { net, one } = setup();
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
    expect((await one(url)).reason).toBe('not_kept');
  });

  it('every break of the URL rule is not_allowed, before any lookup', async () => {
    const { net, run } = setup();
    const bad = [
      'ws://relay.nostr-test.dev',
      'https://relay.nostr-test.dev',
      'WSS://relay.nostr-test.dev',
      'wss://93.184.216.34',
      'wss://[2606:4700::1111]',
      'wss://127.1',
      'wss://0x7f000001',
    ];
    const local = [
      'wss://localhost',
      'wss://relay.local',
      'wss://metadata.internal',
      'wss://user:pw@relay.nostr-test.dev',
      'wss://relay.nostr-test.dev/?q=1',
      'wss://relay.nostr-test.dev/#x',
      `wss://${'a'.repeat(300)}.dev`,
      42,
    ];
    const results = [...(await run(bad)), ...(await run(local))];
    expect(results.every((r) => r.outcome === 'refused' && r.reason === 'not_allowed')).toBe(true);
    expect(results.every((r) => r.host === null)).toBe(true);
    expect(net.resolves).toHaveLength(0);
    expect(net.opens).toHaveLength(0);
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
  ])('a DNS answer %s is not_allowed: no socket, no NIP-11', async (address) => {
    const { net, one } = setup();
    const [url] = relayUrls('priv', 1) as [string];
    net.configure(url);
    net.dns.set('priv-0.nostr-test.dev', [address]);
    expect(await one(url)).toMatchObject({
      outcome: 'refused',
      reason: 'not_allowed',
      host: 'priv-0.nostr-test.dev',
    });
    expect(net.opens).toHaveLength(0);
    expect(net.nip11Fetches).toHaveLength(0);
  });

  it('mixed public and private answers are not_allowed (every answer must be public)', async () => {
    const { net, one } = setup();
    const [url] = relayUrls('mixed', 1) as [string];
    net.configure(url);
    net.dns.set('mixed-0.nostr-test.dev', [PUBLIC_ADDRESS, '2606:4700::1111', '127.0.0.1']);
    expect((await one(url)).reason).toBe('not_allowed');
    expect(net.opens).toHaveLength(0);
  });

  it('DNS rebinding: the name is resolved once and both connections use the pinned address', async () => {
    const { net, one } = setup();
    const [url] = relayUrls('rebind', 1) as [string];
    net.configure(url);
    net.dnsSequence.set('rebind-0.nostr-test.dev', [[PUBLIC_ADDRESS], ['127.0.0.1']]);
    expect((await one(url)).outcome).toBe('ready');
    expect(net.resolves).toEqual(['rebind-0.nostr-test.dev']);
    expect(net.opens).toHaveLength(2);
    expect(net.opens.every((t) => t.address === PUBLIC_ADDRESS)).toBe(true);
    expect(net.nip11Fetches.every((t) => t.address === PUBLIC_ADDRESS)).toBe(true);
  });

  it('a failed or empty lookup is unreachable, with no resolver text', async () => {
    const { net } = setup();
    const [a, b] = relayUrls('nx', 2) as [string, string];
    net.dns.set('nx-0.nostr-test.dev', []);
    const failing = {
      resolve: (host: string) =>
        host === 'nx-1.nostr-test.dev'
          ? Promise.reject(new Error('ENOTFOUND nx-1'))
          : net.resolve(host),
    };
    const pending = precheckServers([a, b], { resolver: failing, connector: net, nip11: net });
    await vi.advanceTimersByTimeAsync(100);
    const results = await pending;
    expect(results.map((r) => r.reason)).toEqual(['unreachable', 'unreachable']);
    expect(JSON.stringify(results)).not.toContain('ENOTFOUND');
  });

  it('TLS and connect failures are unreachable; a refused upgrade is invalid', async () => {
    const { net, run } = setup();
    const [tls, conn, up] = relayUrls('fail', 3) as [string, string, string];
    net.configure(tls, { failure: 'tls' });
    net.configure(conn, { failure: 'connect' });
    net.configure(up, { failure: 'upgrade' });
    const results = await run([tls, conn, up]);
    expect(results.map((r) => r.reason)).toEqual(['unreachable', 'unreachable', 'invalid']);
  });

  it('a server that never opens is unreachable within 10 s', async () => {
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
    await vi.advanceTimersByTimeAsync(PRECHECK_SERVER_TIMEOUT_MS);
    expect(done).toBe(true);
    expect((await pending)[0]).toMatchObject({ outcome: 'refused', reason: 'unreachable' });
    expect(net.sockets.every((s) => s.closed)).toBe(true);
  });

  it('an open socket that never speaks Nostr is invalid', async () => {
    const { net, one } = setup();
    const [url] = relayUrls('mute', 1) as [string];
    net.configure(url, { silent: true });
    expect((await one(url)).reason).toBe('invalid');
  });

  it('each server ends by its 10 s bound, whatever it does', async () => {
    const { net } = setup();
    const urls = relayUrls('cap', PRECHECK_MAX_SERVERS);
    for (const [i, url] of urls.entries()) {
      net.configure(
        url,
        i % 2 === 0 ? { okDelayMs: 60_000 } : { reqDelayMs: 60_000, nip11Hang: true },
      );
    }
    let done = false;
    const pending = precheckServers(urls, { resolver: net, connector: net, nip11: net }).then(
      (r) => {
        done = true;
        return r;
      },
    );
    await vi.advanceTimersByTimeAsync(PRECHECK_SERVER_TIMEOUT_MS);
    expect(done).toBe(true);
    const results = await pending;
    expect(results).toHaveLength(PRECHECK_MAX_SERVERS);
    // No OK at all: invalid; an OK but no read answer: unreachable.
    expect(results.map((r) => r.reason)).toEqual(
      urls.map((_, i) => (i % 2 === 0 ? 'invalid' : 'unreachable')),
    );
    expect(net.sockets.every((s) => s.closed)).toBe(true);
  });

  describe('hostile NIP-11 documents are ignored, never fatal and never echoed', () => {
    it.each([
      [
        'huge',
        {
          nip11Body: JSON.stringify({
            name: 'x'.repeat(70_000),
            limitation: { auth_required: true, max_message_length: 1 },
          }),
        },
      ],
      ['malformed', { nip11Body: '{"limitation": {"auth_required": tru' }],
      ['not an object', { nip11Body: '[1,2,3]' }],
      ['unavailable', { nip11Body: null }],
      ['string flags', doc({ auth_required: 'yes', max_message_length: '1' })],
    ] as const)('%s', async (_name, config) => {
      const { net, one } = setup();
      const [url] = relayUrls('nip11', 1) as [string];
      net.configure(url, config);
      const result = await one(url);
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
      expect((await pending)[0]).toMatchObject({ outcome: 'ready', paymentRequired: null });
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
      precheckServers(relayUrls('many', PRECHECK_MAX_SERVERS + 1), {
        resolver: net,
        connector: net,
      }),
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
    // A login demand ends the test: one EVENT sent, no AUTH, nothing else.
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
