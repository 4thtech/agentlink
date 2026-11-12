// UX1113-R1 (D-147; 04 §2.3.3 "Restore in the app"; 08 §1): the restore routes are their own route
// kind, behind the session, CSRF, Host, Origin and fetch-metadata gate of every /api/ui/ route, run
// by the server's restore gate (never a page handler), with fixed answers only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeBase64url, encodeUtf8 } from '@4thtech-io/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startApprovalServerWith, type ApprovalServer } from '../approval-server.js';
import { ownerWorld, send, type OwnerWorld } from '../approval-ui.fixture.js';
import { TEST_APP } from '../local-ui-app.fixture.js';
import { KeychainOwnerKeyStore } from '../owner-keystore.js';
import type { KeychainBackend } from '../keychain.js';
import { MemoryKeychain } from '../recovery-kit-restore.fixture.js';
import { RESTORE_PATHS, restoreRoutes } from './api/restore.js';
import { LocalUiRouteRegistry, createLocalUiRoutes } from './routes.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

let world: OwnerWorld;
beforeAll(async () => {
  world = await ownerWorld('agentlink-r1-restore-');
});
afterAll(() => {
  world.cleanup();
});
const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

let homes = 0;
async function harness(over: { keychain?: KeychainBackend } = {}) {
  homes += 1;
  const home = join(world.root, `home-${String(homes)}`);
  mkdirSync(join(home, 'Downloads'), { recursive: true });
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
    },
    {
      keychain: over.keychain ?? world.keychain,
      openOwnerStore: (expected) => KeychainOwnerKeyStore.open(world.keychain, expected),
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      restore: { home, kdf: KDF },
    },
  );
  servers.push(server);
  await server.open();
  const token = new URL(opened[0] ?? '').searchParams.get('t') ?? '';
  const login = await send(server.port, `/?t=${token}`);
  const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const page = await send(server.port, '/', { headers: { Cookie: cookie } });
  const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1] ?? '';
  const headers = (over: Record<string, string> = {}) => ({
    Cookie: cookie,
    Origin: server.origin,
    'X-AgentLink-CSRF': csrf,
    'Content-Type': 'application/octet-stream',
    'Sec-Fetch-Site': 'same-origin',
    ...over,
  });
  return { server, home, headers, cookie, csrf };
}

const input = (value: unknown): string => encodeBase64url(encodeUtf8(JSON.stringify(value)));

describe('restore route registration (I-4)', () => {
  it('every restore route is the restore kind at its fixed path, registered once', () => {
    const routes = createLocalUiRoutes().routes();
    const restore = routes.filter((r) => r.presence === 'restore');
    expect(restore.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [
        'GET /api/ui/restore/found',
        'POST /api/ui/restore/upload',
        'POST /api/ui/restore/header',
        'POST /api/ui/restore/presence',
        'POST /api/ui/restore/open',
        'POST /api/ui/restore/check',
        'POST /api/ui/restore/cancel',
        'POST /api/ui/restore/apply/begin',
        'POST /api/ui/restore/apply/finish',
      ].sort(),
    );
    expect(Object.values(RESTORE_PATHS)).toHaveLength(9);
    const registry = new LocalUiRouteRegistry();
    for (const route of restoreRoutes) registry.register(route);
    expect(() => registry.register(restoreRoutes[0] as never)).toThrow();
    expect(() =>
      new LocalUiRouteRegistry().register({
        method: 'POST',
        path: '/api/ui/restore/other',
        presence: 'restore',
        step: 'open',
      } as never),
    ).toThrow();
    expect(() =>
      new LocalUiRouteRegistry().register({
        method: 'GET',
        path: RESTORE_PATHS.open,
        presence: 'restore',
        step: 'open',
      } as never),
    ).toThrow();
  });
});

describe('the restore gate (08 §1; T-3, T-6)', () => {
  it('needs the session and CSRF; Origin and fetch metadata on writes; fixed answers', async () => {
    const h = await harness();
    const port = h.server.port;
    expect((await send(port, RESTORE_PATHS.found)).status).toBe(401);
    const found = await send(port, RESTORE_PATHS.found, {
      headers: { Cookie: h.cookie, 'X-AgentLink-CSRF': h.csrf, 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(found.status).toBe(200);
    expect(JSON.parse(found.body)).toEqual({ kits: [] });
    const noCsrf = await send(port, RESTORE_PATHS.header, {
      method: 'POST',
      headers: h.headers({
        'X-AgentLink-CSRF': 'x',
        'X-AgentLink-Input': input({ handle: 'a'.repeat(22) }),
      }),
    });
    expect(noCsrf.status).toBe(403);
    const cross = await send(port, RESTORE_PATHS.header, {
      method: 'POST',
      headers: h.headers({
        'Sec-Fetch-Site': 'cross-site',
        'X-AgentLink-Input': input({ handle: 'a'.repeat(22) }),
      }),
    });
    expect(cross.status).toBe(403);
    const unknown = await send(port, RESTORE_PATHS.header, {
      method: 'POST',
      headers: h.headers({ 'X-AgentLink-Input': input({ handle: 'a'.repeat(22) }) }),
    });
    expect(unknown.status).toBe(410);
    expect(JSON.parse(unknown.body)).toEqual({ error: 'expired' });
    const query = await send(port, `${RESTORE_PATHS.header}?handle=x`, {
      method: 'POST',
      headers: h.headers({ 'X-AgentLink-Input': input({ handle: 'a'.repeat(22) }) }),
    });
    expect(query.status).toBe(400);
    // The code in the body never comes back, whatever the answer.
    const secret = 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ';
    const open = await send(port, RESTORE_PATHS.open, {
      method: 'POST',
      headers: h.headers({ 'X-AgentLink-Input': input({ handle: 'a'.repeat(22) }) }),
      body: encodeUtf8(secret),
    });
    expect(open.body).not.toContain(secret);
    expect(JSON.parse(open.body)).toEqual({ error: 'expired' });
  });

  it('uploads stream into the restore folder and answer a handle; the header step reads it', async () => {
    const h = await harness();
    const up = await send(h.server.port, RESTORE_PATHS.upload, {
      method: 'POST',
      headers: h.headers(),
      body: encodeUtf8('not a kit at all'),
    });
    expect(up.status).toBe(200);
    const handle = (JSON.parse(up.body) as { handle: string }).handle;
    const header = await send(h.server.port, RESTORE_PATHS.header, {
      method: 'POST',
      headers: h.headers({ 'X-AgentLink-Input': input({ handle }) }),
    });
    expect(JSON.parse(header.body)).toEqual({ header: 'not_a_kit', ownerPresent: true });
  });
});

describe('first run waits for an unfinished restore (T-7; IR Low)', () => {
  it('the owner setup step answers 409 finish_restore while restored IDs wait for their owner', async () => {
    const h = await harness({ keychain: new MemoryKeychain() });
    mkdirSync(join(h.home, '.agentlink'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(h.home, '.agentlink', 'restore-pending.json'),
      `${JSON.stringify({ v: 1, ownerNostr: 'ab'.repeat(32) })}\n`,
      { mode: 0o600 },
    );
    const res = await send(h.server.port, '/api/ui/first-run/owner/begin', {
      method: 'POST',
      headers: h.headers({ 'X-AgentLink-Input': input({}) }),
    });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ status: 'finish_restore' });
  });
});
