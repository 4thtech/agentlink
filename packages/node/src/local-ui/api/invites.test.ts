// UX2-d1: the invite handlers of the local app (08 §1; 04 §3.6, §3.6.1, §4; 06 §2.1; b11 §21;
// owner decision 1.1; I-1, I-4, I-5, I-7).
//
// - Create (`presence: 'invite'`, step `create`): body `{}` or `{"label": "<name>"}`; core
//   `createInvite`; answers what `agentlink_create_invite` answers (link, share text, the owner's
//   short fingerprint, expiry). No owner presence, nothing signed.
// - Check (`presence: 'invite'`, step `check`): body `{"invite": "<link>"}`; core's accept step 1
//   only (the one D-69 codec, schema, signatures, relay URL rule); stores nothing; answers who it is.
// - Accept (`presence: true`): input `{"invite": "<link>"}` behind the owner-presence gate. The owner's
//   presence signs one `approval.decide` (approve) for the accept action under
//   `contacts.acceptInvites`; core applies it, then uses it once and stages the pairing. A `deny`
//   rule or a bad invite signs nothing.
// - The link is never echoed in an answer, and only the canonical link form or the bare payload
//   reaches core: any other host, scheme or shape is refused before it.
import { deflateRawSync } from 'node:zlib';
import {
  INVITE_LINK_PREFIX,
  CoreError,
  acceptInviteSummary,
  decodeInviteLink,
  type CreatedInvite,
  type PendingContact,
} from '@4thtech-io/core';
import {
  canonicalizeToBytes,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  sha256,
  type JsonObject,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import { describe, expect, it } from 'vitest';
import type { LocalUiContext, LocalUiInviteAcceptPort } from '../context.js';
import { INVITE_ACCEPT_PATH, INVITE_CHECK_PATH, INVITE_CREATE_PATH } from '../invite-paths.js';
import type { OwnerSignRequest } from '../../owner-operation.js';
import {
  UI_NOT_SET_UP,
  type LocalUiCheckedInvite,
  type LocalUiInviteDesk,
  type LocalUiOwnerOperation,
} from '../route-types.js';
import {
  INVITE_LINK_MAX_CHARS,
  inviteAcceptRoute,
  inviteCheckRoute,
  inviteCreateRoute,
} from './invites.js';

const PAYLOAD = 'q'.repeat(40) + '_-' + 'Z'.repeat(40);
const LINK = `${INVITE_LINK_PREFIX}${PAYLOAD}`;
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
const CONTACT_OUT = { name: 'Marko', label: 'self-declared', ownerFingerprint: 'AB12·CD34' };

/** Links and payload shapes that must never reach core (04 §4; 04 §3.6 decoder step 1). */
const NOT_A_LINK = [
  `http://169.254.169.254/i#${PAYLOAD}`,
  `http://127.0.0.1:8080/i#${PAYLOAD}`,
  `https://evil.example/i#${PAYLOAD}`,
  `https://agentlink.4thtech.io.evil.example/i#${PAYLOAD}`,
  `http://agentlink.4thtech.io/i#${PAYLOAD}`,
  `https://agentlink.4thtech.io/x#${PAYLOAD}`,
  `file:///etc/passwd#${PAYLOAD}`,
  `javascript:alert(1)//${PAYLOAD}`,
  `${LINK}#again`,
  ` ${LINK}`,
  `${LINK}\n`,
  `${INVITE_LINK_PREFIX}${PAYLOAD}%2F`,
  `${INVITE_LINK_PREFIX}`,
  '',
  'a'.repeat(INVITE_LINK_MAX_CHARS + 1),
];

const coreError = (code: string): CoreError => new CoreError(code as never, `secret ${LINK}`);

function context(over: Partial<LocalUiContext> = {}): LocalUiContext {
  return {
    client: {} as never,
    ownerContext: () => Promise.resolve({ agent: AGENT, owner: OWNER }),
    applyOwnerAction: () => Promise.resolve({ status: 'applied', op: 'approval.decide' } as never),
    now: () => 1_790_000_000_000,
    ...over,
  };
}

// --- create -----------------------------------------------------------------------------------

function desk(over: Partial<LocalUiInviteDesk> = {}): {
  desk: LocalUiInviteDesk;
  created: unknown[];
  checked: string[];
} {
  const created: unknown[] = [];
  const checked: string[] = [];
  return {
    created,
    checked,
    desk: {
      create: (input) => {
        created.push(input);
        return Promise.resolve<CreatedInvite>({
          inviteId: 'AQEBAQEBAQEBAQEBAQEBAQ',
          inviteUrl: LINK,
          format: 'long',
          ownerFingerprint: { short: 'EF56·7890', long: 'EF567890'.repeat(8) },
          expiresAt: 1_793_786_400,
        });
      },
      check: (link) => {
        checked.push(link);
        return Promise.resolve<LocalUiCheckedInvite>({
          contact: CONTACT,
          expiresAt: 1_793_786_400,
        });
      },
      cancel: () => Promise.resolve('not_found'),
      ...over,
    },
  };
}

describe('create an invite (UX2-d1, decision 1.1)', () => {
  it('is the invite kind, step create, a POST at /api/ui/invites', () => {
    expect(inviteCreateRoute).toMatchObject({
      method: 'POST',
      path: INVITE_CREATE_PATH,
      presence: 'invite',
      step: 'create',
    });
    expect(INVITE_CREATE_PATH).toBe('/api/ui/invites');
  });

  it('answers what agentlink_create_invite answers: link, share text, fingerprint, expiry', async () => {
    const d = desk();
    const result = await inviteCreateRoute.handler(context(), {}, d.desk);
    expect(result).toEqual({
      status: 200,
      body: {
        status: 'ok',
        inviteUrl: LINK,
        shareText: `Let's connect our AI agents with AgentLink. Open this link and follow the steps; it works once, until 4 Nov 2026: ${LINK}`,
        ownerFingerprint: 'EF56·7890',
        expiresAt: '2026-11-04T10:00:00Z',
        format: 'long',
        // W4-PEOPLE-INVITE (IR-1 M): the public ID of this invite, so the page cancels only its own.
        inviteId: 'AQEBAQEBAQEBAQEBAQEBAQ',
      },
    });
    expect(d.created).toEqual([{}]);
  });

  it('answers nothing usable when core gives an invite ID of another shape (fail closed)', async () => {
    const d = desk({
      create: () =>
        Promise.resolve<CreatedInvite>({
          inviteId: 'not an id/../x',
          inviteUrl: LINK,
          format: 'long',
          ownerFingerprint: { short: 'EF56·7890', long: 'EF567890'.repeat(8) },
          expiresAt: 1_793_786_400,
        }),
    });
    const result = await inviteCreateRoute.handler(context(), {}, d.desk);
    expect(result.status).not.toBe(200);
  });

  it('passes the optional name as the invite label (a suggested alias in core)', async () => {
    const d = desk();
    expect((await inviteCreateRoute.handler(context(), { label: 'Marko' }, d.desk)).status).toBe(
      200,
    );
    expect(d.created).toEqual([{ label: 'Marko' }]);
  });

  it('refuses any other body before core is called', async () => {
    const d = desk();
    for (const body of [
      { label: 7 },
      { label: '' },
      { label: 'x'.repeat(129) },
      { label: ['Marko'] },
      { label: null },
      { name: 'Marko' },
      { label: 'Marko', expiresInDays: 1 },
      { inviteUrl: LINK },
    ] as unknown as JsonObject[]) {
      const result = await inviteCreateRoute.handler(context(), body, d.desk);
      expect(result, JSON.stringify(body)).toEqual({ status: 400, body: { error: 'invalid' } });
    }
    expect(d.created).toHaveLength(0);
  });

  it('maps core errors to fixed codes and never answers an error text or the link', async () => {
    const cases: [string, number, string][] = [
      ['name_invalid', 400, 'invalid_label'],
      ['identity_missing', 409, 'not_set_up'],
      ['identity_revoked', 409, 'cannot_send'],
      ['rotation_pending', 409, 'cannot_send'],
      ['store_unavailable', 503, 'unavailable'],
    ];
    for (const [code, status, error] of cases) {
      const d = desk({ create: () => Promise.reject(coreError(code)) });
      const result = await inviteCreateRoute.handler(context(), { label: 'M' }, d.desk);
      expect(result, code).toEqual({ status, body: { error } });
    }
    const plain = desk({ create: () => Promise.reject(new Error(`boom ${LINK}`)) });
    const result = await inviteCreateRoute.handler(context(), {}, plain.desk);
    expect(result).toEqual({ status: 503, body: { error: 'unavailable' } });
  });

  it('answers not_set_up without an agent', async () => {
    expect(await inviteCreateRoute.handler(context({ client: undefined }), {}, undefined)).toBe(
      UI_NOT_SET_UP,
    );
  });
});

// --- check ------------------------------------------------------------------------------------

describe('check an invite before connecting (UX2-d1, b11 §21.4)', () => {
  it('is the invite kind, step check, a POST at /api/ui/invites/check', () => {
    expect(inviteCheckRoute).toMatchObject({
      method: 'POST',
      path: INVITE_CHECK_PATH,
      presence: 'invite',
      step: 'check',
    });
    expect(INVITE_CHECK_PATH).toBe('/api/ui/invites/check');
  });

  it('answers who it is (name rule, label, short fingerprint) and the expiry, never the link', async () => {
    const d = desk();
    for (const invite of [LINK, PAYLOAD]) {
      const result = await inviteCheckRoute.handler(context(), { invite }, d.desk);
      expect(result).toEqual({
        status: 200,
        body: { status: 'ok', contact: CONTACT_OUT, expiresAt: '2026-11-04T10:00:00Z' },
      });
      expect(JSON.stringify(result)).not.toContain(PAYLOAD);
    }
    expect(d.checked).toEqual([LINK, PAYLOAD]);
  });

  it('refuses another host, scheme, shape or size before core reads it (04 §4)', async () => {
    const d = desk();
    for (const invite of NOT_A_LINK) {
      const result = await inviteCheckRoute.handler(context(), { invite }, d.desk);
      expect(result, invite.slice(0, 60)).toEqual({
        status: 400,
        body: { error: 'invalid_invite' },
      });
    }
    for (const body of [{}, { invite: 7 }, { invite: LINK, x: 1 }, { link: LINK }] as never[]) {
      const result = await inviteCheckRoute.handler(context(), body, d.desk);
      expect(result).toEqual({ status: 400, body: { error: 'invalid' } });
    }
    expect(d.checked).toHaveLength(0);
  });

  it('maps core refusals to fixed codes, never with the link or an error text', async () => {
    const cases: [string, number, string][] = [
      ['invite_expired', 400, 'expired'],
      ['contact_is_self', 400, 'own_invite'],
      ['invite_invalid', 400, 'invalid_invite'],
      ['invite_too_large', 400, 'invalid_invite'],
      ['card_owner_signature_invalid', 400, 'invalid_invite'],
      ['relays_invalid', 400, 'invalid_invite'],
      ['name_invalid', 400, 'invalid_invite'],
      ['contact_conflict', 409, 'cannot_pair'],
      ['identity_missing', 409, 'not_set_up'],
      ['identity_revoked', 409, 'cannot_send'],
    ];
    for (const [code, status, error] of cases) {
      const d = desk({ check: () => Promise.reject(coreError(code)) });
      const result = await inviteCheckRoute.handler(context(), { invite: LINK }, d.desk);
      expect(result, code).toEqual({ status, body: { error } });
    }
  });

  it('an invite naming a private relay is refused by the one codec (04 §4 relay URL rule)', async () => {
    // A schema-shaped invite whose relay is a loopback address, packed as the codec packs it.
    const json = JSON.stringify({
      v: 1,
      inviteId: encodeBase64url(new Uint8Array(16).fill(1)),
      secret: encodeBase64url(new Uint8Array(32).fill(2)),
      card: {
        version: 1,
        agentEvm: `0x${'1a'.repeat(20)}`,
        agentNostr: `0x${'d4'.repeat(32)}`,
        agentEnc: `0x${'0e'.repeat(32)}`,
        ownerEvm: `0x${'2b'.repeat(20)}`,
        ownerNostr: `0x${'c3'.repeat(32)}`,
        ownerEnc: `0x${'0f'.repeat(32)}`,
        nameHash: `0x${'11'.repeat(32)}`,
        relaysHash: `0x${'22'.repeat(32)}`,
        issuedAt: 1760000000,
        expiresAt: 0,
        keyEpoch: 0,
      },
      cardSig: `0x${'3c'.repeat(64)}1b`,
      cardAgentSig: `0x${'4d'.repeat(64)}1c`,
      codeCommit: encodeBase64url(new Uint8Array(32).fill(3)),
      name: 'Marko',
      relays: ['wss://127.0.0.1:7447', 'ws://169.254.169.254'],
      expiresAt: 1_800_000_000,
    });
    const ssrf = `${INVITE_LINK_PREFIX}${encodeBase64url(deflateRawSync(encodeUtf8(json)))}`;
    const d = desk({
      check: async (link) => {
        await decodeInviteLink(link);
        throw new Error('unreachable: the codec accepted it');
      },
    });
    const result = await inviteCheckRoute.handler(context(), { invite: ssrf }, d.desk);
    expect(result).toEqual({ status: 400, body: { error: 'invalid_invite' } });
  });

  it('answers not_set_up without an agent', async () => {
    expect(
      await inviteCheckRoute.handler(context({ client: undefined }), { invite: LINK }, undefined),
    ).toBe(UI_NOT_SET_UP);
  });
});

// --- accept -----------------------------------------------------------------------------------

interface AcceptSeen {
  checked: string[];
  requested: { action: unknown; summary: string }[];
  accepted: { link: string; approvalId: string; action: unknown }[];
  signed: OwnerSignRequest[][];
  applied: unknown[];
}

const ACTION = {
  tool: 'agentlink_accept_invite',
  args: { inviteUrl: LINK },
  context: {
    triggers: ['contacts.acceptInvites'],
    inviteId: encodeBase64url(new Uint8Array(16).fill(1)),
    counterparty: { agentId: CONTACT.id, ownerKey: 'c3'.repeat(32) },
  },
};
const APPROVAL_ID = `apr_${'A'.repeat(22)}`;

function acceptWorld(
  options: {
    port?: Partial<LocalUiInviteAcceptPort>;
    apply?: LocalUiContext['applyOwnerAction'];
    noPort?: boolean;
  } = {},
): {
  seen: AcceptSeen;
  ctx: LocalUiContext;
  owner: LocalUiOwnerOperation;
} {
  const seen: AcceptSeen = { checked: [], requested: [], accepted: [], signed: [], applied: [] };
  const port: LocalUiInviteAcceptPort = {
    resolve: (link) => Promise.resolve(link),
    list: () => Promise.resolve([]),
    check: (link) => {
      seen.checked.push(link);
      return Promise.resolve(CONTACT);
    },
    decision: () => Promise.resolve('approval'),
    action: () => Promise.resolve(ACTION as never),
    openRequest: (action, summary) => {
      seen.requested.push({ action, summary });
      return Promise.resolve({ approvalId: APPROVAL_ID, expiresAt: 1_790_000_900 });
    },
    acceptApproved: (link, approvalId, action) => {
      seen.accepted.push({ link, approvalId, action });
      return Promise.resolve({ status: 'started', contact: CONTACT, sent: true });
    },
    ...options.port,
  };
  const ctx = context({
    ...(options.noPort === true ? {} : { invites: port }),
    applyOwnerAction: (signed) => {
      seen.applied.push(signed);
      return options.apply === undefined
        ? Promise.resolve({ status: 'applied', op: 'approval.decide' } as never)
        : options.apply(signed);
    },
  });
  const owner: LocalUiOwnerOperation = {
    sign: (_review, requests) => {
      seen.signed.push([...requests]);
      return Promise.resolve(
        requests.map((r) =>
          r.kind === 'owner-action'
            ? { kind: 'owner-action' as const, signed: { body: r.action, sig: 'ab'.repeat(64) } }
            : { kind: 'typed-data' as const, signature: '0x' },
        ),
      );
    },
  };
  return { seen, ctx, owner };
}

const run = (
  world: ReturnType<typeof acceptWorld>,
  input: unknown,
): ReturnType<typeof inviteAcceptRoute.handler> =>
  inviteAcceptRoute.handler(
    world.ctx,
    { params: {}, query: new URLSearchParams(), input: input as never },
    world.owner,
  );

describe('accept an invite: owner presence (UX2-d1, decision 1.1)', () => {
  it('is an owner route (presence: true), a POST at /api/ui/invites/accept', () => {
    expect(inviteAcceptRoute).toMatchObject({
      method: 'POST',
      path: INVITE_ACCEPT_PATH,
      presence: true,
    });
    expect(INVITE_ACCEPT_PATH).toBe('/api/ui/invites/accept');
  });

  it('signs one approval.decide (approve) for the accept action, applies it, then pairs once', async () => {
    const w = acceptWorld();
    const result = await run(w, { invite: LINK });
    expect(result).toEqual({
      status: 200,
      body: { status: 'pending', contact: CONTACT_OUT, sent: true },
    });
    expect(w.seen.checked).toEqual([LINK]);
    expect(w.seen.requested).toEqual([{ action: ACTION, summary: acceptInviteSummary(CONTACT) }]);
    // IR UX2-d1 M: the same summary as the MCP tool and the CLI, with the owner fingerprint.
    expect(w.seen.requested[0]?.summary).toBe(
      'Accept an invite from “Marko” (self-declared) (owner AB12·CD34)',
    );
    expect(w.seen.signed).toHaveLength(1);
    const [request] = w.seen.signed[0] ?? [];
    expect(request?.kind).toBe('owner-action');
    if (request?.kind !== 'owner-action') throw new Error('unreachable');
    const body = request.action;
    expect(body['op']).toBe('approval.decide');
    expect(body['agent']).toBe(AGENT);
    expect(body['owner']).toBe(encodeHex(OWNER.ownerNostr));
    expect(body['params']).toEqual({
      approvalId: APPROVAL_ID,
      actionDigest: encodeHex(sha256(canonicalizeToBytes(ACTION))),
      decision: 'approve',
    });
    expect(Number(body['expiresAt'])).toBeLessThanOrEqual(1_790_000_900);
    expect(w.seen.applied).toHaveLength(1);
    expect(w.seen.accepted).toEqual([{ link: LINK, approvalId: APPROVAL_ID, action: ACTION }]);
    expect(JSON.stringify(result)).not.toContain(PAYLOAD);
  });

  it('says when the answer could not be sent yet (kept for later)', async () => {
    const w = acceptWorld({
      port: {
        acceptApproved: () => Promise.resolve({ status: 'started', contact: CONTACT, sent: false }),
      },
    });
    expect(await run(w, { invite: LINK })).toEqual({
      status: 200,
      body: { status: 'pending', contact: CONTACT_OUT, sent: false },
    });
  });

  it('signs the same way under `allow`: the owner is present either way', async () => {
    const w = acceptWorld({ port: { decision: () => Promise.resolve('allow') } });
    expect((await run(w, { invite: LINK })).status).toBe(200);
    expect(w.seen.signed).toHaveLength(1);
  });

  it('a deny rule signs nothing, requests nothing and pairs nothing (I-4)', async () => {
    const w = acceptWorld({ port: { decision: () => Promise.resolve('deny') } });
    await run(w, { invite: LINK });
    expect(w.seen.signed).toHaveLength(0);
    expect(w.seen.requested).toHaveLength(0);
    expect(w.seen.accepted).toHaveLength(0);
  });

  it('refuses a malformed input or a link of another shape before core reads it, signing nothing', async () => {
    const inputs: unknown[] = [
      undefined,
      null,
      LINK,
      [LINK],
      {},
      { invite: 7 },
      { invite: LINK, approvalId: APPROVAL_ID },
      { inviteUrl: LINK },
      ...NOT_A_LINK.map((invite) => ({ invite })),
    ];
    for (const input of inputs) {
      const w = acceptWorld();
      const result = await run(w, input);
      expect(result.status, JSON.stringify(input)?.slice(0, 60)).toBe(400);
      expect(w.seen.checked).toHaveLength(0);
      expect(w.seen.signed).toHaveLength(0);
    }
  });

  it('a bad, expired or own invite signs nothing (the check runs before anything is signed)', async () => {
    for (const code of ['invite_expired', 'invite_invalid', 'contact_is_self', 'relays_invalid']) {
      const w = acceptWorld({ port: { check: () => Promise.reject(coreError(code)) } });
      const result = await run(w, { invite: LINK });
      expect(result.status, code).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(result)).not.toContain(PAYLOAD);
      expect(w.seen.signed, code).toHaveLength(0);
      expect(w.seen.requested).toHaveLength(0);
    }
  });

  it('a decision core does not apply pairs nothing', async () => {
    const w = acceptWorld({
      apply: () =>
        Promise.resolve({ status: 'refused', op: 'approval.decide', reason: 'x' } as never),
    });
    expect(await run(w, { invite: LINK })).toEqual({
      status: 409,
      body: { error: 'not_applied' },
    });
    expect(w.seen.accepted).toHaveLength(0);
  });

  it('an approval core will not use pairs nothing', async () => {
    const w = acceptWorld({
      port: { acceptApproved: () => Promise.resolve({ status: 'refused' }) },
    });
    expect(await run(w, { invite: LINK })).toEqual({ status: 409, body: { error: 'refused' } });
  });

  it('a pairing core refuses after the decision answers a fixed code, never the link', async () => {
    const w = acceptWorld({
      port: { acceptApproved: () => Promise.reject(coreError('contact_conflict')) },
    });
    const result = await run(w, { invite: LINK });
    expect(result).toEqual({ status: 409, body: { error: 'cannot_pair' } });
  });

  it('signs nothing without an agent', async () => {
    const w = acceptWorld({ noPort: true });
    expect(await run(w, { invite: LINK })).toBe(UI_NOT_SET_UP);
    expect(w.seen.signed).toHaveLength(0);
  });
});

// IR UX2-d1 L: check and accept share one bound, the longest link the accept route's input header
// (`X-AgentLink-Input`, at most 8 192 base64url characters) can carry as `{"invite":"<link>"}`.
describe('one invite size bound for check and accept (IR UX2-d1 L)', () => {
  const headerChars = (link: string): number =>
    encodeBase64url(encodeUtf8(JSON.stringify({ invite: link }))).length;

  it('the longest link fits the accept input header, and one more character does not', () => {
    expect(headerChars('a'.repeat(INVITE_LINK_MAX_CHARS))).toBeLessThanOrEqual(8192);
    expect(headerChars('a'.repeat(INVITE_LINK_MAX_CHARS + 1))).toBeGreaterThan(8192);
  });

  it('check refuses a link accept could not carry, with the same fixed code as accept', async () => {
    const tooLong = { invite: `${INVITE_LINK_PREFIX}${'a'.repeat(INVITE_LINK_MAX_CHARS)}` };
    const d = desk();
    expect(await inviteCheckRoute.handler(context(), tooLong, d.desk)).toEqual({
      status: 400,
      body: { error: 'invalid_invite' },
    });
    expect(d.checked).toHaveLength(0);
    const w = acceptWorld();
    expect(await run(w, tooLong)).toEqual({ status: 400, body: { error: 'invalid_invite' } });
    expect(w.seen.checked).toHaveLength(0);
  });
});
