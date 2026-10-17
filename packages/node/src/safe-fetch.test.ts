// M1-15: the DNS-pinned download against a local HTTPS server (04 §4 "SSRF protection
// (`fetch_file`)"). The test seams resolve names to a public documentation-free address and route
// the checked address to 127.0.0.1, so no test touches the network; `routed` records every address
// a socket was opened for, which is how DNS rebinding and redirect re-checks are observed.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestCertificate, type TestCertificate } from './relay-io.fixture.js';
import { SafeFetchError, createSafeFetchWith, type FetchLookup } from './safe-fetch.js';

const HOST = 'files.agentlink.test';
const OTHER = 'other.agentlink.test';
const PUBLIC_A = '93.184.216.34';
const PUBLIC_B = '151.101.1.69';

let certificate: TestCertificate;
let server: Server;
let port = 0;
const seen: { path: string; host: string | undefined; servername: string | false | null }[] = [];
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const handlers = new Map<string, Handler>();

const routed: string[] = [];
const route = (address: string): { address: string; port: number } => {
  routed.push(address);
  return { address: '127.0.0.1', port };
};

function lookupFrom(table: Record<string, readonly string[]>): FetchLookup & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (host: string) => {
    calls.push(host);
    const answer = table[host];
    if (answer === undefined) throw new Error('ENOTFOUND');
    return answer;
  }) as FetchLookup & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const url = (path: string, host = HOST): string => `https://${host}:${port}${path}`;

beforeAll(async () => {
  certificate = makeTestCertificate([HOST, OTHER]);
  server = createServer({ cert: certificate.cert, key: certificate.key }, (req, res) => {
    const socket = req.socket as TLSSocket;
    seen.push({ path: req.url ?? '', host: req.headers.host, servername: socket.servername });
    const handler = handlers.get((req.url ?? '').split('?')[0] as string);
    if (handler === undefined) {
      res.writeHead(404).end();
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
  routed.length = 0;
  handlers.clear();
});

const ok =
  (body: string | Buffer): Handler =>
  (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(body);
  };
const redirect =
  (location: string, status = 302): Handler =>
  (_req, res) => {
    res.writeHead(status, { Location: location }).end();
  };

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SafeFetchError);
    return (error as SafeFetchError).code;
  }
  throw new Error('expected a SafeFetchError');
}

describe('safe fetch: pinned connection', () => {
  it('downloads over TLS to the checked address with SNI and Host set to the name', async () => {
    handlers.set('/obj', ok('hello'));
    const lookup = lookupFrom({ [HOST]: [PUBLIC_A] });
    const fetch = createSafeFetchWith({ lookup, ca: certificate.cert, route });
    const result = await fetch(url('/obj?X-Amz-Signature=abc%2F'), { maxBytes: 100 });
    expect(Buffer.from(result.body).toString()).toBe('hello');
    expect(result).toMatchObject({ size: 5, redirects: 0 });
    expect(lookup.calls).toEqual([HOST]);
    expect(routed).toEqual([PUBLIC_A]);
    expect(seen).toEqual([
      { path: '/obj?X-Amz-Signature=abc%2F', host: `${HOST}:${port}`, servername: HOST },
    ]);
  });

  it('DNS rebinding: resolves once and connects to that address, never a second answer', async () => {
    handlers.set('/obj', ok('pinned'));
    let calls = 0;
    const lookup: FetchLookup = async () => {
      calls += 1;
      return calls === 1 ? [PUBLIC_A] : ['127.0.0.1']; // a rebinding resolver
    };
    const fetch = createSafeFetchWith({ lookup, ca: certificate.cert, route });
    const result = await fetch(url('/obj'), { maxBytes: 100 });
    expect(Buffer.from(result.body).toString()).toBe('pinned');
    expect(calls).toBe(1);
    expect(routed).toEqual([PUBLIC_A]);
  });

  it.each([
    [['10.0.0.7']],
    [['127.0.0.1']],
    [['169.254.169.254']],
    [['::1']],
    [['::ffff:127.0.0.1']],
    [['fd00::1']],
    [['100.64.1.1']],
    [[PUBLIC_A, '192.168.1.10']],
    [[]],
  ])('refuses a host resolving to %j without opening a socket', async (answers) => {
    const fetch = createSafeFetchWith({
      lookup: lookupFrom({ [HOST]: answers }),
      ca: certificate.cert,
      route,
    });
    expect(await codeOf(fetch(url('/obj'), { maxBytes: 100 }))).toBe('address_refused');
    expect(routed).toEqual([]);
  });

  it('reports a failed lookup as resolve_failed', async () => {
    const fetch = createSafeFetchWith({ lookup: lookupFrom({}), ca: certificate.cert, route });
    expect(await codeOf(fetch(url('/obj'), { maxBytes: 100 }))).toBe('resolve_failed');
  });

  it.each([
    'http://files.agentlink.test/obj',
    'https://127.0.0.1/obj',
    'https://2130706433/obj',
    'https://0x7f.0.0.1/obj',
    'https://0177.0.0.1/obj',
    'https://[::ffff:127.0.0.1]/obj',
    'https://169.254.169.254/latest/meta-data/',
    'https://localhost/obj',
    'https://user@files.agentlink.test/obj',
  ])('refuses %s before any lookup', async (bad) => {
    const lookup = lookupFrom({ [HOST]: [PUBLIC_A] });
    const fetch = createSafeFetchWith({ lookup, ca: certificate.cert, route });
    expect(await codeOf(fetch(bad, { maxBytes: 100 }))).toBe('url_refused');
    expect(lookup.calls).toEqual([]);
    expect(routed).toEqual([]);
  });

  it('refuses a certificate that does not chain to a trusted root', async () => {
    handlers.set('/obj', ok('x'));
    const fetch = createSafeFetchWith({ lookup: lookupFrom({ [HOST]: [PUBLIC_A] }), route });
    expect(await codeOf(fetch(url('/obj'), { maxBytes: 100 }))).toBe('network');
  });

  it('ignores proxy environment variables (the socket is always our own)', async () => {
    handlers.set('/obj', ok('direct'));
    const saved = { https: process.env.HTTPS_PROXY, all: process.env.ALL_PROXY };
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    process.env.ALL_PROXY = 'http://127.0.0.1:1';
    try {
      const fetch = createSafeFetchWith({
        lookup: lookupFrom({ [HOST]: [PUBLIC_A] }),
        ca: certificate.cert,
        route,
      });
      const result = await fetch(url('/obj'), { maxBytes: 100 });
      expect(Buffer.from(result.body).toString()).toBe('direct');
    } finally {
      if (saved.https === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved.https;
      if (saved.all === undefined) delete process.env.ALL_PROXY;
      else process.env.ALL_PROXY = saved.all;
    }
  });
});

describe('safe fetch: redirects (at most 2, each re-checked)', () => {
  const fetchWith = (table: Record<string, readonly string[]>) => {
    const lookup = lookupFrom(table);
    return { lookup, fetch: createSafeFetchWith({ lookup, ca: certificate.cert, route }) };
  };

  it('follows two redirects, re-resolving and re-pinning each hop', async () => {
    handlers.set('/a', redirect('/b'));
    handlers.set('/b', redirect(url('/c', OTHER), 307));
    handlers.set('/c', ok('done'));
    const { lookup, fetch } = fetchWith({ [HOST]: [PUBLIC_A], [OTHER]: [PUBLIC_B] });
    const result = await fetch(url('/a'), { maxBytes: 100 });
    expect(Buffer.from(result.body).toString()).toBe('done');
    expect(result.redirects).toBe(2);
    expect(lookup.calls).toEqual([HOST, HOST, OTHER]);
    expect(routed).toEqual([PUBLIC_A, PUBLIC_A, PUBLIC_B]);
    expect(seen.map((s) => s.servername)).toEqual([HOST, HOST, OTHER]);
  });

  it('refuses a third redirect', async () => {
    handlers.set('/a', redirect('/b'));
    handlers.set('/b', redirect('/c'));
    handlers.set('/c', redirect('/d'));
    handlers.set('/d', ok('never'));
    const { fetch } = fetchWith({ [HOST]: [PUBLIC_A] });
    expect(await codeOf(fetch(url('/a'), { maxBytes: 100 }))).toBe('too_many_redirects');
    expect(seen.map((s) => s.path)).toEqual(['/a', '/b', '/c']);
  });

  it('refuses a redirect chain that ends at the metadata address', async () => {
    handlers.set('/a', redirect('/b'));
    handlers.set('/b', redirect('https://169.254.169.254/latest/meta-data/iam/'));
    const { fetch } = fetchWith({ [HOST]: [PUBLIC_A] });
    expect(await codeOf(fetch(url('/a'), { maxBytes: 100 }))).toBe('redirect_refused');
    expect(routed).toEqual([PUBLIC_A, PUBLIC_A]);
  });

  it('refuses a redirect to a name that resolves to a private address', async () => {
    handlers.set('/a', redirect(url('/x', OTHER)));
    const { fetch } = fetchWith({ [HOST]: [PUBLIC_A], [OTHER]: ['10.1.2.3'] });
    expect(await codeOf(fetch(url('/a'), { maxBytes: 100 }))).toBe('address_refused');
    expect(routed).toEqual([PUBLIC_A]);
  });

  it.each([
    'http://files.agentlink.test/x',
    '//127.0.0.1/x',
    'https://[::1]/x',
    'https://0x7f000001/x',
    'relative/x',
    'file:///etc/passwd',
  ])('refuses a redirect to %s', async (location) => {
    handlers.set('/a', redirect(location));
    const { fetch } = fetchWith({ [HOST]: [PUBLIC_A] });
    expect(await codeOf(fetch(url('/a'), { maxBytes: 100 }))).toBe('redirect_refused');
    expect(routed).toEqual([PUBLIC_A]);
  });

  it('refuses a redirect without a Location', async () => {
    handlers.set('/a', (_req, res) => res.writeHead(302).end());
    const { fetch } = fetchWith({ [HOST]: [PUBLIC_A] });
    expect(await codeOf(fetch(url('/a'), { maxBytes: 100 }))).toBe('redirect_refused');
  });
});

describe('safe fetch: size and time limits', () => {
  const fetch = () =>
    createSafeFetchWith({
      lookup: lookupFrom({ [HOST]: [PUBLIC_A] }),
      ca: certificate.cert,
      route,
    });

  it('accepts exactly maxBytes', async () => {
    handlers.set('/obj', ok(Buffer.alloc(1000, 7)));
    expect((await fetch()(url('/obj'), { maxBytes: 1000 })).size).toBe(1000);
  });

  it('aborts on a declared Content-Length above the cap', async () => {
    handlers.set('/obj', ok(Buffer.alloc(1001)));
    expect(await codeOf(fetch()(url('/obj'), { maxBytes: 1000 }))).toBe('too_large');
  });

  it('aborts a chunked body that grows past the cap', async () => {
    handlers.set('/obj', (_req, res) => {
      res.writeHead(200); // no Content-Length: chunked
      const timer = setInterval(() => {
        if (!res.write(Buffer.alloc(4096))) return;
      }, 1);
      res.on('close', () => clearInterval(timer));
    });
    expect(await codeOf(fetch()(url('/obj'), { maxBytes: 64 * 1024 }))).toBe('too_large');
  });

  it('stops a server that never finishes at the deadline', async () => {
    handlers.set('/obj', (_req, res) => {
      res.writeHead(200);
      res.write('x'); // and never ends
    });
    const started = Date.now();
    expect(await codeOf(fetch()(url('/obj'), { maxBytes: 100, timeoutMs: 300 }))).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('stops when the caller aborts', async () => {
    handlers.set('/obj', () => undefined); // never answers
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    expect(await codeOf(fetch()(url('/obj'), { maxBytes: 100, signal: controller.signal }))).toBe(
      'timeout',
    );
  });

  it('refuses a non-200 status and a compressed body', async () => {
    expect(await codeOf(fetch()(url('/missing'), { maxBytes: 100 }))).toBe('http_status');
    handlers.set('/gz', (_req, res) => {
      res.writeHead(200, { 'Content-Encoding': 'gzip' }).end('zz');
    });
    expect(await codeOf(fetch()(url('/gz'), { maxBytes: 100 }))).toBe('http_status');
  });

  it('streams chunks to onChunk without buffering, and rethrows its error unchanged', async () => {
    handlers.set('/obj', ok(Buffer.alloc(3000, 1)));
    let received = 0;
    const result = await fetch()(url('/obj'), {
      maxBytes: 3000,
      onChunk: (chunk) => {
        received += chunk.length;
      },
    });
    expect(received).toBe(3000);
    expect(result.size).toBe(3000);
    expect(result.body.length).toBe(0);
    const disk = new Error('disk full');
    await expect(
      fetch()(url('/obj'), {
        maxBytes: 3000,
        onChunk: () => {
          throw disk;
        },
      }),
    ).rejects.toBe(disk);
  });

  it.each([
    [{ maxBytes: 0 }],
    [{ maxBytes: -1 }],
    [{ maxBytes: 1.5 }],
    [{ maxBytes: 10, timeoutMs: 0 }],
  ])('refuses invalid limits %j', async (options) => {
    expect(await codeOf(fetch()(url('/obj'), options))).toBe('options_invalid');
  });
});

describe('safe fetch: errors never carry the URL (I-7)', () => {
  it('uses fixed messages', async () => {
    const secret = 'X-Amz-Signature=deadbeefcafe';
    const fetch = createSafeFetchWith({
      lookup: lookupFrom({ [HOST]: ['10.0.0.1'] }),
      ca: certificate.cert,
      route,
    });
    for (const target of [
      `http://${HOST}/obj?${secret}`,
      `https://${HOST}:${port}/obj?${secret}`,
      `https://127.0.0.1/obj?${secret}`,
    ]) {
      try {
        await fetch(target, { maxBytes: 10 });
        throw new Error('expected failure');
      } catch (error) {
        const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ''}`;
        expect(text).not.toContain(secret);
        expect(text).not.toContain(HOST);
        expect(text).not.toContain('10.0.0.1');
        expect((error as Error).cause).toBeUndefined();
      }
    }
  });
});
