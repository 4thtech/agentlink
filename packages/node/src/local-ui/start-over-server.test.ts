// OWNER-START-OVER (D-153; 04 §2.5.4; 08 §1; I-4): the start-over routes are their own route kind,
// behind the session, CSRF, Host, Origin and fetch-metadata gate of every /api/ui/ route, run by the
// server's start-over gate (never a page handler), with fixed answers only. Nothing an AI app holds
// reaches them: no MCP tool, no handoff token and no agent credential is a session; the engine is not
// exported from the package entry (the 04 §8.1 fence), and no MCP tool module names the paths.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_PRESENCE_MACOS, encodeBase64url, encodeUtf8 } from '@4thtech-io/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startApprovalServerWith, type ApprovalServer } from '../approval-server.js';
import { ownerWorld, send, type OwnerWorld } from '../approval-ui.fixture.js';
import { TEST_APP } from '../local-ui-app.fixture.js';
import { StandInHelper } from '../owner-native.fixture.js';
import { MemoryKeychain } from '../recovery-kit-restore.fixture.js';
import * as entry from '../index.js';
import type { AgentDirectory } from './app-host.js';
import { START_OVER_PATHS, startOverRoutes } from './api/start-over.js';
import { LocalUiRouteRegistry, createLocalUiRoutes } from './routes.js';

let world: OwnerWorld;
beforeAll(async () => {
  world = await ownerWorld('agentlink-start-over-server-');
});
afterAll(() => {
  world.cleanup();
});
const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const AGENT = `0x${'d'.repeat(40)}`;
const input = (value: unknown): string => encodeBase64url(encodeUtf8(JSON.stringify(value)));

/** An app host with no ID open (the directory lists none). */
const emptyDirectory = {
  list: () => Promise.resolve([]),
  read: () => Promise.resolve(undefined),
  stats: () => Promise.resolve(undefined),
  readCurrent: () => Promise.resolve(undefined),
  writeCurrent: () => Promise.resolve(),
  create: () => Promise.reject(new Error('unused')),
} as unknown as AgentDirectory;

let homes = 0;
async function harness(over: { host?: boolean } = {}) {
  homes += 1;
  const home = join(world.root, `home-${String(homes)}`);
  mkdirSync(join(home, '.agentlink', 'agents', 'default'), { recursive: true });
  writeFileSync(
    join(home, '.agentlink', 'agents', 'default', 'config.json'),
    JSON.stringify({ agentId: AGENT }),
  );
  const keychain = new MemoryKeychain();
  keychain.items.set('owner', new Uint8Array(32).fill(1));
  keychain.items.set(AGENT, new Uint8Array(32).fill(2));
  keychain.items.set('someone-else', new Uint8Array(32).fill(3));
  const native = new StandInHelper(NATIVE_PRESENCE_MACOS);
  const opened: string[] = [];
  const server = await startApprovalServerWith(
    {
      source: {
        context: () => Promise.resolve({ agent: world.agentId, owner: world.owner }),
        list: () => Promise.resolve([]),
        get: () => Promise.resolve(undefined),
        apply: () => Promise.reject(new Error('unused')),
      },
      localUi: { assets: TEST_APP },
      nativePresence: native,
      ...(over.host === false
        ? {}
        : { host: { directory: emptyDirectory, open: () => Promise.resolve(undefined) } }),
    },
    {
      keychain,
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      restore: { home },
    },
  );
  servers.push(server);
  await server.open();
  const token = new URL(opened[0] ?? '').searchParams.get('t') ?? '';
  const login = await send(server.port, `/?t=${token}`);
  const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const page = await send(server.port, '/', { headers: { Cookie: cookie } });
  const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1] ?? '';
  const headers = (extra: Record<string, string> = {}) => ({
    Cookie: cookie,
    Origin: server.origin,
    'X-AgentLink-CSRF': csrf,
    'Content-Type': 'application/octet-stream',
    'Sec-Fetch-Site': 'same-origin',
    ...extra,
  });
  return { server, home, keychain, native, headers, cookie, csrf };
}

/** The generation the page is built against now (a start over opens a new one). */
async function generationOf(h: { server: ApprovalServer; cookie: string }): Promise<string> {
  const page = await send(h.server.port, '/', { headers: { Cookie: h.cookie } });
  return /<meta name="agentlink-generation" content="([0-9]+)">/.exec(page.body)?.[1] ?? '';
}

describe('start-over route registration (I-4)', () => {
  it('three fixed paths of their own kind, no handler, registered once', () => {
    const routes = createLocalUiRoutes().routes();
    const own = routes.filter((r) => r.presence === 'start-over');
    expect(own.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [
        'GET /api/ui/start-over/state',
        'POST /api/ui/start-over/begin',
        'POST /api/ui/start-over/finish',
      ].sort(),
    );
    expect(own.every((r) => !('handler' in r))).toBe(true);
    const registry = new LocalUiRouteRegistry();
    for (const route of startOverRoutes) registry.register(route);
    expect(() => registry.register(startOverRoutes[0] as never)).toThrow();
    expect(() =>
      new LocalUiRouteRegistry().register({
        method: 'POST',
        path: '/api/ui/start-over/other',
        presence: 'start-over',
        step: 'begin',
      } as never),
    ).toThrow();
    expect(() =>
      new LocalUiRouteRegistry().register({
        method: 'GET',
        path: START_OVER_PATHS.finish,
        presence: 'start-over',
        step: 'finish',
      } as never),
    ).toThrow();
  });

  it('the engine is not reachable from the package entry, and no MCP tool names the routes', () => {
    expect(Object.keys(entry).filter((k) => /start.?over/i.test(k))).toEqual([]);
    const here = dirname(fileURLToPath(import.meta.url));
    const tools = join(here, '..', '..', '..', 'mcp-tools', 'src');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)],
      );
    const files = walk(tools).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('start-over');
      expect(text).not.toMatch(/startOver/i);
    }
  });
});

describe('the start-over gate (08 §1; I-4)', () => {
  it('refuses a caller without the page session: an agent credential or no cookie', async () => {
    const h = await harness();
    const port = h.server.port;
    expect((await send(port, START_OVER_PATHS.state)).status).toBe(401);
    const bearer = await send(port, START_OVER_PATHS.begin, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer agent-token',
        Origin: h.server.origin,
        'X-AgentLink-CSRF': h.csrf,
        'Content-Type': 'application/octet-stream',
        'X-AgentLink-Input': input({ phrase: 'start over' }),
      },
    });
    expect(bearer.status).toBe(401);
    const noCsrf = await send(port, START_OVER_PATHS.begin, {
      method: 'POST',
      headers: h.headers({
        'X-AgentLink-CSRF': 'x',
        'X-AgentLink-Input': input({ phrase: 'start over' }),
      }),
    });
    expect(noCsrf.status).toBe(403);
    const noOrigin: Record<string, string> = h.headers({
      'X-AgentLink-Input': input({ phrase: 'start over' }),
    });
    Reflect.deleteProperty(noOrigin, 'Origin');
    expect(
      (await send(port, START_OVER_PATHS.begin, { method: 'POST', headers: noOrigin })).status,
    ).toBe(403);
    const cross = await send(port, START_OVER_PATHS.begin, {
      method: 'POST',
      headers: h.headers({
        'Sec-Fetch-Site': 'cross-site',
        'X-AgentLink-Input': input({ phrase: 'start over' }),
      }),
    });
    expect(cross.status).toBe(403);
    const query = await send(port, `${START_OVER_PATHS.begin}?phrase=start%20over`, {
      method: 'POST',
      headers: h.headers({ 'X-AgentLink-Input': input({ phrase: 'start over' }) }),
    });
    expect(query.status).toBe(400);
    // Nothing moved, nothing erased.
    expect(existsSync(join(h.home, '.agentlink'))).toBe(true);
    expect(h.keychain.items.has('owner')).toBe(true);
    expect(h.native.calls).toEqual([]);
  });

  it('needs the phrase and the gesture; then moves the folder and erases our items only', async () => {
    const h = await harness();
    const port = h.server.port;
    const state = await send(port, START_OVER_PATHS.state, {
      headers: { Cookie: h.cookie, 'X-AgentLink-CSRF': h.csrf, 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(JSON.parse(state.body)).toMatchObject({ presence: 'native', unfinished: false });
    const wrong = await send(port, START_OVER_PATHS.begin, {
      method: 'POST',
      headers: h.headers({ 'X-AgentLink-Input': input({ phrase: 'yes' }) }),
    });
    expect(wrong.status).toBe(400);
    expect(JSON.parse(wrong.body)).toEqual({ error: 'phrase' });
    const begun = await send(port, START_OVER_PATHS.begin, {
      method: 'POST',
      headers: h.headers({ 'X-AgentLink-Input': input({ phrase: 'start over' }) }),
    });
    expect(begun.status).toBe(200);
    const { nonce } = JSON.parse(begun.body) as { nonce: string };
    // No presence header: refused, and the nonce is spent.
    const bare = await send(port, START_OVER_PATHS.finish, {
      method: 'POST',
      headers: h.headers({ 'X-AgentLink-Input': input({ nonce }) }),
    });
    expect(bare.status).toBe(400);
    expect(existsSync(join(h.home, '.agentlink'))).toBe(true);
    const again = JSON.parse(
      (
        await send(port, START_OVER_PATHS.begin, {
          method: 'POST',
          headers: h.headers({ 'X-AgentLink-Input': input({ phrase: 'start over' }) }),
        })
      ).body,
    ) as { nonce: string };
    const done = await send(port, START_OVER_PATHS.finish, {
      method: 'POST',
      headers: h.headers({
        'X-AgentLink-Input': input({ nonce: again.nonce }),
        'X-AgentLink-Presence': 'native',
      }),
    });
    expect(done.status).toBe(200);
    expect(JSON.parse(done.body)).toMatchObject({ status: 'done' });
    expect(h.native.calls).toEqual(['create@0', 'release:reset@0']);
    expect(existsSync(join(h.home, '.agentlink'))).toBe(false);
    const backups = readdirSync(h.home).filter((n) => n.startsWith('.agentlink.backup-'));
    expect(backups).toHaveLength(1);
    expect(existsSync(join(h.home, backups[0] as string, 'agents', 'default', 'config.json'))).toBe(
      true,
    );
    expect([...h.keychain.items.keys()]).toEqual(['someone-else']);
    // The host started with no first run of its own; now, with no ID left, it offers first run.
    const firstRun = await send(port, '/api/ui/first-run/owner/begin', {
      method: 'POST',
      headers: h.headers({ 'X-AgentLink-Generation': await generationOf(h) }),
    });
    expect(firstRun.status).toBe(200);
  });

  it('without Touch ID: the phrase typed twice, server-checked both times; no session, no start over', async () => {
    const h = await harness();
    h.native.unavailable = 'not_set_up';
    const port = h.server.port;
    const begin = async () =>
      JSON.parse(
        (
          await send(port, START_OVER_PATHS.begin, {
            method: 'POST',
            headers: h.headers({ 'X-AgentLink-Input': input({ phrase: 'start over' }) }),
          })
        ).body,
      ) as { presence: string; nonce: string };
    const first = await begin();
    expect(first.presence).toBe('typed');
    // An agent credential instead of the session: refused before anything runs.
    const agent = await send(port, START_OVER_PATHS.finish, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer agent-token',
        Origin: h.server.origin,
        'Content-Type': 'application/octet-stream',
        'X-AgentLink-Presence': 'typed',
        'X-AgentLink-Input': input({ nonce: first.nonce, phrase: 'start over' }),
      },
    });
    expect(agent.status).toBe(401);
    // The second typing missing: refused.
    const missing = await send(port, START_OVER_PATHS.finish, {
      method: 'POST',
      headers: h.headers({
        'X-AgentLink-Presence': 'typed',
        'X-AgentLink-Input': input({ nonce: first.nonce }),
      }),
    });
    expect(JSON.parse(missing.body)).toEqual({ error: 'phrase' });
    expect(existsSync(join(h.home, '.agentlink'))).toBe(true);
    const second = await begin();
    const done = await send(port, START_OVER_PATHS.finish, {
      method: 'POST',
      headers: h.headers({
        'X-AgentLink-Presence': 'typed',
        'X-AgentLink-Input': input({ nonce: second.nonce, phrase: 'start over' }),
      }),
    });
    expect(JSON.parse(done.body)).toMatchObject({ status: 'done' });
    expect(h.native.calls).toEqual([]);
    expect(existsSync(join(h.home, '.agentlink'))).toBe(false);
  });

  it('first run is not offered by a host that did not start over', async () => {
    const h = await harness();
    const firstRun = await send(h.server.port, '/api/ui/first-run/owner/begin', {
      method: 'POST',
      headers: h.headers({ 'X-AgentLink-Generation': await generationOf(h) }),
    });
    expect(firstRun.status).toBe(503);
  });

  it('is not offered on a server that is not the app (the ID is open in another process)', async () => {
    const h = await harness({ host: false });
    const begun = await send(h.server.port, START_OVER_PATHS.begin, {
      method: 'POST',
      headers: h.headers({ 'X-AgentLink-Input': input({ phrase: 'start over' }) }),
    });
    expect(begun.status).toBe(409);
    expect(JSON.parse(begun.body)).toEqual({ error: 'open_app' });
    expect(existsSync(join(h.home, '.agentlink'))).toBe(true);
  });
});
