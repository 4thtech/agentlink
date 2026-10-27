// M1-11s-b: the local UI route registry (08 §1; 04 §2.5; I-4).
//
// - Every route declares its method, its path under /api/ui/ and `presence`. A mutating method
//   (POST, PUT, PATCH, DELETE) must declare `presence: true`: registration throws otherwise, so no
//   page card can add an owner operation that skips the central presence gate. A GET route never
//   carries presence (it has no body to carry the proof in).
// - Paths are fixed segments and `:name` parameters only; duplicates and paths outside /api/ui/ throw.
// - The default registry holds the page stubs, each answering 501 `not_implemented`.
import { describe, expect, it } from 'vitest';
import type { LocalUiContext } from './context.js';
import type { LocalUiRoute } from './route-types.js';
import {
  LOCAL_UI_API_PREFIX,
  LocalUiRouteRegistry,
  REVEAL_PATH,
  createLocalUiRoutes,
} from './routes.js';

const ok = () => Promise.resolve({ status: 200, body: { ok: true } });
const context = {} as LocalUiContext;

describe('route registration (M1-11s-b, I-4)', () => {
  it('refuses a mutating route that does not declare presence', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const registry = new LocalUiRouteRegistry();
      const route = { method, path: '/api/ui/rules/set', presence: false, handler: ok };
      expect(() => registry.register(route as never), method).toThrow(/presence/);
      expect(registry.routes()).toHaveLength(0);
    }
  });

  it('refuses a GET route that declares presence, and an unknown method', () => {
    const registry = new LocalUiRouteRegistry();
    expect(() =>
      registry.register({ method: 'GET', path: '/api/ui/x', presence: true, handler: ok } as never),
    ).toThrow(/presence/);
    expect(() =>
      registry.register({
        method: 'HEAD',
        path: '/api/ui/x',
        presence: false,
        handler: ok,
      } as never),
    ).toThrow(/method/);
    expect(() =>
      registry.register({ method: 'POST', path: '/api/ui/x', handler: ok } as never),
    ).toThrow(/presence/);
  });

  it('accepts a mutating route with presence and a GET route without it', () => {
    const registry = new LocalUiRouteRegistry();
    registry.register({ method: 'POST', path: '/api/ui/rules/set', presence: true, handler: ok });
    registry.register({ method: 'GET', path: '/api/ui/rules', presence: false, handler: ok });
    expect(registry.routes().map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/ui/rules/set',
      'GET /api/ui/rules',
    ]);
  });

  it('refuses paths outside /api/ui/, malformed segments and duplicates', () => {
    const registry = new LocalUiRouteRegistry();
    expect(LOCAL_UI_API_PREFIX).toBe('/api/ui/');
    for (const path of [
      '/api/approvals',
      '/api/ui',
      '/api/ui/',
      '/api/ui//x',
      '/api/ui/x/',
      '/api/ui/../approvals',
      '/api/ui/a b',
      '/api/ui/%2e',
      '/api/ui/:',
      '/api/ui/:a/:a',
      'api/ui/x',
    ]) {
      expect(
        () => registry.register({ method: 'GET', path, presence: false, handler: ok }),
        path,
      ).toThrow();
    }
    registry.register({
      method: 'GET',
      path: '/api/ui/contacts/:id',
      presence: false,
      handler: ok,
    });
    expect(() =>
      registry.register({
        method: 'GET',
        path: '/api/ui/contacts/:id',
        presence: false,
        handler: ok,
      }),
    ).toThrow(/already/);
  });

  it('matches fixed segments and strict parameters, and tells a wrong method apart', () => {
    const registry = new LocalUiRouteRegistry();
    registry.register({
      method: 'GET',
      path: '/api/ui/contacts/:id',
      presence: false,
      handler: ok,
    });
    registry.register({
      method: 'DELETE',
      path: '/api/ui/contacts/:id',
      presence: true,
      handler: ok,
    });
    const hit = registry.match('GET', '/api/ui/contacts/c_123-AB');
    expect(hit !== undefined && hit !== 'method' ? hit.params : undefined).toEqual({
      id: 'c_123-AB',
    });
    const del = registry.match('DELETE', '/api/ui/contacts/c1');
    expect(del !== undefined && del !== 'method' ? del.route.presence : undefined).toBe(true);
    expect(registry.match('POST', '/api/ui/contacts/c1')).toBe('method');
    for (const path of [
      '/api/ui/contacts',
      '/api/ui/contacts/',
      '/api/ui/contacts/a/b',
      '/api/ui/contacts/%2e%2e',
      '/api/ui/contacts/a.b',
      `/api/ui/contacts/${'a'.repeat(129)}`,
      '/api/ui/other/c1',
      '/api/approvals',
    ]) {
      expect(registry.match('GET', path), path).toBeUndefined();
    }
  });
});

describe('the default registry: one stub per page (M1-11s-b)', () => {
  it('registers every page stub as a read route that answers 501 not_implemented', async () => {
    // A built page's own test covers its routes (files: api/files.test.ts, M1-11c-a3; contacts: api/contacts.test.ts, M1-11c-a2; proofs:
    // api/proofs.test.ts, M1-11c-a4; top-up and withdraw: api/proofs-top-up.test.ts, M1-11c-a4c).
    const built = new Set([
      '/api/ui/rules',
      '/api/ui/rules/review',
      '/api/ui/files',
      '/api/ui/files/review',
      '/api/ui/files/folders',
      // MSG-FILES-IO-d: Files, Received and Sent (api/files-io.test.ts).
      '/api/ui/files/received',
      '/api/ui/files/sent',
      '/api/ui/contacts',
      '/api/ui/contacts/:ref/safety-code',
      '/api/ui/contacts/:ref/rename-check',
      '/api/ui/contacts/:ref/check',
      '/api/ui/contacts/:ref/rename',
      '/api/ui/contacts/:ref/remove',
      '/api/ui/proofs',
      '/api/ui/proofs/credits',
      '/api/ui/proofs/top-up',
      '/api/ui/proofs/withdraw',
      // MSG-FILES-IO-c: the Messages reads (api/messages.test.ts).
      '/api/ui/messages',
      '/api/ui/messages/:contactId',
      // M1-11s-a-d: the status bar's health read (api/health.test.ts).
      '/api/ui/health',
      // MSG-FILES-IO-h: Show in Finder (api/files-io-reveal.test.ts).
      '/api/ui/files/received/reveal',
    ]);
    const registry = createLocalUiRoutes();
    // M1-11b-1: the first-run page has its real status route (api/first-run.test.ts).
    const pages = ['approvals', 'activity', 'storage', 'backup', 'advanced'];
    // M1-11s-c: the first-run page's two owner setup routes are covered in owner-setup-route.test.ts.
    const stubs = registry.routes().filter(
      // M1-PAY-CONFIRM-a: the two paid-action confirmation routes are covered in pay-confirm.test.ts.
      (r) =>
        r.presence !== 'setup' &&
        r.presence !== 'pay-confirm' &&
        r.path !== '/api/ui/first-run' &&
        !built.has(r.path),
    );
    expect(stubs.map((r) => r.path).sort()).toEqual(pages.map((p) => `/api/ui/${p}`).sort());
    for (const route of stubs as readonly LocalUiRoute[]) {
      expect(route.method).toBe('GET');
      expect(route.presence).toBe(false);
      if (route.presence) throw new Error('unreachable');
      // M1-11c-a1 filled the activity page (api/activity.test.ts).
      if (route.path === '/api/ui/activity') continue;
      const result = await route.handler(context, { params: {}, query: new URLSearchParams() });
      expect(result).toEqual({ status: 501, body: { error: 'not_implemented' } });
    }
  });
});

describe('pay-confirm routes (M1-PAY-CONFIRM-a, 04 §2.5.3)', () => {
  const route = (over: Record<string, unknown>) =>
    ({
      method: 'POST',
      path: '/api/ui/pay-confirm/begin',
      presence: 'pay-confirm',
      step: 'begin',
      ...over,
    }) as unknown as LocalUiRoute;

  it('registers begin and finish, run by the server gate (no handler)', () => {
    const steps = createLocalUiRoutes()
      .routes()
      .filter((r) => r.presence === 'pay-confirm')
      .map((r) => `${r.method} ${r.path}`);
    expect(steps).toEqual(['POST /api/ui/pay-confirm/begin', 'POST /api/ui/pay-confirm/finish']);
  });

  it('refuses a handler, another method, another prefix or a repeated step', () => {
    const registry = new LocalUiRouteRegistry();
    expect(() => registry.register(route({ handler: () => undefined }))).toThrow();
    expect(() => registry.register(route({ method: 'GET' }))).toThrow();
    expect(() => registry.register(route({ path: '/api/ui/rules/pay' }))).toThrow();
    expect(() => registry.register(route({ step: 'other' }))).toThrow();
    registry.register(route({}));
    expect(() => registry.register(route({ path: '/api/ui/pay-confirm/again' }))).toThrow();
  });
});

// MSG-FILES-IO-h (D-134): the one route kind with no presence that is not a read. It is a POST for a
// single fixed local OS action (Show in Finder), signs nothing and writes nothing; only that one
// path may use it, once. Every other mutating route still needs presence.
describe('the reveal route kind (MSG-FILES-IO-h, D-134, I-4)', () => {
  const reveal = () => Promise.resolve({ status: 200, body: { status: 'shown' } });

  it('the default registry has exactly one reveal route, a POST at the fixed path', () => {
    const kinds = createLocalUiRoutes()
      .routes()
      .filter((r) => r.presence === 'reveal');
    expect(kinds.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${REVEAL_PATH}`]);
    expect(REVEAL_PATH).toBe('/api/ui/files/received/reveal');
  });

  it('no other path, method or second route can use the kind', () => {
    for (const path of [
      '/api/ui/files/received/open',
      '/api/ui/files/reveal',
      '/api/ui/rules/set',
      '/api/ui/files/received/reveal/x',
    ]) {
      const registry = new LocalUiRouteRegistry();
      expect(
        () =>
          registry.register({ method: 'POST', path, presence: 'reveal', handler: reveal } as never),
        path,
      ).toThrow(/reveal/);
      expect(registry.routes()).toHaveLength(0);
    }
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const registry = new LocalUiRouteRegistry();
      expect(
        () =>
          registry.register({
            method,
            path: REVEAL_PATH,
            presence: 'reveal',
            handler: reveal,
          } as never),
        method,
      ).toThrow(/reveal/);
    }
    const registry = new LocalUiRouteRegistry();
    expect(() =>
      registry.register({ method: 'POST', path: REVEAL_PATH, presence: 'reveal' } as never),
    ).toThrow(/handler/);
    registry.register({
      method: 'POST',
      path: REVEAL_PATH,
      presence: 'reveal',
      handler: reveal,
    } as never);
    expect(() =>
      registry.register({
        method: 'POST',
        path: REVEAL_PATH,
        presence: 'reveal',
        handler: reveal,
      } as never),
    ).toThrow();
    expect(registry.routes()).toHaveLength(1);
  });

  it('still refuses a POST without presence at the reveal path and anywhere else', () => {
    for (const path of [REVEAL_PATH, '/api/ui/files/received/open']) {
      const registry = new LocalUiRouteRegistry();
      expect(() =>
        registry.register({ method: 'POST', path, presence: false, handler: reveal } as never),
      ).toThrow(/presence/);
    }
  });
});
