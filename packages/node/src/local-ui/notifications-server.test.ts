// N4 acceptance (S2; PLAN-NOTIFY §3.1, §3.4; 08 §1, proposed): the notification centre's routes.
//
// - `GET /api/ui/notifications` is a read route: session cookie and CSRF token required (no Origin
//   needed for a GET, as every /api/ui/ read). It answers only schema items, per open ID.
// - `POST /api/ui/notifications/:id/read` and `POST /api/ui/notifications/read-all` are the `mark`
//   kind: session, CSRF, Origin, fetch metadata, octet-stream, the generation, no query, no input,
//   no presence header and an empty body. No owner presence, nothing signed.
// - The record lives in a JSON file under the ID folder (AgentDirectory.readNotifications /
//   writeNotifications), per ID.
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { encodeUtf8 } from '@4thtech-io/crypto';
import {
  NOTIFICATIONS_PATH,
  NOTIFICATIONS_READ_ALL_PATH,
  NOTIFICATIONS_REFRESH_PATH,
  NOTIFICATION_KEYS,
  NOTIFICATION_READ_PATH,
} from '@4thtech-io/types/ui-contract/notifications';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerSource,
} from '../approval-server.js';
import type { AgentDirectory, AppHostAgent } from './app-host.js';
import type { LocalUiAssets } from './context.js';
import { createLocalUiRoutes } from './routes.js';
import type { UiSettings } from '@4thtech-io/types/ui-contract/ui-settings';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const NOW = Math.floor(Date.now() / 1000);

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

const source: ApprovalServerSource = {
  context: () => Promise.resolve(undefined),
  list: () => Promise.resolve([]),
  get: () => Promise.resolve(undefined),
  apply: () => Promise.reject(new Error('never')),
};

interface World {
  readonly files: Map<string, unknown>;
  readonly writes: { name: string; record: unknown }[];
  /** ui-settings.json (N6: `notify`). */
  settings?: UiSettings;
}

function directory(world: World): AgentDirectory {
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
    readUiSettings: () => Promise.resolve(world.settings),
    writeUiSettings: (settings: UiSettings) => {
      world.settings = settings;
      return Promise.resolve();
    },
    readNotifications: (name: string) => Promise.resolve(world.files.get(name)),
    writeNotifications: (name: string, record: unknown) => {
      world.writes.push({ name, record });
      world.files.set(name, JSON.parse(JSON.stringify(record)));
      return Promise.resolve();
    },
  };
}

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const UPDATE_READY = {
  install: 'desktop' as const,
  view: () => ({
    state: 'available' as const,
    current: '0.5.2',
    latest: '0.5.3',
    download: 'https://github.com/4thtech/agentlink/releases/tag/v0.5.3',
  }),
  check: () => undefined,
};

async function harness(options: { updateReady?: boolean } = {}) {
  const opened: string[] = [];
  const alerts: number[] = [];
  const ownerStores: number[] = [];
  const world: World = {
    files: new Map<string, unknown>([
      [
        'default',
        {
          v: 1,
          cursor: NOW,
          items: [
            { id: `messages-${A}`, kind: 'messages', ref: A, count: 2, at: NOW - 5, read: false },
            { id: `files-${B}`, kind: 'files', ref: B, count: 1, at: NOW - 9, read: false },
          ],
        },
      ],
    ]),
    writes: [],
  };
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
      host: { directory: directory(world), initial, open: () => Promise.resolve(initial) },
      ...(options.updateReady === true ? { appUpdate: UPDATE_READY } : {}),
    },
    {
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => {
        alerts.push(1);
        return Promise.resolve(true);
      },
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
  const read = (extra: Record<string, string> = {}, query = ''): Promise<Res> =>
    send(port, `${NOTIFICATIONS_PATH}${query}`, {
      headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf, ...extra },
    });
  const generation = async (): Promise<string> =>
    String((await read()).headers['x-agentlink-generation'] ?? '');
  const mark = async (
    path: string,
    extra: Record<string, string | undefined> = {},
    body?: Uint8Array,
  ): Promise<Res> => {
    const headers: Record<string, string> = {};
    const all: Record<string, string | undefined> = {
      Cookie: cookie,
      Origin: server.origin,
      'X-AgentLink-CSRF': csrf,
      'X-AgentLink-Generation': await generation(),
      'Content-Type': 'application/octet-stream',
      ...extra,
    };
    for (const [k, v] of Object.entries(all)) if (v !== undefined) headers[k] = v;
    return send(port, path, { method: 'POST', headers, ...(body === undefined ? {} : { body }) });
  };
  return { server, port, world, ownerStores, cookie, csrf, read, mark, alerts };
}

const readPath = (id: string): string => NOTIFICATION_READ_PATH.replace(':id', id);

describe('the notification routes (routes.ts)', () => {
  it('registers one read and three marks, never an owner-presence route', () => {
    const mine = createLocalUiRoutes()
      .routes()
      .filter((r) => r.path.startsWith(NOTIFICATIONS_PATH));
    expect(mine.map((r) => `${r.method} ${r.path} ${String(r.presence)}`).sort()).toEqual([
      `GET ${NOTIFICATIONS_PATH} false`,
      `POST ${NOTIFICATION_READ_PATH} mark`,
      `POST ${NOTIFICATIONS_READ_ALL_PATH} mark`,
      `POST ${NOTIFICATIONS_REFRESH_PATH} mark`,
    ]);
  });
});

describe('GET /api/ui/notifications', () => {
  it('answers the ID folder record: schema keys only, newest first, with the bell number', async () => {
    const h = await harness();
    const res = await h.read();
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { items: Record<string, unknown>[]; unread: number };
    expect(body.items.map((i) => i['id'])).toEqual([`messages-${A}`, `files-${B}`]);
    for (const item of body.items) {
      for (const key of Object.keys(item)) {
        expect(NOTIFICATION_KEYS as readonly string[]).toContain(key);
      }
    }
    expect(body.unread).toBe(2);
    expect(Object.keys(body).sort()).toEqual(['approvals', 'items', 'unread']);
    expect(h.ownerStores).toEqual([]);
  });

  it('needs the session cookie and the CSRF token, and refuses a query', async () => {
    const h = await harness();
    const noCookie = await send(h.port, NOTIFICATIONS_PATH, {
      headers: { 'X-AgentLink-CSRF': h.csrf },
    });
    expect(noCookie.status).toBe(401);
    const noCsrf = await send(h.port, NOTIFICATIONS_PATH, { headers: { Cookie: h.cookie } });
    expect(noCsrf.status).toBe(403);
    const crossSite = await h.read({ 'Sec-Fetch-Site': 'cross-site' });
    expect(crossSite.status).toBe(403);
    const query = await h.read({}, '?all=1');
    expect(query.status).toBe(400);
    expect(query.body).not.toContain('all');
  });
});

describe('POST …/read and …/read-all (the mark kind)', () => {
  it('marks one item read, kept in the ID folder file', async () => {
    const h = await harness();
    const res = await h.mark(readPath(`messages-${A}`));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'done' });
    const body = JSON.parse((await h.read()).body) as {
      items: { id: string; read: boolean }[];
      unread: number;
    };
    expect(body.items.find((i) => i.id === `messages-${A}`)?.read).toBe(true);
    expect(body.unread).toBe(1);
    expect(h.world.writes.at(-1)?.name).toBe('default');
    expect(h.ownerStores).toEqual([]);
  });

  it('marks all read', async () => {
    const h = await harness();
    expect((await h.mark(NOTIFICATIONS_READ_ALL_PATH)).status).toBe(200);
    expect(JSON.parse((await h.read()).body).unread).toBe(0);
  });

  it('answers 404 for an ID that is not an item, never echoing it', async () => {
    const h = await harness();
    const res = await h.mark(readPath(`messages-${B}`));
    expect(res.status).toBe(404);
    expect(res.body).not.toContain(B);
    expect((await h.mark(readPath('Ana'))).status).toBe(404);
  });

  it('keeps every write gate: session, CSRF, Origin, type, generation, empty body', async () => {
    const h = await harness();
    const path = readPath(`messages-${A}`);
    expect((await h.mark(path, { Cookie: undefined })).status).toBe(401);
    expect((await h.mark(path, { 'X-AgentLink-CSRF': undefined })).status).toBe(403);
    expect((await h.mark(path, { 'X-AgentLink-CSRF': 'x'.repeat(43) })).status).toBe(403);
    expect((await h.mark(path, { Origin: undefined })).status).toBe(403);
    expect((await h.mark(path, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await h.mark(path, { 'Content-Type': 'application/json' })).status).toBe(415);
    expect((await h.mark(path, { 'X-AgentLink-Generation': '999' })).status).toBe(409);
    expect((await h.mark(path, {}, encodeUtf8('{"text":"x"}'))).status).toBe(400);
    expect((await h.mark(`${path}?x=1`)).status).toBe(400);
    expect((await h.mark(path, { 'X-AgentLink-Presence': 'passkey' })).status).toBe(400);
    // Nothing was marked by any refused request.
    expect(JSON.parse((await h.read()).body).unread).toBe(2);
    expect(h.ownerStores).toEqual([]);
  });

  it('a GET is a read, never a mark', async () => {
    const h = await harness();
    const res = await send(h.port, readPath(`messages-${A}`), {
      headers: { Cookie: h.cookie, 'X-AgentLink-CSRF': h.csrf },
    });
    expect(res.status).toBe(405);
    expect(JSON.parse((await h.read()).body).unread).toBe(2);
  });
});

describe('IR-NOTIFY-1 L-1: the GET only reads; POST …/refresh brings the store up to date', () => {
  it('a GET never writes the file, even when there is news', async () => {
    const h = await harness({ updateReady: true });
    const before = JSON.parse((await h.read()).body) as { items: { id: string }[] };
    expect(before.items.map((i) => i.id)).not.toContain('update');
    expect(h.world.writes).toEqual([]);
  });

  it('refresh (the mark kind) records the news, then the GET lists it', async () => {
    const h = await harness({ updateReady: true });
    const res = await h.mark(NOTIFICATIONS_REFRESH_PATH);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'done' });
    const after = JSON.parse((await h.read()).body) as { items: { id: string }[] };
    expect(after.items.map((i) => i.id)).toContain('update');
    expect(h.world.writes).toHaveLength(1);
    // Every write gate still applies.
    expect((await h.mark(NOTIFICATIONS_REFRESH_PATH, { 'X-AgentLink-CSRF': undefined })).status).toBe(
      403,
    );
    expect((await h.mark(NOTIFICATIONS_REFRESH_PATH, { Origin: undefined })).status).toBe(403);
  });
});

describe('IR-NOTIFY-1 M-1: the "Approvals waiting" switch governs the OS approval alert', () => {
  const ID = `apr_${'A'.repeat(22)}`;

  it('alerts by default (D2: approvals on)', async () => {
    const h = await harness();
    await h.server.notifyNewApproval(ID);
    expect(h.alerts).toHaveLength(1);
  });

  it('no OS alert once the owner turned it off; the link is still answered', async () => {
    const h = await harness();
    h.world.settings = { notify: { approvals: false } };
    expect(await h.server.notifyNewApproval(ID)).toBe(`${h.server.origin}/approve/${ID}`);
    expect(h.alerts).toEqual([]);
    h.world.settings = { notify: { approvals: true } };
    await h.server.notifyNewApproval(ID);
    expect(h.alerts).toHaveLength(1);
  });

  it('outside the app host it asks the caller (agentlink mcp reads ui-settings.json)', async () => {
    let allowed = false;
    let alerts = 0;
    const server = await startApprovalServerWith(
      { source, approvalAlerts: () => Promise.resolve(allowed) },
      {
        opener: () => Promise.resolve(true),
        notifier: () => {
          alerts += 1;
          return Promise.resolve(true);
        },
      },
    );
    servers.push(server);
    await server.notifyNewApproval(ID);
    expect(alerts).toBe(0);
    allowed = true;
    await server.notifyNewApproval(ID);
    expect(alerts).toBe(1);
  });
});
