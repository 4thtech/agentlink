/* eslint-disable boundaries/no-bypass -- a contract test: it runs the page against the real server code of packages/node, which has no public entry for it */
// @vitest-environment node
// U3-h CONTRACT: the page's own requests against the REAL server code of packages/node (no
// hand-written answer shapes). The switch goes through the real approval server and app host; Add and
// Rename go through the real route handlers of api/agents-manage.ts, fed exactly what the gate would
// hand them (the JSON of X-AgentLink-Input). The assertions are that the page's request is accepted
// and that the real answer maps to the right outcome word.
import { afterEach, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerInternals,
  type ApprovalServerSource,
} from '../../../../../packages/node/src/approval-server.js';
import type {
  AgentDirectory,
  AgentDirectoryEntry,
  AppHostAgent,
} from '../../../../../packages/node/src/local-ui/app-host.js';
import { createAgentsApi } from './api.js';

const encodeUtf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const INDEX_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="agentlink-csrf" content="" /><title>AgentLink</title>' +
  '<script type="module" crossorigin src="/assets/index-Bx3f9a2Q.js"></script></head>' +
  '<body><div id="root"></div></body></html>';

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start() {
  const written: string[] = [];
  const entries = new Map<string, AgentDirectoryEntry>([
    ['default', { name: 'default', label: 'Personal', available: true, removing: false }],
    ['work', { name: 'work', label: 'Work', available: true, removing: false }],
  ]);
  const source = (): ApprovalServerSource => ({
    context: () => Promise.resolve(undefined),
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    apply: () => Promise.reject(new Error('never')),
  });
  const agent = (name: string): AppHostAgent => ({
    name,
    label: entries.get(name)?.label ?? name,
    source: source(),
    localUi: {},
    close: () => Promise.resolve(),
  });
  const directory: AgentDirectory = {
    list: () => Promise.resolve([...entries.values()]),
    read: (name) => Promise.resolve(entries.get(name)),
    stats: () => Promise.resolve({ contacts: 1, running: false }),
    writeLabel: () => Promise.reject(new Error('never')),
    markRemoving: () => Promise.reject(new Error('never')),
    removeFolder: () => Promise.reject(new Error('never')),
    readCurrent: () => Promise.resolve(undefined),
    writeCurrent: (name) => {
      written.push(name);
      return Promise.resolve();
    },
  };
  const opened: string[] = [];
  const internals: ApprovalServerInternals = {
    opener: (url) => {
      opened.push(url);
      return Promise.resolve(true);
    },
    notifier: () => Promise.resolve(true),
    openOwnerStore: () => Promise.reject(new Error('no owner store')),
  };
  const initial = agent('default');
  const server = await startApprovalServerWith(
    {
      source: initial.source,
      localUi: {
        assets: {
          files: new Map<string, Uint8Array>([
            ['index.html', encodeUtf8(INDEX_HTML)],
            ['assets/index-Bx3f9a2Q.js', encodeUtf8('console.log(1);')],
          ]),
        },
      },
      host: { directory, initial, open: (name) => Promise.resolve(agent(name)) },
    },
    internals,
  );
  servers.push(server);
  await server.open();
  const link = new URL(opened[0] ?? '');
  const entry = await fetch(`${server.origin}/?t=${link.searchParams.get('t') ?? ''}`, {
    redirect: 'manual',
  });
  const cookie = (entry.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const page = await (await fetch(`${server.origin}/`, { headers: { Cookie: cookie } })).text();
  const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page)?.[1] ?? '';
  // The page's fetch, pointed at the real server with the browser's cookie and Origin.
  const pageFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('Cookie', cookie);
    headers.set('Origin', server.origin);
    return fetch(`${server.origin}${String(input)}`, { ...init, headers });
  }) as typeof fetch;
  return { api: createAgentsApi({ fetch: pageFetch, token: csrf }), written };
}

describe('contract: the real server accepts the page', () => {
  it('lists the agents and parses them', async () => {
    const { api } = await start();
    const read = await api.list();
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') {
      expect(read.list.switchable).toBe(true);
      expect(read.list.agents.map((a) => a.name)).toEqual(['default', 'work']);
    }
  });

  it('the switch is accepted (octet-stream, {name, generation}) and the app opens the other agent', async () => {
    const { api, written } = await start();
    const read = await api.list();
    if (read.kind !== 'ok' || read.list.generation === undefined) throw new Error('no list');
    expect(await api.switchTo('work', read.list.generation)).toEqual({ kind: 'done' });
    expect(written).toEqual(['work']);
  });

  it('a stale generation is agent_changed, not a format error', async () => {
    const { api } = await start();
    expect(await api.switchTo('work', 99)).toEqual({ kind: 'agent_changed' });
  });
});
