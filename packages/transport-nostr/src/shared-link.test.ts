// RELAY-SHARED-CONN L2: the shared relay link's multiplexer (the state machine the L3 server hosts)
// and the client connector that the RelayPool uses unchanged. Mock relays and an in-memory channel:
// no sockets, no network. Fake timers drive the handshake and check timeouts.
import { encodeHex, randomBytes, type EnvelopeKeys } from '@4thtech-io/crypto';
import { MemoryKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger, type Level, type Logger } from '@4thtech-io/log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayConnector, RelaySocket, RelaySocketHandlers } from './relay-io.js';
import { MAX_FRAME_BYTES, RelayPool, type RelayPoolOptions } from './relay-pool.js';
import { SharedLinkMux, type SharedLinkMuxOptions } from './shared-link-mux.js';
import {
  SHARED_LINK_VERSION,
  decodeServerFrame,
  encodeLinkFrame,
  linkProof,
} from './shared-link-protocol.js';
import {
  FallbackConnector,
  SHARED_HANDSHAKE_TIMEOUT_MS,
  SharedLinkUnavailable,
  SharedRelayConnector,
  type SharedRelayConnectorOptions,
} from './shared-relay-connector.js';
import { MockNetwork, PUBLIC_ADDRESS, makeWrapEvent, relayUrls } from './testing/mock-network.js';
import { memoryDialer, stalledDialer } from './testing/shared-link-memory.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const CLI = '0.5.18';
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** Counts sockets a connector has open at once (MockSocket.close does not call onClose). */
function counting(inner: RelayConnector): { connector: RelayConnector; max: () => number } {
  let live = 0;
  let max = 0;
  return {
    max: () => max,
    connector: {
      open(target, handlers) {
        live += 1;
        max = Math.max(max, live);
        let ended = false;
        const end = (): void => {
          if (!ended) {
            ended = true;
            live -= 1;
          }
        };
        const socket = inner.open(target, {
          ...handlers,
          onClose: () => {
            end();
            handlers.onClose();
          },
        });
        return {
          send: (text) => socket.send(text),
          close: () => {
            end();
            socket.close();
          },
        };
      },
    },
  };
}

function setup(mux: Partial<SharedLinkMuxOptions> = {}) {
  const net = new MockNetwork();
  const direct = new MockNetwork();
  const lines: string[] = [];
  const logger: Logger = createLogger({
    level: 'debug',
    sink: (_level: Level, line: string) => lines.push(line),
  });
  const token = randomBytes(32);
  const server = new SharedLinkMux({
    connector: net,
    addressCheck: { resolver: net },
    token,
    cliVersion: CLI,
    logger,
    ...mux,
  });
  const { dial, links } = memoryDialer(server);
  const shared = (options: Partial<SharedRelayConnectorOptions> = {}): SharedRelayConnector =>
    new SharedRelayConnector({ dial, token, cliVersion: CLI, logger, ...options });
  const pool = (
    connector: SharedRelayConnector,
    options: Partial<RelayPoolOptions> = {},
  ): RelayPool =>
    new RelayPool({
      connector: new FallbackConnector(connector, direct),
      addressCheck: { resolver: net },
      logger,
      ...options,
    });
  return { net, direct, server, links, lines, token, logger, shared, pool };
}

interface Raw {
  socket: RelaySocket;
  got: string[];
  failures: string[];
  opened: () => boolean;
  closed: () => boolean;
}

/** A virtual socket opened straight on a connector, recording what reaches it. */
function raw(connector: RelayConnector, url: string, address = PUBLIC_ADDRESS): Raw {
  const got: string[] = [];
  const failures: string[] = [];
  let opened = false;
  let closed = false;
  const handlers: RelaySocketHandlers = {
    onOpen: () => {
      opened = true;
    },
    onMessage: (data) => got.push(data as string),
    onClose: () => {
      closed = true;
    },
    onFailure: (kind) => failures.push(kind),
  };
  const host = /^wss:\/\/([^/:]+)/.exec(url)?.[1] ?? 'invalid';
  const socket = connector.open({ url, host, port: 443, address }, handlers);
  return { socket, got, failures, opened: () => opened, closed: () => closed };
}

const parsed = (r: Raw): unknown[][] => r.got.map((text) => JSON.parse(text) as unknown[]);

async function keys(): Promise<{ store: EnvelopeKeys; pubkey: string }> {
  const store = new MemoryKeyStore(randomBytes(32));
  const bundle = await store.getPublicBundle();
  return { store, pubkey: encodeHex(bundle.agentNostr) };
}

describe('one upstream per relay', () => {
  it('two programs publishing to the same relays share one connection per relay', async () => {
    const { net, direct, shared, pool, server } = setup();
    const [r1, r2] = relayUrls('share', 2) as [string, string];
    net.configure(r1);
    net.configure(r2);
    const a = pool(shared());
    const b = pool(shared());
    const [outA, outB] = await Promise.all([
      a.publish(makeWrapEvent(), [r1, r2]),
      b.publish(makeWrapEvent(), [r1, r2]),
    ]);
    expect(outA.sent).toBe(true);
    expect(outB.sent).toBe(true);
    expect(net.opens.filter((t) => t.url === r1)).toHaveLength(1);
    expect(net.opens.filter((t) => t.url === r2)).toHaveLength(1);
    expect(direct.opens).toHaveLength(0);
    expect(server.stats().upstreams).toBe(2);
  });

  it('closes the upstream once the last program lets go of it', async () => {
    const { net, shared, server } = setup();
    const [r1] = relayUrls('last', 1) as [string];
    net.configure(r1);
    const a = raw(shared(), r1);
    const b = raw(shared(), r1);
    await flush();
    expect(a.opened() && b.opened()).toBe(true);
    a.socket.close();
    await flush();
    expect(net.socket(r1)?.closed).toBe(false);
    b.socket.close();
    await flush();
    expect(net.socket(r1)?.closed).toBe(true);
    expect(server.stats().upstreams).toBe(0);
  });
});

describe('subscription ids', () => {
  it('rewrites ids upstream and never shows a program another program events or EOSE', async () => {
    const { net, shared } = setup();
    const [r1] = relayUrls('subs', 1) as [string];
    net.configure(r1);
    const a = raw(shared(), r1);
    const b = raw(shared(), r1);
    await flush();
    const pA = 'a1'.repeat(32);
    const pB = 'b2'.repeat(32);
    a.socket.send(JSON.stringify(['REQ', 's1', { kinds: [1059], '#p': [pA] }]));
    b.socket.send(JSON.stringify(['REQ', 's1', { kinds: [1059], '#p': [pB] }]));
    await flush();
    const upstream = net.reqs(r1).map((r) => r.subId);
    expect(upstream).toHaveLength(2);
    expect(new Set(upstream).size).toBe(2);
    for (const id of upstream) expect(id).toMatch(/^c[0-9]+:s1$/);
    expect(parsed(a)).toEqual([['EOSE', 's1']]);
    expect(parsed(b)).toEqual([['EOSE', 's1']]);

    const forA = makeWrapEvent({ recipient: pA });
    net.inject(r1, forA);
    await flush();
    expect(parsed(a).at(-1)).toEqual(['EVENT', 's1', JSON.parse(JSON.stringify(forA))]);
    expect(parsed(b)).toEqual([['EOSE', 's1']]);

    a.socket.send(JSON.stringify(['CLOSE', 's1']));
    await flush();
    const closes = net.received
      .filter((f) => f.relay === r1)
      .map((f) => JSON.parse(f.frame) as unknown[])
      .filter((f) => f[0] === 'CLOSE');
    expect(closes).toEqual([['CLOSE', upstream[0]]]);
    net.inject(r1, makeWrapEvent({ recipient: pA }));
    await flush();
    expect(parsed(a).filter((f) => f[0] === 'EVENT')).toHaveLength(1);
  });

  it('drops relay frames for a subscription no program holds', async () => {
    const { net, shared } = setup();
    const [r1] = relayUrls('stray', 1) as [string];
    net.configure(r1, {
      extraFrames: () => [JSON.stringify(['EVENT', 'c999:s1', makeWrapEvent()]), '["EOSE","s1"]'],
    });
    const a = raw(shared(), r1);
    await flush();
    a.socket.send(JSON.stringify(['REQ', 's1', { kinds: [1059] }]));
    await flush();
    expect(parsed(a)).toEqual([['EOSE', 's1']]);
  });

  it('a pool subscribing through the shared link sees its own subscription ids', async () => {
    const { net, shared, pool } = setup();
    const [r1] = relayUrls('poolsub', 1) as [string];
    net.configure(r1);
    const p = pool(shared());
    const frames: (readonly unknown[])[] = [];
    p.onFrame((_relay, frame) => frames.push(frame));
    const link = await p.connect(r1);
    expect(typeof link).toBe('object');
    if (typeof link === 'string') return;
    link.send(JSON.stringify(['REQ', 'mine', { kinds: [1059] }]));
    await flush();
    expect(frames).toEqual([['EOSE', 'mine']]);
    link.release();
  });
});

describe('OK routing', () => {
  it('routes OK by event id to the program that sent the event only', async () => {
    const { net, shared } = setup();
    const [r1] = relayUrls('ok', 1) as [string];
    net.configure(r1);
    const a = raw(shared(), r1);
    const b = raw(shared(), r1);
    await flush();
    const event = makeWrapEvent();
    a.socket.send(JSON.stringify(['EVENT', event]));
    await flush();
    expect(parsed(a)).toEqual([['OK', event.id, true, '']]);
    expect(b.got).toEqual([]);
  });
});

describe('NIP-42 AUTH through the shared link', () => {
  it('sends the challenge to every program; each signs its own login on the one connection', async () => {
    const { net, shared, pool } = setup();
    const [r1, r2] = relayUrls('auth', 2) as [string, string];
    net.configure(r1, { requireAuth: true });
    net.configure(r2, { requireAuth: true });
    const ka = await keys();
    const kb = await keys();
    const a = pool(shared(), { authKeys: ka.store, mayAuthenticate: () => true });
    const b = pool(shared(), { authKeys: kb.store, mayAuthenticate: () => true });
    const [outA, outB] = await Promise.all([
      a.publish(makeWrapEvent(), [r1, r2]),
      b.publish(makeWrapEvent(), [r1, r2]),
    ]);
    expect(outA.sent).toBe(true);
    expect(outB.sent).toBe(true);
    expect(net.opens.filter((t) => t.url === r1)).toHaveLength(1);
    expect([...(net.socket(r1)?.authedKeys ?? [])].sort()).toEqual([ka.pubkey, kb.pubkey].sort());
  });

  it('a program that may not log in on a relay sends no AUTH, even on a shared connection', async () => {
    const { net, shared, pool } = setup();
    const [r1] = relayUrls('noauth', 1) as [string];
    net.configure(r1, { requireAuth: true });
    const ka = await keys();
    const kc = await keys();
    const a = pool(shared(), { authKeys: ka.store, mayAuthenticate: () => true });
    const c = pool(shared(), { authKeys: kc.store, mayAuthenticate: () => false });
    // C first: it gets the challenge on the shared connection but may not log in, so it fails.
    const outC = await c.publish(makeWrapEvent(), [r1]);
    expect(outC.results[0]?.ok).toBe(false);
    expect((await a.publish(makeWrapEvent(), [r1])).results[0]?.ok).toBe(true);
    expect(net.opens.filter((t) => t.url === r1)).toHaveLength(1);
    const logins = net.received
      .filter((f) => f.frame.startsWith('["AUTH"'))
      .map((f) => (JSON.parse(f.frame) as [string, { pubkey: string }])[1].pubkey);
    expect(logins).toEqual([ka.pubkey]);
  });

  it('a program that joins after the challenge still receives it', async () => {
    const { net, shared } = setup();
    const [r1] = relayUrls('late', 1) as [string];
    net.configure(r1, { requireAuth: true });
    const a = raw(shared(), r1);
    await flush();
    const b = raw(shared(), r1);
    await flush();
    const challenge = net.socket(r1)?.challenge;
    expect(parsed(a)).toEqual([['AUTH', challenge]]);
    expect(parsed(b)).toEqual([['AUTH', challenge]]);
  });
});

describe('not an open proxy (04 §4)', () => {
  it('refuses a URL the relay URL rule does not allow, without connecting', async () => {
    const { net, shared, server } = setup();
    for (const url of ['wss://localhost', 'ws://relay.nostr-test.dev', 'wss://10.0.0.1']) {
      const r = raw(shared(), url);
      await flush();
      expect(r.opened()).toBe(false);
      expect(r.closed()).toBe(true);
    }
    expect(net.opens).toHaveLength(0);
    expect(net.resolves).toHaveLength(0);
    expect(server.stats().refused).toBe(3);
  });

  it('re-checks the address itself: a private answer is refused whatever the program claims', async () => {
    const { net, shared } = setup();
    const url = 'wss://inside.nostr-test.dev';
    net.configure(url);
    net.dns.set('inside.nostr-test.dev', ['10.0.0.7']);
    const r = raw(shared(), url, PUBLIC_ADDRESS);
    await flush();
    expect(r.opened()).toBe(false);
    expect(r.closed()).toBe(true);
    expect(net.opens).toHaveLength(0);
  });

  it('connects to the address it checked, never the one the program sent', async () => {
    const { net, shared } = setup();
    const [r1] = relayUrls('pin', 1) as [string];
    net.configure(r1);
    raw(shared(), r1, '203.0.113.9');
    await flush();
    expect(net.opens[0]?.address).toBe(PUBLIC_ADDRESS);
  });

  it('caps relays per program; over the cap the pool uses its own connection', async () => {
    const { net, direct, shared, pool } = setup({ maxRelaysPerClient: 2 });
    const urls = relayUrls('cap', 3);
    for (const url of urls) {
      net.configure(url);
      direct.configure(url);
    }
    const p = pool(shared());
    const out = await p.publish(makeWrapEvent(), urls);
    expect(out.results.every((r) => r.ok)).toBe(true);
    expect(net.openedUrls()).toHaveLength(2);
    expect(direct.openedUrls()).toHaveLength(1);
  });

  it('caps upstream connections in total', async () => {
    const { net, direct, shared, pool, server } = setup({ maxUpstreams: 1 });
    const urls = relayUrls('total', 2);
    for (const url of urls) {
      net.configure(url);
      direct.configure(url);
    }
    await pool(shared()).publish(makeWrapEvent(), urls);
    expect(net.openedUrls()).toHaveLength(1);
    expect(direct.openedUrls()).toHaveLength(1);
    expect(server.stats().upstreams).toBeLessThanOrEqual(1);
  });
});

describe('frame limits', () => {
  it('drops and counts a relay frame over MAX_FRAME_BYTES; the program never sees it', async () => {
    const { net, shared, server } = setup();
    const [r1] = relayUrls('big', 1) as [string];
    const huge = JSON.stringify(['NOTICE', 'x'.repeat(MAX_FRAME_BYTES)]);
    net.configure(r1, { extraFrames: () => [huge] });
    const a = raw(shared(), r1);
    await flush();
    a.socket.send(JSON.stringify(['REQ', 's', { kinds: [1] }]));
    await flush();
    expect(a.got.some((t) => t.length > MAX_FRAME_BYTES)).toBe(false);
    expect(parsed(a)).toEqual([['EOSE', 's']]);
    expect(server.stats().dropped.too_large).toBe(1);
  });

  it('drops and counts an oversized or unknown frame from a program, and forwards nothing', async () => {
    const { net, shared, links, server } = setup();
    const [r1] = relayUrls('bigc', 1) as [string];
    net.configure(r1);
    raw(shared(), r1);
    await flush();
    const before = net.received.length;
    const client = links[0]?.client;
    client?.receive(`{"t":"send","link":1}\n${'x'.repeat(MAX_FRAME_BYTES + 1)}`);
    client?.receive('{"t":"teleport","link":1}');
    client?.receive(encodeLinkFrame({ t: 'send', link: 1, data: '["PING","x"]' }));
    await flush();
    expect(net.received.length).toBe(before);
    expect(server.stats().dropped.too_large).toBe(1);
    expect(server.stats().dropped.unknown).toBeGreaterThanOrEqual(1);
  });

  it('refuses to send relay text over MAX_FRAME_BYTES on a virtual socket', async () => {
    const { net, shared } = setup();
    const [r1] = relayUrls('bigs', 1) as [string];
    net.configure(r1);
    const a = raw(shared(), r1);
    await flush();
    expect(() => a.socket.send('x'.repeat(MAX_FRAME_BYTES + 1))).toThrow();
  });
});

describe('handshake and fallback to the program own connections', () => {
  it('a CLI version mismatch falls back to direct connections', async () => {
    const { net, direct, shared, pool } = setup();
    const [r1, r2] = relayUrls('ver', 2) as [string, string];
    for (const url of [r1, r2]) {
      net.configure(url);
      direct.configure(url);
    }
    const connector = shared({ cliVersion: '0.5.17' });
    const out = await pool(connector).publish(makeWrapEvent(), [r1, r2]);
    expect(out.sent).toBe(true);
    expect(net.opens).toHaveLength(0);
    expect(direct.openedUrls().sort()).toEqual([r1, r2].sort());
    expect(connector.state).toBe('refused');
  });

  it('a protocol version mismatch is rejected and the channel closed', async () => {
    const { server } = setup();
    const sent: string[] = [];
    let closed = false;
    const client = server.attach({
      send: (f) => sent.push(f),
      close: () => {
        closed = true;
      },
    });
    client.receive(
      encodeLinkFrame({ t: 'hello', v: SHARED_LINK_VERSION + 1, cli: CLI, nonce: 'aa'.repeat(32) }),
    );
    await flush();
    expect(sent).toEqual([encodeLinkFrame({ t: 'reject', reason: 'version' })]);
    expect(closed).toBe(true);
  });

  it('proves the token both ways without sending it; a wrong proof closes before any relay frame', async () => {
    const { net, server, token } = setup();
    const [r1] = relayUrls('tok', 1) as [string];
    net.configure(r1);
    const sent: string[] = [];
    let closed = false;
    const client = server.attach({
      send: (f) => sent.push(f),
      close: () => {
        closed = true;
      },
    });
    const cn = 'aa'.repeat(32);
    client.receive(encodeLinkFrame({ t: 'hello', v: SHARED_LINK_VERSION, cli: CLI, nonce: cn }));
    await flush();
    const challenge = decodeServerFrame(sent[0]);
    if (!challenge.ok || challenge.frame.t !== 'challenge') throw new Error('no challenge');
    const sn = challenge.frame.nonce;
    expect(challenge.frame.proof).toBe(linkProof(token, 'server', cn, sn));
    expect(sent.join('')).not.toContain(encodeHex(token));
    // A proof made with another token.
    client.receive(
      encodeLinkFrame({ t: 'prove', proof: linkProof(randomBytes(32), 'client', cn, sn) }),
    );
    client.receive(encodeLinkFrame({ t: 'open', link: 1, url: r1 }));
    await flush();
    expect(sent.slice(1)).toEqual([encodeLinkFrame({ t: 'reject', reason: 'token' })]);
    expect(closed).toBe(true);
    expect(net.opens).toHaveLength(0);
  });

  it('a right proof is accepted', async () => {
    const { server, token } = setup();
    const sent: string[] = [];
    const client = server.attach({ send: (f) => sent.push(f), close: () => undefined });
    const cn = 'cc'.repeat(32);
    client.receive(encodeLinkFrame({ t: 'hello', v: SHARED_LINK_VERSION, cli: CLI, nonce: cn }));
    await flush();
    const challenge = decodeServerFrame(sent[0]);
    if (!challenge.ok || challenge.frame.t !== 'challenge') throw new Error('no challenge');
    client.receive(
      encodeLinkFrame({ t: 'prove', proof: linkProof(token, 'client', cn, challenge.frame.nonce) }),
    );
    await flush();
    expect(sent[1]).toBe(encodeLinkFrame({ t: 'accept', v: SHARED_LINK_VERSION }));
  });

  it('a link that cannot prove the token gets nothing from the program but the hello', async () => {
    const { net, direct, links, shared, pool } = setup();
    const [r1, r2] = relayUrls('impostor', 2) as [string, string];
    for (const url of [r1, r2]) direct.configure(url);
    const connector = shared({ token: randomBytes(32) });
    expect((await pool(connector).publish(makeWrapEvent(), [r1, r2])).sent).toBe(true);
    expect(connector.state).toBe('refused');
    expect(net.opens).toHaveLength(0);
    const types = links[0]?.toServer.map(
      (f) => (JSON.parse(f.split('\n')[0] as string) as { t: string }).t,
    );
    expect(types).toEqual(['hello']);
  });

  it('a frame before the handshake closes the channel', async () => {
    const { net, server } = setup();
    const [r1] = relayUrls('early', 1) as [string];
    let closed = false;
    const client = server.attach({
      send: () => undefined,
      close: () => {
        closed = true;
      },
    });
    client.receive(encodeLinkFrame({ t: 'open', link: 1, url: r1 }));
    await flush();
    expect(closed).toBe(true);
    expect(net.opens).toHaveLength(0);
  });

  it('a program with the wrong token falls back to direct connections', async () => {
    const { net, direct, shared, pool } = setup();
    const [r1, r2] = relayUrls('tokf', 2) as [string, string];
    for (const url of [r1, r2]) direct.configure(url);
    const connector = shared({ token: randomBytes(32) });
    expect((await pool(connector).publish(makeWrapEvent(), [r1, r2])).sent).toBe(true);
    expect(net.opens).toHaveLength(0);
    expect(connector.state).toBe('refused');
  });

  it('a stalled shared link falls back to direct connections within the connect budget', async () => {
    const { direct, pool, token, logger } = setup();
    const [r1, r2] = relayUrls('stall', 2) as [string, string];
    for (const url of [r1, r2]) direct.configure(url);
    const { dial } = stalledDialer();
    const connector = new SharedRelayConnector({ dial, token, cliVersion: CLI, logger });
    const pending = pool(connector).publish(makeWrapEvent(), [r1, r2]);
    await vi.advanceTimersByTimeAsync(SHARED_HANDSHAKE_TIMEOUT_MS);
    const out = await pending;
    expect(out.sent).toBe(true);
    expect(direct.openedUrls().sort()).toEqual([r1, r2].sort());
    expect(connector.state).toBe('down');
  });

  it('a dial that throws falls back to direct connections', async () => {
    const { direct, pool, token } = setup();
    const [r1, r2] = relayUrls('nodial', 2) as [string, string];
    for (const url of [r1, r2]) direct.configure(url);
    const connector = new SharedRelayConnector({
      dial: () => {
        throw new Error('no endpoint');
      },
      token,
      cliVersion: CLI,
    });
    expect((await pool(connector).publish(makeWrapEvent(), [r1, r2])).sent).toBe(true);
    expect(() => raw(connector, r1)).toThrow(SharedLinkUnavailable);
  });

  it('when the shared link goes away, open sockets close and new ones go direct', async () => {
    const { net, direct, shared, links } = setup();
    const [r1] = relayUrls('gone', 1) as [string];
    net.configure(r1);
    direct.configure(r1);
    const connector = shared();
    const fallback = new FallbackConnector(connector, direct);
    const a = raw(fallback, r1);
    await flush();
    expect(a.opened()).toBe(true);
    links[0]?.client?.detach();
    await flush();
    expect(a.closed()).toBe(true);
    expect(connector.state).toBe('down');
    const b = raw(fallback, r1);
    await flush();
    expect(b.opened()).toBe(true);
    expect(direct.opens).toHaveLength(1);
  });
});

describe('check lane (D-156 (7) on the shared link)', () => {
  it('batches one program checks into one login-free read per relay, at most one at a time', async () => {
    const net = new MockNetwork();
    const count = counting(net);
    const token = randomBytes(32);
    const server = new SharedLinkMux({
      connector: count.connector,
      addressCheck: { resolver: net },
      token,
      cliVersion: CLI,
    });
    const { dial } = memoryDialer(server);
    const make = (): SharedRelayConnector =>
      new SharedRelayConnector({ dial, token, cliVersion: CLI });
    const [r1] = relayUrls('check', 1) as [string];
    net.configure(r1);
    const e1 = makeWrapEvent();
    const e2 = makeWrapEvent();
    net.inject(r1, e1);
    net.inject(r1, e2);
    const missing = 'ef'.repeat(32);
    const one = make();
    const outcomes = await Promise.all([
      one.checkServed(r1, e1.id),
      one.checkServed(r1, e2.id),
      one.checkServed(r1, missing),
    ]);
    expect(outcomes).toEqual(['served', 'served', 'missing']);
    expect(count.max()).toBe(1);
    const reqs = net.reqs(r1);
    expect(reqs).toHaveLength(1);
    expect([...(reqs[0]?.filter.ids ?? [])].sort()).toEqual([e1.id, e2.id, missing].sort());
    expect(net.received.some((f) => f.frame.startsWith('["AUTH"'))).toBe(false);
  });

  it('never puts ids of different programs into one read (D-159 owner decision 1)', async () => {
    const net = new MockNetwork();
    const count = counting(net);
    const token = randomBytes(32);
    const server = new SharedLinkMux({
      connector: count.connector,
      addressCheck: { resolver: net },
      token,
      cliVersion: CLI,
    });
    const { dial } = memoryDialer(server);
    const a = new SharedRelayConnector({ dial, token, cliVersion: CLI });
    const b = new SharedRelayConnector({ dial, token, cliVersion: CLI });
    const [r1] = relayUrls('apart', 1) as [string];
    net.configure(r1);
    const [e1, e2, e3] = [makeWrapEvent(), makeWrapEvent(), makeWrapEvent()];
    for (const e of [e1, e2, e3]) net.inject(r1, e);
    const outcomes = await Promise.all([
      a.checkServed(r1, e1.id),
      b.checkServed(r1, e3.id),
      a.checkServed(r1, e2.id),
    ]);
    expect(outcomes).toEqual(['served', 'served', 'served']);
    const reads = net.reqs(r1).map((r) => [...(r.filter.ids ?? [])].sort());
    expect(reads).toHaveLength(2);
    expect(reads).toContainEqual([e1.id, e2.id].sort());
    expect(reads).toContainEqual([e3.id]);
    expect(count.max()).toBe(1);
  });

  it('a check that arrives while one runs waits; still one check connection at a time', async () => {
    const net = new MockNetwork();
    const count = counting(net);
    const token = randomBytes(32);
    const server = new SharedLinkMux({
      connector: count.connector,
      addressCheck: { resolver: net },
      token,
      cliVersion: CLI,
    });
    const { dial } = memoryDialer(server);
    const connector = new SharedRelayConnector({ dial, token, cliVersion: CLI });
    const [r1] = relayUrls('queue', 1) as [string];
    net.configure(r1, { reqDelayMs: 100 });
    const e1 = makeWrapEvent();
    net.inject(r1, e1);
    const first = connector.checkServed(r1, e1.id);
    await flush();
    const second = connector.checkServed(r1, e1.id);
    await vi.advanceTimersByTimeAsync(500);
    expect(await first).toBe('served');
    expect(await second).toBe('served');
    expect(count.max()).toBe(1);
    expect(net.opens).toHaveLength(2);
  });

  it('the check never uses the shared publishing connection', async () => {
    const { net, shared } = setup();
    const [r1] = relayUrls('indep', 1) as [string];
    net.configure(r1);
    const connector = shared();
    const a = raw(connector, r1);
    await flush();
    const event = makeWrapEvent();
    a.socket.send(JSON.stringify(['EVENT', event]));
    await flush();
    expect(await connector.checkServed(r1, event.id)).toBe('served');
    expect(net.opens.filter((t) => t.url === r1)).toHaveLength(2);
    const publishing = net.sockets[0];
    expect([...(publishing?.subs.keys() ?? [])]).toEqual([]);
  });

  it('a relay that wants a login for reading leaves the check unchecked, and no login is sent', async () => {
    const { net, shared } = setup();
    const [r1] = relayUrls('gated', 1) as [string];
    net.configure(r1, { reqNeedsAuth: true });
    expect(await shared().checkServed(r1, makeWrapEvent().id)).toBe('unchecked');
    expect(net.received.some((f) => f.frame.startsWith('["AUTH"'))).toBe(false);
  });

  it('an event that does not match or does not verify is not evidence', async () => {
    const { net, shared } = setup();
    const [r1] = relayUrls('forged', 1) as [string];
    const other = makeWrapEvent();
    net.configure(r1, { serveInstead: { ...other, id: 'aa'.repeat(32) } });
    expect(await shared().checkServed(r1, 'aa'.repeat(32))).toBe('missing');
  });

  it('a disallowed URL is unchecked without connecting; an unusable link says so', async () => {
    const { net, shared } = setup();
    expect(await shared().checkServed('wss://localhost', 'aa'.repeat(32))).toBe('unchecked');
    expect(net.opens).toHaveLength(0);
    const refused = shared({ token: randomBytes(32) });
    expect(await refused.checkServed(relayUrls('x', 1)[0] as string, 'aa'.repeat(32))).toBe(
      'unavailable',
    );
  });
});

describe('no frame content in logs or errors (I-7)', () => {
  it('logs counts and fixed reasons only', async () => {
    const { net, shared, pool, links, lines, token } = setup({ maxRelaysPerClient: 1 });
    const [r1, r2] = relayUrls('quiet', 2) as [string, string];
    net.configure(r1, {
      extraFrames: (sub) => [
        JSON.stringify(['NOTICE', 'y'.repeat(MAX_FRAME_BYTES)]),
        JSON.stringify(['EVENT', `${sub}x`, makeWrapEvent()]),
        'not json at all',
      ],
    });
    net.configure(r2);
    const connector = shared();
    const a = raw(connector, r1);
    await flush();
    a.socket.send(JSON.stringify(['REQ', 'secret-sub', { kinds: [1059] }]));
    const event = makeWrapEvent();
    a.socket.send(JSON.stringify(['EVENT', event]));
    raw(connector, r2); // over the per-program cap
    raw(connector, 'wss://localhost');
    links[0]?.client?.receive('{"t":"open","link":99,"url":"wss://leak.nostr-test.dev"}x');
    await pool(shared({ cliVersion: '9.9.9' })).publish(makeWrapEvent(), [r1, r2]);
    await connector.checkServed(r1, event.id);
    await flush();
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    for (const secret of [
      'nostr-test.dev',
      'wss://',
      'localhost',
      'secret-sub',
      event.id,
      encodeHex(token),
      'yyyy',
      'not json',
      '9.9.9',
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  it('errors carry no relay URL', () => {
    const connector = new SharedRelayConnector({
      dial: () => {
        throw new Error('wss://leak.nostr-test.dev');
      },
      token: randomBytes(32),
      cliVersion: CLI,
    });
    let message = '';
    try {
      raw(connector, 'wss://leak.nostr-test.dev');
    } catch (error) {
      message = String(error) + JSON.stringify(error);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('leak');
  });
});
