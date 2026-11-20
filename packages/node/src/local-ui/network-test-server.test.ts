// NET-PRECHECK (08 §1 `POST /api/ui/network/test`; 04 §2.5, §4; I-4): the server Test's gate. The
// same session cookie, CSRF header, exact Host, Origin, fetch-metadata and octet-stream checks as
// every /api/ui/ write; no query, operation input or presence header; no owner presence, because it
// changes nothing and signs nothing with an ID key (no key is even read). Not an MCP tool. A stub
// resolver and an in-memory connector stand in for DNS and relays: no network.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OwnerActionOutcome } from '@4thtech-io/core';
import { encodeUtf8 } from '@4thtech-io/crypto';
import type {
  HostResolver,
  RelayConnector,
  RelaySocket,
  RelaySocketHandlers,
  RelayTarget,
} from '@4thtech-io/transport-nostr';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerSource,
} from '../approval-server.js';
import { ownerWorld, send, type OwnerWorld } from '../approval-ui.fixture.js';
import { KeychainKeyStore } from '../keychain-keystore.js';
import { KeychainOwnerKeyStore } from '../owner-keystore.js';
import type { LocalUiAssets } from './context.js';
import { LocalUiRouteRegistry } from './routes.js';
import { NETWORK_TEST_PATH, createNetworkTestRoute } from './api/network-test.js';

let world: OwnerWorld;
beforeAll(async () => {
  world = await ownerWorld('agentlink-net-test-');
}, 60_000);
afterAll(() => world.cleanup());

const INDEX_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="agentlink-csrf" content="" /><title>AgentLink</title></head>' +
  '<body><div id="root"></div></body></html>';

const servers: ApprovalServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** An in-memory relay that stores EVENTs and serves them by id: enough for `ready`. */
function memoryRelays(): {
  connector: RelayConnector;
  frames: unknown[][];
  targets: RelayTarget[];
} {
  const stored: { id: string }[] = [];
  const frames: unknown[][] = [];
  const targets: RelayTarget[] = [];
  const connector: RelayConnector = {
    open(target: RelayTarget, handlers: RelaySocketHandlers): RelaySocket {
      targets.push(target);
      let closed = false;
      const push = (frame: unknown[]): void => {
        queueMicrotask(() => {
          if (!closed) handlers.onMessage(JSON.stringify(frame));
        });
      };
      queueMicrotask(() => {
        if (!closed) handlers.onOpen();
      });
      return {
        send(text: string) {
          const frame = JSON.parse(text) as unknown[];
          frames.push(frame);
          if (frame[0] === 'EVENT') {
            const event = frame[1] as { id: string };
            stored.push(event);
            push(['OK', event.id, true, '']);
          } else if (frame[0] === 'REQ') {
            const ids = (frame[2] as { ids?: string[] }).ids ?? [];
            for (const event of stored)
              if (ids.includes(event.id)) push(['EVENT', frame[1], event]);
            push(['EOSE', frame[1]]);
          }
        },
        close() {
          closed = true;
        },
      };
    },
  };
  return { connector, frames, targets };
}

async function harness() {
  const resolves: string[] = [];
  const resolver: HostResolver = {
    resolve: (host) => {
      resolves.push(host);
      return Promise.resolve(['93.184.215.30']);
    },
  };
  const relays = memoryRelays();
  const routes = new LocalUiRouteRegistry();
  routes.register(createNetworkTestRoute(() => ({ resolver, connector: relays.connector })));
  const source: ApprovalServerSource = {
    context: () => Promise.resolve({ agent: world.agentId, owner: world.owner }),
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    apply: () => Promise.resolve({ status: 'refused', op: 'x' } as unknown as OwnerActionOutcome),
  };
  const opened: string[] = [];
  const server = await startApprovalServerWith(
    {
      source,
      localUi: {
        assets: {
          files: new Map([['index.html', encodeUtf8(INDEX_HTML)]]),
        } satisfies LocalUiAssets,
      },
    },
    {
      keychain: world.keychain,
      openOwnerStore: (expected) => KeychainOwnerKeyStore.open(world.keychain, expected),
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      routes,
    },
  );
  servers.push(server);
  const port = server.port;
  await server.open();
  const token = new URL(opened[0] ?? '').searchParams.get('t') ?? '';
  const login = await send(port, `/?t=${token}`);
  const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const page = await send(port, '/', { headers: { Cookie: cookie } });
  const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1] ?? '';
  const post = (
    p: string,
    body: Uint8Array,
    extra: Record<string, string> = {},
    omit: readonly string[] = [],
  ) => {
    const headers: Record<string, string> = {
      Cookie: cookie,
      Origin: server.origin,
      'X-AgentLink-CSRF': csrf,
      'Content-Type': 'application/octet-stream',
      'Sec-Fetch-Site': 'same-origin',
      'Content-Length': String(body.length),
      ...extra,
    };
    for (const name of omit) Reflect.deleteProperty(headers, name);
    return send(port, p, { method: 'POST', headers, body });
  };
  return { post, resolves, relays, port, cookie };
}

const json = (value: unknown): Uint8Array => encodeUtf8(JSON.stringify(value));
const SERVERS = { servers: ['wss://relay-a.nostr-test.dev'] };

describe('NET-PRECHECK: the network test gate', () => {
  it('answers the outcomes behind the page session, with no presence and no ID key read', async () => {
    const h = await harness();
    const keychainReads = vi.spyOn(world.keychain, 'get');
    const signs = vi.spyOn(KeychainKeyStore.prototype, 'signNostr');
    const res = await h.post(NETWORK_TEST_PATH, json(SERVERS));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      results: [
        {
          host: 'relay-a.nostr-test.dev',
          outcome: 'ready',
          reason: null,
          roundTripMs: expect.any(Number) as number,
        },
      ],
    });
    expect(keychainReads).not.toHaveBeenCalled();
    expect(signs).not.toHaveBeenCalled();
    expect(h.relays.frames.some((f) => f[0] === 'AUTH')).toBe(false);
  });

  it.each([
    ['no CSRF header', {}, ['X-AgentLink-CSRF']],
    ['no session cookie', {}, ['Cookie']],
    ['another Origin', { Origin: 'http://evil.example' }, []],
    ['cross-site fetch', { 'Sec-Fetch-Site': 'cross-site' }, []],
    ['a presence header', { 'X-AgentLink-Presence': 'x' }, []],
    ['an operation input', { 'X-AgentLink-Input': 'e30' }, []],
  ] as const)('refuses %s before anything is resolved', async (_name, extra, omit) => {
    const h = await harness();
    const res = await h.post(NETWORK_TEST_PATH, json(SERVERS), extra, omit);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(h.resolves).toHaveLength(0);
  });

  it('refuses a query, a body over its cap and a body that is not one JSON object', async () => {
    const h = await harness();
    expect((await h.post(`${NETWORK_TEST_PATH}?x=1`, json(SERVERS))).status).toBe(400);
    expect((await h.post(NETWORK_TEST_PATH, new Uint8Array(9000).fill(32))).status).toBe(413);
    expect((await h.post(NETWORK_TEST_PATH, encodeUtf8('[1]'))).status).toBe(400);
    expect((await h.post(NETWORK_TEST_PATH, encodeUtf8('{nope'))).status).toBe(400);
    expect(h.resolves).toHaveLength(0);
  });

  it('a GET is not the test', async () => {
    const h = await harness();
    const res = await send(h.port, NETWORK_TEST_PATH, { headers: { Cookie: h.cookie } });
    expect(res.status).not.toBe(200);
    expect(h.resolves).toHaveLength(0);
  });

  it('is not reachable from MCP (I-4): no MCP source names the path', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const mcpRoot = path.resolve(here, '../../../mcp-tools/src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts')) files.push(full);
      }
    };
    walk(mcpRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(file, 'utf8')).not.toContain('network/test');
  });
});
