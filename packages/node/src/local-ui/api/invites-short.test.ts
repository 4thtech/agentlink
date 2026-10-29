// W4-SHORT-INVITE and W4-INVITES-LIST (D-139; 04 §3.6.2; 08 §1): the local app's invite routes with
// short links. Create answers the link format and takes `long: true` only from the owner's page;
// the open-invites read answers name and expiry, never a link; Cancel is the invite kind with
// exactly `{inviteId}`; check and accept take a short link, resolve it ONCE (accept builds its
// action from the resolved invite, so the approval keeps it sealed and nothing re-fetches), and map
// a gone object and an unreachable drop to fixed codes. The answers follow the ui-contract samples.
import {
  CoreError,
  INVITE_LINK_PREFIX,
  type CreatedInvite,
  type PendingContact,
} from '@4thtech-io/core';
import type { JsonObject, OwnerPublicKeys } from '@4thtech-io/crypto';
import {
  INVITES_LIST,
  INVITE_CANCEL,
  INVITE_CANCEL_PATH,
  INVITES_PATH,
  INVITES_WORLD,
  SHORT_INVITE_REFUSALS,
} from '@4thtech-io/types/ui-contract/invites';
import { describe, expect, it } from 'vitest';
import type { LocalUiContext, LocalUiInviteAcceptPort } from '../context.js';
import type { OwnerSignRequest } from '../../owner-operation.js';
import type {
  LocalUiCheckedInvite,
  LocalUiInviteDesk,
  LocalUiOwnerOperation,
  LocalUiRequest,
} from '../route-types.js';
import {
  inviteAcceptRoute,
  inviteCancelRoute,
  inviteCheckRoute,
  inviteCreateRoute,
  invitesListRoute,
} from './invites.js';

const SHORT = INVITES_WORLD.shortLink;
const LONG = `${INVITE_LINK_PREFIX}${'q'.repeat(60)}`;
const AGENT = `0x${'1a'.repeat(20)}`;
const OWNER: OwnerPublicKeys = {
  ownerEvm: new Uint8Array(20).fill(1),
  ownerNostr: new Uint8Array(32).fill(2),
  ownerEnc: new Uint8Array(32).fill(3),
};
const CONTACT: PendingContact = {
  id: `0x${'3d'.repeat(20)}`,
  display: { name: 'Marko', label: 'self-declared', nameSource: 'counterparty' } as never,
  ownerFingerprint: { short: 'AB12·CD34', long: 'AB12CD34'.repeat(8) },
  pairing: 'pending',
  safetyCodeChecked: false,
};
const EXPIRES = 1_800_000_000; // 2027-01-15T08:00:00Z

function context(over: Partial<LocalUiContext> = {}): LocalUiContext {
  return {
    client: {} as never,
    ownerContext: () => Promise.resolve({ agent: AGENT, owner: OWNER }),
    applyOwnerAction: () => Promise.resolve({ status: 'applied', op: 'approval.decide' } as never),
    now: () => 1_790_000_000_000,
    ...over,
  };
}

function desk(over: Partial<LocalUiInviteDesk> = {}) {
  const created: unknown[] = [];
  const checked: string[] = [];
  const cancelled: string[] = [];
  const d: LocalUiInviteDesk = {
    create: (input) => {
      created.push(input);
      return Promise.resolve<CreatedInvite>({
        inviteUrl: input.long === true ? LONG : SHORT,
        format: input.long === true ? 'long' : 'short',
        ownerFingerprint: { short: '7F3A·19C2', long: '7F3A19C2'.repeat(8) },
        expiresAt: EXPIRES,
      });
    },
    check: (link) => {
      checked.push(link);
      return Promise.resolve<LocalUiCheckedInvite>({ contact: CONTACT, expiresAt: EXPIRES });
    },
    cancel: (id) => {
      cancelled.push(id);
      return Promise.resolve(id === INVITES_WORLD.inviteId ? 'cancelled' : 'not_found');
    },
    ...over,
  };
  return { desk: d, created, checked, cancelled };
}

const request = (): LocalUiRequest =>
  ({ method: 'GET', path: INVITES_PATH, query: new URLSearchParams(), input: undefined }) as never;

describe('create (D-139 (7))', () => {
  it('answers the short link and its format; `long: true` asks for the long link', async () => {
    const d = desk();
    const short = await inviteCreateRoute.handler(context(), {}, d.desk);
    expect(short.status).toBe(200);
    expect(short.body).toMatchObject({ status: 'ok', inviteUrl: SHORT, format: 'short' });
    const long = await inviteCreateRoute.handler(context(), { long: true, label: 'Bo' }, d.desk);
    expect(long.body).toMatchObject({ inviteUrl: LONG, format: 'long' });
    expect(d.created).toEqual([{}, { label: 'Bo', long: true }]);
  });

  it('refuses `long` other than true', async () => {
    const d = desk();
    for (const body of [{ long: false }, { long: 'yes' }, { long: 1 }] as unknown as JsonObject[]) {
      expect(await inviteCreateRoute.handler(context(), body, d.desk)).toEqual({
        status: 400,
        body: { error: 'invalid' },
      });
    }
    expect(d.created).toHaveLength(0);
  });
});

describe('open invites (W4-INVITES-LIST)', () => {
  it('GET /api/ui/invites answers name and expiry only, as the contract sample', async () => {
    expect(invitesListRoute).toMatchObject({ method: 'GET', path: INVITES_PATH, presence: false });
    const port = {
      list: () =>
        Promise.resolve([
          { inviteId: INVITES_WORLD.inviteId, label: 'Bo', expiresAt: EXPIRES },
          { inviteId: INVITES_WORLD.otherInviteId, label: null, expiresAt: EXPIRES },
        ]),
    } as unknown as LocalUiInviteAcceptPort;
    const result = await invitesListRoute.handler(context({ invites: port }), request());
    expect(result).toEqual(INVITES_LIST.two.answer);
    expect(JSON.stringify(result)).not.toContain('#');
  });

  it('a label that is too long or not text is answered as null; no agent is not set up', async () => {
    const port = {
      list: () =>
        Promise.resolve([
          { inviteId: INVITES_WORLD.inviteId, label: 'x'.repeat(500), expiresAt: EXPIRES },
        ]),
    } as unknown as LocalUiInviteAcceptPort;
    const result = await invitesListRoute.handler(context({ invites: port }), request());
    expect((result.body as { invites: { name: unknown }[] }).invites[0]?.name).toBeNull();
    expect((await invitesListRoute.handler(context(), request())).status).toBe(409);
  });
});

describe('cancel (04 §3.6.2: an owner action on the local page)', () => {
  it('is the invite kind at /api/ui/invites/cancel with exactly {inviteId}', async () => {
    expect(inviteCancelRoute).toMatchObject({
      method: 'POST',
      path: INVITE_CANCEL_PATH,
      presence: 'invite',
      step: 'cancel',
    });
    const d = desk();
    expect(
      await inviteCancelRoute.handler(context(), INVITE_CANCEL.cancelled.body, d.desk),
    ).toEqual(INVITE_CANCEL.cancelled.answer);
    expect(await inviteCancelRoute.handler(context(), INVITE_CANCEL.gone.body, d.desk)).toEqual(
      INVITE_CANCEL.gone.answer,
    );
    for (const body of [
      {},
      { inviteId: 'short' },
      { inviteId: 7 },
      { inviteId: INVITES_WORLD.inviteId, x: 1 },
    ] as unknown as JsonObject[]) {
      expect(await inviteCancelRoute.handler(context(), body, d.desk)).toEqual({
        status: 400,
        body: { error: 'invalid' },
      });
    }
    expect(d.cancelled).toEqual([INVITES_WORLD.inviteId, INVITES_WORLD.otherInviteId]);
  });
});

describe('check and accept a short link (04 §3.6.2)', () => {
  it('a short link reaches core; a malformed one does not', async () => {
    const d = desk();
    expect((await inviteCheckRoute.handler(context(), { invite: SHORT }, d.desk)).status).toBe(200);
    expect(
      (
        await inviteCheckRoute.handler(
          context(),
          { invite: SHORT.slice(INVITE_LINK_PREFIX.length) },
          d.desk,
        )
      ).status,
    ).toBe(200);
    for (const bad of [
      `${SHORT}A`,
      `${SHORT.slice(0, -1)}B`,
      SHORT.replace('https:', 'http:'),
      `${SHORT}#x`,
    ]) {
      expect(await inviteCheckRoute.handler(context(), { invite: bad }, d.desk)).toEqual({
        status: 400,
        body: { error: 'invalid_invite' },
      });
    }
    expect(d.checked).toEqual([SHORT, SHORT.slice(INVITE_LINK_PREFIX.length)]);
  });

  it('maps a gone object and an unreachable drop to the contract codes', async () => {
    const gone = desk({ check: () => Promise.reject(new CoreError('invite_unavailable', 'x')) });
    expect(await inviteCheckRoute.handler(context(), { invite: SHORT }, gone.desk)).toEqual(
      SHORT_INVITE_REFUSALS.unavailable.answer,
    );
    const down = desk({ check: () => Promise.reject(new CoreError('invite_fetch_failed', 'x')) });
    expect(await inviteCheckRoute.handler(context(), { invite: SHORT }, down.desk)).toEqual(
      SHORT_INVITE_REFUSALS.retry.answer,
    );
  });

  it('accept resolves the short link once and uses the resolved invite for every step', async () => {
    const resolved: string[] = [];
    const seen: string[] = [];
    const port: LocalUiInviteAcceptPort = {
      resolve: (link) => {
        resolved.push(link);
        return Promise.resolve(LONG);
      },
      list: () => Promise.resolve([]),
      check: (link) => {
        seen.push(`check:${link}`);
        return Promise.resolve(CONTACT);
      },
      decision: () => Promise.resolve('approval'),
      action: (link) => {
        seen.push(`action:${link}`);
        return Promise.resolve({
          tool: 'agentlink_accept_invite',
          args: { inviteUrl: link },
          context: {
            triggers: ['contacts.acceptInvites'],
            inviteId: 'AQEBAQEBAQEBAQEBAQEBAQ',
            counterparty: { agentId: CONTACT.id, ownerKey: 'ab'.repeat(32) },
          },
        });
      },
      openRequest: () => Promise.resolve({ approvalId: 'ap1', expiresAt: 1_790_000_600 }),
      acceptApproved: (link) => {
        seen.push(`accept:${link}`);
        return Promise.resolve({ status: 'started', contact: CONTACT, sent: true });
      },
    };
    const owner: LocalUiOwnerOperation = {
      sign: (_req: OwnerSignRequest, items) =>
        Promise.resolve(items.map(() => ({ kind: 'owner-action', signed: {} as never })) as never),
    } as unknown as LocalUiOwnerOperation;
    const result = await inviteAcceptRoute.handler(
      context({ invites: port }),
      { ...request(), method: 'POST', input: { invite: SHORT } } as never,
      owner,
    );
    expect(result.status).toBe(200);
    expect(resolved).toEqual([SHORT]);
    expect(seen).toEqual([`check:${LONG}`, `action:${LONG}`, `accept:${LONG}`]);
  });

  it('accept maps a gone short link before anything is signed', async () => {
    let signed = 0;
    const port = {
      resolve: () => Promise.reject(new CoreError('invite_unavailable', 'x')),
    } as unknown as LocalUiInviteAcceptPort;
    const owner = {
      sign: () => {
        signed += 1;
        return Promise.resolve([]);
      },
    } as unknown as LocalUiOwnerOperation;
    const result = await inviteAcceptRoute.handler(
      context({ invites: port }),
      { ...request(), method: 'POST', input: { invite: SHORT } } as never,
      owner,
    );
    expect(result).toEqual(SHORT_INVITE_REFUSALS.unavailable.answer);
    expect(signed).toBe(0);
  });
});
