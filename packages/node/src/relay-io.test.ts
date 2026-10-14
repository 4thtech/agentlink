// M1-5b-b: the Node relay connector, host resolver and NIP-11 fetcher (07 §4.2 "Relay connections";
// 04 §4 "Transport, at connect"). Local TLS servers on 127.0.0.1 with a throwaway certificate stand
// in for relays; a fake name server stands in for DNS. No test touches the network.
import dns from 'node:dns';
import type { Socket } from 'node:net';
import {
  CONNECT_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  NIP11_MAX_BYTES,
  RelayPool,
  type RelayConnector,
  type RelayTarget,
} from '@agentlink/transport-nostr';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RELAY_HOST,
  makeSignedWrap,
  makeTestAgent,
  makeTestCertificate,
  startCountingListener,
  startTestRelay,
  type TestCertificate,
  type TestRelay,
} from './relay-io.fixture.js';
import {
  NIP11_TIMEOUT_MS,
  createHostResolverWith,
  createNip11FetcherWith,
  createRelayConnectorWith,
  nodeHostResolver,
  nodeNip11Fetcher,
  nodeRelayConnector,
} from './relay-io.js';

const OTHER_HOST = 'other.agentlink.test';
let certificate: TestCertificate;
const relays: TestRelay[] = [];

beforeAll(() => {
  certificate = makeTestCertificate([
    RELAY_HOST,
    'relay-a.agentlink.test',
    'relay-b.agentlink.test',
    'relay-c.agentlink.test',
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

async function relay(options: Parameters<typeof startTestRelay>[1] = {}): Promise<TestRelay> {
  const started = await startTestRelay(certificate, options);
  relays.push(started);
  return started;
}

function targetFor(port: number, overrides: Partial<RelayTarget> = {}): RelayTarget {
  return {
    url: `wss://${RELAY_HOST}:${port}/`,
    host: RELAY_HOST,
    port,
    address: '127.0.0.1',
    ...overrides,
  };
}

/** Opens a socket and records what the connector reported. */
function observe(connector: RelayConnector, target: RelayTarget) {
  const messages: unknown[] = [];
  let opens = 0;
  let closes = 0;
  let resolveOpen: (open: boolean) => void = () => undefined;
  let resolveClose: () => void = () => undefined;
  const opened = new Promise<boolean>((resolve) => (resolveOpen = resolve));
  const closed = new Promise<void>((resolve) => (resolveClose = resolve));
  const socket = connector.open(target, {
    onOpen: () => {
      opens += 1;
      resolveOpen(true);
    },
    onMessage: (data) => messages.push(data),
    onClose: () => {
      closes += 1;
      resolveOpen(false);
      resolveClose();
    },
  });
  return {
    socket,
    messages,
    opened,
    closed,
    counts: () => ({ opens, closes }),
  };
}

const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

/** A text frame of exactly `bytes` UTF-8 bytes, with `char` (1 or 2 bytes) as filler. */
function frameOfBytes(bytes: number, char = 'a'): string {
  const prefix = '["NOTICE","';
  const suffix = '"]';
  const fill = bytes - prefix.length - suffix.length;
  const width = Buffer.byteLength(char);
  const text = prefix + char.repeat(Math.floor(fill / width)) + 'a'.repeat(fill % width) + suffix;
  expect(Buffer.byteLength(text)).toBe(bytes);
  return text;
}

describe('the connector connects to the checked address only (07 §4.2 step 3)', () => {
  it('opens to the pinned address, with SNI and Host from the host name, and never looks the name up', async () => {
    const server = await relay();
    // A later lookup of the same name would answer a private address: the connector must not ask.
    const lookup = vi
      .spyOn(dns, 'lookup')
      .mockImplementation(((
        _host: string,
        _options: unknown,
        callback: (err: null, addresses: { address: string; family: number }[]) => void,
      ) => callback(null, [{ address: '10.66.0.1', family: 4 }])) as unknown as typeof dns.lookup);
    const connection = observe(
      createRelayConnectorWith({ ca: certificate.cert }),
      targetFor(server.port),
    );
    expect(await connection.opened).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]).toMatchObject({
      kind: 'upgrade',
      servername: RELAY_HOST,
      host: `${RELAY_HOST}:${server.port}`,
      remoteAddress: '127.0.0.1',
    });
    connection.socket.close();
    await connection.closed;
  });

  it('DNS rebinding: the check answer is used even when the next answer for the name differs', async () => {
    const server = await relay();
    // The fake name server: the first query (the check) answers the test relay's address, every
    // later one a private address. The pool hands the connector the first answer.
    const answers = [['127.0.0.1'], ['10.66.0.1'], ['10.66.0.1']];
    const queries: string[] = [];
    const resolver = createHostResolverWith({
      lookup: (host, _options, callback) => {
        queries.push(host);
        const next = answers.shift() ?? ['10.66.0.1'];
        callback(
          null,
          next.map((address) => ({ address, family: 4 })),
        );
      },
    });
    const checked = await resolver.resolve(RELAY_HOST);
    expect(checked).toEqual(['127.0.0.1']);
    const systemLookup = vi.spyOn(dns, 'lookup');
    const connection = observe(
      createRelayConnectorWith({ ca: certificate.cert }),
      targetFor(server.port, { address: checked[0] }),
    );
    expect(await connection.opened).toBe(true);
    expect(queries).toEqual([RELAY_HOST]); // one lookup: the check
    expect(systemLookup).not.toHaveBeenCalled();
    expect(server.seen[0]?.remoteAddress).toBe('127.0.0.1');
    connection.socket.close();
    await connection.closed;
  });

  it('verifies the certificate against the host name, not the address', async () => {
    const server = await relay();
    const connection = observe(
      createRelayConnectorWith({ ca: certificate.cert }),
      targetFor(server.port, { host: OTHER_HOST, url: `wss://${OTHER_HOST}:${server.port}/` }),
    );
    expect(await connection.opened).toBe(false);
    expect(server.seen).toHaveLength(0);
  });

  it('refuses a certificate the trust store does not know (no CA given)', async () => {
    const server = await relay();
    const connection = observe(nodeRelayConnector(), targetFor(server.port));
    expect(await connection.opened).toBe(false);
    expect(server.seen).toHaveLength(0);
  });

  it.each([
    ['no checked address', { address: undefined }],
    ['a host name as the address', { address: RELAY_HOST }],
    ['an address with a zone id', { address: 'fe80::1%lo0' }],
    ['a ws:// URL', { url: `ws://${RELAY_HOST}:1/` }],
  ])('fails closed on %s, without connecting', async (_name, overrides) => {
    const server = await relay();
    const lookup = vi.spyOn(dns, 'lookup');
    const connection = observe(
      createRelayConnectorWith({ ca: certificate.cert }),
      targetFor(server.port, overrides as Partial<RelayTarget>),
    );
    expect(await connection.opened).toBe(false);
    await settle();
    expect(connection.counts()).toEqual({ opens: 0, closes: 1 });
    expect(server.seen).toHaveLength(0);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('redirects are refused (07 §4.2 step 4)', () => {
  it.each([301, 302, 307, 308])('does not follow a %i on the upgrade', async (status) => {
    const target = await relay();
    const server = await relay({
      upgrade: (_req, socket: Socket) => {
        socket.end(
          `HTTP/1.1 ${status} Moved\r\nLocation: wss://${RELAY_HOST}:${target.port}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        );
        return false;
      },
    });
    const connection = observe(
      createRelayConnectorWith({ ca: certificate.cert }),
      targetFor(server.port),
    );
    expect(await connection.opened).toBe(false);
    await settle();
    expect(target.seen).toHaveLength(0);
    expect(connection.counts()).toEqual({ opens: 0, closes: 1 });
  });

  it('does not follow a redirect on the NIP-11 read', async () => {
    const target = await relay({ http: (_req, res) => res.end('{"name":"elsewhere"}') });
    const server = await relay({
      http: (_req, res) => {
        res.writeHead(302, { Location: `https://${RELAY_HOST}:${target.port}/` }).end();
      },
    });
    await expect(
      createNip11FetcherWith({ ca: certificate.cert }).fetch(targetFor(server.port)),
    ).rejects.toThrow();
    expect(target.seen).toHaveLength(0);
  });
});

describe('proxy settings are ignored (07 §4.2 step 5)', () => {
  it('connects and reads NIP-11 directly with HTTPS_PROXY, ALL_PROXY and friends set', async () => {
    const proxy = await startCountingListener();
    try {
      const proxyUrl = `http://127.0.0.1:${proxy.port}`;
      for (const name of [
        'HTTPS_PROXY',
        'https_proxy',
        'HTTP_PROXY',
        'http_proxy',
        'ALL_PROXY',
        'all_proxy',
        'WS_PROXY',
        'WSS_PROXY',
      ]) {
        vi.stubEnv(name, proxyUrl);
      }
      vi.stubEnv('NO_PROXY', '');
      vi.stubEnv('no_proxy', '');
      vi.stubEnv('NODE_USE_ENV_PROXY', '1');
      const server = await relay({
        http: (_req, res) => res.writeHead(200).end('{"name":"direct"}'),
      });
      const connection = observe(
        createRelayConnectorWith({ ca: certificate.cert }),
        targetFor(server.port),
      );
      expect(await connection.opened).toBe(true);
      expect(
        await createNip11FetcherWith({ ca: certificate.cert }).fetch(targetFor(server.port)),
      ).toBe('{"name":"direct"}');
      expect(proxy.connections()).toBe(0);
      expect(server.seen.map((s) => s.kind).sort()).toEqual(['http', 'upgrade']);
      connection.socket.close();
      await connection.closed;
    } finally {
      await proxy.close();
    }
  });
});

describe('inbound messages are capped at 131 072 bytes in the socket layer (04 §3.1.1)', () => {
  it('uses the transport limit', () => {
    expect(MAX_FRAME_BYTES).toBe(131_072);
  });

  it('delivers a 131 072-byte message as a string and keeps the socket open', async () => {
    const frame = frameOfBytes(MAX_FRAME_BYTES);
    const server = await relay({ onSocket: (ws) => ws.send(frame) });
    const connection = observe(
      createRelayConnectorWith({ ca: certificate.cert }),
      targetFor(server.port),
    );
    expect(await connection.opened).toBe(true);
    await vi.waitFor(() => expect(connection.messages).toHaveLength(1));
    expect(connection.messages[0]).toBe(frame);
    await settle();
    expect(connection.counts().closes).toBe(0);
    connection.socket.close();
    await connection.closed;
  });

  it.each([
    ['ASCII', 'a'],
    ['two-byte UTF-8 (counted in bytes, not characters)', 'é'],
  ])(
    'closes the socket on a 131 073-byte %s message and never delivers it',
    async (_name, char) => {
      const frame = frameOfBytes(MAX_FRAME_BYTES + 1, char);
      const server = await relay({ onSocket: (ws) => ws.send(frame) });
      const connection = observe(
        createRelayConnectorWith({ ca: certificate.cert }),
        targetFor(server.port),
      );
      expect(await connection.opened).toBe(true);
      await connection.closed;
      expect(connection.messages).toHaveLength(0);
      expect(connection.counts().closes).toBe(1);
    },
  );

  it('counts a fragmented message as a whole', async () => {
    const server = await relay({
      onSocket: (ws) => {
        ws.send('a'.repeat(70_000), { fin: false });
        ws.send('a'.repeat(70_000), { fin: true });
      },
    });
    const connection = observe(
      createRelayConnectorWith({ ca: certificate.cert }),
      targetFor(server.port),
    );
    expect(await connection.opened).toBe(true);
    await connection.closed;
    expect(connection.messages).toHaveLength(0);
  });

  it('does not negotiate per-message compression', async () => {
    const server = await relay();
    const connection = observe(
      createRelayConnectorWith({ ca: certificate.cert }),
      targetFor(server.port),
    );
    expect(await connection.opened).toBe(true);
    expect(server.seen[0]?.extensions).toBeUndefined();
    connection.socket.close();
    await connection.closed;
  });

  it('drops binary frames and delivers text frames as strings', async () => {
    const server = await relay({
      onSocket: (ws) => {
        ws.send(Buffer.from('["NOTICE","binary"]'), { binary: true });
        ws.send('["NOTICE","text"]');
      },
    });
    const connection = observe(
      createRelayConnectorWith({ ca: certificate.cert }),
      targetFor(server.port),
    );
    expect(await connection.opened).toBe(true);
    await vi.waitFor(() => expect(connection.messages).toEqual(['["NOTICE","text"]']));
    connection.socket.close();
    await connection.closed;
  });

  it('sends text frames, and reports one close after close()', async () => {
    const received: string[] = [];
    const server = await relay({
      onSocket: (ws) => ws.on('message', (data) => received.push(String(data))),
    });
    const connection = observe(
      createRelayConnectorWith({ ca: certificate.cert }),
      targetFor(server.port),
    );
    expect(await connection.opened).toBe(true);
    connection.socket.send('["REQ","s",{}]');
    await vi.waitFor(() => expect(received).toEqual(['["REQ","s",{}]']));
    connection.socket.close();
    connection.socket.close();
    await connection.closed;
    await settle();
    expect(connection.counts()).toEqual({ opens: 1, closes: 1 });
    expect(() => connection.socket.send('late')).not.toThrow();
  });
});

describe('the NIP-11 read (07 §4.2 "Size")', () => {
  const nip11 = (body: string | Buffer, headers: Record<string, string> = {}) => ({
    http: (_req: unknown, res: import('node:http').ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'application/nostr+json', ...headers });
      res.end(body);
    },
  });

  it('GETs the relay path with Accept: application/nostr+json, pinned, and returns the body', async () => {
    const lookup = vi.spyOn(dns, 'lookup');
    const server = await relay(nip11('{"limitation":{"max_message_length":4096}}'));
    const body = await createNip11FetcherWith({ ca: certificate.cert }).fetch(
      targetFor(server.port, { url: `wss://${RELAY_HOST}:${server.port}/nostr` }),
    );
    expect(body).toBe('{"limitation":{"max_message_length":4096}}');
    expect(server.seen).toEqual([
      expect.objectContaining({
        kind: 'http',
        servername: RELAY_HOST,
        host: `${RELAY_HOST}:${server.port}`,
        accept: 'application/nostr+json',
        path: '/nostr',
        remoteAddress: '127.0.0.1',
      }),
    ]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('accepts a body of exactly the cap', async () => {
    const server = await relay(nip11('x'.repeat(NIP11_MAX_BYTES)));
    const body = await createNip11FetcherWith({ ca: certificate.cert }).fetch(
      targetFor(server.port),
    );
    expect(body).toHaveLength(NIP11_MAX_BYTES);
  });

  it('abandons a body one byte over the cap, declared or chunked', async () => {
    const declared = await relay(nip11('x'.repeat(NIP11_MAX_BYTES + 1)));
    await expect(
      createNip11FetcherWith({ ca: certificate.cert }).fetch(targetFor(declared.port)),
    ).rejects.toThrow();
    const chunked = await relay({
      http: (_req, res) => {
        res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
        res.write('x'.repeat(NIP11_MAX_BYTES));
        res.write('x');
        res.end();
      },
    });
    await expect(
      createNip11FetcherWith({ ca: certificate.cert }).fetch(targetFor(chunked.port)),
    ).rejects.toThrow();
  });

  it('abandons a slow response within its own timeout, shorter than the connect budget', async () => {
    expect(NIP11_TIMEOUT_MS).toBe(5_000);
    expect(NIP11_TIMEOUT_MS).toBeLessThan(CONNECT_TIMEOUT_MS);
    const silent = await relay({ http: () => undefined });
    let started = Date.now();
    await expect(
      createNip11FetcherWith({ ca: certificate.cert, timeoutMs: 300 }).fetch(
        targetFor(silent.port),
      ),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
    // A drip of one byte every 50 ms never ends: the timeout is a deadline, not an idle timer.
    const timers: NodeJS.Timeout[] = [];
    const drip = await relay({
      http: (_req, res) => {
        res.writeHead(200);
        timers.push(setInterval(() => res.write('x'), 50));
        res.on('close', () => timers.forEach(clearInterval));
      },
    });
    started = Date.now();
    await expect(
      createNip11FetcherWith({ ca: certificate.cert, timeoutMs: 300 }).fetch(targetFor(drip.port)),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
    timers.forEach(clearInterval);
  });

  it('rejects any status other than 200 without echoing relay text', async () => {
    const server = await relay({
      http: (_req, res) => res.writeHead(500).end('RELAY-TEXT-CANARY http://169.254.169.254/'),
    });
    const error = await createNip11FetcherWith({ ca: certificate.cert })
      .fetch(targetFor(server.port))
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toMatch(
      /CANARY|169\.254|agentlink\.test|127\.0\.0\.1/,
    );
  });

  it('fails closed without a checked address, a valid certificate or the wss scheme', async () => {
    const server = await relay(nip11('{}'));
    const fetcher = createNip11FetcherWith({ ca: certificate.cert });
    await expect(fetcher.fetch(targetFor(server.port, { address: undefined }))).rejects.toThrow();
    await expect(fetcher.fetch(targetFor(server.port, { address: RELAY_HOST }))).rejects.toThrow();
    await expect(
      fetcher.fetch(targetFor(server.port, { url: `ws://${RELAY_HOST}:${server.port}/` })),
    ).rejects.toThrow();
    await expect(
      fetcher.fetch(
        targetFor(server.port, { host: OTHER_HOST, url: `wss://${OTHER_HOST}:${server.port}/` }),
      ),
    ).rejects.toThrow();
    await expect(nodeNip11Fetcher().fetch(targetFor(server.port))).rejects.toThrow();
    expect(server.seen).toHaveLength(0);
  });
});

describe('the host resolver (07 §4.2 step 1)', () => {
  it('returns every A and AAAA answer in resolver order', async () => {
    const calls: unknown[] = [];
    const resolver = createHostResolverWith({
      lookup: (host, options, callback) => {
        calls.push([host, options]);
        callback(null, [
          { address: '93.184.215.14', family: 4 },
          { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 },
        ]);
      },
    });
    expect(await resolver.resolve('relay.example.com')).toEqual([
      '93.184.215.14',
      '2606:2800:21f:cb07:6820:80da:af6b:8b2c',
    ]);
    expect(calls).toEqual([['relay.example.com', expect.objectContaining({ all: true })]]);
  });

  it('rejects with a fixed message on a lookup error', async () => {
    const resolver = createHostResolverWith({
      lookup: (_host, _options, callback) =>
        callback(
          Object.assign(new Error('getaddrinfo ENOTFOUND relay.example.com'), {
            code: 'ENOTFOUND',
          }),
          [],
        ),
    });
    const error = await resolver.resolve('relay.example.com').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/relay\.example\.com/);
  });

  it('uses the system resolver by default, with all answers', async () => {
    const lookup = vi
      .spyOn(dns, 'lookup')
      .mockImplementation(((
        _host: string,
        _options: unknown,
        callback: (err: null, addresses: { address: string; family: number }[]) => void,
      ) =>
        callback(null, [{ address: '93.184.215.14', family: 4 }])) as unknown as typeof dns.lookup);
    expect(await nodeHostResolver().resolve('relay.example.com')).toEqual(['93.184.215.14']);
    expect(lookup).toHaveBeenCalledWith(
      'relay.example.com',
      expect.objectContaining({ all: true }),
      expect.any(Function),
    );
  });
});

describe('with the relay pool of @agentlink/transport-nostr', () => {
  it('publishes through the connector: the pool skips the small relay and gets 2 OKs', async () => {
    const accept = {
      onSocket: (ws: import('ws').WebSocket) =>
        ws.on('message', (data) => {
          const frame = JSON.parse(String(data)) as [string, { id: string }];
          if (frame[0] === 'EVENT') ws.send(JSON.stringify(['OK', frame[1].id, true, '']));
        }),
    };
    const a = await relay({ ...accept, ...nip11Doc(65_536) });
    const b = await relay({ ...accept, ...nip11Doc(undefined) });
    const small = await relay({ ...accept, ...nip11Doc(256) });
    // The pool checks a public answer; the test routes that checked address to the local server.
    const routes = new Map([
      ['93.184.215.1', a.port],
      ['93.184.215.2', b.port],
      ['93.184.215.3', small.port],
    ]);
    const answers = new Map([
      ['relay-a.agentlink.test', '93.184.215.1'],
      ['relay-b.agentlink.test', '93.184.215.2'],
      ['relay-c.agentlink.test', '93.184.215.3'],
    ]);
    const route = (address: string) => ({ address: '127.0.0.1', port: routes.get(address) ?? 1 });
    const pool = new RelayPool({
      connector: createRelayConnectorWith({ ca: certificate.cert, route }),
      nip11: createNip11FetcherWith({ ca: certificate.cert, route }),
      addressCheck: {
        resolver: { resolve: (host) => Promise.resolve([answers.get(host) ?? '10.0.0.1']) },
      },
    });
    const keys = await makeTestAgent();
    try {
      const event = await makeSignedWrap(keys, 512);
      const outcome = await pool.publish(event, [
        'wss://relay-a.agentlink.test',
        'wss://relay-b.agentlink.test',
        'wss://relay-c.agentlink.test',
      ]);
      expect(outcome.sent).toBe(true);
      expect(Object.fromEntries(outcome.results.map((r) => [r.relay, r.reason]))).toEqual({
        'wss://relay-a.agentlink.test': 'ok',
        'wss://relay-b.agentlink.test': 'ok',
        'wss://relay-c.agentlink.test': 'too_large',
      });
      expect(a.seen.find((s) => s.kind === 'upgrade')).toMatchObject({
        servername: 'relay-a.agentlink.test',
        host: 'relay-a.agentlink.test',
      });
    } finally {
      pool.close();
      await keys.close();
    }
  });
});

function nip11Doc(maxMessageLength: number | undefined) {
  return {
    http: (_req: unknown, res: import('node:http').ServerResponse) => {
      const doc =
        maxMessageLength === undefined
          ? { name: 'test' }
          : { name: 'test', limitation: { max_message_length: maxMessageLength } };
      res.writeHead(200, { 'Content-Type': 'application/nostr+json' }).end(JSON.stringify(doc));
    },
  };
}
