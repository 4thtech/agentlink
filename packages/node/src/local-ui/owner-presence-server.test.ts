// UX1113 WP-S2 (design-1112 §3.3; 04 §2.5 "Touch ID & master code page"; 08 §1): the routes behind
// Settings › Touch ID & master code, through the approval server's real presence gate, the real owner
// store and the real keychain items.
//
// - "Check my master code" is an oracle: it runs through the central gate, shares the one wrong-code
//   backoff with every other presence route (both directions), answers a wrong code with the same
//   generic 403 `presence_rejected`, takes only the master code (never a passkey) and signs nothing.
// - "Test Touch ID" takes only a passkey assertion, signs nothing and leaves nothing unlocked.
// - "Replace master code" follows the `owner-next` protocol: after presence the new code is staged
//   (and shown once); the `owner` item is not touched until the owner types the new code back, so the
//   old code keeps working until then. Finish is all or nothing; Cancel removes the staged item.
// - Nothing carries a code into an event.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { encodeUtf8, ownerPrfSalt, type JsonObject } from '@4thtech-io/crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerEvent,
  type ApprovalServerSource,
} from '../approval-server.js';
import { ownerWorld, send, type OwnerWorld } from '../approval-ui.fixture.js';
import { TEST_APP } from '../local-ui-app.fixture.js';
import { KeychainOwnerKeyStore, OWNER_NEXT_ACCOUNT, readOwnerItem } from '../owner-keystore.js';
import { encodePasskeyAssertion, registerOwnerPasskey } from '../owner-passkey.js';
import { VirtualPrfAuthenticator } from '../passkey-authenticator.fixture.js';
import type { LocalUiOwnerRoute, LocalUiRoute } from './route-types.js';
import { LocalUiRouteRegistry, createLocalUiRoutes } from './routes.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

// The fixed paths (08 §1), spelled out so this suite does not depend on the module under test.
const CHECK = '/api/ui/owner-code/check';
const TEST = '/api/ui/owner-presence/test';
const REPLACE = '/api/ui/owner-code/replace';
const FINISH = '/api/ui/owner-code/replace/finish';
const CANCEL = '/api/ui/owner-code/replace/cancel';
const RULES = '/api/ui/rules';

const NEW_CODE = /^[A-Z2-7]{4}(?: [A-Z2-7]{4}){5}$/;
const WRONG = 'AAAA BBBB CCCC DDDD EEEE FFFF';

const worlds: OwnerWorld[] = [];
const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const w of worlds.splice(0)) w.cleanup();
});

interface Harness {
  readonly world: OwnerWorld;
  readonly events: ApprovalServerEvent[];
  readonly applied: JsonObject[];
  post(path: string, body: string | Uint8Array, options?: { passkey?: boolean }): Promise<Answer>;
  /** A second page session of the same server (another tab). */
  otherSession(): Promise<Harness['post']>;
}

interface Answer {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly retryAfter: string | undefined;
}

async function harness(): Promise<Harness> {
  const world = await ownerWorld('agentlink-wp-s2-');
  worlds.push(world);
  const home = join(world.root, 'home');
  mkdirSync(join(home, '.agentlink', 'agents', 'default'), { recursive: true });
  const applied: JsonObject[] = [];
  const source: ApprovalServerSource = {
    context: () => Promise.resolve({ agent: world.agentId, owner: world.owner }),
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    apply: (signed) => {
      applied.push(signed.body as JsonObject);
      return Promise.resolve({ status: 'applied', op: 'x' } as never);
    },
  };
  const events: ApprovalServerEvent[] = [];
  const opened: string[] = [];
  const server = await startApprovalServerWith(
    {
      source,
      onEvent: (event) => void events.push(event),
      localUi: { assets: TEST_APP },
    },
    {
      keychain: world.keychain,
      openOwnerStore: (expected) => KeychainOwnerKeyStore.open(world.keychain, expected),
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      ownerKdf: KDF,
    },
  );
  servers.push(server);
  await server.open();

  const session = async (): Promise<Harness['post']> => {
    const before = opened.length;
    if (before > 0) await server.open();
    const token = new URL(opened[before] ?? '').searchParams.get('t') ?? '';
    const login = await send(server.port, `/?t=${token}`);
    const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    const page = await send(server.port, '/', { headers: { Cookie: cookie } });
    const csrf =
      /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1] ?? '';
    return async (path, body, options = {}) => {
      const res = await send(server.port, path, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: server.origin,
          'X-AgentLink-CSRF': csrf,
          'Content-Type': 'application/octet-stream',
          'Sec-Fetch-Site': 'same-origin',
          'X-AgentLink-Input': 'e30', // base64url of `{}`
          ...(options.passkey === true ? { 'X-AgentLink-Presence': 'passkey' } : {}),
        },
        body: typeof body === 'string' ? encodeUtf8(body) : body,
      });
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(res.body) as Record<string, unknown>;
      } catch {
        // not JSON
      }
      const retry = res.headers['retry-after'];
      return {
        status: res.status,
        json,
        retryAfter: Array.isArray(retry) ? retry[0] : retry,
      };
    };
  };
  const post = await session();
  return { world, events, applied, post, otherSession: session };
}

async function withPasskey(world: OwnerWorld): Promise<() => Uint8Array> {
  const salt = ownerPrfSalt();
  const auth = new VirtualPrfAuthenticator();
  await registerOwnerPasskey(
    world.keychain,
    world.owner,
    encodeUtf8(world.code),
    auth.create(world.owner.ownerNostr, salt),
  );
  return () => encodePasskeyAssertion(auth.get(salt));
}

const noCodeIn = (h: Harness, ...codes: string[]): void => {
  const text = JSON.stringify(h.events);
  for (const code of codes) {
    expect(text).not.toContain(code);
    expect(text).not.toContain(code.replace(/ /g, ''));
  }
};

describe('Check my master code (WP-S2): an oracle behind the shared gate', () => {
  it('the right code answers done and signs nothing', async () => {
    const h = await harness();
    const res = await h.post(CHECK, h.world.code);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'done' });
    expect(h.applied).toEqual([]);
    noCodeIn(h, h.world.code);
  });

  it('a wrong code is the generic 403 presence_rejected of every presence route', async () => {
    const h = await harness();
    const check = await h.post(CHECK, WRONG);
    const rules = await (await harness()).post(RULES, WRONG);
    expect(check.status).toBe(403);
    expect(check.json).toEqual({ status: 'presence_rejected' });
    expect(check.json).toEqual(rules.json);
    expect(h.applied).toEqual([]);
  });

  it('no code: presence_required, nothing read', async () => {
    const h = await harness();
    const res = await h.post(CHECK, '');
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ status: 'presence_required' });
  });

  it('takes only the master code: a passkey assertion is refused before anything is checked', async () => {
    const h = await harness();
    const assertion = await withPasskey(h.world);
    const res = await h.post(CHECK, assertion(), { passkey: true });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ status: 'presence_required' });
  });

  it('wrong checks hold back every other presence route (one shared backoff)', async () => {
    const h = await harness();
    for (let i = 0; i < 3; i += 1) expect((await h.post(CHECK, WRONG)).status).toBe(403);
    const held = await h.post(RULES, h.world.code);
    expect(held.status).toBe(429);
    expect(held.json['status']).toBe('wait');
    expect(Number(held.retryAfter)).toBeGreaterThan(0);
    // ...and the check itself waits too, even with the right code.
    expect((await h.post(CHECK, h.world.code)).status).toBe(429);
  });

  it('wrong codes on another presence route make the check wait (both directions)', async () => {
    const h = await harness();
    for (let i = 0; i < 3; i += 1) expect((await h.post(RULES, WRONG)).status).toBe(403);
    const res = await h.post(CHECK, h.world.code);
    expect(res.status).toBe(429);
    expect(res.json['status']).toBe('wait');
  });

  it('a right check resets the count like any successful presence', async () => {
    const h = await harness();
    for (let i = 0; i < 2; i += 1) await h.post(CHECK, WRONG);
    expect((await h.post(CHECK, h.world.code)).status).toBe(200);
    for (let i = 0; i < 2; i += 1) await h.post(CHECK, WRONG);
    expect((await h.post(CHECK, h.world.code)).status).toBe(200);
  });
});

describe('Test Touch ID (WP-S2): signs nothing, unlocks nothing', () => {
  it('a good passkey assertion answers done and signs nothing', async () => {
    const h = await harness();
    const assertion = await withPasskey(h.world);
    const res = await h.post(TEST, assertion(), { passkey: true });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'done' });
    expect(h.applied).toEqual([]);
  });

  it('takes only a passkey: the master code is refused (presence_required)', async () => {
    const h = await harness();
    await withPasskey(h.world);
    const res = await h.post(TEST, h.world.code);
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ status: 'presence_required' });
  });

  it('a bad assertion is presence_rejected and counts towards the shared backoff', async () => {
    const h = await harness();
    const assertion = await withPasskey(h.world);
    const bad = assertion();
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1; // flip a bit of the PRF output
    for (let i = 0; i < 3; i += 1) {
      const res = await h.post(TEST, bad, { passkey: true });
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ status: 'presence_rejected' });
    }
    expect((await h.post(CHECK, h.world.code)).status).toBe(429);
  });
});

describe('Replace master code (WP-S2): owner-next, all or nothing, shown once', () => {
  it('presence stages a new code; the old one keeps working until the new one is typed back', async () => {
    const h = await harness();
    const before = await readOwnerItem(h.world.keychain);
    const res = await h.post(REPLACE, h.world.code);
    expect(res.status).toBe(200);
    expect(res.json['status']).toBe('staged');
    const code = String(res.json['code']);
    expect(code).toMatch(NEW_CODE);
    expect(code).not.toBe(h.world.code);
    expect(await h.world.keychain.get(OWNER_NEXT_ACCOUNT)).not.toBeNull();
    expect(await readOwnerItem(h.world.keychain)).toEqual(before);
    // The old code still opens; the new one does not yet.
    expect((await h.post(CHECK, h.world.code)).status).toBe(200);
    expect((await h.post(CHECK, code)).status).toBe(403);
    expect(h.applied).toEqual([]);
    noCodeIn(h, code, h.world.code);
  });

  it('typing the new code back finishes: the new code works, the old one stops', async () => {
    const h = await harness();
    const code = String((await h.post(REPLACE, h.world.code)).json['code']);
    const done = await h.post(FINISH, code.toLowerCase().replace(/ /g, '-'));
    expect(done.status).toBe(200);
    expect(done.json).toEqual({ status: 'done' });
    expect(await h.world.keychain.get(OWNER_NEXT_ACCOUNT)).toBeNull();
    expect((await h.post(CHECK, code)).status).toBe(200);
    expect((await h.post(CHECK, h.world.code)).status).toBe(403);
    expect(h.applied).toEqual([]);
    noCodeIn(h, code, h.world.code);
  });

  it('works with Touch ID as the presence too', async () => {
    const h = await harness();
    const assertion = await withPasskey(h.world);
    const res = await h.post(REPLACE, assertion(), { passkey: true });
    expect(res.status).toBe(200);
    const code = String(res.json['code']);
    expect((await h.post(FINISH, code)).status).toBe(200);
    expect((await h.post(CHECK, code)).status).toBe(200);
    // Touch ID itself is untouched by the new code.
    expect((await h.post(TEST, assertion(), { passkey: true })).status).toBe(200);
  });

  it('a wrong code typed back changes nothing and counts towards the backoff', async () => {
    const h = await harness();
    const before = await readOwnerItem(h.world.keychain);
    await h.post(REPLACE, h.world.code);
    const res = await h.post(FINISH, WRONG);
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ status: 'presence_rejected' });
    expect(await readOwnerItem(h.world.keychain)).toEqual(before);
    // The old code is unchanged; the other code typed (the current one) is not accepted either.
    const old = await h.post(FINISH, h.world.code);
    expect(old.status).toBe(403);
    expect((await h.post(FINISH, WRONG)).status).toBe(403);
    // Three wrong entries: the backoff holds every presence route, finish included.
    expect((await h.post(CHECK, h.world.code)).status).toBe(429);
    expect(await readOwnerItem(h.world.keychain)).toEqual(before);
  });

  it('three wrong entries end the change: the staged item is removed, the old code keeps working', async () => {
    const h = await harness();
    const res = await h.post(REPLACE, h.world.code);
    const code = String(res.json['code']);
    for (let i = 0; i < 3; i += 1) await h.post(FINISH, WRONG);
    expect(await h.world.keychain.get(OWNER_NEXT_ACCOUNT)).toBeNull();
    // Even the right code no longer finishes it (the change is gone, not just waiting).
    const late = await h.post(FINISH, code);
    expect([409, 429]).toContain(late.status);
    expect(late.json['status'] === 'not_pending' || late.json['status'] === 'wait').toBe(true);
  });

  it('cancel removes the staged item and keeps the old code', async () => {
    const h = await harness();
    const before = await readOwnerItem(h.world.keychain);
    const code = String((await h.post(REPLACE, h.world.code)).json['code']);
    const res = await h.post(CANCEL, '');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'cancelled' });
    expect(await h.world.keychain.get(OWNER_NEXT_ACCOUNT)).toBeNull();
    expect(await readOwnerItem(h.world.keychain)).toEqual(before);
    expect((await h.post(FINISH, code)).json).toEqual({ status: 'not_pending' });
    expect((await h.post(CHECK, h.world.code)).status).toBe(200);
  });

  it('finish without a staged change is not_pending and touches nothing', async () => {
    const h = await harness();
    const res = await h.post(FINISH, h.world.code);
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ status: 'not_pending' });
  });

  it('the staged change belongs to the page session that began it', async () => {
    const h = await harness();
    const code = String((await h.post(REPLACE, h.world.code)).json['code']);
    const other = await h.otherSession();
    expect((await other(FINISH, code)).json).toEqual({ status: 'not_pending' });
    expect((await other(CANCEL, '')).json).toEqual({ status: 'not_pending' });
    expect((await h.post(FINISH, code)).status).toBe(200);
  });

  it('a wrong current code stages nothing', async () => {
    const h = await harness();
    const res = await h.post(REPLACE, WRONG);
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ status: 'presence_rejected' });
    expect(await h.world.keychain.get(OWNER_NEXT_ACCOUNT)).toBeNull();
  });

  it('a leftover owner-next from an unfinished change is refused, never overwritten', async () => {
    const h = await harness();
    const leftover = new Uint8Array(90).fill(7);
    await h.world.keychain.set(OWNER_NEXT_ACCOUNT, leftover);
    const res = await h.post(REPLACE, h.world.code);
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ status: 'unfinished' });
    expect(await h.world.keychain.get(OWNER_NEXT_ACCOUNT)).toEqual(leftover);
  });

  it('a second replace in the same session drops the first staged code', async () => {
    const h = await harness();
    const first = String((await h.post(REPLACE, h.world.code)).json['code']);
    const second = String((await h.post(REPLACE, h.world.code)).json['code']);
    expect(second).not.toBe(first);
    expect((await h.post(FINISH, first)).status).toBe(403);
    expect((await h.post(FINISH, second)).status).toBe(200);
  });

  it('closing the server removes a staged change it began (the old code keeps working)', async () => {
    const h = await harness();
    await h.post(REPLACE, h.world.code);
    await Promise.all(servers.splice(0).map((s) => s.close()));
    expect(await h.world.keychain.get(OWNER_NEXT_ACCOUNT)).toBeNull();
  });
});

describe('the owner-code routes are fixed (WP-S2, I-4)', () => {
  const STEPS = {
    check: CHECK,
    test: TEST,
    replace: REPLACE,
    finish: FINISH,
    cancel: CANCEL,
  } as const;

  it('the default registry has each step once, a POST presence route at its fixed path', () => {
    const routes = createLocalUiRoutes().routes();
    for (const [step, path] of Object.entries(STEPS)) {
      const found = routes.filter(
        (r) => (r as { ownerCode?: unknown }).ownerCode === step,
      ) as LocalUiOwnerRoute[];
      expect(found.length, step).toBe(1);
      expect(found[0]?.method).toBe('POST');
      expect(found[0]?.path).toBe(path);
      expect(found[0]?.presence).toBe(true);
    }
  });

  it('no other path, method, presence or second route can take an owner-code step', () => {
    const handler = () => Promise.resolve({ status: 200, body: {} });
    const bad: unknown[] = [
      { method: 'POST', path: '/api/ui/other', presence: true, ownerCode: 'check', handler },
      { method: 'PUT', path: CHECK, presence: true, ownerCode: 'check', handler },
      { method: 'POST', path: CHECK, presence: true, ownerCode: 'nope', handler },
      { method: 'POST', path: CHECK, presence: true, ownerCode: 'test', handler },
      {
        method: 'POST',
        path: CHECK,
        presence: true,
        ownerCode: 'check',
        recoveryKit: true,
        handler,
      },
    ];
    for (const route of bad) {
      const registry = new LocalUiRouteRegistry();
      expect(() => registry.register(route as LocalUiRoute), JSON.stringify(route)).toThrow();
    }
    const twice = createLocalUiRoutes();
    expect(() =>
      twice.register({
        method: 'POST',
        path: CHECK,
        presence: true,
        ownerCode: 'check',
        handler,
      } as unknown as LocalUiRoute),
    ).toThrow();
  });
});
