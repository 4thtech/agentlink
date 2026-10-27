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
import { LOCAL_UI_API_PREFIX, LocalUiRouteRegistry, createLocalUiRoutes } from './routes.js';

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
    ]);
    const registry = createLocalUiRoutes();
    // M1-11b-1: the first-run page has its real status route (api/first-run.test.ts).
    const pages = ['approvals', 'activity', 'storage', 'backup', 'advanced'];
    // M1-11s-c: the first-run page's two owner setup routes are covered in owner-setup-route.test.ts.
    const stubs = registry
      .routes()
      .filter(
        (r) => r.presence !== 'setup' && r.path !== '/api/ui/first-run' && !built.has(r.path),
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
