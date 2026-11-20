// NET-ANNOUNCE-OPTOUT (S2; D-158 (7); 08 §1 `POST /api/ui/network/announce`; 04 §2.5.1
// `network.announce`; 07 §4.3 "Privacy"; I-4, I-7): turning "Don't also announce on the default
// servers" on or off without changing the list.
//
// - An owner route (presence). Input exactly `{announce: true | false}`; anything else is 400.
// - Before the gesture (precheck, nothing opened or signed): 409 `mix_in_on` for `false` while the
//   list holds a default server; `same_choice` when nothing would change; the agent's state refusals.
// - After the gesture it signs exactly `network.announce` {agent, announceDefault} for the open
//   agent, has core apply it, then runs the clean-up (pending retries to the default servers end).
// - The OS sheet names the action (IR NET-OWNER-SET L6): the route's `sheetDetail`.
import type { JsonObject, JsonValue } from '@4thtech-io/crypto';
import { DEFAULT_RELAYS } from '@4thtech-io/transport-nostr';
import { describe, expect, it } from 'vitest';
import type { LocalUiContext, LocalUiServerListPort } from '../context.js';
import type { LocalUiOwnerOperation, LocalUiOwnerRoute, LocalUiResult } from '../route-types.js';
import type { OwnerReview, OwnerSignRequest } from '../../owner-operation.js';
import { NETWORK_ANNOUNCE_PATH, networkAnnounceRoute } from './network-announce.js';

const AGENT = '0x71c4000000000000000000000000000000009a2e';
const OWN = ['wss://one.example.org', 'wss://two.example.org'];

interface Fake {
  relays: readonly string[];
  announceDefault: boolean;
  paused: boolean;
  sendState: string;
  prepareReason?: string;
  applied?: string;
}

function setup(over: Partial<Fake> = {}) {
  const state: Fake = {
    relays: OWN,
    announceDefault: true,
    paused: false,
    sendState: 'ready',
    ...over,
  };
  const calls = { prepared: [] as boolean[], applied: [] as unknown[], after: 0 };
  const serverList: LocalUiServerListPort = {
    state: () =>
      Promise.resolve({
        relays: state.relays,
        leaving: [],
        announceDefault: state.announceDefault,
        paused: state.paused,
        sendState: state.sendState as never,
      }),
    contacts: () => Promise.resolve(0),
    progress: () =>
      Promise.resolve({
        changedAt: null,
        total: 0,
        sent: 0,
        waiting: 0,
        items: [],
        leavingUntil: null,
      }),
    prepareAnnounce: (value: boolean) => {
      calls.prepared.push(value);
      if (state.prepareReason !== undefined) {
        return Promise.resolve({
          status: 'refused',
          op: 'network.announce',
          reason: state.prepareReason,
        } as never);
      }
      return Promise.resolve({
        status: 'prepared',
        body: {
          v: 1,
          agent: AGENT,
          owner: 'ab'.repeat(32),
          op: 'network.announce',
          params: { agent: AGENT, announceDefault: value },
          nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
          issuedAt: 1_800_000_000,
          expiresAt: 1_800_000_600,
        },
      } as never);
    },
    afterAnnounce: () => {
      calls.after += 1;
      return Promise.resolve();
    },
  };
  const context = {
    client: { agentId: AGENT },
    serverList,
    now: () => 1_800_000_000_000,
    applyOwnerAction: (signed: unknown) => {
      calls.applied.push(signed);
      return Promise.resolve(
        state.applied === undefined
          ? { status: 'applied', op: 'network.announce' }
          : { status: 'refused', op: 'network.announce', reason: state.applied },
      );
    },
  } as unknown as LocalUiContext;
  const signed: { review: OwnerReview; requests: readonly OwnerSignRequest[] }[] = [];
  const owner: LocalUiOwnerOperation = {
    sign: (review, requests) => {
      signed.push({ review, requests });
      return Promise.resolve(
        requests.map((r) => ({
          kind: 'owner-action' as const,
          signed: { body: (r as { action: JsonObject }).action, sig: 'cd'.repeat(64) },
        })) as never,
      );
    },
  };
  return { state, calls, context, owner, signed };
}

const route = networkAnnounceRoute as LocalUiOwnerRoute;
const request = (input?: JsonValue) => ({
  params: {},
  query: new URLSearchParams(),
  ...(input === undefined ? {} : { input }),
});
const errorOf = (r: LocalUiResult | undefined) => (r?.body as Record<string, unknown>)['error'];

describe('POST /api/ui/network/announce (NET-ANNOUNCE-OPTOUT)', () => {
  it('is an owner route at its own path', () => {
    expect(route.method).toBe('POST');
    expect(route.path).toBe(NETWORK_ANNOUNCE_PATH);
    expect(NETWORK_ANNOUNCE_PATH).toBe('/api/ui/network/announce');
    expect(route.presence).toBe(true);
    expect(route.precheck).toBeDefined();
  });

  it('takes exactly {announce: boolean}', async () => {
    const t = setup();
    for (const input of [
      undefined,
      {},
      { announce: 'false' },
      { announce: 0 },
      { announce: false, servers: OWN },
      { announce: false, review: true },
      [false],
    ] as (JsonValue | undefined)[]) {
      const pre = await route.precheck?.(t.context, request(input));
      expect(pre?.status, JSON.stringify(input)).toBe(400);
      const res = await route.handler(t.context, request(input), t.owner);
      expect(res.status, JSON.stringify(input)).toBe(400);
    }
    expect(t.signed).toEqual([]);
  });

  it('refuses the opt-out with mix_in_on before the gesture while the list holds a default server', async () => {
    const t = setup({ relays: [OWN[0] as string, DEFAULT_RELAYS[0] as string] });
    const pre = await route.precheck?.(t.context, request({ announce: false }));
    expect(pre?.status).toBe(409);
    expect(errorOf(pre)).toBe('mix_in_on');
    const res = await route.handler(t.context, request({ announce: false }), t.owner);
    expect(errorOf(res)).toBe('mix_in_on');
    expect(t.signed).toEqual([]);
    expect(t.calls.prepared).toEqual([]);
  });

  it('refuses nothing-to-change and the agent state before the gesture', async () => {
    expect(
      errorOf(await route.precheck?.(setup().context, request({ announce: true }))),
    ).toBe('same_choice');
    expect(
      errorOf(await route.precheck?.(setup({ paused: true }).context, request({ announce: false }))),
    ).toBe('agent_paused');
    expect(
      errorOf(
        await route.precheck?.(
          setup({ sendState: 'rotation_pending' }).context,
          request({ announce: false }),
        ),
      ),
    ).toBe('rotation_pending');
    expect(await route.precheck?.(setup().context, request({ announce: false }))).toBeUndefined();
  });

  it('signs exactly network.announce for the open agent, applies it, then cleans up', async () => {
    const t = setup();
    const res = await route.handler(t.context, request({ announce: false }), t.owner);
    expect(res).toEqual({ status: 200, body: { status: 'done', announceDefault: false } });
    expect(t.calls.prepared).toEqual([false]);
    expect(t.signed).toHaveLength(1);
    const [only] = t.signed[0]?.requests ?? [];
    expect(only?.kind).toBe('owner-action');
    const action = (only as { action: JsonObject }).action;
    expect(action['op']).toBe('network.announce');
    expect(action['params']).toEqual({ agent: AGENT, announceDefault: false });
    expect(t.calls.applied).toHaveLength(1);
    expect(t.calls.after).toBe(1);
    // The owner statement names the action; never a host or a list.
    const lines = t.signed[0]?.review.lines.join(' ') ?? '';
    expect(lines).toMatch(/default servers/);
    expect(lines).not.toMatch(/example\.org|wss:/);
  });

  it('turning it back on signs announceDefault true; a list with default servers is no bar', async () => {
    const t = setup({ announceDefault: false, relays: OWN });
    const res = await route.handler(t.context, request({ announce: true }), t.owner);
    expect(res.status).toBe(200);
    const action = (t.signed[0]?.requests[0] as { action: JsonObject }).action;
    expect(action['params']).toEqual({ agent: AGENT, announceDefault: true });
  });

  it('signs nothing for a body that is not exactly the asked change', async () => {
    const t = setup();
    // A prepare that answered another choice (a bug or a race) is never signed.
    t.context.serverList!.prepareAnnounce = () =>
      Promise.resolve({
        status: 'prepared',
        body: {
          op: 'network.announce',
          agent: AGENT,
          params: { agent: AGENT, announceDefault: true },
        },
      } as never);
    const res = await route.handler(t.context, request({ announce: false }), t.owner);
    expect(errorOf(res)).toBe('not_applied');
    expect(t.signed).toEqual([]);
  });

  it('core refusals after the gesture are fixed codes, and no clean-up runs', async () => {
    const t = setup({ applied: 'mix_in_on' });
    const res = await route.handler(t.context, request({ announce: false }), t.owner);
    expect(errorOf(res)).toBe('mix_in_on');
    expect(t.calls.after).toBe(0);
    const u = setup({ prepareReason: 'mix_in_on' });
    expect(errorOf(await route.handler(u.context, request({ announce: false }), u.owner))).toBe(
      'mix_in_on',
    );
    expect(u.signed).toEqual([]);
  });

  it('the OS sheet names the action (sheetDetail), a plain single line', () => {
    const on = route.sheetDetail?.(request({ announce: false }));
    const off = route.sheetDetail?.(request({ announce: true }));
    expect(on).toMatch(/default servers/);
    expect(off).toMatch(/default servers/);
    expect(on).not.toBe(off);
    for (const d of [on, off]) {
      expect([...(d ?? '')].length).toBeLessThanOrEqual(64);
      expect(d).not.toMatch(/[\u0000-\u001f]/u);
    }
    expect(route.sheetDetail?.(request({ announce: 'x' }))).toBeUndefined();
  });
});
