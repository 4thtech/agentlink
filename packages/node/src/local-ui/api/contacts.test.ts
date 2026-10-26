// M1-11c-a2: the Contacts page's API (08 §1; 04 §2.5.1, §3.6.1; 06 §2.1; 11 §5.2; D-118; I-4, I-5).
//
// - Three read routes (`presence: false`): the contact list, one contact's safety code and a rename
//   pre-check. Three owner routes (`presence: true`, the central gate checks presence first):
//   "They match" (`contact.check`), rename (`contact.rename`) and remove (`contact.remove`).
// - Owner routes build the unsigned body with core's prepare helpers (#415), sign it once through
//   the gate's one-use `sign` with fixed review lines (never a contact's name), and hand the signed
//   object to core's `ownerActions.apply`. The browser never signs and never builds a body.
// - "They match" binds the code the owner compared: the server recomputes the code now, and signs
//   only when it equals the code the page showed and the prepared digest is the one behind it.
// - What leaves is what the page shows: a name (alias, or the contact's own restricted name), the
//   short fingerprint only as the name rule's fallback, a label, a status, the pairing state and a
//   date. Never the card, keys, the raw name, the pairing digest or an error's text.
import type { ContactView, OwnerSafetyCode, PreparedOwnerAction } from '@4thtech-io/core';
import type { JsonObject } from '@4thtech-io/crypto';
import { describe, expect, it } from 'vitest';
import { readOnlyClient, type LocalUiContext, type LocalUiReadClient } from '../context.js';
import {
  UI_INVALID_QUERY,
  UI_NOT_SET_UP,
  UI_UNAVAILABLE,
  type LocalUiOwnerOperation,
  type LocalUiOwnerRoute,
  type LocalUiReadRoute,
  type LocalUiRequest,
  type LocalUiResult,
} from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import type { OwnerReview, OwnerSignRequest } from '../../owner-operation.js';
import { contactsRoutes } from './contacts.js';

const SELF = '0x71c4000000000000000000000000000000009a2e';
const MARKO = '0x7f3a19c200000000000000000000000000000001';
const ANA = '0x4c21a0f700000000000000000000000000000002';
const NOSTR = 'ee'.repeat(32);
const OWNER_NOSTR = 'dd'.repeat(32);
const DIGEST = 'ab'.repeat(32);
const CODE = '4821 0937 5512';
const RAW_NAME = 'Marko <b>Novak</b>';

type Contacts = LocalUiReadClient['contacts'];

function view(over: Partial<ContactView> & { id: string }): ContactView {
  const base = {
    agentNostr: NOSTR,
    name: { value: RAW_NAME, source: 'counterparty', selfDeclared: true },
    display: { name: 'Marko Novak', label: 'self-declared', nameSource: 'counterparty' },
    card: { agentEvm: over.id, agentNostr: NOSTR, ownerNostr: OWNER_NOSTR, name: RAW_NAME },
    keyEpoch: 0,
    ownerFingerprint: { short: '7F3A·19C2', long: '7F3A·19C2·5D0E·88B1' },
    status: 'active',
    pairing: 'complete',
    safetyCodeChecked: false,
    createdAt: 1_759_449_600,
    updatedAt: 1_759_449_600,
  };
  return { ...base, ...over } as unknown as ContactView;
}

function prepared(op: string, params: JsonObject): PreparedOwnerAction {
  const body = {
    v: 2,
    agent: SELF,
    owner: OWNER_NOSTR,
    op,
    params,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    issuedAt: 1_760_000_000,
    expiresAt: 1_760_000_600,
  };
  return {
    status: 'prepared',
    op,
    body,
    jcs: JSON.stringify(body),
  } as unknown as PreparedOwnerAction;
}

const refused = (op: string, reason: string): PreparedOwnerAction =>
  ({ status: 'refused', op, reason }) as unknown as PreparedOwnerAction;

function fakeContacts(over: Partial<Contacts> = {}): Contacts {
  return {
    list: () => Promise.resolve([view({ id: MARKO })]),
    safetyCode: () =>
      Promise.resolve<OwnerSafetyCode>({ status: 'ok', code: CODE, pairingDigest: DIGEST }),
    prepareCheck: (id) =>
      Promise.resolve(prepared('contact.check', { contact: id, pairingDigest: DIGEST })),
    prepareRename: (id, alias) =>
      Promise.resolve(prepared('contact.rename', { contact: id, alias })),
    prepareRemove: (id) => Promise.resolve(prepared('contact.remove', { contact: id })),
    ...over,
  };
}

function fakeClient(contacts: Contacts = fakeContacts()): LocalUiReadClient {
  return {
    agentId: SELF,
    getProof: () => Promise.reject(new Error('not used')),
    listActivity: () => Promise.reject(new Error('not used')),
    files: {
      resolvedFolders: () => Promise.reject(new Error('not used')),
      preparePolicyEdit: () => Promise.reject(new Error('not used')),
    },
    proofs: {
      list: () => Promise.reject(new Error('not used')),
      creditsBalance: () => Promise.reject(new Error('not used')),
    },
    contacts,
  };
}

interface Applied {
  readonly signed: { readonly body: JsonObject; readonly sig: string }[];
}

function ctx(
  client: LocalUiReadClient | undefined,
  apply: (signed: { body: JsonObject; sig: string }) => Promise<unknown> = (s) =>
    Promise.resolve({ status: 'applied', op: s.body['op'] }),
): LocalUiContext & Applied {
  const signed: { body: JsonObject; sig: string }[] = [];
  return {
    client,
    signed,
    ownerContext: () => Promise.reject(new Error('not used')),
    applyOwnerAction: (s) => {
      signed.push(s as { body: JsonObject; sig: string });
      return apply(s as { body: JsonObject; sig: string }) as ReturnType<
        LocalUiContext['applyOwnerAction']
      >;
    },
    now: () => 0,
  };
}

interface Signer extends LocalUiOwnerOperation {
  readonly calls: { review: OwnerReview; requests: readonly OwnerSignRequest[] }[];
}

function signer(): Signer {
  const calls: Signer['calls'] = [];
  return {
    calls,
    sign: (review, requests) => {
      calls.push({ review, requests });
      return Promise.resolve(
        requests.map((r) => ({
          kind: 'owner-action' as const,
          signed: { body: (r as { action: JsonObject }).action, sig: 'aa'.repeat(64) },
        })),
      );
    },
  };
}

function readRoute(path: string): LocalUiReadRoute {
  const found = contactsRoutes.find((r) => r.path === path && r.method === 'GET');
  if (found === undefined || found.presence) throw new Error(`no read route ${path}`);
  return found;
}

function ownerRoute(path: string): LocalUiOwnerRoute {
  const found = contactsRoutes.find((r) => r.path === path && r.method === 'POST');
  if (found === undefined || found.presence !== true) throw new Error(`no owner route ${path}`);
  return found;
}

const req = (params: Record<string, string> = {}, query = '', input?: unknown): LocalUiRequest => ({
  params,
  query: new URLSearchParams(query),
  ...(input === undefined ? {} : { input: input as NonNullable<LocalUiRequest['input']> }),
});

const body = (r: LocalUiResult): Record<string, unknown> => r.body as Record<string, unknown>;

/** Nothing but what the page shows: no key, card, raw name, digest or full fingerprint. */
function expectNoLeak(value: unknown): void {
  const text = JSON.stringify(value);
  for (const marker of [
    NOSTR,
    OWNER_NOSTR,
    DIGEST,
    RAW_NAME,
    '<b>',
    '7F3A·19C2·5D0E·88B1',
    'agentNostr',
    'ownerNostr',
    'card',
    'pairingDigest',
    'keyEpoch',
  ]) {
    expect(text, marker).not.toContain(marker);
  }
}

describe('routes (M1-11c-a2, I-4)', () => {
  it('declares three reads without presence and three owner routes behind the gate', () => {
    expect(contactsRoutes.map((r) => [r.method, r.path, r.presence])).toEqual([
      ['GET', '/api/ui/contacts', false],
      ['GET', '/api/ui/contacts/:ref/safety-code', false],
      ['GET', '/api/ui/contacts/:ref/rename-check', false],
      ['POST', '/api/ui/contacts/:ref/check', true],
      ['POST', '/api/ui/contacts/:ref/rename', true],
      ['POST', '/api/ui/contacts/:ref/remove', true],
    ]);
    expect(Object.isFrozen(contactsRoutes)).toBe(true);
  });

  it('is in the default registry; no block or unblock route bypasses the gate', () => {
    const registry = createLocalUiRoutes();
    const list = registry.match('GET', '/api/ui/contacts');
    expect(list !== undefined && list !== 'method' && list.route.presence).toBe(false);
    for (const op of ['check', 'rename', 'remove']) {
      const hit = registry.match('POST', `/api/ui/contacts/${MARKO}/${op}`);
      expect(hit !== undefined && hit !== 'method' && hit.route.presence).toBe(true);
      expect(registry.match('GET', `/api/ui/contacts/${MARKO}/${op}`)).toBe('method');
    }
    for (const op of ['block', 'unblock', 'export']) {
      expect(registry.match('POST', `/api/ui/contacts/${MARKO}/${op}`)).toBeUndefined();
    }
  });
});

describe('the read-only client view (context.ts, IR-M1-11s-b-1 H-1)', () => {
  it('adds one frozen `contacts` object of bound reads and prepare helpers, nothing else', async () => {
    const seen: string[] = [];
    const full = {
      agentId: SELF,
      getProof: () => Promise.resolve(undefined),
      contacts: {
        list: () => (seen.push('list'), Promise.resolve([])),
        block: () => (seen.push('block'), Promise.resolve()),
        remove: () => (seen.push('remove'), Promise.resolve()),
      },
      pairing: {
        ownerSafetyCode: (id: string) => (seen.push(`code:${id}`), Promise.resolve({})),
      },
      ownerActions: {
        prepareContactCheck: (id: string) => (seen.push(`check:${id}`), Promise.resolve({})),
        prepareContactRename: (id: string, a: string) => (
          seen.push(`rename:${id}:${a}`),
          Promise.resolve({})
        ),
        prepareContactRemove: (id: string) => (seen.push(`remove:${id}`), Promise.resolve({})),
        apply: () => (seen.push('apply'), Promise.resolve({})),
      },
    };
    const view = readOnlyClient(full as unknown as Parameters<typeof readOnlyClient>[0]);
    expect(Object.keys(view.contacts).sort()).toEqual([
      'list',
      'prepareCheck',
      'prepareRemove',
      'prepareRename',
      'safetyCode',
    ]);
    expect(Object.isFrozen(view.contacts)).toBe(true);
    expect(view.contacts).not.toBe(full.contacts);
    await view.contacts.list();
    await view.contacts.safetyCode(MARKO);
    await view.contacts.prepareCheck(MARKO);
    await view.contacts.prepareRename(MARKO, 'Marko');
    await view.contacts.prepareRemove(MARKO);
    expect(seen).toEqual([
      'list',
      `code:${MARKO}`,
      `check:${MARKO}`,
      `rename:${MARKO}:Marko`,
      `remove:${MARKO}`,
    ]);
    // No direct write of the contact book is reachable (block, remove, apply).
    expect('block' in view.contacts).toBe(false);
    expect('remove' in view.contacts).toBe(false);
    expect('apply' in view.contacts).toBe(false);
  });
});

describe('GET /api/ui/contacts: the list', () => {
  const list = readRoute('/api/ui/contacts');

  it('answers not_set_up without an agent', async () => {
    expect(await list.handler(ctx(undefined), req())).toBe(UI_NOT_SET_UP);
  });

  it('refuses any query parameter without echoing it', async () => {
    const r = await list.handler(ctx(fakeClient()), req({}, 'x=<script>'));
    expect(r).toBe(UI_INVALID_QUERY);
  });

  it('gives each contact a name, label, status, pairing and date, and nothing else', async () => {
    const contacts = fakeContacts({
      list: () =>
        Promise.resolve([
          view({ id: MARKO }),
          view({
            id: ANA,
            display: { name: 'Ana', label: 'safety-code-checked', nameSource: 'owner' },
            safetyCodeChecked: true,
            status: 'blocked',
            pairing: 'pending',
          } as Partial<ContactView> & { id: string }),
        ]),
    });
    const r = await list.handler(ctx(fakeClient(contacts)), req());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      status: 'ok',
      contacts: [
        {
          ref: MARKO,
          name: 'Marko Novak',
          nameSource: 'counterparty',
          fingerprint: '7F3A·19C2',
          label: 'self-declared',
          status: 'active',
          pairing: 'complete',
          since: 1_759_449_600,
        },
        {
          ref: ANA,
          name: 'Ana',
          nameSource: 'owner',
          label: 'safety-code-checked',
          status: 'blocked',
          pairing: 'pending',
          since: 1_759_449_600,
        },
      ],
    });
    expectNoLeak(r.body);
  });

  it('never shows a stronger label than core gives, and drops rows it does not know', async () => {
    const contacts = fakeContacts({
      list: () =>
        Promise.resolve([
          view({
            id: MARKO,
            display: { name: 'Marko', label: 'verified-domain', nameSource: 'counterparty' },
          } as Partial<ContactView> & { id: string }),
          view({ id: ANA, status: 'weird' } as unknown as Partial<ContactView> & { id: string }),
          view({ id: 'not-an-address' }),
          view({
            id: ANA.replace('2', '3'),
            pairing: 'other',
          } as unknown as Partial<ContactView> & { id: string }),
        ]),
    });
    const r = await list.handler(ctx(fakeClient(contacts)), req());
    const rows = body(r)['contacts'] as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['label']).toBe('self-declared');
  });

  it('answers unavailable on a core error, never its text', async () => {
    const contacts = fakeContacts({
      list: () => Promise.reject(new Error('/home/tali/.agentlink/store.db locked')),
    });
    const r = await list.handler(ctx(fakeClient(contacts)), req());
    expect(r).toBe(UI_UNAVAILABLE);
  });
});

describe('GET /api/ui/contacts/:ref/safety-code', () => {
  const code = readRoute('/api/ui/contacts/:ref/safety-code');

  it('shows the 12 digits recomputed now, never the digest', async () => {
    const r = await code.handler(ctx(fakeClient()), req({ ref: MARKO }));
    expect(r).toEqual({ status: 200, body: { status: 'ok', code: CODE } });
    expectNoLeak(r.body);
  });

  it('says unavailable when core cannot show a code', async () => {
    const contacts = fakeContacts({
      safetyCode: () => Promise.resolve({ status: 'unavailable', reason: 'conflict' }),
    });
    const r = await code.handler(ctx(fakeClient(contacts)), req({ ref: MARKO }));
    expect(r).toEqual({ status: 200, body: { status: 'unavailable' } });
  });

  it('refuses a ref that is not a contact ID, and a code of the wrong shape', async () => {
    const r1 = await code.handler(ctx(fakeClient()), req({ ref: 'abc' }));
    expect(r1.status).toBe(404);
    const contacts = fakeContacts({
      safetyCode: () => Promise.resolve({ status: 'ok', code: '<b>1</b>', pairingDigest: DIGEST }),
    });
    const r2 = await code.handler(ctx(fakeClient(contacts)), req({ ref: MARKO }));
    expect(r2).toEqual({ status: 200, body: { status: 'unavailable' } });
  });

  it('answers not_set_up and unavailable with the shared answers', async () => {
    expect(await code.handler(ctx(undefined), req({ ref: MARKO }))).toBe(UI_NOT_SET_UP);
    const contacts = fakeContacts({ safetyCode: () => Promise.reject(new Error('secret path')) });
    expect(await code.handler(ctx(fakeClient(contacts)), req({ ref: MARKO }))).toBe(UI_UNAVAILABLE);
  });
});

describe('GET /api/ui/contacts/:ref/rename-check', () => {
  const check = readRoute('/api/ui/contacts/:ref/rename-check');

  it('says ok for a name core would sign', async () => {
    const r = await check.handler(ctx(fakeClient()), req({ ref: MARKO }, 'alias=Marko'));
    expect(r).toEqual({ status: 200, body: { status: 'ok' } });
  });

  it('passes core refusals as fixed codes', async () => {
    for (const reason of ['alias_invalid', 'alias_taken', 'contact_unknown']) {
      const contacts = fakeContacts({
        prepareRename: () => Promise.resolve(refused('contact.rename', reason)),
      });
      const r = await check.handler(ctx(fakeClient(contacts)), req({ ref: MARKO }, 'alias=Ana'));
      expect(r).toEqual({ status: 200, body: { status: 'refused', reason } });
    }
  });

  it('refuses a missing, repeated or overlong alias as an invalid query', async () => {
    for (const q of ['', 'alias=a&alias=b', `alias=${'x'.repeat(200)}`, 'alias=a&x=1']) {
      expect(await check.handler(ctx(fakeClient()), req({ ref: MARKO }, q))).toBe(UI_INVALID_QUERY);
    }
  });
});

describe('POST /api/ui/contacts/:ref/check: "They match" (04 §3.6.1)', () => {
  const route = ownerRoute('/api/ui/contacts/:ref/check');

  it('signs the prepared contact.check once, with fixed review lines, and applies it', async () => {
    const c = ctx(fakeClient());
    const s = signer();
    const r = await route.handler(c, req({ ref: MARKO }, '', { code: CODE }), s);
    expect(r).toEqual({ status: 200, body: { status: 'done' } });
    expect(s.calls).toHaveLength(1);
    const call = s.calls[0];
    expect(call?.requests).toHaveLength(1);
    const action = (call?.requests[0] as { action: JsonObject }).action;
    expect(action['op']).toBe('contact.check');
    expect(action['params']).toEqual({ contact: MARKO, pairingDigest: DIGEST });
    // The review is ours, never the contact's own name (I-5).
    expect(JSON.stringify(call?.review)).not.toContain('Marko');
    expect(c.signed).toHaveLength(1);
    expect(c.signed[0]?.body).toEqual(action);
  });

  it('signs nothing when the code changed since the page showed it', async () => {
    const s = signer();
    const c = ctx(fakeClient());
    await route.handler(c, req({ ref: MARKO }, '', { code: '0000 0000 0000' }), s);
    expect(s.calls).toHaveLength(0);
    expect(c.signed).toHaveLength(0);
  });

  it('signs nothing when the prepared digest is not the one behind the shown code', async () => {
    const contacts = fakeContacts({
      prepareCheck: (id) =>
        Promise.resolve(prepared('contact.check', { contact: id, pairingDigest: 'cd'.repeat(32) })),
    });
    const s = signer();
    await route.handler(ctx(fakeClient(contacts)), req({ ref: MARKO }, '', { code: CODE }), s);
    expect(s.calls).toHaveLength(0);
  });

  it('signs nothing for a malformed input, a bad ref or a core refusal', async () => {
    const cases: [Record<string, string>, unknown, Contacts][] = [
      [{ ref: MARKO }, undefined, fakeContacts()],
      [{ ref: MARKO }, { code: CODE, extra: 1 }, fakeContacts()],
      [{ ref: MARKO }, { code: 4821 }, fakeContacts()],
      [{ ref: 'nope' }, { code: CODE }, fakeContacts()],
      [
        { ref: MARKO },
        { code: CODE },
        fakeContacts({
          prepareCheck: () => Promise.resolve(refused('contact.check', 'pairing_unavailable')),
        }),
      ],
      [
        { ref: MARKO },
        { code: CODE },
        fakeContacts({
          safetyCode: () => Promise.resolve({ status: 'unavailable', reason: 'invalid' }),
        }),
      ],
    ];
    for (const [params, input, contacts] of cases) {
      const s = signer();
      await route.handler(ctx(fakeClient(contacts)), req(params, '', input), s);
      expect(s.calls).toHaveLength(0);
    }
  });

  it('answers not_applied, a fixed code, when core refuses the signed object', async () => {
    const c = ctx(fakeClient(), () =>
      Promise.resolve({ status: 'refused', op: 'contact.check', reason: 'digest_mismatch' }),
    );
    const r = await route.handler(c, req({ ref: MARKO }, '', { code: CODE }), signer());
    expect(r).toEqual({ status: 409, body: { error: 'not_applied' } });
  });
});

describe('POST /api/ui/contacts/:ref/rename', () => {
  const route = ownerRoute('/api/ui/contacts/:ref/rename');

  it('signs the prepared contact.rename with exactly the alias the owner typed', async () => {
    const s = signer();
    const c = ctx(fakeClient());
    const r = await route.handler(c, req({ ref: MARKO }, '', { alias: 'Marko N' }), s);
    expect(r).toEqual({ status: 200, body: { status: 'done' } });
    const action = (s.calls[0]?.requests[0] as { action: JsonObject }).action;
    expect(action['op']).toBe('contact.rename');
    expect(action['params']).toEqual({ contact: MARKO, alias: 'Marko N' });
    expect(JSON.stringify(s.calls[0]?.review)).not.toContain('Marko');
  });

  it('signs nothing for a refused or malformed alias', async () => {
    const bad = fakeContacts({
      prepareRename: () => Promise.resolve(refused('contact.rename', 'alias_taken')),
    });
    for (const [contacts, input] of [
      [bad, { alias: 'Ana' }],
      [fakeContacts(), { alias: '' }],
      [fakeContacts(), { alias: 'x'.repeat(200) }],
      [fakeContacts(), { name: 'Ana' }],
      [fakeContacts(), 'Ana'],
    ] as [Contacts, unknown][]) {
      const s = signer();
      await route.handler(ctx(fakeClient(contacts)), req({ ref: MARKO }, '', input), s);
      expect(s.calls).toHaveLength(0);
    }
  });
});

describe('POST /api/ui/contacts/:ref/remove', () => {
  const route = ownerRoute('/api/ui/contacts/:ref/remove');

  it('signs the prepared contact.remove and applies it', async () => {
    const s = signer();
    const c = ctx(fakeClient());
    const r = await route.handler(c, req({ ref: MARKO }), s);
    expect(r).toEqual({ status: 200, body: { status: 'done' } });
    const action = (s.calls[0]?.requests[0] as { action: JsonObject }).action;
    expect(action['op']).toBe('contact.remove');
    expect(action['params']).toEqual({ contact: MARKO });
    expect(c.signed).toHaveLength(1);
  });

  it('signs nothing for a revoked contact or an input it does not take', async () => {
    const revoked = fakeContacts({
      prepareRemove: () => Promise.resolve(refused('contact.remove', 'contact_revoked')),
    });
    const s1 = signer();
    await route.handler(ctx(fakeClient(revoked)), req({ ref: MARKO }), s1);
    expect(s1.calls).toHaveLength(0);
    const s2 = signer();
    await route.handler(ctx(fakeClient()), req({ ref: MARKO }, '', { contact: ANA }), s2);
    expect(s2.calls).toHaveLength(0);
  });

  it('answers not_set_up without an agent, signing nothing', async () => {
    const s = signer();
    expect(await route.handler(ctx(undefined), req({ ref: MARKO }), s)).toBe(UI_NOT_SET_UP);
    expect(s.calls).toHaveLength(0);
  });
});
