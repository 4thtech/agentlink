// UPD-BUTTON-FIX (0.5.6): the page's REAL api client (apps/local-ui/src/api/client.ts), behind the
// page's REAL generation guard (apps/local-ui/src/api/generation.ts), against the REAL approval
// server's gate (packages/node, built). Owner test of 0.5.5: Settings > Updates > "Update now" did
// nothing: the page POSTed with no body and no Content-Type, the server's mutating gate answered 415
// `content_type` before the mark gate, so the update desk never ran. Every bodyless POST the page
// sends (`api.post(path)`) must pass that gate: Update now, Restart now, and the recovery kit's
// Show in Finder (the kit-reveal kind, same gate).
//
// The only stand-in is the browser itself: a fetch that adds what a browser adds on its own for a
// same-origin page (the session cookie, the Origin header). The desk is a recording desk.
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { encodeUtf8 } from '@4thtech-io/crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerSource,
} from '../../packages/node/dist/approval-server.js';
import type { AgentDirectory, AppUpdateView, LocalUiAppUpdateDesk } from '@4thtech-io/node';
import { createApiClient } from '../../apps/local-ui/src/api/client.js';
import { generationGuard } from '../../apps/local-ui/src/api/generation.js';
import {
  APP_UPDATE_INSTALL_PATH,
  APP_UPDATE_RESTART_PATH,
} from '../../apps/local-ui/src/pages/updates/data.js';

/** apps/local-ui/src/pages/backup/save-checklist.tsx (a component file: it loads the UI library). */
const BACKUP_REVEAL_PATH = '/api/ui/backup/reveal';

const INDEX_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="agentlink-csrf" content="" /><title>AgentLink</title>' +
  '<script type="module" crossorigin src="/assets/index-Bx3f9a2Q.js"></script></head>' +
  '<body><div id="root"></div></body></html>';

interface Res {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Res> {
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

const source: ApprovalServerSource = {
  context: () => Promise.resolve(undefined),
  list: () => Promise.resolve([]),
  get: () => Promise.resolve(undefined),
  apply: () => Promise.reject(new Error('never')),
};
const directory: AgentDirectory = {
  list: () => Promise.resolve([]),
  read: () => Promise.resolve(undefined),
  stats: () => Promise.resolve(undefined),
  writeLabel: () => Promise.reject(new Error('never')),
  markRemoving: () => Promise.reject(new Error('never')),
  removeFolder: () => Promise.reject(new Error('never')),
  readCurrent: () => Promise.resolve(undefined),
  writeCurrent: () => Promise.resolve(),
};

const AVAILABLE: AppUpdateView = {
  state: 'available',
  current: '0.5.5',
  latest: '0.5.6',
  download:
    'https://github.com/4thtech/agentlink/releases/download/v0.5.6/AgentLink-0.5.6-mac-arm64.dmg',
  installable: true,
  percent: 0,
};

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** The real server (the desktop app's desk) and the page's real client, as the shell loads it. */
async function world() {
  const calls: string[] = [];
  let view: AppUpdateView = AVAILABLE;
  const desk: LocalUiAppUpdateDesk = {
    install: 'desktop',
    view: () => view,
    check: () => view,
    startInstall: () => {
      calls.push('install');
      view = { ...view, state: 'ready' };
      return { ...AVAILABLE, state: 'downloading' };
    },
    restart: () => {
      calls.push('restart');
      return { ...view, state: 'restarting' };
    },
    busy: () => false,
  };
  const opened: string[] = [];
  const server = await startApprovalServerWith(
    {
      source,
      localUi: { assets: { files: new Map([['index.html', encodeUtf8(INDEX_HTML)]]) } },
      host: { directory, open: () => Promise.resolve(undefined) },
      appUpdate: desk,
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
  await server.open();
  const port = server.port;
  const origin = `http://localhost:${String(port)}`;
  const t = new URL(opened[0] ?? '').searchParams.get('t') ?? '';
  const landed = await get(port, `/?t=${t}`);
  const cookie = (landed.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const shell = await get(port, '/', { Cookie: cookie });
  const csrf =
    /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(shell.body)?.[1] ?? '';
  const generation = /<meta name="agentlink-generation" content="([0-9]+)">/.exec(shell.body)?.[1];
  expect(csrf).not.toBe('');
  expect(generation).toBeDefined();

  // What the browser adds by itself for a same-origin page: the cookie and the Origin header.
  const sent: { method: string; contentType: string | null; body: unknown }[] = [];
  const browser: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : String(input), origin);
    const headers = new Headers(init?.headers);
    headers.set('Cookie', cookie);
    if ((init?.method ?? 'GET') !== 'GET') headers.set('Origin', origin);
    sent.push({
      method: init?.method ?? 'GET',
      contentType: headers.get('content-type'),
      body: init?.body,
    });
    return new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: url.pathname + url.search,
          method: init?.method ?? 'GET',
          headers: { Host: `localhost:${String(port)}`, ...Object.fromEntries(headers) },
          setHost: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const h = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === 'string') h.set(k, v);
            }
            resolve(
              new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: h }),
            );
          });
        },
      );
      req.on('error', reject);
      const body = init?.body;
      if (typeof body === 'string' || body instanceof Uint8Array) req.end(body);
      else req.end();
    });
  };
  // The page wraps fetch once with the generation guard (main.tsx), then makes its client.
  const guarded = generationGuard({
    generation,
    origin,
    fetch: browser,
    onChange: () => undefined,
  });
  const api = createApiClient({ fetch: guarded ?? browser, token: csrf });
  return { api, calls, sent };
}

describe('UPD-BUTTON-FIX: the page’s bodyless POSTs pass the real server gate', () => {
  it('Update now reaches the update desk and answers the new state', async () => {
    const w = await world();
    const result = await w.api.post(APP_UPDATE_INSTALL_PATH);
    expect(result).toMatchObject({ kind: 'ok', status: 200, data: { state: 'downloading' } });
    expect(w.calls).toEqual(['install']);
    // An empty octet-stream POST, as every other empty-body route (no JSON, no body byte).
    expect(w.sent.at(-1)).toMatchObject({
      method: 'POST',
      contentType: 'application/octet-stream',
    });
    expect(w.sent.at(-1)?.body).toBeUndefined();
  });

  it('Restart now reaches the update desk once the update is ready', async () => {
    const w = await world();
    expect(await w.api.post(APP_UPDATE_INSTALL_PATH)).toMatchObject({ kind: 'ok' });
    const result = await w.api.post(APP_UPDATE_RESTART_PATH);
    expect(result).toMatchObject({ kind: 'ok', status: 200, data: { state: 'restarting' } });
    expect(w.calls).toEqual(['install', 'restart']);
  });

  it('the recovery kit’s Show in Finder passes the content-type gate (kit-reveal kind)', async () => {
    const w = await world();
    const result = await w.api.post(BACKUP_REVEAL_PATH);
    // No agent is open in this world, so the route itself answers no agent (409); what matters is
    // that the request got past the gate the page used to fail (415 content_type).
    expect(result).toEqual({ kind: 'error', status: 409 });
  });
});
