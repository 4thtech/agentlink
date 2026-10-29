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
  AGENTS_REMOVE_PATH,
  AGENTS_SWITCH_PATH,
  INVITE_ACCEPT_PATH,
  INVITE_CHECK_PATH,
  INVITE_CREATE_PATH,
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
      // UX2-f1: the activity pulse (api/messages-pulse.test.ts).
      '/api/ui/messages/pulse',
      // M1-11s-a-d: the status bar's health read (api/health.test.ts).
      '/api/ui/health',
      // MSG-FILES-IO-h: Show in Finder (api/files-io-reveal.test.ts).
      '/api/ui/files/received/reveal',
      // UX2-d1: create, check and accept an invite (api/invites.test.ts).
      '/api/ui/invites',
      '/api/ui/invites/check',
      '/api/ui/invites/accept',
      // U3-c: the Agents list, the switch kind and the U3 stubs (local-ui/app-host-server.test.ts).
      '/api/ui/agents',
      '/api/ui/agents/switch',
      '/api/ui/agents/label',
      // U3-d: the label pre-check (api/agents-manage.test.ts).
      '/api/ui/agents/label-check',
      '/api/ui/agents/remove',
      '/api/ui/apps',
      '/api/ui/apps/preview',
      '/api/ui/apps/apply',
      '/api/ui/apps/disconnect',
      '/api/ui/flow',
      // U3-invite: the join screen and the handoff kind (local-ui/join-server.test.ts).
      '/api/ui/join',
      '/api/ui/join/accept',
      '/api/ui/join/dismiss',
      '/api/ui/join/handoff',
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

// UX2-d1 (owner decision 1.1): creating and checking an invite need no owner presence, as their own
// named route kind `invite`: only POST, only at the two fixed paths, one route per step. Accepting is
// an ordinary owner route (`presence: true`). Every other mutating route still needs presence.
describe('the invite route kind (UX2-d1, decision 1.1, I-4)', () => {
  const answer = () => Promise.resolve({ status: 200, body: { status: 'ok' } });
  const route = (over: Record<string, unknown>) =>
    ({
      method: 'POST',
      path: INVITE_CREATE_PATH,
      presence: 'invite',
      step: 'create',
      handler: answer,
      ...over,
    }) as unknown as LocalUiRoute;

  it('the default registry has create and check as the invite kind, and accept behind presence', () => {
    const routes = createLocalUiRoutes().routes();
    expect(
      routes.filter((r) => r.presence === 'invite').map((r) => `${r.method} ${r.path}`),
      // U3-invite: "Not now" on the join screen is the invite kind too (no presence, signs nothing).
    ).toEqual([
      `POST ${INVITE_CREATE_PATH}`,
      `POST ${INVITE_CHECK_PATH}`,
      'POST /api/ui/join/dismiss',
    ]);
    expect(routes.find((r) => r.path === INVITE_ACCEPT_PATH)).toMatchObject({
      method: 'POST',
      presence: true,
    });
    expect([INVITE_CREATE_PATH, INVITE_CHECK_PATH, INVITE_ACCEPT_PATH]).toEqual([
      '/api/ui/invites',
      '/api/ui/invites/check',
      '/api/ui/invites/accept',
    ]);
  });

  it('no other path, method, step or second route can use the kind', () => {
    for (const path of [
      INVITE_ACCEPT_PATH,
      '/api/ui/invites/new',
      '/api/ui/contacts/invite',
      '/api/ui/rules/set',
      `${INVITE_CREATE_PATH}/x`,
    ]) {
      const registry = new LocalUiRouteRegistry();
      expect(() => registry.register(route({ path })), path).toThrow(/invite/);
      expect(registry.routes()).toHaveLength(0);
    }
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const registry = new LocalUiRouteRegistry();
      expect(() => registry.register(route({ method })), method).toThrow(/invite/);
    }
    const mismatched = new LocalUiRouteRegistry();
    expect(() => mismatched.register(route({ step: 'check' }))).toThrow(/invite/);
    expect(() => mismatched.register(route({ step: 'accept' }))).toThrow(/invite/);
    expect(() => mismatched.register(route({ path: INVITE_CHECK_PATH, step: 'create' }))).toThrow(
      /invite/,
    );
    expect(() => mismatched.register(route({ handler: undefined }))).toThrow(/handler/);
    const registry = new LocalUiRouteRegistry();
    registry.register(route({}));
    registry.register(route({ path: INVITE_CHECK_PATH, step: 'check' }));
    expect(() => registry.register(route({}))).toThrow();
    expect(() => registry.register(route({ path: INVITE_CHECK_PATH, step: 'check' }))).toThrow();
    expect(registry.routes()).toHaveLength(2);
  });

  it('accept cannot drop presence, and a POST without presence is still refused anywhere', () => {
    for (const path of [INVITE_ACCEPT_PATH, INVITE_CREATE_PATH, '/api/ui/invites/other']) {
      const registry = new LocalUiRouteRegistry();
      expect(() =>
        registry.register({ method: 'POST', path, presence: false, handler: answer } as never),
      ).toThrow(/presence/);
    }
  });
});

// U3-c (D-138, 08 §1): switching the open agent is the sixth named route kind `switch`: only POST,
// only at the fixed path, no handler, once. A stub (`stub: true`) is only a POST owner route.
describe('the switch route kind and the U3 stubs (U3-c, I-4)', () => {
  const answer = () => Promise.resolve({ status: 200, body: { status: 'ok' } });

  it('the default registry has exactly one switch route, at the fixed path, with no handler', () => {
    const routes = createLocalUiRoutes().routes();
    const switches = routes.filter((r) => r.presence === 'switch');
    expect(switches.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${AGENTS_SWITCH_PATH}`]);
    expect(AGENTS_SWITCH_PATH).toBe('/api/ui/agents/switch');
    expect('handler' in (switches[0] as object)).toBe(false);
  });

  it('no other path, method, handler or second route can use the switch kind', () => {
    const route = (over: Record<string, unknown>) =>
      ({
        method: 'POST',
        path: AGENTS_SWITCH_PATH,
        presence: 'switch',
        ...over,
      }) as unknown as LocalUiRoute;
    for (const path of [
      '/api/ui/agents',
      '/api/ui/agents/label',
      '/api/ui/rules',
      `${AGENTS_SWITCH_PATH}/x`,
    ]) {
      const registry = new LocalUiRouteRegistry();
      expect(() => registry.register(route({ path })), path).toThrow(/switch/);
    }
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      expect(() => new LocalUiRouteRegistry().register(route({ method })), method).toThrow(
        /switch/,
      );
    }
    expect(() => new LocalUiRouteRegistry().register(route({ handler: answer }))).toThrow(
      /handler/,
    );
    const registry = new LocalUiRouteRegistry();
    registry.register(route({}));
    expect(() => registry.register(route({}))).toThrow(/switch/);
    expect(registry.routes()).toHaveLength(1);
  });

  it('a stub is only a POST owner route; a POST without presence is still refused at the U3 paths', () => {
    for (const over of [
      { method: 'GET', presence: false },
      { method: 'POST', presence: 'reveal' },
      { method: 'PUT', presence: true },
      { method: 'POST', presence: true, stub: 'yes' },
    ]) {
      const registry = new LocalUiRouteRegistry();
      expect(
        () =>
          registry.register({
            path: '/api/ui/agents/label',
            handler: answer,
            stub: true,
            ...over,
          } as never),
        JSON.stringify(over),
      ).toThrow();
    }
    for (const path of [
      '/api/ui/agents',
      '/api/ui/agents/label',
      '/api/ui/agents/remove',
      '/api/ui/apps/apply',
    ]) {
      expect(() =>
        new LocalUiRouteRegistry().register({
          method: 'POST',
          path,
          presence: false,
          handler: answer,
        } as never),
      ).toThrow(/presence/);
    }
    const stubs = createLocalUiRoutes()
      .routes()
      .filter((r) => r.presence === true && r.stub === true)
      .map((r) => r.path);
    // U3-d replaced the stubs of POST /api/ui/agents and /api/ui/agents/label; U3-e the remove one;
    // U3-f those of POST /api/ui/apps/apply and /api/ui/apps/disconnect. No stubs remain.
    expect(stubs).toEqual([]);
  });
});

// U3-e (D-138, 08 §1): removing an agent is the seventh named route kind `remove`: only POST, only
// at its fixed path, no handler, once. U3-e replaces U3-c's stub (it is never registered twice).
describe('the remove route kind (U3-e, I-4)', () => {
  const answer = () => Promise.resolve({ status: 200, body: { status: 'ok' } });
  const route = (over: Record<string, unknown>) =>
    ({
      method: 'POST',
      path: AGENTS_REMOVE_PATH,
      presence: 'remove',
      ...over,
    }) as unknown as LocalUiRoute;

  it('the default registry has exactly one remove route, at the fixed path, with no handler', () => {
    const removes = createLocalUiRoutes()
      .routes()
      .filter((r) => r.path === AGENTS_REMOVE_PATH);
    expect(removes.map((r) => `${r.method} ${r.presence}`)).toEqual(['POST remove']);
    expect(AGENTS_REMOVE_PATH).toBe('/api/ui/agents/remove');
    expect('handler' in (removes[0] as object)).toBe(false);
  });

  it('no other path, method, handler or second route can use the remove kind', () => {
    for (const path of ['/api/ui/agents', '/api/ui/agents/label', `${AGENTS_REMOVE_PATH}/x`]) {
      expect(() => new LocalUiRouteRegistry().register(route({ path })), path).toThrow(/remove/);
    }
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      expect(() => new LocalUiRouteRegistry().register(route({ method })), method).toThrow(
        /remove/,
      );
    }
    expect(() => new LocalUiRouteRegistry().register(route({ handler: answer }))).toThrow(
      /handler/,
    );
    const registry = new LocalUiRouteRegistry();
    registry.register(route({}));
    expect(() => registry.register(route({}))).toThrow(/remove/);
    expect(registry.routes()).toHaveLength(1);
  });
});

// U3-invite (08 §4): the handoff is the eighth named kind: only POST, only at its fixed path, no
// handler, once. The join screen's accept is an ordinary presence route; "Not now" the invite kind.
describe('the handoff route kind and the join routes (U3-invite, I-4)', () => {
  const HANDOFF = '/api/ui/join/handoff';
  const route = (over: Record<string, unknown>): LocalUiRoute =>
    ({ method: 'POST', path: HANDOFF, presence: 'handoff', ...over }) as unknown as LocalUiRoute;

  it('the default registry has one handoff route with no handler; accept needs presence', () => {
    const routes = createLocalUiRoutes().routes();
    const handoffs = routes.filter((r) => r.presence === 'handoff');
    expect(handoffs.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${HANDOFF}`]);
    expect('handler' in (handoffs[0] as object)).toBe(false);
    expect(routes.find((r) => r.path === '/api/ui/join/accept')).toMatchObject({
      method: 'POST',
      presence: true,
    });
    expect(routes.find((r) => r.path === '/api/ui/join')).toMatchObject({
      method: 'GET',
      presence: false,
    });
    expect(routes.find((r) => r.path === '/api/ui/join/dismiss')).toMatchObject({
      presence: 'invite',
      step: 'dismiss',
    });
  });

  it('no other path, method, handler or second route can use the handoff kind', () => {
    for (const path of ['/api/ui/join', '/api/ui/join/accept', `${HANDOFF}/x`, '/api/ui/invites']) {
      expect(() => new LocalUiRouteRegistry().register(route({ path })), path).toThrow(/handoff/);
    }
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      expect(() => new LocalUiRouteRegistry().register(route({ method })), method).toThrow(
        /handoff/,
      );
    }
    expect(() =>
      new LocalUiRouteRegistry().register(route({ handler: () => Promise.resolve() })),
    ).toThrow(/handler/);
    const registry = new LocalUiRouteRegistry();
    registry.register(route({}));
    expect(() => registry.register(route({}))).toThrow(/handoff/);
    expect(registry.routes()).toHaveLength(1);
  });

  it('the dismiss step is only at its fixed path', () => {
    const answer = () => Promise.resolve({ status: 200, body: {} });
    expect(() =>
      new LocalUiRouteRegistry().register({
        method: 'POST',
        path: '/api/ui/invites',
        presence: 'invite',
        step: 'dismiss',
        handler: answer,
      } as never),
    ).toThrow(/invite/);
  });
});
