// U3-c acceptance: the approval server as the app host (08 §1 "Agents and AI apps in the app"; 04
// §2.5 "Several agents in one app"; 06 §6; D-138; I-1, I-4, I-7).
//
// - Every answer carries the generation and the open agent's label; the app shell carries the
//   generation for the page's fetch guard.
// - Every mutating request (every POST of the route registry, the approval decisions and review, the
//   passkey registration) is refused with 409 `agent_changed` when its generation is stale or
//   missing, before any presence check; a request that passed that check is refused again right
//   before the server acts when a switch began meanwhile (tests switch mid-request).
// - The switch kind: closes the old agent and opens the other in the same process, port and session
//   (the same cookie keeps working), signs nothing (the owner store is never opened), writes only
//   app.json, and keeps every guard (session, CSRF, Origin, fetch metadata, octet-stream; no query,
//   input or presence header; a strict body).
// - Every U3 route is registered; the stubs answer 501 `not_available` before any presence check.
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from 'node:http';
import { encodeUtf8 } from '@4thtech-io/crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerEvent,
  type ApprovalServerInternals,
  type ApprovalServerSource,
} from '../approval-server.js';
import { agentsSwitchRoute } from './api/agents.js';
import type { AgentDirectory, AgentDirectoryEntry, AppHostAgent } from './app-host.js';
import type { LocalUiAssets } from './context.js';
import { REVEAL_PATH } from './reveal-path.js';
import type { LocalUiRoute } from './route-types.js';
import { LocalUiRouteRegistry, createLocalUiRoutes } from './routes.js';

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

interface Response {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

function start(port: number, path: string, options: SendOptions = {}) {
  let req: ClientRequest | undefined;
  const done = new Promise<Response>((resolve, reject) => {
    req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { Host: `localhost:${String(port)}`, ...options.headers },
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
  });
  return { req: req as unknown as ClientRequest, done };
}

function send(port: number, path: string, options: SendOptions = {}): Promise<Response> {
  const { req, done } = start(port, path, options);
  if (options.body !== undefined) req.write(options.body);
  req.end();
  return done;
}

/** A copy of `headers` without `name`. */
const without = (headers: Record<string, string>, name: string): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name));

const json = (value: unknown): Uint8Array => encodeUtf8(JSON.stringify(value));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Agents {
  readonly log: string[];
  readonly written: string[];
  readonly entries: Map<string, AgentDirectoryEntry>;
  readonly directory: AgentDirectory;
  agent(name: string): AppHostAgent;
}

function agents(): Agents {
  const log: string[] = [];
  const written: string[] = [];
  const entries = new Map<string, AgentDirectoryEntry>([
    ['default', { name: 'default', label: 'Personal', available: true, removing: false }],
    ['work', { name: 'work', label: "Work's agent", available: true, removing: false }],
    ['old', { name: 'old', label: 'Old', available: true, removing: true }],
  ]);
  const source = (name: string): ApprovalServerSource => ({
    context: () => Promise.resolve(undefined),
    list: () => {
      log.push(`list ${name}`);
      return Promise.resolve([]);
    },
    get: () => Promise.resolve(undefined),
    apply: () => Promise.reject(new Error('never')),
  });
  const agent = (name: string): AppHostAgent => ({
    name,
    label: entries.get(name)?.label ?? name,
    source: source(name),
    localUi: {},
    close: () => {
      log.push(`close ${name}`);
      return Promise.resolve();
    },
  });
  const directory: AgentDirectory = {
    list: () => Promise.resolve([...entries.values()]),
    read: (name) => Promise.resolve(entries.get(name)),
    stats: (name) =>
      Promise.resolve(
        name === 'old'
          ? undefined
          : { contacts: name === 'work' ? 3 : 1, running: name === 'work' },
      ),
    writeLabel: () => Promise.reject(new Error('not in U3-c')),
    markRemoving: () => Promise.reject(new Error('not in U3-c')),
    removeFolder: () => Promise.reject(new Error('not in U3-c')),
    readCurrent: () => Promise.resolve(undefined),
    writeCurrent: (name) => {
      written.push(name);
      return Promise.resolve();
    },
  };
  return { log, written, entries, directory, agent };
}

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

interface Harness {
  readonly server: ApprovalServer;
  readonly port: number;
  readonly origin: string;
  readonly world: Agents;
  readonly events: ApprovalServerEvent[];
  readonly ownerStores: number[];
  cookie(): Promise<string>;
  csrf(cookie: string): Promise<string>;
  /** The headers of a valid write (session, CSRF, Origin, octet-stream) plus `extra`. */
  write(cookie: string, csrf: string, extra?: Record<string, string>): Record<string, string>;
}

async function harness(
  options: { routes?: LocalUiRouteRegistry; host?: boolean } = {},
): Promise<Harness> {
  const opened: string[] = [];
  const events: ApprovalServerEvent[] = [];
  const ownerStores: number[] = [];
  const world = agents();
  const internals: ApprovalServerInternals = {
    opener: (url) => {
      opened.push(url);
      return Promise.resolve(true);
    },
    notifier: () => Promise.resolve(true),
    // A switch signs nothing: the owner store is never opened.
    openOwnerStore: () => {
      ownerStores.push(1);
      return Promise.reject(new Error('no owner store in these tests'));
    },
    ...(options.routes === undefined ? {} : { routes: options.routes }),
  };
  const initial = world.agent('default');
  const server = await startApprovalServerWith(
    {
      source: initial.source,
      localUi: { assets: bundle() },
      onEvent: (event) => events.push(event),
      ...(options.host === false
        ? {}
        : {
            host: {
              directory: world.directory,
              initial,
              open: (name) => {
                world.log.push(`open ${name}`);
                return Promise.resolve(world.agent(name));
              },
            },
          }),
    },
    internals,
  );
  servers.push(server);
  const port = server.port;
  return {
    server,
    port,
    origin: server.origin,
    world,
    events,
    ownerStores,
    async cookie() {
      const at = opened.length;
      await server.open();
      const fresh = new URL(opened[at] ?? '').searchParams.get('t') ?? '';
      const res = await send(port, `/?t=${fresh}`);
      expect(res.status).toBe(303);
      return (res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    },
    async csrf(cookie) {
      const res = await send(port, '/', { headers: { Cookie: cookie } });
      return /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(res.body)?.[1] ?? '';
    },
    write(cookie, csrf, extra = {}) {
      return {
        Cookie: cookie,
        Origin: server.origin,
        'X-AgentLink-CSRF': csrf,
        'Content-Type': 'application/octet-stream',
        ...extra,
      };
    },
  };
}

const switchTo = (h: Harness, cookie: string, csrf: string, name: string, generation: number) =>
  send(h.port, '/api/ui/agents/switch', {
    method: 'POST',
    headers: h.write(cookie, csrf),
    body: json({ name, generation }),
  });

/** A path of the registry with every `:param` filled. */
const concrete = (path: string): string => path.replace(/:[A-Za-z0-9]+/g, 'x1');

describe('the app host: generation and label on every answer (U3-c, 08 §1)', () => {
  it('stamps reads, the shell and refusals; the shell carries the generation meta tag', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    const shell = await send(h.port, '/settings/activity', { headers: { Cookie: cookie } });
    expect(shell.status).toBe(200);
    expect(shell.body).toContain('<meta name="agentlink-generation" content="1">');
    expect(shell.headers['x-agentlink-generation']).toBe('1');
    expect(shell.headers['x-agentlink-agent']).toBe('Personal');
    const list = await send(h.port, '/api/approvals', {
      headers: { Cookie: cookie, 'X-AgentLink-CSRF': await h.csrf(cookie) },
    });
    expect(list.headers['x-agentlink-generation']).toBe('1');
  });

  it('outside the app host nothing is stamped and the agents read is not switchable', async () => {
    const h = await harness({ host: false });
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const shell = await send(h.port, '/settings/activity', { headers: { Cookie: cookie } });
    expect(shell.body).not.toContain('agentlink-generation');
    expect(shell.headers['x-agentlink-generation']).toBeUndefined();
    const read = await send(h.port, '/api/ui/agents', {
      headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf },
    });
    expect(JSON.parse(read.body)).toEqual({ switchable: false, agents: [] });
    const sw = await switchTo(h, cookie, csrf, 'work', 1);
    expect(sw.status).toBe(501);
    expect(JSON.parse(sw.body)).toEqual({ error: 'not_available' });
  });
});

describe('GET /api/ui/agents (U3-c)', () => {
  it('lists every agent with label, current, counts, Running and removing; no path or ID', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    const res = await send(h.port, '/api/ui/agents', {
      headers: { Cookie: cookie, 'X-AgentLink-CSRF': await h.csrf(cookie) },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      switchable: true,
      generation: 1,
      current: 'default',
      label: 'Personal',
      agents: [
        {
          name: 'default',
          label: 'Personal',
          current: true,
          available: true,
          removing: false,
          contacts: 1,
          running: false,
          apps: [],
        },
        {
          name: 'work',
          label: "Work's agent",
          current: false,
          available: true,
          removing: false,
          contacts: 3,
          running: true,
          apps: [],
        },
        {
          name: 'old',
          label: 'Old',
          current: false,
          available: true,
          removing: true,
          contacts: null,
          running: false,
          apps: [],
        },
      ],
    });
    // The label is percent-encoded plain text in the header.
    expect(res.headers['x-agentlink-agent']).toBe('Personal');
    const query = await send(h.port, '/api/ui/agents?x=1', {
      headers: { Cookie: cookie, 'X-AgentLink-CSRF': await h.csrf(cookie) },
    });
    expect(query.status).toBe(400);
  });
});

describe('the generation check on every mutating request (U3-c, 08 §1)', () => {
  it('refuses every mutating /api/ui/ route with agent_changed on a stale or missing generation, before presence', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const mutating = createLocalUiRoutes()
      .routes()
      .filter((r) => r.method !== 'GET' && r.presence !== 'switch');
    expect(mutating.length).toBeGreaterThan(10);
    for (const route of mutating) {
      for (const generation of [undefined, '0', '2', 'x', '01', '1.0']) {
        const res = await send(h.port, concrete(route.path), {
          method: route.method,
          headers: h.write(
            cookie,
            csrf,
            generation === undefined ? {} : { 'X-AgentLink-Generation': generation },
          ),
          body: encodeUtf8('1234'),
        });
        expect(res.status, `${route.path} ${String(generation)}`).toBe(409);
        expect(JSON.parse(res.body), route.path).toEqual({ status: 'agent_changed' });
        expect(res.headers['x-agentlink-generation']).toBe('1');
      }
    }
    // No presence was ever checked: the owner store was never opened.
    expect(h.ownerStores).toEqual([]);
  });

  it('refuses the approval decisions, the review and the passkey registration the same way', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const id = `apr_${'A'.repeat(22)}`;
    for (const path of [
      `/api/approvals/${id}/approve`,
      `/api/approvals/${id}/deny`,
      '/api/approvals/review',
      '/api/owner/passkey',
    ]) {
      const res = await send(h.port, path, {
        method: 'POST',
        headers: h.write(cookie, csrf, { 'X-AgentLink-Generation': '7' }),
        body: encodeUtf8('1234'),
      });
      expect(res.status, path).toBe(409);
      expect(JSON.parse(res.body), path).toEqual({ status: 'agent_changed' });
    }
    expect(h.ownerStores).toEqual([]);
  });

  it('a stale generation is refused only after the session, CSRF, Origin, fetch-metadata and type checks', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const path = '/api/ui/rules';
    const stale = { 'X-AgentLink-Generation': '9' };
    const base = h.write(cookie, csrf, stale);
    const noCookie = without(base, 'Cookie');
    expect((await send(h.port, path, { method: 'POST', headers: noCookie })).status).toBe(401);
    expect(
      (
        await send(h.port, path, {
          method: 'POST',
          headers: { ...base, 'X-AgentLink-CSRF': 'bad' },
        })
      ).status,
    ).toBe(403);
    const noOrigin = without(base, 'Origin');
    expect((await send(h.port, path, { method: 'POST', headers: noOrigin })).status).toBe(403);
    expect(
      (
        await send(h.port, path, {
          method: 'POST',
          headers: { ...base, 'Sec-Fetch-Site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send(h.port, path, {
          method: 'POST',
          headers: { ...base, 'Content-Type': 'application/json' },
        })
      ).status,
    ).toBe(415);
  });
});

describe('U3 route stubs (U3-c review note c)', () => {
  it('registers every U3 route; each stub answers 501 not_available before presence', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const registered = createLocalUiRoutes()
      .routes()
      .map((r) => `${r.method} ${r.path}`);
    for (const route of [
      'GET /api/ui/agents',
      'POST /api/ui/agents',
      'POST /api/ui/agents/switch',
      'POST /api/ui/agents/label',
      'POST /api/ui/agents/remove',
      'GET /api/ui/apps',
      'GET /api/ui/apps/preview',
      'POST /api/ui/apps/apply',
      'POST /api/ui/apps/disconnect',
      'GET /api/ui/flow',
    ]) {
      expect(registered, route).toContain(route);
    }
    for (const path of [
      '/api/ui/agents',
      '/api/ui/agents/label',
      '/api/ui/agents/remove',
      '/api/ui/apps/apply',
      '/api/ui/apps/disconnect',
    ]) {
      const res = await send(h.port, path, {
        method: 'POST',
        headers: h.write(cookie, csrf, { 'X-AgentLink-Generation': '1' }),
        body: encodeUtf8('1234'),
      });
      expect(res.status, path).toBe(501);
      expect(JSON.parse(res.body), path).toEqual({ error: 'not_available' });
    }
    // U3-flow replaced its stub: `/api/ui/flow` is a live read (see the U3-flow block below).
    for (const path of ['/api/ui/apps', '/api/ui/apps/preview']) {
      const res = await send(h.port, path, {
        headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf },
      });
      expect(res.status, path).toBe(501);
      expect(JSON.parse(res.body), path).toEqual({ error: 'not_available' });
    }
    expect(h.ownerStores).toEqual([]);
  });
});

describe('POST /api/ui/agents/switch (U3-c, the switch kind)', () => {
  it('closes the old agent, opens the other in the same port and session, writes app.json and signs nothing', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const res = await switchTo(h, cookie, csrf, 'work', 1);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'done', generation: 2, current: 'work' });
    expect(res.headers['x-agentlink-generation']).toBe('2');
    expect(h.world.log).toEqual(['close default', 'open work']);
    expect(h.world.written).toEqual(['work']);
    expect(h.ownerStores).toEqual([]);
    expect(h.events).toContainEqual({ kind: 'switch', outcome: 'done' });
    // The same cookie and CSRF keep working; the pages now read the other agent.
    const list = await send(h.port, '/api/approvals', {
      headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf },
    });
    expect(list.status).toBe(200);
    expect(h.world.log).toContain('list work');
    expect(list.headers['x-agentlink-agent']).toBe(encodeURIComponent("Work's agent"));
    const shell = await send(h.port, '/settings/activity', { headers: { Cookie: cookie } });
    expect(shell.body).toContain('<meta name="agentlink-generation" content="2">');
    // The page built against generation 1 is refused from now on.
    const stale = await send(h.port, '/api/ui/rules', {
      method: 'POST',
      headers: h.write(cookie, csrf, { 'X-AgentLink-Generation': '1' }),
      body: encodeUtf8('1234'),
    });
    expect(JSON.parse(stale.body)).toEqual({ status: 'agent_changed' });
    // Closing the server closes whichever agent is open.
    await h.server.close();
    servers.splice(servers.indexOf(h.server), 1);
    expect(h.world.log.at(-1)).toBe('close work');
  });

  it('refuses a stale generation, an unknown or removing agent, and a busy switch', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const status = async (name: string, generation: number) => {
      const res = await switchTo(h, cookie, csrf, name, generation);
      return [res.status, (JSON.parse(res.body) as { status: string }).status];
    };
    expect(await status('work', 2)).toEqual([409, 'agent_changed']);
    expect(await status('nobody', 1)).toEqual([404, 'unknown_agent']);
    expect(await status('../work', 1)).toEqual([404, 'unknown_agent']);
    expect(await status('old', 1)).toEqual([409, 'removing']);
    expect(h.world.log).toEqual([]);
  });

  it('keeps every guard: session, CSRF, Origin, fetch metadata, type, no query, input or presence, a strict body', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const good = h.write(cookie, csrf);
    const body = json({ name: 'work', generation: 1 });
    const post = (
      headers: Record<string, string>,
      b: Uint8Array = body,
      path = '/api/ui/agents/switch',
    ) => send(h.port, path, { method: 'POST', headers, body: b }).then((r) => r.status);
    const noCookie = without(good, 'Cookie');
    const noOrigin = without(good, 'Origin');
    expect(await post(noCookie)).toBe(401);
    expect(await post({ ...good, 'X-AgentLink-CSRF': 'x' })).toBe(403);
    expect(await post(noOrigin)).toBe(403);
    expect(await post({ ...good, Origin: 'http://localhost:1' })).toBe(403);
    expect(await post({ ...good, 'Sec-Fetch-Site': 'same-site' })).toBe(403);
    expect(await post({ ...good, 'Content-Type': 'application/json' })).toBe(415);
    expect(await post({ ...good, Host: '127.0.0.1' })).toBe(403);
    expect(await post(good, body, '/api/ui/agents/switch?name=work')).toBe(400);
    expect(await post({ ...good, 'X-AgentLink-Presence': 'passkey' })).toBe(400);
    expect(await post({ ...good, 'X-AgentLink-Input': 'e30' })).toBe(400);
    for (const bad of [
      { name: 'work' },
      { generation: 1 },
      { name: 'work', generation: 1, extra: true },
      { name: 'work', generation: '1' },
      { name: 'work', generation: 1.5 },
      { name: 7, generation: 1 },
      ['work', 1],
    ]) {
      expect(await post(good, json(bad)), JSON.stringify(bad)).toBe(400);
    }
    expect(await post(good, encodeUtf8('{'))).toBe(400);
    expect(
      await post(good, encodeUtf8(JSON.stringify({ name: 'w'.repeat(200), generation: 1 }))),
    ).toBe(413);
    expect(h.world.log).toEqual([]);
    expect(await post(good)).toBe(200);
  });

  it('a switch waits for a read in flight before it closes the agent', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const routes = new LocalUiRouteRegistry();
    routes.register(agentsSwitchRoute);
    routes.register({
      method: 'GET',
      path: '/api/ui/slow',
      presence: false,
      handler: async () => {
        await gate;
        return { status: 200, body: { ok: true } };
      },
    } as LocalUiRoute);
    const h = await harness({ routes });
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const reading = send(h.port, '/api/ui/slow', {
      headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf },
    });
    await sleep(30);
    const switching = switchTo(h, cookie, csrf, 'work', 1);
    await sleep(50);
    expect(h.world.log).toEqual([]);
    release();
    const read = await reading;
    expect(read.status).toBe(200);
    expect(read.headers['x-agentlink-generation']).toBe('1');
    expect((await switching).status).toBe(200);
    expect(h.world.log).toEqual(['close default', 'open work']);
  });

  it('a write that passed the arrival check is refused right before acting when a switch began (mid-request)', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    const reveal = json({ id: 'abc.01' });
    // The write arrives with the right generation; its body is still on its way.
    const { req, done } = start(h.port, REVEAL_PATH, {
      method: 'POST',
      headers: {
        ...h.write(cookie, csrf, { 'X-AgentLink-Generation': '1' }),
        'Content-Length': String(reveal.length),
      },
    });
    req.flushHeaders();
    await sleep(30);
    const switching = switchTo(h, cookie, csrf, 'work', 1);
    await sleep(30);
    // The switch waits: nothing is closed while the write is in flight.
    expect(h.world.log).toEqual([]);
    req.end(reveal);
    const res = await done;
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ status: 'agent_changed' });
    expect((await switching).status).toBe(200);
    expect(h.world.log).toEqual(['close default', 'open work']);
  });
});

// U3-c (owner request 2026-10-29, existing users): a switch shows the chosen agent's own contacts and
// message history, and nothing of the previous agent is left in any answer.
describe('a switch shows the other agent’s own contacts and messages (U3-c)', () => {
  const ANNA = `0x${'a1'.repeat(20)}`;
  const BORIS = `0x${'b2'.repeat(20)}`;

  /** A fake core client of one agent: one contact, one conversation, one inbound message. */
  const fakeClient = (contactId: string, name: string, text: string) =>
    ({
      agentId: `0x${contactId.slice(2, 4).repeat(20)}`,
      contacts: {
        list: () =>
          Promise.resolve([
            {
              id: contactId,
              agentNostr: 'ee'.repeat(32),
              display: { name, label: 'self-declared', nameSource: 'owner' },
              keyEpoch: 0,
              ownerFingerprint: { short: '7F3A·19C2', long: '7F3A·19C2·5D0E·88B1' },
              status: 'active',
              pairing: 'complete',
              safetyCodeChecked: false,
              createdAt: 1_759_449_600,
              updatedAt: 1_759_449_600,
            },
          ]),
      },
      messages: {
        conversations: () =>
          Promise.resolve([
            {
              contactId,
              display: { name, nameSource: 'owner', label: 'self-declared' },
              lastAt: 1_800_000_100,
              lastInAt: 1_800_000_100,
            },
          ]),
        list: (id: string) =>
          Promise.resolve({
            items:
              id === contactId
                ? [
                    {
                      id: 'env_AAAAAAAAAAAAAAAAAAAAAA',
                      at: 1_800_000_100,
                      type: 'text',
                      text,
                      files: [],
                      proof: false,
                      size: text.length,
                    },
                  ]
                : [],
          }),
        // U3-flow: one inbound message a few seconds ago; a hostile store field never leaves.
        flowEvents: (since: number, until: number) =>
          Promise.resolve({
            events: [
              {
                contactId,
                direction: 'in',
                kind: 'message',
                state: 'received',
                at: Math.min(until, Math.max(since, Math.floor(Date.now() / 1000) - 5)),
                text: `${text} (flow)`,
                name,
              },
            ],
            capped: false,
          }),
      },
    }) as never;

  it('before the switch every read is agent A’s; after it, agent B’s only', async () => {
    const world = agents();
    const clients: Record<string, unknown> = {
      default: fakeClient(ANNA, 'Anna', 'History of agent A'),
      work: fakeClient(BORIS, 'Boris', 'History of agent B'),
    };
    const withClient = (name: string): AppHostAgent => ({
      ...world.agent(name),
      localUi: { client: clients[name] as never },
    });
    const opened: string[] = [];
    const server = await startApprovalServerWith(
      {
        source: world.agent('default').source,
        localUi: { assets: bundle() },
        host: {
          directory: world.directory,
          initial: withClient('default'),
          open: (name) => Promise.resolve(withClient(name)),
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
    const cookie =
      ((await send(port, `/?t=${t}`)).headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    const page = await send(port, '/', { headers: { Cookie: cookie } });
    const csrf =
      /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1] ?? '';
    const read = async (path: string): Promise<string> => {
      const res = await send(port, path, { headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf } });
      expect(res.status, path).toBe(200);
      return res.body;
    };
    const everything = async (): Promise<string> =>
      [
        await read('/api/ui/contacts'),
        await read('/api/ui/messages'),
        await read(`/api/ui/messages/${ANNA}?box=in`),
        await read(`/api/ui/messages/${BORIS}?box=in`),
        await read('/api/ui/flow'),
      ].join('\n');

    const before = await everything();
    expect(JSON.parse(await read('/api/ui/contacts'))).toMatchObject({
      contacts: [{ ref: ANNA, name: 'Anna' }],
    });
    expect(JSON.parse(await read('/api/ui/messages'))).toEqual({
      conversations: [
        { contactId: ANNA, name: 'Anna', lastAt: 1_800_000_100, lastInAt: 1_800_000_100 },
      ],
    });
    expect(before).toContain('History of agent A');
    expect(before).not.toMatch(/Boris|History of agent B/);

    const switched = await send(port, '/api/ui/agents/switch', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: server.origin,
        'X-AgentLink-CSRF': csrf,
        'Content-Type': 'application/octet-stream',
      },
      body: json({ name: 'work', generation: 1 }),
    });
    expect(switched.status).toBe(200);

    const after = await everything();
    expect(JSON.parse(await read('/api/ui/contacts'))).toMatchObject({
      contacts: [{ ref: BORIS, name: 'Boris' }],
    });
    expect(JSON.parse(await read('/api/ui/messages'))).toEqual({
      conversations: [
        { contactId: BORIS, name: 'Boris', lastAt: 1_800_000_100, lastInAt: 1_800_000_100 },
      ],
    });
    expect(after).toContain('History of agent B');
    // U3-flow: the live connections read follows the open agent, metadata only.
    const flow = await send(port, '/api/ui/flow', {
      headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf },
    });
    expect(flow.headers['x-agentlink-generation']).toBe('2');
    expect(
      (JSON.parse(flow.body) as { items: { contactId: string }[] }).items.map((i) => i.contactId),
    ).toEqual([BORIS]);
    expect(flow.body).not.toMatch(/Boris|History|\(flow\)/);
    // Nothing of agent A is left in any answer.
    expect(after).not.toMatch(/Anna|History of agent A/);
    expect(after).not.toContain(ANNA);
  });
});

describe('GET /api/ui/flow behind the app host guards (U3-flow)', () => {
  it('needs the session and CSRF, refuses other methods, and is stamped with the generation', async () => {
    const h = await harness();
    const cookie = await h.cookie();
    const csrf = await h.csrf(cookie);
    expect(
      (await send(h.port, '/api/ui/flow', { headers: { 'X-AgentLink-CSRF': csrf } })).status,
    ).toBe(401);
    expect((await send(h.port, '/api/ui/flow', { headers: { Cookie: cookie } })).status).toBe(403);
    const post = await send(h.port, '/api/ui/flow', {
      method: 'POST',
      headers: h.write(cookie, csrf, { 'X-AgentLink-Generation': '1' }),
      body: encodeUtf8('1234'),
    });
    expect(post.status).toBe(405);
    // These agents have no client: the read answers not_set_up, still stamped (08 §1).
    const res = await send(h.port, '/api/ui/flow?since=1', {
      headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf },
    });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_set_up' });
    expect(res.headers['x-agentlink-generation']).toBe('1');
    expect(h.ownerStores).toEqual([]);
  });
});

// U3-c, IR-U3-c-SEC-1 L-1: a handler that outlives the switch's drain wait keeps the context it was
// given. Its owner context and apply stay bound to the agent it started with; it never reaches the
// agent opened after the switch.
describe('a late handler after a switch cannot reach the new agent (U3-c, L-1)', () => {
  it('ownerContext and applyOwnerAction stay bound to the agent the handler started with', async () => {
    const world = agents();
    const reached: string[] = [];
    const bound = (name: string): AppHostAgent => {
      const base = world.agent(name);
      return {
        ...base,
        source: {
          ...base.source,
          context: () => {
            reached.push(`context ${name}`);
            return Promise.resolve(undefined);
          },
          apply: () => {
            reached.push(`apply ${name}`);
            return Promise.reject(new Error('refused in this test'));
          },
        },
      };
    };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished: () => void = () => undefined;
    const handlerDone = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const routes = new LocalUiRouteRegistry();
    routes.register(agentsSwitchRoute);
    routes.register({
      method: 'GET',
      path: '/api/ui/late',
      presence: false,
      handler: async (context) => {
        await gate;
        await context.ownerContext();
        await context.applyOwnerAction({ body: {}, sig: '' } as never).catch(() => undefined);
        finished();
        return { status: 200, body: { ok: true } };
      },
    } as LocalUiRoute);
    const opened: string[] = [];
    const server = await startApprovalServerWith(
      {
        source: bound('default').source,
        localUi: { assets: bundle() },
        host: {
          directory: world.directory,
          initial: bound('default'),
          open: (name) => Promise.resolve(bound(name)),
        },
      },
      {
        routes,
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
    const cookie =
      ((await send(port, `/?t=${t}`)).headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    const page = await send(port, '/', { headers: { Cookie: cookie } });
    const csrf =
      /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1] ?? '';
    const late = send(port, '/api/ui/late', {
      headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf },
    });
    await sleep(30);
    // The switch waits for the handler at most SWITCH_DRAIN_MS, then opens the other agent anyway.
    const switched = await send(port, '/api/ui/agents/switch', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: server.origin,
        'X-AgentLink-CSRF': csrf,
        'Content-Type': 'application/octet-stream',
      },
      body: json({ name: 'work', generation: 1 }),
    });
    expect(switched.status).toBe(200);
    // Now the late handler goes on: it must never reach the agent opened after it started.
    release();
    await handlerDone;
    await late;
    expect(reached).toEqual(['context default', 'apply default']);
  }, 30_000);
});
