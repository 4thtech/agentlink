// U3-invite fix round (IR-U3-invite-SEC-4 (a), IR-U3-invite-2 low): the waiting invite while its
// accept is in flight, and the rules' refusal said before presence.
import { CoreError } from '@4thtech-io/core';
import { describe, expect, it } from 'vitest';
import type { LocalUiContext } from './context.js';
import { JOIN_ACCEPT_PATH } from './invite-paths.js';
import { JoinDesk, type JoinCheck } from './join-desk.js';
import type { LocalUiOwnerRoute } from './route-types.js';
import { createLocalUiRoutes } from './routes.js';

const LINK_A = `https://agentlink.4thtech.io/i#${'A'.repeat(40)}`;
const LINK_B = `https://agentlink.4thtech.io/i#${'B'.repeat(40)}`;
const ID_A = 'AQEBAQEBAQEBAQEBAQEBAQ';
const ID_B = 'BwcHBwcHBwcHBwcHBwcHBw';
const NOW_MS = 1_790_000_000_000;
const EXPIRES = 1_800_000_000;
const contact = {
  id: `0x${'1a'.repeat(20)}`,
  display: { name: 'Marko', label: 'self-declared', nameSource: 'counterparty' },
  ownerFingerprint: { short: '7F3A·19C2', long: 'AB'.repeat(32) },
  pairing: 'pending',
  safetyCodeChecked: false,
};
const check: JoinCheck = (link) =>
  link === LINK_A || link === LINK_B
    ? Promise.resolve({
        inviteId: link === LINK_A ? ID_A : ID_B,
        contact: contact as never,
        expiresAt: EXPIRES,
      })
    : Promise.reject(new CoreError('invite_invalid', 'x'));

describe('JoinDesk: an accept in flight is still shown (SEC-4 (a))', () => {
  it('a handoff cannot replace the invite while its accept is connecting', async () => {
    const desk = new JoinDesk(() => NOW_MS, check);
    expect(await desk.offer(LINK_A)).toBe('stored');
    const taken = desk.take(ID_A);
    expect(taken).toEqual({ link: LINK_A });
    expect(desk.shown()).toBe(true);
    expect(await desk.offer(LINK_B)).toBe('invite_waiting');
    // Still the same invite when the accept settles.
    desk.settle(ID_A, false);
    expect((await desk.view(undefined)).inviteId).toBe(ID_A);
  });

  it('connecting stays shown even past the expiry; after a started accept a new one is taken', async () => {
    let now = NOW_MS;
    const desk = new JoinDesk(() => now, check);
    await desk.offer(LINK_A);
    desk.take(ID_A);
    now = EXPIRES * 1000 + 1;
    expect(desk.shown()).toBe(true);
    now = NOW_MS;
    desk.settle(ID_A, true);
    expect(desk.shown()).toBe(false);
    expect(await desk.offer(LINK_B)).toBe('stored');
  });
});

describe('join accept precheck: the rules refuse new contacts (IR-U3-invite-2 low)', () => {
  const route = createLocalUiRoutes()
    .routes()
    .find((r) => r.path === JOIN_ACCEPT_PATH) as LocalUiOwnerRoute;

  async function precheck(decision: 'deny' | 'approval', inviteId = ID_A) {
    const desk = new JoinDesk(() => NOW_MS, check);
    await desk.offer(LINK_A);
    const context = {
      join: desk,
      client: { agentId: `0x${'42'.repeat(20)}`, contacts: { list: () => Promise.resolve([]) } },
      invites: { decision: () => Promise.resolve(decision) },
    } as unknown as LocalUiContext;
    return route.precheck?.(context, {
      params: {},
      query: new URLSearchParams(),
      input: { inviteId },
    });
  }

  it('answers policy_denied before presence when the rule is deny', async () => {
    expect(await precheck('deny')).toEqual({ status: 409, body: { error: 'policy_denied' } });
  });

  it('lets the request on otherwise; a changed inviteId is still invite_changed first', async () => {
    expect(await precheck('approval')).toBeUndefined();
    expect(await precheck('deny', ID_B)).toEqual({
      status: 409,
      body: { error: 'invite_changed' },
    });
  });
});
