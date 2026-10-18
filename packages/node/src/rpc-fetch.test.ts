// M1-4a (IR-M1-4a-1 M-1): the address-checked RPC fetch against a local HTTPS server (04 §4). The
// seams resolve names to chosen addresses and route the checked address to 127.0.0.1, so no test
// touches the network; `routed` records every address a socket was opened for.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestCertificate, type TestCertificate } from './relay-io.fixture.js';
import { RpcFetchError, createRpcFetchWith } from './rpc-fetch.js';
import type { FetchLookup } from './safe-fetch.js';

const HOST = 'rpc.agentlink.test';
const PUBLIC_A = '93.184.216.34';
const PUBLIC_B = '151.101.1.69';
/** A canary path standing in for an owner's provider key: it must never surface. */
const CANARY_PATH = '/v3/canary0secret0key0abcdef0123456789';

let certificate: TestCertificate;
let server: Server;
let port = 0;
const routed: string[] = [];
const seen: { method: string; path: string; body: string; host: string | undefined }[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void = () => undefined;

const route = (address: string): { address: string; port: number } => {
  routed.push(address);
  return { address: '127.0.0.1', port };
};

function lookupSequence(...answers: (readonly string[])[]): FetchLookup {
  let i = 0;
  return async () => {
    const answer = answers[Math.min(i, answers.length - 1)];
    i += 1;
    if (answer === undefined) throw new Error('ENOTFOUND');
    return answer;
  };
}

const url = (): string => `https://${HOST}:${String(port)}${CANARY_PATH}`;
const rpcInit = (signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  ...(signal === undefined ? {} : { signal }),
});

beforeAll(async () => {
  certificate = makeTestCertificate([HOST]);
  server = createServer({ cert: certificate.cert, key: certificate.key }, (req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', path: req.url ?? '', body, host: req.headers.host });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  routed.length = 0;
  seen.length = 0;
  handler = (_req, res) => {
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end('{"jsonrpc":"2.0","id":1,"result":"0x14a34"}');
  };
});

function expectNoLeak(error: unknown): void {
  const text = [
    String((error as Error).message),
    JSON.stringify(error),
    String((error as Error).stack),
    String((error as { cause?: unknown }).cause),
  ].join('\n');
  for (const fragment of ['canary0secret', HOST, PUBLIC_A, '127.0.0.1', '10.1.2.3']) {
    expect(text).not.toContain(fragment);
  }
}

describe('nodeRpcFetch: the 04 §4 resolve-time rule for chain RPC', () => {
  it('POSTs the JSON-RPC body to the checked, pinned address, with the name on TLS and Host', async () => {
    const rpcFetch = createRpcFetchWith({
      lookup: lookupSequence([PUBLIC_A]),
      ca: certificate.cert,
      route,
    });
    const response = await rpcFetch(url(), rpcInit());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: '0x14a34' });
    expect(routed).toEqual([PUBLIC_A]);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: CANARY_PATH,
      host: `${HOST}:${String(port)}`,
    });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toMatchObject({ method: 'eth_chainId' });
  });

  const refusedAnswers: [string, readonly string[]][] = [
    ['loopback', ['127.0.0.1']],
    ['IPv6 loopback', ['::1']],
    ['a private address', ['10.1.2.3']],
    ['a link-local (metadata) address', ['169.254.169.254']],
    ['a unique-local IPv6 address', ['fd00::1']],
    ['one private answer among public ones', [PUBLIC_A, '192.168.1.1']],
  ];
  for (const [name, answers] of refusedAnswers) {
    it(`refuses a host that resolves to ${name}, before any connection, without leaking`, async () => {
      const rpcFetch = createRpcFetchWith({
        lookup: lookupSequence(answers),
        ca: certificate.cert,
        route,
      });
      let thrown: unknown;
      try {
        await rpcFetch(url(), rpcInit());
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RpcFetchError);
      expect((thrown as RpcFetchError).code).toBe('address_refused');
      expect(routed).toEqual([]);
      expectNoLeak(thrown);
    });
  }

  it('resolves again on every request (DNS rebinding cannot reuse an earlier check)', async () => {
    const rpcFetch = createRpcFetchWith({
      lookup: lookupSequence([PUBLIC_A], ['127.0.0.1'], [PUBLIC_B]),
      ca: certificate.cert,
      route,
    });
    expect((await rpcFetch(url(), rpcInit())).status).toBe(200);
    await expect(rpcFetch(url(), rpcInit())).rejects.toMatchObject({ code: 'address_refused' });
    expect((await rpcFetch(url(), rpcInit())).status).toBe(200);
    expect(routed).toEqual([PUBLIC_A, PUBLIC_B]);
  });

  it('refuses a redirect instead of following it', async () => {
    handler = (_req, res) => {
      res.writeHead(307, { Location: 'https://127.0.0.1/' }).end();
    };
    const rpcFetch = createRpcFetchWith({
      lookup: lookupSequence([PUBLIC_A]),
      ca: certificate.cert,
      route,
    });
    await expect(rpcFetch(url(), rpcInit())).rejects.toMatchObject({ code: 'redirect_refused' });
    expect(routed).toEqual([PUBLIC_A]);
  });

  it('refuses URLs the raw rule refuses, without a lookup', async () => {
    let lookups = 0;
    const rpcFetch = createRpcFetchWith({
      lookup: async () => {
        lookups += 1;
        return [PUBLIC_A];
      },
      ca: certificate.cert,
      route,
    });
    for (const bad of [
      'http://rpc.agentlink.io/',
      'https://localhost/',
      'https://k@rpc.agentlink.io/',
    ]) {
      await expect(rpcFetch(bad, rpcInit())).rejects.toMatchObject({ code: 'url_refused' });
    }
    expect(lookups).toBe(0);
  });

  it('honours the caller abort (the per-request timeout)', async () => {
    handler = () => undefined; // never answers
    const rpcFetch = createRpcFetchWith({
      lookup: lookupSequence([PUBLIC_A]),
      ca: certificate.cert,
      route,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    let thrown: unknown;
    try {
      await rpcFetch(url(), rpcInit(controller.signal));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'timeout' });
    expectNoLeak(thrown);
  });

  it('passes an error status through as a Response for the RPC client to handle', async () => {
    handler = (_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain' }).end('busy');
    };
    const rpcFetch = createRpcFetchWith({
      lookup: lookupSequence([PUBLIC_A]),
      ca: certificate.cert,
      route,
    });
    expect((await rpcFetch(url(), rpcInit())).status).toBe(503);
  });
});
