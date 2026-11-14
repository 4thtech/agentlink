// DESK051-UPD through the real server: Settings > Updates answers the desktop host's checked state
// behind the gates of every read (session cookie, CSRF header, fetch metadata), with no agent open
// too; a check reaches the desk only through those gates; outside the desktop app it is 501.
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { encodeUtf8 } from '@4thtech-io/crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerSource,
} from '../approval-server.js';
import {
  APP_UPDATE_CHECK_PATH,
  APP_UPDATE_INSTALL_PATH,
  APP_UPDATE_PATH,
  APP_UPDATE_RESTART_PATH,
  type AppUpdateView,
  type LocalUiAppUpdateDesk,
} from './api/app-update.js';
import type { AgentDirectory } from './app-host.js';
import type { LocalUiAssets } from './context.js';

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

const DMG =
  'https://github.com/4thtech/agentlink/releases/download/v0.5.2/AgentLink-0.5.2-mac-arm64.dmg';
const AVAILABLE: AppUpdateView = {
  state: 'available',
  current: '0.5.1',
  latest: '0.5.2',
  download: DMG,
};

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function harness(appUpdate?: LocalUiAppUpdateDesk) {
  const opened: string[] = [];
  const server = await startApprovalServerWith(
    {
      source,
      localUi: { assets: bundle() },
      // No agent open (Welcome): the app's own update state still answers.
      host: { directory, open: () => Promise.resolve(undefined) },
      ...(appUpdate === undefined ? {} : { appUpdate }),
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
  const t = new URL(opened[0] ?? '').searchParams.get('t') ?? '';
  const landed = await send(server.port, `/?t=${t}`);
  const cookie = (landed.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const shell = await send(server.port, '/', { Cookie: cookie });
  const csrf =
    /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(shell.body)?.[1] ?? '';
  const generation =
    /<meta name="agentlink-generation" content="([0-9]+)">/.exec(shell.body)?.[1] ?? '';
  return { port: server.port, cookie, csrf, generation };
}

describe('Settings > Updates through the server (DESK051-UPD)', () => {
  it('answers the desk’s state with a session and the CSRF header, with no agent open', async () => {
    const h = await harness({ install: 'desktop', view: () => AVAILABLE, check: () => AVAILABLE });
    const res = await send(h.port, APP_UPDATE_PATH, {
      Cookie: h.cookie,
      'X-AgentLink-CSRF': h.csrf,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ...AVAILABLE,
      install: 'desktop',
      installable: false,
      percent: 0,
      busy: false,
    });
  });

  it('a check reaches the desk only through the read gates', async () => {
    let checks = 0;
    const h = await harness({
      install: 'desktop',
      view: () => AVAILABLE,
      check: () => {
        checks += 1;
        return { state: 'checking', current: '0.5.1', latest: '', download: '' };
      },
    });
    const noCookie = await send(h.port, APP_UPDATE_CHECK_PATH, { 'X-AgentLink-CSRF': h.csrf });
    expect(noCookie.status).toBe(401);
    const noCsrf = await send(h.port, APP_UPDATE_CHECK_PATH, { Cookie: h.cookie });
    expect(noCsrf.status).toBe(403);
    const crossSite = await send(h.port, APP_UPDATE_CHECK_PATH, {
      Cookie: h.cookie,
      'X-AgentLink-CSRF': h.csrf,
      'Sec-Fetch-Site': 'cross-site',
    });
    expect(crossSite.status).toBe(403);
    expect(checks).toBe(0);
    const ok = await send(h.port, APP_UPDATE_CHECK_PATH, {
      Cookie: h.cookie,
      'X-AgentLink-CSRF': h.csrf,
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ state: 'checking' });
    expect(checks).toBe(1);
  });

  it('UPD-5: Update now and Restart now reach the desk only with the session, CSRF and Origin', async () => {
    const calls: string[] = [];
    const IN_APP: AppUpdateView = { ...AVAILABLE, installable: true, percent: 0 };
    const h = await harness({
      install: 'desktop',
      view: () => IN_APP,
      check: () => IN_APP,
      startInstall: () => {
        calls.push('install');
        return { ...IN_APP, state: 'downloading' };
      },
      restart: () => {
        calls.push('restart');
        return { ...IN_APP, state: 'restarting' };
      },
      busy: () => false,
    });
    const origin = `http://localhost:${String(h.port)}`;
    const good = {
      Cookie: h.cookie,
      'X-AgentLink-CSRF': h.csrf,
      Origin: origin,
      'Content-Type': 'application/octet-stream',
      'X-AgentLink-Generation': h.generation,
    };
    const without = (name: string): Record<string, string> =>
      Object.fromEntries(Object.entries(good).filter(([k]) => k !== name));
    const noCookie = without('Cookie');
    const noCsrf = without('X-AgentLink-CSRF');
    expect((await send(h.port, APP_UPDATE_INSTALL_PATH, noCookie, 'POST')).status).toBe(401);
    expect((await send(h.port, APP_UPDATE_INSTALL_PATH, noCsrf, 'POST')).status).toBe(403);
    expect(
      (
        await send(
          h.port,
          APP_UPDATE_INSTALL_PATH,
          { ...good, 'Sec-Fetch-Site': 'cross-site' },
          'POST',
        )
      ).status,
    ).toBe(403);
    // A GET is never the install.
    expect((await send(h.port, APP_UPDATE_INSTALL_PATH, good)).status).not.toBe(200);
    expect(calls).toEqual([]);
    const ok = await send(h.port, APP_UPDATE_INSTALL_PATH, good, 'POST');
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ state: 'downloading', install: 'desktop' });
    const again = await send(h.port, APP_UPDATE_RESTART_PATH, good, 'POST');
    expect(again.status).toBe(200);
    expect(JSON.parse(again.body)).toMatchObject({ state: 'restarting' });
    expect(calls).toEqual(['install', 'restart']);
  });

  it('the browser app’s desk (REL051-UPD2): the version and how it was installed, no link', async () => {
    const browser = {
      state: 'available',
      current: '0.5.1',
      latest: '0.5.2',
      download: '',
    } as const;
    const h = await harness({ install: 'global', view: () => browser, check: () => browser });
    const res = await send(h.port, APP_UPDATE_PATH, {
      Cookie: h.cookie,
      'X-AgentLink-CSRF': h.csrf,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ...browser, install: 'global' });
  });

  it('BROWSER-UPDATE: the browser app’s Update now passes the same gates as the Mac app’s', async () => {
    const calls: string[] = [];
    const view: AppUpdateView = {
      state: 'available',
      current: '0.5.1',
      latest: '0.5.2',
      download: '',
      installable: true,
      percent: 0,
    };
    const h = await harness({
      install: 'npx',
      view: () => view,
      check: () => view,
      startInstall: () => {
        calls.push('install');
        return { ...view, state: 'downloading' };
      },
      restart: () => {
        calls.push('restart');
        return view;
      },
    });
    const origin = `http://localhost:${String(h.port)}`;
    const good = {
      Cookie: h.cookie,
      'X-AgentLink-CSRF': h.csrf,
      Origin: origin,
      'Content-Type': 'application/octet-stream',
      'X-AgentLink-Generation': h.generation,
    };
    const without = (name: string): Record<string, string> =>
      Object.fromEntries(Object.entries(good).filter(([k]) => k !== name));
    expect((await send(h.port, APP_UPDATE_INSTALL_PATH, without('Cookie'), 'POST')).status).toBe(401);
    expect((await send(h.port, APP_UPDATE_INSTALL_PATH, without('X-AgentLink-CSRF'), 'POST')).status).toBe(403);
    expect(
      (await send(h.port, APP_UPDATE_INSTALL_PATH, { ...good, Origin: 'http://evil.example' }, 'POST'))
        .status,
    ).toBe(403);
    // A bearer token (what an MCP client or script might hold) is not the page's session.
    expect(
      (
        await send(
          h.port,
          APP_UPDATE_INSTALL_PATH,
          { ...without('Cookie'), Authorization: 'Bearer x' },
          'POST',
        )
      ).status,
    ).toBe(401);
    expect(calls).toEqual([]);
    const ok = await send(h.port, APP_UPDATE_INSTALL_PATH, good, 'POST');
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ state: 'downloading', install: 'npx' });
    expect(calls).toEqual(['install']);
  });

  it('a server with no desk: 501 not_available', async () => {
    const h = await harness();
    const res = await send(h.port, APP_UPDATE_PATH, {
      Cookie: h.cookie,
      'X-AgentLink-CSRF': h.csrf,
    });
    expect(res.status).toBe(501);
  });
});
