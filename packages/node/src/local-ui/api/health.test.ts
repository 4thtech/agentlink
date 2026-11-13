// M1-11s-a-d: the local UI health read (08 §1; 04 §2.5, §4; I-4, I-5, I-7).
//
// - `GET /api/ui/health` is a read route (presence: false) behind the server's session cookie,
//   CSRF header and fetch-metadata checks, like every /api/ui/ route.
// - It answers one fixed, allowlisted shape: `agent` (running, paused, not_running, needs_setup),
//   `relays` ({ connected, total } or null), `lastSyncAt` (unix seconds or null) and `version`
//   (a plain version or null). Nothing else: no relay address, key, token, path or error text,
//   whatever the source hands over.
// - It is cheap and bounded: the source is read at most once per cache window (single flight), and
//   a source that hangs or throws answers within the time limit as not_running (never "running"
//   without evidence).
import { encodeUtf8 } from '@4thtech-io/crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startApprovalServerWith, type ApprovalServer } from '../../approval-server.js';
import type { LocalUiContext } from '../context.js';
import { createLocalUiRoutes } from '../routes.js';
import {
  HEALTH_CACHE_MS,
  HEALTH_SOURCE_TIMEOUT_MS,
  createHealthReader,
  healthRoutes,
  type LocalUiHealthSnapshot,
} from './health.js';

const KEYS = ['agent', 'relays', 'lastSyncAt', 'network', 'version', 'dataFolder', 'uptimeSeconds'];

function contextWith(health: LocalUiContext['health']): LocalUiContext {
  return {
    client: undefined,
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: () => Promise.reject(new Error('never called')),
    now: () => 0,
    ...(health === undefined ? {} : { health }),
  };
}

/** A manual clock in milliseconds. */
function clock(start = 1_800_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe('the health reader (M1-11s-a-d)', () => {
  it('answers each agent state the source gives', async () => {
    for (const agent of ['running', 'paused', 'not_running'] as const) {
      const read = createHealthReader({
        source: () => ({ agent }),
        hasClient: true,
        now: Date.now,
      });
      const body = await read();
      expect(body.agent).toBe(agent);
      expect(Object.keys(body).sort()).toEqual([...KEYS].sort());
    }
  });

  it('answers needs_setup when no agent is set up, without asking the source', async () => {
    let calls = 0;
    const read = createHealthReader({
      source: () => {
        calls += 1;
        return { agent: 'running' };
      },
      hasClient: false,
      now: Date.now,
    });
    expect((await read()).agent).toBe('needs_setup');
    expect(calls).toBe(0);
  });

  it('answers running for an opened agent when no source is wired', async () => {
    const read = createHealthReader({ hasClient: true, now: Date.now, version: '0.3.0' });
    expect(await read()).toEqual({
      agent: 'running',
      relays: null,
      lastSyncAt: null,
      network: null,
      version: '0.3.0',
      dataFolder: null,
      uptimeSeconds: null,
    });
  });

  it('passes relay counts, last sync and version through only in their fixed shape', async () => {
    const c = clock();
    const read = createHealthReader({
      source: () => ({
        agent: 'running',
        relays: { connected: 2, total: 3 },
        lastSyncAt: Math.floor(c.now() / 1000) - 30,
      }),
      hasClient: true,
      now: c.now,
      version: '0.3.0-next.2',
    });
    expect(await read()).toEqual({
      agent: 'running',
      relays: { connected: 2, total: 3 },
      lastSyncAt: Math.floor(c.now() / 1000) - 30,
      network: null,
      version: '0.3.0-next.2',
      dataFolder: null,
      uptimeSeconds: null,
    });
  });

  it('drops anything the source adds and every malformed field', async () => {
    const leaky = {
      agent: 'running',
      relays: {
        connected: 1,
        total: 2,
        urls: ['wss://user:secret@relay.example/path?token=abc'],
      },
      lastSyncAt: 1_700_000_000,
      key: 'nsec1secret',
      path: '/Users/someone/.agentlink',
      error: 'boom at /Users/x',
    } as unknown as LocalUiHealthSnapshot;
    const read = createHealthReader({ source: () => leaky, hasClient: true, now: Date.now });
    const body = await read();
    expect(Object.keys(body).sort()).toEqual([...KEYS].sort());
    expect(body.relays).toEqual({ connected: 1, total: 2 });
    const text = JSON.stringify(body);
    for (const leak of ['wss:', 'secret', 'token', 'nsec', '/Users', 'boom']) {
      expect(text).not.toContain(leak);
    }

    const bad: unknown[] = [
      { agent: 'connected' },
      { agent: 'running', relays: { connected: 3, total: 2 } },
      { agent: 'running', relays: { connected: -1, total: 2 } },
      { agent: 'running', relays: { connected: 1.5, total: 2 } },
      { agent: 'running', relays: { connected: 1, total: 1000 } },
      { agent: 'running', relays: 'wss://relay.example' },
      { agent: 'running', lastSyncAt: 'yesterday' },
      { agent: 'running', lastSyncAt: -5 },
      { agent: 'running', lastSyncAt: Number.NaN },
      { agent: 'running', lastSyncAt: 4_000_000_000 },
    ];
    for (const snapshot of bad) {
      const r = createHealthReader({
        source: () => snapshot as LocalUiHealthSnapshot,
        hasClient: true,
        now: () => 1_800_000_000_000,
      });
      const b = await r();
      expect(['running', 'not_running']).toContain(b.agent);
      if ((snapshot as { agent: string }).agent === 'connected')
        expect(b.agent).toBe('not_running');
      if ('relays' in (snapshot as object)) expect(b.relays).toBeNull();
      if ('lastSyncAt' in (snapshot as object)) expect(b.lastSyncAt).toBeNull();
    }
  });

  it('never answers a version that is not a plain version', async () => {
    for (const version of [
      '',
      'v1',
      '1.2',
      '1.2.3 /Users/x',
      '1.2.3-' + 'a'.repeat(64),
      'x'.repeat(200),
    ]) {
      const read = createHealthReader({ hasClient: true, now: Date.now, version });
      expect((await read()).version).toBeNull();
    }
  });

  it('answers the data folder home-relative (`~`), never an absolute path or any other path', async () => {
    const cases: [{ path: string; home: string }, string | null][] = [
      [{ path: '/Users/alice/.agentlink', home: '/Users/alice' }, '~/.agentlink'],
      [{ path: '/home/alice/.agentlink', home: '/home/alice/' }, '~/.agentlink'],
      [{ path: 'C:\\Users\\alice\\.agentlink', home: 'C:\\Users\\alice' }, '~\\.agentlink'],
      [{ path: '/Users/alice', home: '/Users/alice' }, '~'],
      // Outside the home folder, relative, unshowable or malformed: nothing, never the path.
      [{ path: '/opt/agentlink', home: '/Users/alice' }, null],
      [{ path: '/Users/alice2/.agentlink', home: '/Users/alice' }, null],
      [{ path: '.agentlink', home: '/Users/alice' }, null],
      [{ path: '/Users/alice/.agent\nlink', home: '/Users/alice' }, null],
      [{ path: '/Users/alice/' + 'a'.repeat(300), home: '/Users/alice' }, null],
      [{ path: '/Users/alice/.agentlink', home: '' }, null],
      [{ path: '/Users/alice/.agentlink', home: '/' }, null],
    ];
    for (const [dataFolder, expected] of cases) {
      const read = createHealthReader({ hasClient: true, now: Date.now, dataFolder });
      const body = await read();
      expect(body.dataFolder).toBe(expected);
      expect(Object.keys(body).sort()).toEqual([...KEYS].sort());
      expect(JSON.stringify(body)).not.toContain('alice');
      expect(JSON.stringify(body)).not.toContain('/opt');
    }
    // With no agent set up the data folder is still answered (a server fact), trimmed.
    const setup = createHealthReader({
      hasClient: false,
      now: Date.now,
      dataFolder: { path: '/Users/alice/.agentlink', home: '/Users/alice' },
    });
    expect((await setup()).dataFolder).toBe('~/.agentlink');
  });

  it('answers the server uptime in whole seconds from its start, never negative', async () => {
    const c = clock();
    const startedAt = c.now();
    const read = createHealthReader({ hasClient: true, now: c.now, startedAt });
    expect((await read()).uptimeSeconds).toBe(0);
    c.advance(HEALTH_CACHE_MS + 61_500);
    expect((await read()).uptimeSeconds).toBe(Math.floor((HEALTH_CACHE_MS + 61_500) / 1000));
    const future = createHealthReader({ hasClient: true, now: c.now, startedAt: c.now() + 10_000 });
    expect((await future()).uptimeSeconds).toBeNull();
    const none = createHealthReader({ hasClient: true, now: c.now });
    expect((await none()).uptimeSeconds).toBeNull();
  });

  it('answers not_running, never running, when the source throws, without the error text', async () => {
    const read = createHealthReader({
      source: () => {
        throw new Error('relay wss://secret@relay.example failed');
      },
      hasClient: true,
      now: Date.now,
    });
    const body = await read();
    expect(body.agent).toBe('not_running');
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('answers not_running within the time limit when the source hangs', async () => {
    const read = createHealthReader({
      source: () => new Promise<LocalUiHealthSnapshot>(() => undefined),
      hasClient: true,
      now: Date.now,
    });
    const started = Date.now();
    const body = await read();
    expect(body.agent).toBe('not_running');
    expect(Date.now() - started).toBeLessThan(HEALTH_SOURCE_TIMEOUT_MS + 500);
  });

  it('reads the source at most once per cache window, and once for concurrent requests', async () => {
    const c = clock();
    let calls = 0;
    const read = createHealthReader({
      source: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return { agent: calls % 2 === 1 ? 'running' : 'paused' } as LocalUiHealthSnapshot;
      },
      hasClient: true,
      now: c.now,
    });
    const [a, b, d] = await Promise.all([read(), read(), read()]);
    expect(calls).toBe(1);
    expect([a.agent, b.agent, d.agent]).toEqual(['running', 'running', 'running']);
    c.advance(HEALTH_CACHE_MS - 1);
    expect((await read()).agent).toBe('running');
    expect(calls).toBe(1);
    c.advance(1);
    expect((await read()).agent).toBe('paused');
    expect(calls).toBe(2);
    expect(HEALTH_CACHE_MS).toBeGreaterThanOrEqual(1000);
    expect(HEALTH_CACHE_MS).toBeLessThanOrEqual(5000);
  });
});

describe('GET /api/ui/health (M1-11s-a-d)', () => {
  it('is one read route: GET, no presence, no other method', () => {
    expect(healthRoutes.map((r) => [r.method, r.path, r.presence])).toEqual([
      ['GET', '/api/ui/health', false],
    ]);
    const registry = createLocalUiRoutes();
    const match = registry.match('GET', '/api/ui/health');
    if (match === undefined || match === 'method') throw new Error('not registered');
    expect(match.route.presence).toBe(false);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(registry.match(method, '/api/ui/health')).toBe('method');
    }
  });

  it('answers 200 with the reader body, and needs_setup without a reader', async () => {
    const route = healthRoutes[0];
    if (route === undefined || route.presence !== false) throw new Error('no read route');
    const body = {
      agent: 'paused',
      relays: null,
      lastSyncAt: null,
      network: null,
      version: null,
      dataFolder: null,
      uptimeSeconds: null,
    } as const;
    expect(
      await route.handler(
        contextWith(() => Promise.resolve(body)),
        {
          params: {},
          query: new URLSearchParams(),
        },
      ),
    ).toEqual({ status: 200, body });
    const fallback = await route.handler(contextWith(undefined), {
      params: {},
      query: new URLSearchParams(),
    });
    expect(fallback).toEqual({
      status: 200,
      body: {
        agent: 'needs_setup',
        relays: null,
        lastSyncAt: null,
        network: null,
        version: null,
        dataFolder: null,
        uptimeSeconds: null,
      },
    });
  });
});

// Through the real server: the session, CSRF and fetch-metadata gates apply as to every route.
interface Res {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function send(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: { Host: `localhost:${String(port)}`, ...headers },
        setHost: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const INDEX_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="agentlink-csrf" content="" /><title>AgentLink</title>' +
  '<script type="module" crossorigin src="/assets/index-Bx3f9a2Q.js"></script>' +
  '</head><body><div id="root"></div></body></html>';

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(
  health?: () => LocalUiHealthSnapshot,
  version?: string,
  dataFolder?: { path: string; home: string },
  clientExtra: Record<string, unknown> = {},
): Promise<{ port: number; cookie: string; csrf: string }> {
  const opened: string[] = [];
  const server = await startApprovalServerWith(
    {
      source: {
        context: () => Promise.resolve(undefined),
        list: () => Promise.resolve([]),
        get: () => Promise.resolve(undefined),
        apply: () => Promise.reject(new Error('never called')),
      },
      localUi: {
        assets: {
          files: new Map<string, Uint8Array>([
            ['index.html', encodeUtf8(INDEX_HTML)],
            ['assets/index-Bx3f9a2Q.js', encodeUtf8('console.log(1);')],
          ]),
        },
        client: { agentId: '0x' + '11'.repeat(20), ...clientExtra } as never,
        ...(health === undefined ? {} : { health }),
        ...(version === undefined ? {} : { version }),
        ...(dataFolder === undefined ? {} : { dataFolder }),
      },
    },
    {
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
    },
  );
  servers.push(server);
  const port = server.port;
  await server.open();
  const t = new URL(opened[0] ?? '').searchParams.get('t') ?? '';
  const first = await send(port, `/?t=${t}`);
  const cookie = (first.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const page = await send(port, '/', { Cookie: cookie });
  const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1] ?? '';
  return { port, cookie, csrf };
}

describe('the health route through the server (M1-11s-a-d)', () => {
  it('needs the session cookie, the CSRF header and same-origin fetch metadata', async () => {
    const { port, cookie, csrf } = await serve(() => ({ agent: 'running' }), '0.3.0');
    expect((await send(port, '/api/ui/health')).status).toBe(401);
    expect((await send(port, '/api/ui/health', { Cookie: cookie })).status).toBe(403);
    expect(
      (
        await send(port, '/api/ui/health', {
          Cookie: cookie,
          'X-AgentLink-CSRF': csrf,
          'Sec-Fetch-Site': 'cross-site',
        })
      ).status,
    ).toBe(403);
    const res = await send(port, '/api/ui/health', { Cookie: cookie, 'X-AgentLink-CSRF': csrf });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(JSON.parse(res.body)).toEqual({
      agent: 'running',
      relays: null,
      lastSyncAt: null,
      network: null,
      version: '0.3.0',
      dataFolder: null,
      uptimeSeconds: expect.any(Number),
    });
    const post = await send(
      port,
      '/api/ui/health',
      { Cookie: cookie, 'X-AgentLink-CSRF': csrf },
      'POST',
    );
    expect(post.status).toBe(405);
  });

  it('never echoes the session, the CSRF token or anything the source leaks', async () => {
    const { port, cookie, csrf } = await serve(
      () =>
        ({
          agent: 'paused',
          relays: { connected: 1, total: 2, url: 'wss://relay.example/?auth=x' },
          seed: 'abandon abandon',
        }) as unknown as LocalUiHealthSnapshot,
    );
    const res = await send(port, '/api/ui/health', { Cookie: cookie, 'X-AgentLink-CSRF': csrf });
    expect(JSON.parse(res.body)).toEqual({
      agent: 'paused',
      relays: { connected: 1, total: 2 },
      lastSyncAt: null,
      network: null,
      version: null,
      dataFolder: null,
      uptimeSeconds: expect.any(Number),
    });
    const cookieValue = cookie.split('=')[1] ?? '';
    for (const leak of [cookieValue, csrf, 'wss:', 'auth', 'abandon']) {
      expect(res.body).not.toContain(leak);
    }
  });
  it('answers the trimmed data folder and the uptime, and no other new field', async () => {
    const { port, cookie, csrf } = await serve(() => ({ agent: 'running' }), '0.5.1', {
      path: '/Users/alice/.agentlink',
      home: '/Users/alice',
    });
    const res = await send(port, '/api/ui/health', { Cookie: cookie, 'X-AgentLink-CSRF': csrf });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([...KEYS].sort());
    expect(parsed['dataFolder']).toBe('~/.agentlink');
    expect(typeof parsed['uptimeSeconds']).toBe('number');
    expect(parsed['uptimeSeconds']).toBeGreaterThanOrEqual(0);
    expect(res.body).not.toContain('alice');
    expect(res.body).not.toContain('/Users');
  });

  it('REL051-CF2: answers network checking until the first relay check finished', async () => {
    const { port, cookie, csrf } = await serve(undefined, '0.5.1', undefined, {
      relayReachability: () => new Promise(() => undefined),
    });
    const res = await send(port, '/api/ui/health', { Cookie: cookie, 'X-AgentLink-CSRF': csrf });
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toMatchObject({ agent: 'running', relays: null, network: 'checking' });
  });

  it("REL051-CF2: with no source wired, answers the open agent's real relay counts (0 of 3 while unreachable)", async () => {
    let reach = 0;
    const { port, cookie, csrf } = await serve(undefined, '0.5.1', undefined, {
      relayReachability: () => Promise.resolve({ connected: reach, total: 3 }),
    });
    const read = async (): Promise<Record<string, unknown>> =>
      JSON.parse(
        (await send(port, '/api/ui/health', { Cookie: cookie, 'X-AgentLink-CSRF': csrf })).body,
      ) as Record<string, unknown>;
    const down = await read();
    expect(down['agent']).toBe('running');
    expect(down['relays']).toEqual({ connected: 0, total: 3 });
    expect(down['lastSyncAt']).toBeNull();
    reach = 3;
    // The answer is cached for a short window; the check after it sees the relays back.
    await new Promise((r) => setTimeout(r, HEALTH_CACHE_MS + 50));
    await read();
    await new Promise((r) => setTimeout(r, HEALTH_CACHE_MS + 50));
    const up = await read();
    expect(up['relays']).toEqual({ connected: 3, total: 3 });
    expect(typeof up['lastSyncAt']).toBe('number');
  }, 20_000);
});

describe('UX-LEFT-1: the reconnect hook (OUTBOX-RECONNECT)', () => {
  it('fires once when the relays come back after a read that saw none', async () => {
    const c = clock();
    let connected = 2;
    let fired = 0;
    const read = createHealthReader({
      source: () => ({ agent: 'running', relays: { connected, total: 2 } }),
      hasClient: true,
      now: c.now,
      onReconnect: () => void (fired += 1),
    });
    await read();
    expect(fired).toBe(0);
    c.advance(HEALTH_CACHE_MS + 1);
    await read();
    expect(fired).toBe(0);
    connected = 0;
    c.advance(HEALTH_CACHE_MS + 1);
    await read();
    connected = 2;
    c.advance(HEALTH_CACHE_MS + 1);
    await read();
    expect(fired).toBe(1);
    c.advance(HEALTH_CACHE_MS + 1);
    await read();
    expect(fired).toBe(1);
  });
});
