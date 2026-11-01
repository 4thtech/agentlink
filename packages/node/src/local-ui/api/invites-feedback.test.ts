// W5-INVITE-FEEDBACK (08 §1; 04 §2.9; I-5, I-7): the invite answers that let both sides follow an
// invite. The open invites list also answers the accepts that wait (`connecting`), check says when
// the invite comes from an existing contact (`alreadyContact`), accept says when it was a re-pair
// (`again`), and contact rows carry `pairedAt`. Real handlers, fake core ports; answers against the
// shared contract samples.
import type { ContactView, PendingContact } from '@4thtech-io/core';
import type { OwnerPublicKeys } from '@4thtech-io/crypto';
import {
  FEEDBACK_WORLD,
  INVITES_CONNECTING,
  INVITE_ACCEPT_AGAIN_OFFLINE,
  INVITE_CHECK_AGAIN,
} from '@4thtech-io/types/ui-contract/invite-feedback';
import { describe, expect, it } from 'vitest';
import type { LocalUiContext, LocalUiInviteAcceptPort } from '../context.js';
import type {
  LocalUiCheckedInvite,
  LocalUiInviteDesk,
  LocalUiOwnerOperation,
  LocalUiRequest,
} from '../route-types.js';
import { contactsRoutes } from './contacts.js';
import { inviteAcceptRoute, inviteCheckRoute, invitesListRoute } from './invites.js';

const LINK = `https://agentlink.4thtech.io/i#${'q'.repeat(60)}`;
const EXPIRES = 1_800_000_000; // 2027-01-15T08:00:00Z
const OWNER: OwnerPublicKeys = {
  ownerEvm: new Uint8Array(20).fill(1),
  ownerNostr: new Uint8Array(32).fill(2),
  ownerEnc: new Uint8Array(32).fill(3),
};
const PENDING: PendingContact = {
  id: FEEDBACK_WORLD.ref,
  display: { name: 'Marko', label: 'self-declared', nameSource: 'counterparty' } as never,
  ownerFingerprint: { short: 'AB12·CD34', long: 'AB12CD34'.repeat(8) },
  pairing: 'pending',
  safetyCodeChecked: false,
};

const view = (over: Partial<ContactView> = {}): ContactView =>
  ({
    id: FEEDBACK_WORLD.ref,
    name: { value: 'Marko', source: 'owner', selfDeclared: false },
    display: { name: 'Marko (work)', label: 'self-declared', nameSource: 'owner' },
    ownerFingerprint: { short: 'AB12·CD34', long: 'AB12CD34'.repeat(8) },
    status: 'active',
    pairing: 'complete',
    safetyCodeChecked: false,
    createdAt: 1_790_000_000,
    updatedAt: 1_790_000_000,
    pairedAt: 1_790_000_100,
    ...over,
  }) as unknown as ContactView;

function context(over: Partial<LocalUiContext> = {}, contacts: ContactView[] = []): LocalUiContext {
  return {
    client: { contacts: { list: () => Promise.resolve(contacts) } } as never,
    ownerContext: () => Promise.resolve({ agent: `0x${'1a'.repeat(20)}`, owner: OWNER }),
    applyOwnerAction: () => Promise.resolve({ status: 'applied', op: 'approval.decide' } as never),
    now: () => 1_790_000_000_000,
    ...over,
  };
}

const desk: LocalUiInviteDesk = {
  create: () => Promise.reject(new Error('unused')),
  check: () => Promise.resolve<LocalUiCheckedInvite>({ contact: PENDING, expiresAt: EXPIRES }),
  cancel: () => Promise.resolve('not_found'),
};

const request = (over: Partial<LocalUiRequest> = {}): LocalUiRequest =>
  ({
    method: 'GET',
    path: '/api/ui/invites',
    query: new URLSearchParams(),
    params: {},
    input: undefined,
    ...over,
  }) as never;

describe('open invites also list the accepts that wait (connecting)', () => {
  it('answers ref, name, expiry, sent and again only, as the contract sample', async () => {
    const port = {
      list: () => Promise.resolve([]),
      connecting: () =>
        Promise.resolve([
          {
            id: FEEDBACK_WORLD.ref,
            display: { name: 'Marko', label: 'self-declared', nameSource: 'counterparty' },
            expiresAt: EXPIRES,
            sent: false,
            again: false,
          },
        ]),
    } as unknown as LocalUiInviteAcceptPort;
    const result = await invitesListRoute.handler(context({ invites: port }), request());
    expect(result).toEqual(INVITES_CONNECTING.answer);
  });

  it('leaves out a row of another shape and answers no connecting when it cannot be read', async () => {
    const bad = {
      list: () => Promise.resolve([]),
      connecting: () =>
        Promise.resolve([
          { id: 'not-a-ref', display: { name: 'X' }, expiresAt: EXPIRES, sent: true, again: false },
          {
            id: FEEDBACK_WORLD.ref,
            display: { name: 'y'.repeat(500) },
            expiresAt: EXPIRES,
            sent: true,
            again: false,
          },
        ]),
    } as unknown as LocalUiInviteAcceptPort;
    const first = await invitesListRoute.handler(context({ invites: bad }), request());
    expect((first.body as { connecting: unknown[] }).connecting).toEqual([]);
    const failing = {
      list: () => Promise.resolve([]),
      connecting: () => Promise.reject(new Error(`secret ${LINK}`)),
    } as unknown as LocalUiInviteAcceptPort;
    const second = await invitesListRoute.handler(context({ invites: failing }), request());
    expect(second.status).toBe(200);
    expect((second.body as { connecting: unknown[] }).connecting).toEqual([]);
    expect(JSON.stringify(second)).not.toContain('secret');
  });
});

describe('check says when the invite comes from an existing contact', () => {
  it('answers alreadyContact {ref, name} under the name the owner sees', async () => {
    const result = await inviteCheckRoute.handler(context({}, [view()]), { invite: LINK }, desk);
    expect(result).toEqual(INVITE_CHECK_AGAIN.answer);
  });

  it('answers no alreadyContact for a new agent, a removed or a still pending contact', async () => {
    for (const contacts of [
      [],
      [view({ id: `0x${'4e'.repeat(20)}` })],
      [view({ pairing: 'pending' })],
      [view({ status: 'blocked' })],
    ]) {
      const result = await inviteCheckRoute.handler(context({}, contacts), { invite: LINK }, desk);
      expect(result.status).toBe(200);
      expect(result.body).not.toHaveProperty('alreadyContact');
    }
  });

  it('a contacts read that fails changes nothing else', async () => {
    const ctx = context({
      client: { contacts: { list: () => Promise.reject(new Error('x')) } } as never,
    });
    const result = await inviteCheckRoute.handler(ctx, { invite: LINK }, desk);
    expect(result.status).toBe(200);
    expect(result.body).not.toHaveProperty('alreadyContact');
  });
});

describe('accept says when it was a re-pair (again)', () => {
  const port = (sent: boolean): LocalUiInviteAcceptPort =>
    ({
      resolve: (link: string) => Promise.resolve(link),
      list: () => Promise.resolve([]),
      check: () => Promise.resolve(PENDING),
      decision: () => Promise.resolve('ask'),
      action: (link: string) =>
        Promise.resolve({
          tool: 'agentlink_accept_invite',
          args: { inviteUrl: link },
          context: {
            triggers: ['contacts.acceptInvites'],
            inviteId: 'AQEBAQEBAQEBAQEBAQEBAQ',
            counterparty: { agentId: PENDING.id, ownerKey: 'ab'.repeat(32) },
          },
        }),
      openRequest: () =>
        Promise.resolve({ approvalId: `apr_${'A'.repeat(22)}`, expiresAt: 1_790_000_600 }),
      acceptApproved: () => Promise.resolve({ status: 'started', contact: PENDING, sent }),
    }) as unknown as LocalUiInviteAcceptPort;
  const owner = {
    sign: (_r: unknown, items: readonly unknown[]) =>
      Promise.resolve(items.map(() => ({ kind: 'owner-action', signed: {} }))),
  } as unknown as LocalUiOwnerOperation;

  it('answers again and sent, as the contract sample', async () => {
    const result = await inviteAcceptRoute.handler(
      context({ invites: port(false) }, [view()]),
      request({ method: 'POST', input: { invite: LINK } }),
      owner,
    );
    expect(result).toEqual(INVITE_ACCEPT_AGAIN_OFFLINE.answer);
  });

  it('answers again: false for a first pairing', async () => {
    const result = await inviteAcceptRoute.handler(
      context({ invites: port(true) }, []),
      request({ method: 'POST', input: { invite: LINK } }),
      owner,
    );
    expect(result.body).toMatchObject({ status: 'pending', sent: true, again: false });
  });
});

describe('contact rows carry pairedAt', () => {
  it('answers pairedAt for a paired contact and leaves it out when core has none', async () => {
    const list = contactsRoutes.find((r) => r.method === 'GET' && r.path === '/api/ui/contacts');
    if (list === undefined || list.presence !== false) throw new Error('test: no list route');
    const result = await list.handler(
      context({}, [view(), view({ id: `0x${'4e'.repeat(20)}`, pairedAt: undefined } as never)]),
      request({ path: '/api/ui/contacts' }),
    );
    const rows = (result.body as { contacts: Record<string, unknown>[] }).contacts;
    expect(rows[0]?.['pairedAt']).toBe(1_790_000_100);
    expect(rows[1]).not.toHaveProperty('pairedAt');
  });
});
