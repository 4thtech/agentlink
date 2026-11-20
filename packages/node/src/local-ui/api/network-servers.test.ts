// NET-OWNER-SET (S2; D-158; 08 §1 `POST /api/ui/network/servers`, `/reset`, `GET /progress`; 07 §4.3;
// 04 §2.5, §2.6; I-4, I-5, I-7): the routes of "Use your own servers".
//
// - The review (`{…, review: true}`) runs before the presence gate (the route's precheck) and signs
//   nothing: the server tests the list again (never the page's results), builds the final list (own,
//   then the mixed-in automatic ones), the leaving servers with their ends, the contact count and the
//   warnings.
// - The confirm (presence) tests again and must match the review (`changed` otherwise); the handler
//   hands the gate's one-use `changeServers` exactly the reviewed list and the announce choice.
// - Refusals before anything is signed: invalid_list, not_ready (a private address, fewer than 2
//   own ready), mix_in_on, same_list, too_many_previous with fitsFrom, rotation_pending,
//   agent_paused.
// - Reset is the same path to the default set; progress is a read.
import type { LeavingServer } from '@4thtech-io/core';
import type { JsonObject, JsonValue } from '@4thtech-io/crypto';
import {
  DEFAULT_RELAYS,
  LEGACY_READ_RELAYS,
  type HostResolver,
  type RelayConnector,
  type RelaySocket,
  type RelaySocketHandlers,
  type RelayTarget,
} from '@4thtech-io/transport-nostr';
import { describe, expect, it } from 'vitest';
import type { LocalUiContext, LocalUiServerListPort, LocalUiServerProgress } from '../context.js';
import type {
  LocalUiOwnerOperation,
  LocalUiOwnerRoute,
  LocalUiReadRoute,
  LocalUiResult,
} from '../route-types.js';
import {
  NETWORK_PROGRESS_PATH,
  NETWORK_RESET_PATH,
  NETWORK_SERVERS_PATH,
  createNetworkServersRoutes,
} from './network-servers.js';
import { PrecheckBudget, createNetworkTestRoute } from './network-test.js';

const NOW = 1_800_000_000;
const DAYS30 = 30 * 86_400;
const own = (n: number, tag = 'own'): string[] =>
  Array.from({ length: n }, (_, i) => `wss://${tag}${i + 1}.example.org`);

/** An in-memory relay that keeps and serves every event: every public host tests `ready`. */
function memoryRelays(): RelayConnector {
  const stored: { id: string }[] = [];
  return {
    open(_target: RelayTarget, handlers: RelaySocketHandlers): RelaySocket {
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
          if (frame[0] === 'EVENT') {
            const event = frame[1] as { id: string };
            stored.push(event);
            push(['OK', event.id, true, '']);
          } else if (frame[0] === 'REQ') {
            const ids = (frame[2] as { ids?: string[] }).ids;
            for (const event of stored)
              if (ids === undefined || ids.includes(event.id)) push(['EVENT', frame[1], event]);
            push(['EOSE', frame[1]]);
          }
        },
        close() {
          closed = true;
        },
      };
    },
  };
}

/** `private*` resolves to a private address (not allowed), `gone*` does not resolve. */
const resolver: HostResolver = {
  resolve: (host) =>
    host.startsWith('private')
      ? Promise.resolve(['10.0.0.7'])
      : host.startsWith('gone')
        ? Promise.reject(new Error('ENOTFOUND'))
        : Promise.resolve(['93.184.215.30']),
};

interface Fake {
  relays: readonly string[];
  leaving: readonly LeavingServer[];
  announceDefault: boolean;
  paused: boolean;
  sendState: string;
}

function setup(over: Partial<Fake> = {}, budget: PrecheckBudget = new PrecheckBudget()) {
  const state: Fake = {
    relays: ['wss://relay.primal.net', 'wss://offchain.pub'],
    leaving: [],
    announceDefault: true,
    paused: false,
    sendState: 'ready',
    ...over,
  };
  const progress: LocalUiServerProgress = {
    changedAt: null,
    total: 0,
    sent: 0,
    waiting: 0,
    items: [],
    leavingUntil: null,
  };
  const serverList: LocalUiServerListPort = {
    state: () =>
      Promise.resolve({
        relays: state.relays,
        leaving: state.leaving,
        announceDefault: state.announceDefault,
        paused: state.paused,
        sendState: state.sendState as never,
      }),
    contacts: () => Promise.resolve(3),
    progress: () => Promise.resolve(progress),
  };
  const context = {
    client: { agentId: '0x71c4000000000000000000000000000000009a2e' },
    serverList,
    now: () => NOW * 1000,
  } as unknown as LocalUiContext;
  const routes = createNetworkServersRoutes(
    () => ({ resolver, connector: memoryRelays() }),
    budget,
  );
  const find = (method: string, path: string) => {
    const r = routes.find((x) => x.method === method && x.path === path);
    if (r === undefined) throw new Error(`no route ${method} ${path}`);
    return r;
  };
  const signed: { relays: readonly string[]; announceDefault: boolean }[] = [];
  const owner: LocalUiOwnerOperation = {
    sign: () => Promise.reject(new Error('test: sign is never used here')),
    changeServers: (plan) => {
      signed.push(plan);
      state.relays = plan.relays;
      state.announceDefault = plan.announceDefault;
      return Promise.resolve({ status: 'changed', contacts: 3, leavingUntil: NOW + DAYS30 });
    },
  };
  const servers = find('POST', NETWORK_SERVERS_PATH) as LocalUiOwnerRoute;
  const reset = find('POST', NETWORK_RESET_PATH) as LocalUiOwnerRoute;
  const progressRoute = find('GET', NETWORK_PROGRESS_PATH) as LocalUiReadRoute;
  const req = (input?: JsonValue) => ({
    params: {},
    query: new URLSearchParams(),
    ...(input === undefined ? {} : { input }),
  });
  /** What the server does: the precheck, then (only when it lets the request on) the handler. */
  const confirm = async (route: LocalUiOwnerRoute, input: JsonObject): Promise<LocalUiResult> => {
    const early = await route.precheck?.(context, req(input));
    if (early !== undefined) return early;
    return route.handler(context, req(input), owner);
  };
  const review = async (route: LocalUiOwnerRoute, input: JsonObject) =>
    (await route.precheck?.(context, req({ ...input, review: true }))) as LocalUiResult;
  return { state, context, servers, reset, progressRoute, signed, confirm, review, req, progress };
}

const body = (r: LocalUiResult) => r.body as Record<string, unknown>;

describe('POST /api/ui/network/servers: the review signs nothing', () => {
  it('is an owner route (presence) whose review runs before the gate', () => {
    const w = setup();
    expect(w.servers.presence).toBe(true);
    expect(w.reset.presence).toBe(true);
    expect(w.progressRoute.presence).toBe(false);
    expect(typeof w.servers.precheck).toBe('function');
  });

  it('answers the final list (own, then 2 automatic), the leaving servers, contacts, warnings', async () => {
    const w = setup();
    const res = await w.review(w.servers, { servers: own(2), automatic: true, announce: true });
    expect(res.status).toBe(200);
    expect(body(res)['servers']).toEqual([
      { host: 'own1.example.org', role: 'own', outcome: 'ready' },
      { host: 'own2.example.org', role: 'own', outcome: 'ready' },
      { host: 'offchain.pub', role: 'automatic', outcome: 'ready' },
      { host: 'relay.primal.net', role: 'automatic', outcome: 'ready' },
    ]);
    expect(body(res)['leaving']).toEqual([]);
    expect(body(res)['contacts']).toBe(3);
    expect(Array.isArray(body(res)['warnings'])).toBe(true);
    expect(w.signed).toEqual([]);
  });

  it('the mix-in counts toward 8: 6 own and 2 automatic', async () => {
    const w = setup();
    const res = await w.review(w.servers, { servers: own(6), automatic: true, announce: true });
    expect(res.status).toBe(200);
    const list = body(res)['servers'] as { role: string }[];
    expect(list).toHaveLength(8);
    expect(list.filter((s) => s.role === 'automatic')).toHaveLength(2);
    // 7 own with the mix-in would be 9: refused as an invalid list.
    const seven = await w.review(w.servers, { servers: own(7), automatic: true, announce: true });
    expect(seven).toEqual({ status: 400, body: { error: 'invalid_list' } });
  });

  it('lists every server that leaves, each with its end', async () => {
    const w = setup({ relays: own(3, 'old') });
    const res = await w.review(w.servers, { servers: own(2), automatic: false, announce: true });
    expect(body(res)['leaving']).toEqual(
      own(3, 'old').map((url) => ({ host: url.slice(6), until: NOW + DAYS30 })),
    );
  });

  it('re-test refusals: a private address and fewer than 2 own ready are not_ready', async () => {
    const w = setup();
    const priv = await w.review(w.servers, {
      servers: [...own(2), 'wss://private.example.org'],
      automatic: true,
      announce: true,
    });
    expect(priv).toEqual({ status: 409, body: { error: 'not_ready' } });
    const one = await w.review(w.servers, {
      servers: [own(1)[0] as string, 'wss://gone.example.org'],
      automatic: false,
      announce: true,
    });
    expect(one).toEqual({ status: 409, body: { error: 'not_ready' } });
  });

  it('refuses a bad list, a duplicate, an IP literal and an opt-out with the mix-in on', async () => {
    const w = setup();
    const bad = (input: JsonObject) => w.review(w.servers, input);
    const invalid = { status: 400, body: { error: 'invalid_list' } };
    expect(await bad({ servers: own(1), automatic: false, announce: true })).toEqual(invalid);
    expect(
      await bad({
        servers: ['wss://a.example.org', 'wss://a.example.org'],
        automatic: false,
        announce: true,
      }),
    ).toEqual(invalid);
    expect(
      await bad({
        servers: ['wss://a.example.org', 'wss://1.2.3.4'],
        automatic: false,
        announce: true,
      }),
    ).toEqual(invalid);
    expect(await bad({ servers: own(2), automatic: true })).toEqual(invalid);
    expect(await bad({ servers: own(2), automatic: true, announce: true, extra: 1 })).toEqual(
      invalid,
    );
    expect(await bad({ servers: own(2), automatic: true, announce: false })).toEqual({
      status: 409,
      body: { error: 'mix_in_on' },
    });
  });

  it('refuses the same list, an unfinished rotation and a paused agent', async () => {
    const same = setup({ relays: own(2) });
    expect(
      await same.review(same.servers, { servers: own(2), automatic: false, announce: true }),
    ).toEqual({ status: 409, body: { error: 'same_list' } });
    const pending = setup({ sendState: 'rotation_pending' });
    expect(
      await pending.review(pending.servers, { servers: own(2), automatic: false, announce: true }),
    ).toEqual({ status: 409, body: { error: 'rotation_pending' } });
    const paused = setup({ paused: true });
    expect(
      await paused.review(paused.servers, { servers: own(2), automatic: false, announce: true }),
    ).toEqual({ status: 409, body: { error: 'agent_paused' } });
  });

  it('refuses past 16 leaving servers with fitsFrom (unix seconds)', async () => {
    const leaving = own(14, 'prev').map((url, i) => ({ url, until: NOW + 100 + i }));
    const w = setup({ relays: own(3, 'old'), leaving });
    const res = await w.review(w.servers, { servers: own(2), automatic: false, announce: true });
    expect(res).toEqual({
      status: 409,
      body: { error: 'too_many_previous', fitsFrom: NOW + 100 },
    });
  });
});

describe('POST /api/ui/network/servers: the confirm (presence) signs exactly the reviewed list', () => {
  it('happy path: the gate signs the reviewed list and the announce choice', async () => {
    const w = setup();
    const input = { servers: own(3), automatic: false, announce: false };
    expect((await w.review(w.servers, input)).status).toBe(200);
    const res = await w.confirm(w.servers, input);
    expect(res).toEqual({
      status: 200,
      body: { status: 'done', contacts: 3, leavingUntil: NOW + DAYS30 },
    });
    expect(w.signed).toEqual([{ relays: own(3), announceDefault: false }]);
  });

  it('a confirm with no matching review is `changed`; nothing is signed', async () => {
    const w = setup();
    const res = await w.confirm(w.servers, { servers: own(3), automatic: false, announce: true });
    expect(res).toEqual({ status: 409, body: { error: 'changed' } });
    expect(w.signed).toEqual([]);
  });

  it('a second confirm after the change is refused (same_list); the owner signs once', async () => {
    const w = setup();
    const input = { servers: own(3), automatic: false, announce: true };
    await w.review(w.servers, input);
    expect((await w.confirm(w.servers, input)).status).toBe(200);
    expect(await w.confirm(w.servers, input)).toEqual({
      status: 409,
      body: { error: 'same_list' },
    });
    expect(w.signed).toHaveLength(1);
  });

  it('without the one-use owner operation the confirm signs nothing', async () => {
    const w = setup();
    const input = { servers: own(3), automatic: false, announce: true };
    await w.review(w.servers, input);
    expect(await w.servers.precheck?.(w.context, w.req(input))).toBeUndefined();
    const res = await w.servers.handler(w.context, w.req(input), {
      sign: () => Promise.reject(new Error('no')),
    });
    expect(res.status).toBe(501);
    expect(w.signed).toEqual([]);
  });
});

describe('POST /api/ui/network/reset: the same path to the default set', () => {
  it('reviews and signs the default set with the announce choice on', async () => {
    const w = setup({ relays: own(3), announceDefault: false });
    const res = await w.review(w.reset, {});
    expect(res.status).toBe(200);
    expect((body(res)['servers'] as { role: string }[]).map((s) => s.role)).toEqual(
      DEFAULT_RELAYS.map(() => 'automatic'),
    );
    expect((await w.confirm(w.reset, {})).status).toBe(200);
    expect(w.signed).toEqual([{ relays: DEFAULT_RELAYS, announceDefault: true }]);
  });

  it('already automatic is same_list; an input other than {} is invalid', async () => {
    const w = setup({ relays: DEFAULT_RELAYS });
    expect(await w.review(w.reset, {})).toEqual({ status: 409, body: { error: 'same_list' } });
    expect(await w.review(w.reset, { servers: own(2) })).toEqual({
      status: 400,
      body: { error: 'invalid' },
    });
  });
});

describe('GET /api/ui/network/progress', () => {
  it('is a read: {changedAt: null} before a change, the counts and items after', async () => {
    const w = setup();
    expect(await w.progressRoute.handler(w.context, w.req())).toEqual({
      status: 200,
      body: { changedAt: null },
    });
    Object.assign(w.progress, {
      changedAt: NOW,
      total: 2,
      sent: 1,
      waiting: 1,
      items: [
        { ref: '0xaa', name: 'Bob', state: 'sent' },
        { ref: '0xbb', name: 'Carol', state: 'waiting' },
      ],
      leavingUntil: NOW + DAYS30,
    });
    expect(await w.progressRoute.handler(w.context, w.req())).toEqual({
      status: 200,
      body: {
        changedAt: NOW,
        contacts: { total: 2, sent: 1, waiting: 1 },
        items: [
          { ref: '0xaa', name: 'Bob', state: 'sent' },
          { ref: '0xbb', name: 'Carol', state: 'waiting' },
        ],
        leavingUntil: NOW + DAYS30,
      },
    });
    const query = { params: {}, query: new URLSearchParams('x=1') };
    expect((await w.progressRoute.handler(w.context, query)).status).toBe(400);
  });
});

describe('IR L1: the re-test shares the Test budget (10 a minute per process, then 429 busy)', () => {
  it('the 11th review in a minute is busy; the Test and the review draw on one budget', async () => {
    let t = NOW * 1000;
    const budget = new PrecheckBudget(() => t);
    const w = setup({}, budget);
    const input = { servers: own(2), automatic: false, announce: true };
    for (let i = 0; i < 10; i += 1) expect((await w.review(w.servers, input)).status).toBe(200);
    expect(await w.review(w.servers, input)).toEqual({ status: 429, body: { error: 'busy' } });
    // A confirm that would test again is busy too: nothing reaches the presence gate.
    expect(await w.servers.precheck?.(w.context, w.req(input))).toEqual({
      status: 429,
      body: { error: 'busy' },
    });
    t += 61_000;
    expect((await w.review(w.servers, input)).status).toBe(200);
    // The Test route with the same budget: its tests count against the review's.
    const test = createNetworkTestRoute(() => ({ resolver, connector: memoryRelays() }), budget);
    for (let i = 0; i < 9; i += 1) {
      expect((await test.handler(w.context, { servers: own(1) })).status).toBe(200);
    }
    expect(await w.review(w.servers, input)).toEqual({ status: 429, body: { error: 'busy' } });
  });

  it('a reset never tests, so it never takes from the budget', async () => {
    let t = NOW * 1000;
    const budget = new PrecheckBudget(() => t);
    const w = setup({ relays: own(3) }, budget);
    const input = { servers: own(2), automatic: false, announce: true };
    for (let i = 0; i < 10; i += 1) await w.review(w.servers, input);
    expect((await w.review(w.reset, {})).status).toBe(200);
    t += 1;
  });
});

describe('IR L3: the opt-out and default servers', () => {
  it('the opt-out is refused while any own server is a default one', async () => {
    const w = setup();
    const res = await w.review(w.servers, {
      servers: [...own(1), DEFAULT_RELAYS[0] as string],
      automatic: false,
      announce: false,
    });
    expect(res).toEqual({ status: 409, body: { error: 'mix_in_on' } });
    const all = await w.review(w.servers, {
      servers: [...DEFAULT_RELAYS],
      automatic: false,
      announce: false,
    });
    expect(all).toEqual({ status: 409, body: { error: 'mix_in_on' } });
  });

  it('a reset clears the opt-out even when the list is already the default set', async () => {
    const w = setup({ relays: DEFAULT_RELAYS, announceDefault: false });
    expect((await w.review(w.reset, {})).status).toBe(200);
    expect((await w.confirm(w.reset, {})).status).toBe(200);
    expect(w.signed).toEqual([{ relays: DEFAULT_RELAYS, announceDefault: true }]);
    // Now automatic with the choice on: nothing left to clear.
    expect(await w.review(w.reset, {})).toEqual({ status: 409, body: { error: 'same_list' } });
  });

  it('the same own list with another announce choice is a change, not same_list', async () => {
    const w = setup({ relays: own(2), announceDefault: true });
    const input = { servers: own(2), automatic: false, announce: false };
    expect((await w.review(w.servers, input)).status).toBe(200);
    expect((await w.confirm(w.servers, input)).status).toBe(200);
    expect(w.signed).toEqual([{ relays: own(2), announceDefault: false }]);
  });
});

describe('NET-ANNOUNCE-OPTOUT: the old default servers and the OS sheet (IR L6)', () => {
  it('the opt-out is refused while any own server is one of the old default servers', async () => {
    const w = setup();
    const res = await w.review(w.servers, {
      servers: [...own(1), LEGACY_READ_RELAYS[0] as string],
      automatic: false,
      announce: false,
    });
    expect(res).toEqual({ status: 409, body: { error: 'mix_in_on' } });
  });

  it('the OS sheet names the change: "Use {n} message servers" for the confirmed plan', async () => {
    const w = setup({ relays: own(2, 'old') });
    const input = { servers: own(3), automatic: false, announce: true };
    expect(w.servers.sheetDetail?.(w.req(input))).toBeUndefined();
    await w.review(w.servers, input);
    expect(await w.servers.precheck?.(w.context, w.req(input))).toBeUndefined();
    expect(w.servers.sheetDetail?.(w.req(input))).toBe('Use 3 message servers');
    await w.review(w.reset, {});
    expect(await w.reset.precheck?.(w.context, w.req({}))).toBeUndefined();
    expect(w.reset.sheetDetail?.(w.req({}))).toBe(
      `Use ${String(DEFAULT_RELAYS.length)} message servers`,
    );
  });
});
