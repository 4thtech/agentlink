// UX1113-R1 (D-147; 04 §2.3.3 "Restore in the app"; 08 §1): the restore routes are their own route
// kind, behind the session, CSRF, Host, Origin and fetch-metadata gate of every /api/ui/ route, run
// by the server's restore gate (never a page handler), with fixed answers only.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeBase64url, encodeUtf8 } from '@4thtech-io/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startApprovalServerWith, type ApprovalServer } from '../approval-server.js';
import { ownerWorld, send, type OwnerWorld } from '../approval-ui.fixture.js';
import { TEST_APP } from '../local-ui-app.fixture.js';
import { KeychainOwnerKeyStore } from '../owner-keystore.js';
import type { KeychainBackend } from '../keychain.js';
import { newWebauthnTestCredential } from '@4thtech-io/crypto/testing';
import { VirtualPrfAuthenticator } from '../passkey-authenticator.fixture.js';
import {
  MemoryKeychain,
  makeAgent,
  makeKit,
  makeOwner,
  webauthnCreate,
} from '../recovery-kit-restore.fixture.js';
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
async function harness(
  over: {
    keychain?: KeychainBackend;
    keychainTimeoutMs?: number;
    before?: (home: string) => void;
    /** REL051-CF3: the same home again (a restart). */
    home?: string;
  } = {},
) {
  homes += 1;
  const home = over.home ?? join(world.root, `home-${String(homes)}`);
  mkdirSync(join(home, 'Downloads'), { recursive: true });
  over.before?.(home);
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
      restore: {
        home,
        kdf: KDF,
        ...(over.keychainTimeoutMs === undefined
          ? {}
          : { keychainTimeoutMs: over.keychainTimeoutMs }),
      },
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
        // REL051-CF3: the master code a restore or first run showed once, again after a reload.
        'POST /api/ui/master-code/show',
        'POST /api/ui/master-code/saved',
      ].sort(),
    );
    expect(Object.values(RESTORE_PATHS)).toHaveLength(11);
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

describe('first run fails closed on a keychain that does not answer (T-1)', () => {
  it('holds owner setup with keychain_unavailable and creates nothing; proceeds once it answers', async () => {
    let hang = true;
    const real = new MemoryKeychain();
    const keychain: KeychainBackend = {
      get: (account) => (hang ? new Promise(() => undefined) : real.get(account)),
      set: (account, value) => real.set(account, value),
      delete: (account) => real.delete(account),
    };
    const h = await harness({ keychain, keychainTimeoutMs: 50 });
    const begin = () =>
      send(h.server.port, '/api/ui/first-run/owner/begin', {
        method: 'POST',
        headers: h.headers({ 'X-AgentLink-Input': input({}) }),
      });
    const held = await begin();
    expect(held.status).toBe(409);
    expect(JSON.parse(held.body)).toEqual({ status: 'keychain_unavailable' });
    expect([...real.items.keys()]).toEqual([]);
    hang = false;
    const retried = await begin();
    expect(JSON.parse(retried.body)).not.toEqual({ status: 'keychain_unavailable' });
    expect(JSON.parse(retried.body)).not.toEqual({ status: 'finish_restore' });
  });
});

describe('stale restore files go when the server starts (T-7; R1-SEC-08)', () => {
  it('an upload and a quarantined store a crashed run left are removed at start-up', async () => {
    const h = await harness({
      before: (home) => {
        const dir = join(home, '.agentlink', 'restore');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, '.upload-0123456789abcdef.alkk'), 'x');
        writeFileSync(join(dir, '.restore-0123456789abcdef.sqlite'), 'x');
      },
    });
    const dir = join(h.home, '.agentlink', 'restore');
    // No restore request was made: only start-up can have removed them.
    for (let i = 0; i < 50 && readdirSync(dir).length > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(readdirSync(dir)).toEqual([]);
  });
});

// REL051-CF3 (R1-CLASS-03, R1-UI-02; 04 §2.3.3 T-12): a reload on restore step 4 ("Your new master
// code for this computer") shows the same code and outcome again, for this page session only, until
// "I saved it"; after a restart the page is told the code was not saved, never asked for it.
describe('REL051-CF3: restore step 4 survives a reload', () => {
  const SHOW = '/api/ui/master-code/show';
  const SAVED = '/api/ui/master-code/saved';

  async function restored(keychain: MemoryKeychain, home?: string) {
    const h = await harness({ keychain, ...(home === undefined ? {} : { home }) });
    const owner = await makeOwner();
    const a1 = await makeAgent(world.root, owner, 'alpha');
    const kit = await makeKit(
      world.root,
      owner,
      [a1],
      'agentlink-recovery-kit-a.alkk',
      join(h.home, 'Downloads'),
    );
    const call = async (path: string, value?: unknown, body?: Uint8Array) => {
      const res = await send(h.server.port, path, {
        method: 'POST',
        headers: h.headers(value === undefined ? {} : { 'X-AgentLink-Input': input(value) }),
        ...(body === undefined ? {} : { body }),
      });
      return { status: res.status, json: JSON.parse(res.body) as Record<string, unknown> };
    };
    const found = await send(h.server.port, RESTORE_PATHS.found, {
      headers: { Cookie: h.cookie, 'X-AgentLink-CSRF': h.csrf, 'Sec-Fetch-Site': 'same-origin' },
    });
    const handle = (JSON.parse(found.body) as { kits: { handle: string }[] }).kits[0]?.handle;
    expect((await call(RESTORE_PATHS.header, { handle })).json['header']).toBe('ok');
    const opened = await call(RESTORE_PATHS.open, { handle }, encodeUtf8(kit.code));
    const begun = await call(RESTORE_PATHS.applyBegin, {
      kit: opened.json['kit'],
      selection: [a1.agentId],
      names: {},
    });
    const pk = begun.json['publicKey'] as { challenge: string; userId: string; prfSalt: string };
    const auth = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
    const done = await call(
      RESTORE_PATHS.applyFinish,
      { nonce: begun.json['nonce'] },
      webauthnCreate(auth, pk, h.server.origin),
    );
    expect(done.json['status']).toBe('done');
    return { h, call, done: done.json };
  }

  it('the same page session gets the same code and outcome back; another never does', async () => {
    const keychain = new MemoryKeychain();
    const { h, call, done } = await restored(keychain);
    const again = await call(SHOW);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({
      status: 'shown',
      kind: 'restore',
      code: done['masterCode'],
      touchId: true,
      ids: done['ids'],
    });
    const other = await send(h.server.port, SHOW, {
      method: 'POST',
      headers: h.headers({ Cookie: 'agentlink_session=other' }),
    });
    expect(other.body).not.toContain(String(done['masterCode']));
    expect((await call(SAVED)).status).toBe(200);
    expect((await call(SHOW)).json).toEqual({ status: 'none' });
  }, 60_000);

  it('after a restart the page is told the code was never saved, with Touch ID to replace it', async () => {
    const keychain = new MemoryKeychain();
    const { h, done } = await restored(keychain);
    await h.server.close();
    const next = await harness({ keychain, home: h.home });
    const lost = await send(next.server.port, SHOW, { method: 'POST', headers: next.headers() });
    expect(JSON.parse(lost.body)).toEqual({ status: 'lost', kind: 'restore', touchId: true });
    expect(lost.body).not.toContain(String(done['masterCode']));
  }, 60_000);
});
