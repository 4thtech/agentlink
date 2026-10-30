// W4-LIVE-STATUS (D-143; 08 §1 `GET /api/ui/events`, `GET /api/ui/agents`; 04 §2.5 "Live status and
// Pause"): the event stream through the real app host. It sits behind the unchanged gate of every
// `/api/ui/` read (session cookie, CSRF header, exact Host, Origin when present, Sec-Fetch-Site,
// loopback), also requires `Accept: text/event-stream` and refuses any query. It answers
// `text/event-stream` with no-store, nosniff and no CORS headers; it writes nothing and never takes
// the lease. An AI app that starts or quits shows without a reload.
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { encodeUtf8 } from '@4thtech-io/crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerSource,
} from '../approval-server.js';
import type {
  AgentDirectory,
  AgentDirectoryEntry,
  AgentDirectoryStats,
  AppHostAgent,
} from './app-host.js';
import type { LocalUiAiApps, LocalUiAiAppView, LocalUiAssets } from './context.js';

const INDEX_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="agentlink-csrf" content="" /><title>AgentLink</title>' +
  '<script type="module" crossorigin src="/assets/index-Bx3f9a2Q.js"></script></head>' +
  '<body><div id="root"></div></body></html>';

const bundle = (): LocalUiAssets => ({
  files: new Map<string, Uint8Array>([
    ['index.html', encodeUtf8(INDEX_HTML)],
    ['assets/index-Bx3f9a2Q.js', encodeUtf8('console.log(1);')],
  ]),
});

const NOW = Math.floor(Date.now() / 1000);

interface Plain {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function send(port: number, path: string, headers: Record<string, string> = {}): Promise<Plain> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
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

interface Stream {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  text(): string;
  /** Waits until the stream's text satisfies `ok`. */
  until(ok: (text: string) => boolean, ms?: number): Promise<string>;
  readonly ended: Promise<void>;
  close(): void;
}

function openStream(
  port: number,
  headers: Record<string, string>,
  path = '/api/ui/events',
): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { Host: `localhost:${String(port)}`, ...headers },
        setHost: false,
      },
      (res: IncomingMessage) => {
        let text = '';
        const waiters: (() => void)[] = [];
        const ended = new Promise<void>((done) => {
          res.on('end', done);
          res.on('close', done);
        });
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
          for (const w of waiters.splice(0)) w();
        });
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: () => text,
          until: (ok, ms = 3_000) =>
            new Promise<string>((done, fail) => {
              const timer = setTimeout(() => fail(new Error(`timeout: ${text}`)), ms);
              const check = (): void => {
                if (ok(text)) {
                  clearTimeout(timer);
                  done(text);
                } else waiters.push(check);
              };
              check();
            }),
          ended,
          close: () => req.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A copy of `headers` without `name`. */
const without = (headers: Record<string, string>, name: string): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name));

const dataOf = (text: string, event: string): Record<string, unknown>[] =>
  text
    .split('\n\n')
    .filter((block) => block.includes(`event: ${event}\n`))
    .map((block) => {
      const line = block.split('\n').find((l) => l.startsWith('data: ')) ?? 'data: {}';
      return JSON.parse(line.slice(6)) as Record<string, unknown>;
    });

function aiApps(): LocalUiAiApps {
  const view = (app: string, state: LocalUiAiAppView['state']): LocalUiAiAppView => ({
    app,
    name: app,
    path: `~/.${app}`,
    state,
    quitFirst: false,
  });
  return {
    list: () =>
      Promise.resolve({
        desktopRunning: false,
        apps: [
          view('claude-code', { kind: 'agent', agent: 'default' }),
          view('codex', { kind: 'agent', agent: 'work' }),
          view('cursor', { kind: 'foreign' }),
        ],
      }),
    plan: () => Promise.reject(new Error('not here')),
    agentIdOf: () => Promise.resolve(undefined),
  };
}

const servers: ApprovalServer[] = [];
const streams: Stream[] = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function harness() {
  const opened: string[] = [];
  const stats = new Map<string, AgentDirectoryStats>([
    ['default', { contacts: 1, running: false, sessions: [], lastSeen: [] }],
    [
      'work',
      {
        contacts: 3,
        running: false,
        sessions: [],
        lastSeen: [{ app: 'codex', at: NOW - 600 }],
      },
    ],
  ]);
  let statsReads = 0;
  /** While set, every stats read waits for it (a slow host read). */
  let gate: Promise<void> | undefined;
  const entries = new Map<string, AgentDirectoryEntry>([
    ['default', { name: 'default', label: 'Personal', available: true, removing: false }],
    ['work', { name: 'work', label: 'Work', available: true, removing: false }],
  ]);
  const source: ApprovalServerSource = {
    context: () => Promise.resolve(undefined),
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    apply: () => Promise.reject(new Error('never')),
  };
  const agent = (name: string): AppHostAgent => ({
    name,
    label: entries.get(name)?.label ?? name,
    source,
    localUi: { aiApps: aiApps() },
    close: () => Promise.resolve(),
  });
  const directory: AgentDirectory = {
    list: () => Promise.resolve([...entries.values()]),
    read: (name) => Promise.resolve(entries.get(name)),
    stats: async (name) => {
      statsReads += 1;
      await gate;
      return stats.get(name);
    },
    writeLabel: () => Promise.reject(new Error('no')),
    markRemoving: () => Promise.reject(new Error('no')),
    removeFolder: () => Promise.reject(new Error('no')),
    readCurrent: () => Promise.resolve(undefined),
    writeCurrent: () => Promise.resolve(),
  };
  const server = await startApprovalServerWith(
    {
      source,
      localUi: { assets: bundle() },
      host: { directory, initial: agent('default'), open: (name) => Promise.resolve(agent(name)) },
    },
    {
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      openOwnerStore: () => Promise.reject(new Error('no owner store')),
      liveEvents: { readIntervalMs: 50 },
    },
  );
  servers.push(server);
  const port = server.port;
  const cookie = async (): Promise<string> => {
    const at = opened.length;
    await server.open();
    const fresh = new URL(opened[at] ?? '').searchParams.get('t') ?? '';
    const res = await send(port, `/?t=${fresh}`);
    return (res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  };
  const csrf = async (c: string): Promise<string> => {
    const res = await send(port, '/', { Cookie: c });
    return /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(res.body)?.[1] ?? '';
  };
  const c = await cookie();
  const token = await csrf(c);
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    Cookie: c,
    'X-AgentLink-CSRF': token,
    Accept: 'text/event-stream',
    ...extra,
  });
  return {
    server,
    port,
    stats,
    headers,
    cookie,
    csrf,
    get statsReads() {
      return statsReads;
    },
    /** Holds every stats read until the returned function is called. */
    hold(): () => void {
      let open: () => void = () => undefined;
      gate = new Promise((resolve) => {
        open = resolve;
      });
      return () => {
        gate = undefined;
        open();
      };
    },
    async stream(extra: Record<string, string> = {}, path?: string): Promise<Stream> {
      const s = await openStream(port, headers(extra), path);
      streams.push(s);
      return s;
    },
  };
}

describe('GET /api/ui/events: the gate (04 §2.5, 08 §1)', () => {
  it('refuses no cookie, no CSRF header, a wrong Host, a cross-site or cross-origin request', async () => {
    const h = await harness();
    const refused = async (headers: Record<string, string>, status: number) => {
      const res = await send(h.port, '/api/ui/events', headers);
      expect(res.status, JSON.stringify(headers)).toBe(status);
      expect(res.headers['content-type'] ?? '').not.toContain('text/event-stream');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    };
    await refused(without(h.headers(), 'Cookie'), 401);
    await refused(without(h.headers(), 'X-AgentLink-CSRF'), 403);
    await refused(h.headers({ Host: 'evil.example:80' }), 403);
    await refused(h.headers({ Host: `127.0.0.1:${String(h.port)}` }), 403);
    await refused(h.headers({ 'Sec-Fetch-Site': 'cross-site' }), 403);
    await refused(h.headers({ Origin: 'http://evil.example' }), 403);
    await refused(h.headers({ Origin: `http://localhost:${String(h.port + 1)}` }), 403);
  });

  it('requires Accept: text/event-stream and refuses any query parameter', async () => {
    const h = await harness();
    const noAccept = await send(
      h.port,
      '/api/ui/events',
      h.headers({ Accept: 'application/json' }),
    );
    expect(noAccept.status).toBe(400);
    expect(JSON.parse(noAccept.body)).toEqual({ error: 'bad_request' });
    const query = await send(h.port, '/api/ui/events?since=1', h.headers());
    expect(query.status).toBe(400);
    expect(JSON.parse(query.body)).toEqual({ error: 'bad_request' });
  });

  it('answers a same-origin read with the stream headers and no CORS headers', async () => {
    const h = await harness();
    const s = await h.stream({ Origin: h.server.origin, 'Sec-Fetch-Site': 'same-origin' });
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(s.headers['cache-control']).toBe('no-store');
    expect(s.headers['x-content-type-options']).toBe('nosniff');
    expect(s.headers['access-control-allow-origin']).toBeUndefined();
    expect(s.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('refuses a 5th stream of one page session with 429 busy', async () => {
    const h = await harness();
    for (let i = 0; i < 4; i += 1) expect((await h.stream()).status).toBe(200);
    const fifth = await send(h.port, '/api/ui/events', h.headers());
    expect(fifth.status).toBe(429);
    expect(JSON.parse(fifth.body)).toEqual({ error: 'busy' });
  });

  it('a client that disconnects while the host read is pending frees its slot', async () => {
    const h = await harness();
    const release = h.hold();
    const pending = Array.from({ length: 4 }, () => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: h.port,
        path: '/api/ui/events',
        headers: { Host: `localhost:${String(h.port)}`, ...h.headers() },
        setHost: false,
      });
      req.on('error', () => undefined);
      req.end();
      return req;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const req of pending) req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (let i = 0; i < 4; i += 1) expect((await h.stream()).status).toBe(200);
  });

  // W4-WIRE-3 (owner walkthrough 30 Oct): the host's first read takes real time (it reads every
  // agent's store and the AI app configs). By then Node has consumed the empty GET body and marked
  // the request destroyed; that must not count as the reader going away, or the stream is dropped
  // before its first byte and the page waits forever with the status it loaded ("Offline").
  it('a stream whose first host read is slow still answers with its snapshot', async () => {
    const h = await harness();
    const release = h.hold();
    const opening = h.stream();
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const s = await Promise.race([
      opening,
      new Promise<never>((_, fail) =>
        setTimeout(() => fail(new Error('the stream never answered')), 2_000),
      ),
    ]);
    expect(s.status).toBe(200);
    await s.until((t) => t.includes('event: snapshot'));
  });

  it('ends open streams when the host stops', async () => {
    const h = await harness();
    const s = await h.stream();
    await s.until((t) => t.includes('event: snapshot'));
    await h.server.close();
    servers.splice(0);
    await s.ended;
  });
});

describe('GET /api/ui/events: what it carries (08 §1)', () => {
  it('starts with a snapshot of every agent: allowlisted fields only', async () => {
    const h = await harness();
    const s = await h.stream();
    const text = await s.until((t) => t.includes('event: snapshot'));
    expect(text.startsWith('retry: 2000\n')).toBe(true);
    const [snapshot] = dataOf(text, 'snapshot');
    expect(snapshot).toEqual({
      generation: 1,
      current: 'default',
      at: expect.any(Number) as number,
      agents: [
        {
          name: 'default',
          // U3-d: the open agent shows its verified label, else its folder name.
          label: 'default',
          current: true,
          removing: false,
          state: 'offline',
          apps: [
            { app: 'claude-code', state: 'not_running' },
            { app: 'codex', state: 'not_set_up' },
            { app: 'cursor', state: 'not_set_up' },
          ],
        },
        {
          name: 'work',
          label: 'Work',
          current: false,
          removing: false,
          state: 'offline',
          lastSeenAt: NOW - 600,
          apps: [
            { app: 'claude-code', state: 'not_set_up' },
            { app: 'codex', state: 'not_running', since: NOW - 600, lastSeenAt: NOW - 600 },
            { app: 'cursor', state: 'not_set_up' },
          ],
        },
      ],
    });
  });

  it('an AI app that starts and quits shows without a reload (changes only)', async () => {
    const h = await harness();
    const s = await h.stream();
    await s.until((t) => t.includes('event: snapshot'));
    h.stats.set('default', {
      contacts: 1,
      running: true,
      sessions: [{ app: 'claude-code', startedAt: NOW, lastToolAt: null }],
      lastSeen: [{ app: 'claude-code', at: NOW }],
    });
    const started = await s.until((t) => dataOf(t, 'agents').length >= 1);
    const [first] = dataOf(started, 'agents');
    expect(first?.['agents']).toEqual([
      expect.objectContaining({
        name: 'default',
        state: 'ready',
        apps: expect.arrayContaining([
          { app: 'claude-code', state: 'ready', since: NOW },
        ]) as unknown,
      }),
    ]);
    h.stats.set('default', {
      contacts: 1,
      running: false,
      sessions: [],
      lastSeen: [{ app: 'claude-code', at: NOW + 1 }],
    });
    const quit = await s.until((t) => dataOf(t, 'agents').length >= 2);
    expect(dataOf(quit, 'agents')[1]?.['agents']).toEqual([
      expect.objectContaining({ name: 'default', state: 'offline', lastSeenAt: NOW + 1 }),
    ]);
  });

  it('GET /api/ui/agents carries the same allowlisted state, and Running from live sessions only', async () => {
    const h = await harness();
    h.stats.set('work', {
      contacts: 3,
      running: true,
      sessions: [{ app: 'codex', startedAt: NOW - 5, lastToolAt: NOW - 1 }],
      lastSeen: [],
    });
    const res = await send(h.port, '/api/ui/agents', without(h.headers(), 'Accept'));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { agents: Record<string, unknown>[] };
    expect(body.agents[1]).toEqual({
      name: 'work',
      label: 'Work',
      labelled: false,
      current: false,
      available: true,
      removing: false,
      contacts: 3,
      running: true,
      state: 'working',
      apps: [
        { app: 'claude-code', state: 'not_set_up' },
        { app: 'codex', state: 'working', since: NOW - 1 },
        { app: 'cursor', state: 'not_set_up' },
      ],
    });
    expect(body.agents[0]?.['running']).toBe(false);
  });
});
