// W4-SHELL-V2 acceptance (Decisions 49–51; 08 §1, proposed): the app's own UI settings.
//
// - `GET /api/ui/ui-settings` answers the stored allowlisted switches (`{}` when none), with no agent
//   open too; outside the app host it answers `{}`.
// - `PUT /api/ui/ui-settings` is the ui-settings kind: registered once, at its fixed path, as a PUT
//   with a handler. It keeps every write guard (session cookie, CSRF, Origin, Host, fetch metadata,
//   octet-stream) and refuses a query, an operation input, a presence header and any body that is
//   not one strict object of allowlisted booleans, before the store is touched. It takes no owner
//   presence (the owner store is never opened), carries no generation and signs nothing. Outside the
//   app host it is 501 `not_available`.
// - Changes are merged one at a time: two quick PUTs keep both keys.
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { encodeUtf8 } from '@4thtech-io/crypto';
import {
  UI_SETTINGS_PATH,
  UI_SETTINGS_SAMPLES,
  type UiSettings,
} from '@4thtech-io/types/ui-contract/ui-settings';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerSource,
} from '../approval-server.js';
import { createUiSettingsDesk, uiSettingsWriteRoute } from './api/ui-settings.js';
import type { AgentDirectory, AppHostAgent } from './app-host.js';
import type { LocalUiAssets } from './context.js';
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

interface Res {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: Uint8Array } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
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
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const json = (value: unknown): Uint8Array => encodeUtf8(JSON.stringify(value));

const source: ApprovalServerSource = {
  context: () => Promise.resolve(undefined),
  list: () => Promise.resolve([]),
  get: () => Promise.resolve(undefined),
  apply: () => Promise.reject(new Error('never')),
};

interface World {
  stored: UiSettings | undefined;
  readonly writes: UiSettings[];
}

function directory(world: World, withSettings = true): AgentDirectory {
  return {
    list: () =>
      Promise.resolve([{ name: 'default', label: 'Personal', available: true, removing: false }]),
    read: () => Promise.resolve(undefined),
    stats: () => Promise.resolve({ contacts: 0, running: true }),
    writeLabel: () => Promise.reject(new Error('never')),
    markRemoving: () => Promise.reject(new Error('never')),
    removeFolder: () => Promise.reject(new Error('never')),
    readCurrent: () => Promise.resolve(undefined),
    writeCurrent: () => Promise.resolve(),
    ...(withSettings
      ? {
          readUiSettings: () => Promise.resolve(world.stored),
          writeUiSettings: async (settings: UiSettings) => {
            // A slow disk: a second change must still see the first one.
            await new Promise((r) => setTimeout(r, 5));
            world.writes.push(settings);
            world.stored = settings;
          },
        }
      : {}),
  };
}

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

interface Harness {
  readonly server: ApprovalServer;
  readonly port: number;
  readonly world: World;
  readonly ownerStores: number[];
  readonly cookie: string;
  readonly csrf: string;
  write(extra?: Record<string, string>): Record<string, string>;
  read(): Promise<Res>;
  put(body: unknown, extra?: Record<string, string>, query?: string): Promise<Res>;
}

async function harness(
  options: { host?: boolean; initial?: boolean; withSettings?: boolean } = {},
): Promise<Harness> {
  const opened: string[] = [];
  const ownerStores: number[] = [];
  const world: World = { stored: undefined, writes: [] };
  const initial: AppHostAgent = {
    name: 'default',
    label: 'Personal',
    source,
    localUi: {},
    close: () => Promise.resolve(),
  };
  const server = await startApprovalServerWith(
    {
      source,
      localUi: { assets: bundle() },
      ...(options.host === false
        ? {}
        : {
            host: {
              directory: directory(world, options.withSettings !== false),
              ...(options.initial === false ? {} : { initial }),
              open: () => Promise.resolve(initial),
            },
          }),
    },
    {
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      openOwnerStore: () => {
        ownerStores.push(1);
        return Promise.reject(new Error('no owner store here'));
      },
    },
  );
  servers.push(server);
  const port = server.port;
  await server.open();
  const t = new URL(opened[0] ?? '').searchParams.get('t') ?? '';
  const landed = await send(port, `/?t=${t}`);
  const cookie = (landed.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const shell = await send(port, '/', { headers: { Cookie: cookie } });
  const csrf =
    /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(shell.body)?.[1] ?? '';
  const write = (extra: Record<string, string> = {}): Record<string, string> => ({
    Cookie: cookie,
    Origin: server.origin,
    'X-AgentLink-CSRF': csrf,
    'Content-Type': 'application/octet-stream',
    ...extra,
  });
  return {
    server,
    port,
    world,
    ownerStores,
    cookie,
    csrf,
    write,
    read: () =>
      send(port, UI_SETTINGS_PATH, { headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf } }),
    put: (body, extra = {}, query = '') =>
      send(port, `${UI_SETTINGS_PATH}${query}`, {
        method: 'PUT',
        headers: write(extra),
        body: body instanceof Uint8Array ? body : json(body),
      }),
  };
}

describe('the ui-settings route kind (routes.ts)', () => {
  it('is registered once: a GET read and the one PUT of the kind', () => {
    const routes = createLocalUiRoutes().routes();
    const mine = routes.filter((r) => r.path === UI_SETTINGS_PATH);
    expect(mine.map((r) => `${r.method} ${String(r.presence)}`).sort()).toEqual([
      'GET false',
      'PUT ui-settings',
    ]);
  });

  it('refuses the kind at another path, method, twice, or without a handler', () => {
    const r = new LocalUiRouteRegistry();
    expect(() => r.register({ ...uiSettingsWriteRoute, path: '/api/ui/other' })).toThrow(
      /fixed path/,
    );
    expect(() => r.register({ ...uiSettingsWriteRoute, method: 'POST' } as never)).toThrow(/PUT/);
    expect(() => r.register({ ...uiSettingsWriteRoute, handler: undefined } as never)).toThrow(
      /handler/,
    );
    r.register(uiSettingsWriteRoute);
    expect(() => r.register(uiSettingsWriteRoute)).toThrow(/already registered/);
    // An ordinary PUT still needs owner presence (I-4).
    expect(() =>
      r.register({
        method: 'PUT',
        path: '/api/ui/elsewhere',
        presence: false,
        handler: () => Promise.resolve({ status: 200, body: {} }),
      } as never),
    ).toThrow(/presence: true/);
  });
});

describe('GET and PUT /api/ui/ui-settings in the app host', () => {
  it('reads {} until set, then stores and answers exactly the allowlisted switches', async () => {
    const h = await harness();
    const first = await h.read();
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual(UI_SETTINGS_SAMPLES.empty.body);
    const put = await h.put(UI_SETTINGS_SAMPLES.put.body);
    expect(put.status).toBe(200);
    expect(JSON.parse(put.body)).toEqual(UI_SETTINGS_SAMPLES.put.answer.body);
    expect(h.world.stored).toEqual({ underTheHood: true });
    const again = await h.read();
    expect(JSON.parse(again.body)).toEqual({ underTheHood: true });
    // No owner presence, nothing signed.
    expect(h.ownerStores).toEqual([]);
  });

  it('merges two quick changes one at a time (no lost update)', async () => {
    const h = await harness();
    const [a, b] = await Promise.all([
      h.put({ underTheHood: true }),
      h.put({ menuExpanded: true }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(h.world.stored).toEqual({ underTheHood: true, menuExpanded: true });
  });

  it('refuses every body that is not one strict object of allowlisted booleans', async () => {
    const h = await harness();
    for (const bad of UI_SETTINGS_SAMPLES.invalid) {
      const res = await h.put(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid' });
      expect(res.body).not.toContain('passwd');
    }
    expect((await h.put(encodeUtf8('{"underTheHood":tru'))).status).toBe(400);
    expect((await h.put(encodeUtf8('x'.repeat(200)))).status).toBe(413);
    expect(h.world.writes).toEqual([]);
  });

  it('refuses a query, an operation input and a presence header before the store', async () => {
    const h = await harness();
    expect((await h.put({ underTheHood: true }, {}, '?x=1')).status).toBe(400);
    expect((await h.put({ underTheHood: true }, { 'X-AgentLink-Input': 'e30' })).status).toBe(400);
    expect((await h.put({ underTheHood: true }, { 'X-AgentLink-Presence': 'p' })).status).toBe(400);
    expect(h.world.writes).toEqual([]);
  });

  it('keeps every write guard: session, CSRF, Origin, fetch metadata, octet-stream, Host', async () => {
    const h = await harness();
    const body = json({ underTheHood: true });
    const drop = (name: string): Record<string, string> =>
      Object.fromEntries(Object.entries(h.write()).filter(([k]) => k !== name));
    const put = (headers: Record<string, string>) =>
      send(h.port, UI_SETTINGS_PATH, { method: 'PUT', headers, body });
    expect((await put(drop('Cookie'))).status).toBe(401);
    expect((await put(drop('X-AgentLink-CSRF'))).status).toBe(403);
    expect((await put(h.write({ 'X-AgentLink-CSRF': 'wrong' }))).status).toBe(403);
    expect((await put(drop('Origin'))).status).toBe(403);
    expect((await put(h.write({ 'Sec-Fetch-Site': 'cross-site' }))).status).toBe(403);
    expect((await put(h.write({ 'Content-Type': 'application/json' }))).status).toBe(415);
    expect((await put(h.write({ Host: 'evil.example' }))).status).not.toBe(200);
    expect(h.world.writes).toEqual([]);
    // The read keeps the session and CSRF guards too.
    expect((await send(h.port, UI_SETTINGS_PATH, { headers: { Cookie: h.cookie } })).status).toBe(
      403,
    );
  });

  it('answers with no agent open (first run shows the shell)', async () => {
    const h = await harness({ initial: false });
    expect((await h.read()).status).toBe(200);
    expect((await h.put({ menuExpanded: true })).status).toBe(200);
    expect(h.world.stored).toEqual({ menuExpanded: true });
  });
});

describe('outside the app host', () => {
  it('reads {} and the PUT is not available', async () => {
    const h = await harness({ host: false });
    const read = await h.read();
    expect(read.status).toBe(200);
    expect(JSON.parse(read.body)).toEqual({});
    const put = await h.put({ underTheHood: true });
    expect(put.status).toBe(UI_SETTINGS_SAMPLES.notAvailable.status);
    expect(JSON.parse(put.body)).toEqual(UI_SETTINGS_SAMPLES.notAvailable.body);
  });

  it('an app host whose directory keeps no settings answers {} and 501', async () => {
    const h = await harness({ withSettings: false });
    expect(JSON.parse((await h.read()).body)).toEqual({});
    expect((await h.put({ underTheHood: true })).status).toBe(501);
  });
});

describe('createUiSettingsDesk', () => {
  it('reads {} for nothing stored and passes a failed write on', async () => {
    const desk = createUiSettingsDesk({
      read: () => Promise.resolve(undefined),
      write: () => Promise.reject(new Error('disk')),
    });
    expect(await desk.read()).toEqual({});
    await expect(desk.update({ underTheHood: true })).rejects.toThrow();
    // The queue keeps going after a failure.
    await expect(desk.update({ menuExpanded: true })).rejects.toThrow();
  });
});

describe('the W4-SHELL-V2 pages are app pages (the shell is served)', () => {
  it('serves the app for the sections, one agent, the live stream, Advanced and Get started', async () => {
    const h = await harness();
    for (const path of [
      '/agents',
      '/agents/work',
      '/activity',
      '/activity/live',
      '/advanced/network',
      '/advanced/diagnostics',
      '/start/app',
      '/start/connect',
    ]) {
      const res = await send(h.port, path, { headers: { Cookie: h.cookie } });
      expect(res.status, path).toBe(200);
      expect(res.body, path).toContain('agentlink-csrf');
    }
  });

  it('nothing deeper or upper case is a page', async () => {
    const h = await harness();
    for (const path of [
      '/agents/work/x',
      '/agents/Work',
      '/activity/other',
      '/advanced/a/b',
      '/start/a/b',
    ]) {
      const res = await send(h.port, path, { headers: { Cookie: h.cookie } });
      expect(res.status, path).toBe(404);
    }
  });
});
