// NET-PRECHECK (08 §1 `POST /api/ui/network/test`; 04 §4; 07 §4.2, §4.3; I-4, I-5, I-7): the server
// Test behind Advanced › Message network › Your servers. The handler runs the transport's precheck
// over the Node relay I/O (pinned TLS, no redirects, no proxy). Local TLS stand-in relays on
// 127.0.0.1 with a throwaway certificate and a stub resolver: no test reaches a real server.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostResolver } from '@4thtech-io/transport-nostr';
import type { JsonObject } from '@4thtech-io/crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import {
  makeTestCertificate,
  startTestRelay,
  type TestCertificate,
  type TestRelay,
} from '../../relay-io.fixture.js';
import { createNip11FetcherWith, createRelayConnectorWith } from '../../relay-io.js';
import type { LocalUiContext } from '../context.js';
import {
  NETWORK_TEST_MAX_SERVERS,
  NETWORK_TEST_PATH,
  createNetworkTestRoute,
  networkTestRoute,
  type NetworkTestIo,
} from './network-test.js';

const HOST_A = 'relay-a.nostr-test.dev';
const HOST_B = 'relay-b.nostr-test.dev';
const HOST_C = 'relay-c.nostr-test.dev';
const ADDRESS_A = '93.184.215.21';
const ADDRESS_B = '93.184.215.22';

let certificate: TestCertificate;
let otherCertificate: TestCertificate;
const relays: TestRelay[] = [];

beforeAll(() => {
  certificate = makeTestCertificate([HOST_A, HOST_B]);
  otherCertificate = makeTestCertificate(['someone-else.nostr-test.dev']);
}, 60_000);

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

/** A minimal Nostr relay: stores EVENTs (OK true) and serves REQ by ids across connections. */
function speakNostr(store: unknown[], options: { okFalse?: string } = {}) {
  return (ws: WebSocket): void => {
    ws.on('message', (data: Buffer) => {
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (!Array.isArray(frame)) return;
      if (frame[0] === 'EVENT') {
        const event = frame[1] as { id: string };
        if (options.okFalse !== undefined) {
          ws.send(JSON.stringify(['OK', event.id, false, options.okFalse]));
          return;
        }
        store.push(event);
        ws.send(JSON.stringify(['OK', event.id, true, '']));
      } else if (frame[0] === 'REQ') {
        const filter = frame[2] as { ids?: string[]; kinds?: number[]; '#p'?: string[] };
        for (const event of store) {
          const e = event as { id: string; kind: number; tags: string[][] };
          const byId = filter.ids?.includes(e.id) === true;
          const bySync =
            filter.ids === undefined &&
            filter.kinds?.includes(e.kind) === true &&
            e.tags.some((t) => t[0] === 'p' && filter['#p']?.includes(t[1] as string) === true);
          if (byId || bySync) {
            ws.send(JSON.stringify(['EVENT', frame[1], event]));
          }
        }
        ws.send(JSON.stringify(['EOSE', frame[1]]));
      }
    });
  };
}

interface World {
  readonly io: NetworkTestIo;
  readonly resolves: string[];
  readonly dialed: string[];
}

/** Stub DNS plus the Node connector and fetcher routed from public addresses to local ports. */
function world(
  dns: Record<string, readonly (readonly string[])[]>,
  ports: Record<string, number>,
  ca: string = certificate.cert,
): World {
  const resolves: string[] = [];
  const dialed: string[] = [];
  const resolver: HostResolver = {
    resolve(host: string) {
      resolves.push(host);
      const answers = dns[host];
      if (answers === undefined) return Promise.reject(new Error('not found'));
      const count = resolves.filter((h) => h === host).length;
      return Promise.resolve(answers[Math.min(count, answers.length) - 1] ?? []);
    },
  };
  const route = (address: string, port: number) => {
    dialed.push(address);
    return { address: '127.0.0.1', port: ports[address] ?? (port === 443 ? 1 : port) };
  };
  return {
    io: {
      resolver,
      connector: createRelayConnectorWith({ ca, route }),
      nip11: createNip11FetcherWith({ ca, route }),
    },
    resolves,
    dialed,
  };
}

const context = {} as LocalUiContext;
const call = (route: ReturnType<typeof createNetworkTestRoute>, body: unknown) =>
  route.handler(context, body as JsonObject);

const nip11Json =
  (doc: unknown) =>
  (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { 'Content-Type': 'application/nostr+json' }).end(JSON.stringify(doc));
  };

describe('POST /api/ui/network/test (NET-PRECHECK)', () => {
  it('is the net-test kind at its fixed path, not an owner operation', () => {
    expect(networkTestRoute.method).toBe('POST');
    expect(networkTestRoute.path).toBe(NETWORK_TEST_PATH);
    expect(NETWORK_TEST_PATH).toBe('/api/ui/network/test');
    expect(networkTestRoute.presence).toBe('net-test');
    expect(NETWORK_TEST_MAX_SERVERS).toBe(8);
  });

  it('tests real stand-in relays over pinned TLS: ready, refused, private, in input order', async () => {
    const store: unknown[] = [];
    const good = await startTestRelay(certificate, {
      onSocket: speakNostr(store),
      http: nip11Json({ name: 'good' }),
    });
    const refusing = await startTestRelay(certificate, {
      onSocket: speakNostr([], { okFalse: 'blocked: <b>go away</b>' }),
    });
    relays.push(good, refusing);
    const w = world(
      {
        [HOST_A]: [[ADDRESS_A]],
        [HOST_B]: [[ADDRESS_B]],
        [HOST_C]: [['10.1.2.3']],
      },
      { [ADDRESS_A]: good.port, [ADDRESS_B]: refusing.port },
    );
    const route = createNetworkTestRoute(() => w.io);
    const res = await call(route, {
      servers: [
        `wss://${HOST_A}`,
        `wss://${HOST_B}/`,
        `wss://${HOST_C}`,
        'ws://plain.nostr-test.dev',
      ],
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      results: { host: string | null; outcome: string; reason: string | null }[];
    };
    expect(Object.keys(body)).toEqual(['results']);
    expect(body.results.map((r) => [r.host, r.outcome, r.reason])).toEqual([
      [HOST_A, 'ready', null],
      [HOST_B, 'refused', 'not_accepted'],
      [HOST_C, 'refused', 'not_allowed'],
      [null, 'refused', 'not_allowed'],
    ]);
    expect(JSON.stringify(body)).not.toMatch(/go away|<b>|10\.1\.2\.3/);
    // SNI and Host were the name; the private host was never dialed; one lookup per name.
    const upgrades = good.seen.filter((s) => s.kind === 'upgrade');
    expect(upgrades).toHaveLength(2);
    expect(upgrades.every((s) => s.servername === HOST_A && s.host === HOST_A)).toBe(true);
    expect(w.dialed).not.toContain('10.1.2.3');
    expect(w.resolves.filter((h) => h === HOST_A)).toHaveLength(1);
  }, 30_000);

  it('DNS rebinding: a second answer is never asked for; every dial goes to the pinned address', async () => {
    const store: unknown[] = [];
    const good = await startTestRelay(certificate, { onSocket: speakNostr(store) });
    relays.push(good);
    const w = world({ [HOST_A]: [[ADDRESS_A], ['127.0.0.1']] }, { [ADDRESS_A]: good.port });
    const res = await call(
      createNetworkTestRoute(() => w.io),
      { servers: [`wss://${HOST_A}`] },
    );
    expect((res.body as { results: { outcome: string }[] }).results[0]?.outcome).toBe('ready');
    expect(w.resolves).toEqual([HOST_A]);
    expect(w.dialed.length).toBeGreaterThanOrEqual(2);
    expect(w.dialed.every((a) => a === ADDRESS_A)).toBe(true);
  }, 30_000);

  it('a NIP-11 redirect is never followed (and does not decide the outcome)', async () => {
    const store: unknown[] = [];
    const good = await startTestRelay(certificate, {
      onSocket: speakNostr(store),
      http: (_req, res) => {
        res.writeHead(302, { Location: 'https://169.254.169.254/latest/meta-data/' }).end();
      },
    });
    relays.push(good);
    const w = world({ [HOST_A]: [[ADDRESS_A]] }, { [ADDRESS_A]: good.port });
    const res = await call(
      createNetworkTestRoute(() => w.io),
      { servers: [`wss://${HOST_A}`] },
    );
    expect((res.body as { results: { outcome: string }[] }).results[0]?.outcome).toBe('ready');
    expect(good.seen.filter((s) => s.kind === 'http')).toHaveLength(1);
    expect(w.dialed.every((a) => a === ADDRESS_A)).toBe(true);
  }, 30_000);

  it('a certificate for another name is unreachable; a refused upgrade is invalid', async () => {
    const wrongCert = await startTestRelay(otherCertificate, { onSocket: speakNostr([]) });
    const noUpgrade = await startTestRelay(certificate, {
      upgrade: (_req, socket) => {
        socket.end(
          'HTTP/1.1 302 Found\r\nLocation: wss://evil.nostr-test.dev/\r\nContent-Length: 0\r\n\r\n',
        );
        return false;
      },
    });
    relays.push(wrongCert, noUpgrade);
    const w = world(
      { [HOST_A]: [[ADDRESS_A]], [HOST_B]: [[ADDRESS_B]] },
      { [ADDRESS_A]: wrongCert.port, [ADDRESS_B]: noUpgrade.port },
    );
    const res = await call(
      createNetworkTestRoute(() => w.io),
      {
        servers: [`wss://${HOST_A}`, `wss://${HOST_B}`],
      },
    );
    expect((res.body as { results: { reason: string }[] }).results.map((r) => r.reason)).toEqual([
      'unreachable',
      'invalid',
    ]);
  }, 30_000);

  it('a server that demands a login to write is refused (not_accepted); AUTH is never answered', async () => {
    const frames: unknown[][] = [];
    const authRelay = await startTestRelay(certificate, {
      onSocket: (ws) => {
        ws.send(JSON.stringify(['AUTH', 'challenge-1']));
        ws.on('message', (data: Buffer) => {
          const frame = JSON.parse(data.toString('utf8')) as unknown[];
          frames.push(frame);
          if (frame[0] === 'EVENT') {
            const id = (frame[1] as { id: string }).id;
            ws.send(JSON.stringify(['OK', id, false, 'auth-required: sign in please']));
          }
        });
      },
    });
    relays.push(authRelay);
    const w = world({ [HOST_A]: [[ADDRESS_A]] }, { [ADDRESS_A]: authRelay.port });
    const res = await call(
      createNetworkTestRoute(() => w.io),
      { servers: [`wss://${HOST_A}`] },
    );
    // A login to WRITE: contacts could not deliver to it (D-158 (3)).
    expect(
      (res.body as { results: { outcome: string; reason: string }[] }).results[0],
    ).toMatchObject({ outcome: 'refused', reason: 'not_accepted' });
    expect(frames.some((f) => f[0] === 'AUTH')).toBe(false);
  }, 30_000);

  it('refuses a malformed body: 400 invalid, nothing resolved', async () => {
    const w = world({}, {});
    const route = createNetworkTestRoute(() => w.io);
    const tooMany = Array.from(
      { length: NETWORK_TEST_MAX_SERVERS + 1 },
      (_, i) => `wss://r${i}.nostr-test.dev`,
    );
    for (const body of [
      {},
      { servers: [] },
      { servers: 'wss://relay-a.nostr-test.dev' },
      { servers: [42] },
      { servers: tooMany },
      { servers: [`wss://${'a'.repeat(600)}.dev`] },
      { servers: [`wss://${HOST_A}`], extra: true },
    ]) {
      const res = await call(route, body);
      expect(res).toEqual({ status: 400, body: { error: 'invalid' } });
    }
    expect(w.resolves).toHaveLength(0);
  });

  it('allows 10 tests a minute per process, then 429 busy', async () => {
    const w = world({}, {});
    const route = createNetworkTestRoute(() => w.io);
    for (let i = 0; i < 10; i += 1) {
      const res = await call(route, { servers: ['ws://plain.nostr-test.dev'] });
      expect(res.status).toBe(200);
    }
    const res = await call(route, { servers: ['ws://plain.nostr-test.dev'] });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'busy' });
  });

  it('runs one test at a time: a second while one runs is 429', async () => {
    const hang = await startTestRelay(certificate, { onSocket: () => undefined });
    relays.push(hang);
    const w = world({ [HOST_A]: [[ADDRESS_A]] }, { [ADDRESS_A]: hang.port });
    const route = createNetworkTestRoute(() => w.io);
    const first = call(route, { servers: [`wss://${HOST_A}`] });
    const second = await call(route, { servers: ['ws://plain.nostr-test.dev'] });
    expect(second.status).toBe(429);
    await hang.close();
    await first;
  }, 30_000);

  it('the production route has no seam: no options, one limiter for the process', () => {
    expect(createNetworkTestRoute.length).toBeLessThanOrEqual(1);
    expect(Object.keys(networkTestRoute).sort()).toEqual(['handler', 'method', 'path', 'presence']);
  });
});
