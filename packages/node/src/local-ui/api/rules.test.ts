// M1-11c-a5: the Rules page's API (08 §1; 06 §3; 11 §5, §6.2; D-118, D-119; I-4, I-5).
//
// Against a real core client (memory store, memory KeyStore and owner key store), as the local UI
// server wires it: the read-only client view (context.ts) and core's `apply` behind the owner gate.
// - GET /api/ui/rules: the policy in force as the page shows it, never an agent ID or a folder path.
// - GET /api/ui/rules/review?edit=: core's preparePolicyEdit for an edit of the page's own fields;
//   the server keeps the prepared body and answers its body hash and the warning codes.
// - POST /api/ui/rules (presence): D-119. The server signs only the body it prepared, only when the
//   owner acknowledged exactly that body's warning codes (bound to its hash), once, before it expires.
//   Anything else returns without signing, which the central gate answers 409 `refused`.
import { readFileSync } from 'node:fs';
import {
  AgentLinkClient,
  MemoryStore,
  POLICY_EDIT_WARNING_CODES,
  type ApprovalChannel,
  type Sealed,
  type SealContext,
  type StoreCipher,
} from '@4thtech-io/core';
import {
  canonicalize,
  decodeBase64url,
  decodeUtf8,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  hmacSha256,
  sha256,
  type JsonObject,
  type JsonValue,
  type OwnerPresence,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { describe, expect, it } from 'vitest';
import { readOnlyClient, type LocalUiContext } from '../context.js';
import { checkGesture, type OwnerReview, type OwnerSignRequest } from '../../owner-operation.js';
import { createLocalUiRoutes } from '../routes.js';
import type {
  LocalUiOwnerOperation,
  LocalUiOwnerRoute,
  LocalUiReadRoute,
  LocalUiResult,
} from '../route-types.js';
import { acknowledgedExactly, rulesRoutes } from './rules.js';

// --- a real core client, as the Node runtime wires it (test doubles only for storage) -------------

const PREFIX = 'rules-test-sealed:';
/** Not encryption: binds the value to its context so a misplaced value fails (07 §3.1). */
class TestCipher implements StoreCipher {
  seal(context: SealContext, plaintext: string): Promise<Sealed> {
    const body = JSON.stringify([context.table, context.column, context.rowKey, plaintext]);
    return Promise.resolve(`${PREFIX}${encodeBase64url(encodeUtf8(body))}` as Sealed);
  }
  open(context: SealContext, sealed: Sealed): Promise<string> {
    const parsed = JSON.parse(
      decodeUtf8(decodeBase64url(sealed.slice(PREFIX.length))),
    ) as unknown[];
    if (
      parsed[0] !== context.table ||
      parsed[1] !== context.column ||
      parsed[2] !== context.rowKey
    ) {
      return Promise.reject(new Error('test cipher: wrong context'));
    }
    return Promise.resolve(parsed[3] as string);
  }
  indexDigest(data: Uint8Array): Promise<string> {
    return Promise.resolve(encodeHex(hmacSha256(new Uint8Array(32).fill(0x1d), data)));
  }
}

class Mark {
  value = 0;
  read(): Promise<number> {
    return Promise.resolve(this.value);
  }
  raise(version: number): Promise<number> {
    this.value = Math.max(this.value, version);
    return Promise.resolve(this.value);
  }
}

class Kept {
  value: number | null = null;
  read(): Promise<number | null> {
    return Promise.resolve(this.value);
  }
  write(version: number): Promise<void> {
    this.value = version;
    return Promise.resolve();
  }
}

const approvals: ApprovalChannel = {
  request: (request) => Promise.resolve({ approvalId: request.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const passphrase = (): OwnerPresence => ({
  kind: 'passphrase',
  secret: encodeUtf8('correct horse'),
});
const RELAYS = ['wss://relay.agentlink.dev', 'wss://nos.lol'];

interface Setup {
  readonly client: AgentLinkClient;
  readonly context: LocalUiContext;
  readonly owner: MemoryOwnerKeyStore;
  readonly clock: { t: number };
  readonly kept: Kept;
  readonly mark: Mark;
  /** Signs and applies a whole policy edit as another surface (the CLI) would. */
  readonly applyElsewhere: (patch: JsonObject) => Promise<void>;
}

async function setup(options: { identity?: boolean } = {}): Promise<Setup> {
  const owner = new MemoryOwnerKeyStore(seed(41), passphrase());
  const clock = { t: 1_800_000_000 };
  const kept = new Kept();
  const mark = new Mark();
  const client = await AgentLinkClient.create({
    keyStore: new MemoryKeyStore(seed(4)),
    store: new MemoryStore(),
    cipher: new TestCipher(),
    approvals,
    clock: () => clock.t,
    policyMark: mark,
    receiptsKept: kept,
  });
  if (options.identity !== false) {
    const session = await owner.unlock(passphrase());
    await client.identity.init({
      owner: session,
      ownerKeys: await owner.getPublicKeys(),
      name: 'Agent',
      relays: RELAYS,
    });
    await session.close();
  }
  const context: LocalUiContext = Object.freeze<LocalUiContext>({
    client: readOnlyClient(client),
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: (signed) => client.ownerActions.apply(JSON.stringify(signed)),
    now: () => clock.t * 1000,
  });
  const applyElsewhere = async (patch: JsonObject): Promise<void> => {
    const prepared = await client.ownerActions.preparePolicyEdit(patch);
    if (prepared.status !== 'prepared') throw new Error(prepared.reason);
    const session = await owner.unlock(passphrase());
    try {
      const body = prepared.body as unknown as JsonObject;
      const out = await client.ownerActions.apply(
        JSON.stringify({ body, sig: await session.signOwnerAction(body) }),
      );
      if (out.status !== 'applied') throw new Error(out.reason);
    } finally {
      await session.close();
    }
  };
  return { client, context, owner, clock, kept, mark, applyElsewhere };
}

/** The owner operation the central gate hands a presence route: one `sign`, checked as the gate does. */
function ownerOp(owner: MemoryOwnerKeyStore) {
  const calls: { review: OwnerReview; requests: readonly OwnerSignRequest[] }[] = [];
  const op: LocalUiOwnerOperation = {
    sign: async (review, requests) => {
      calls.push({ review, requests });
      const frozen = checkGesture(review, requests);
      const first = frozen[0];
      if (first?.kind !== 'owner-action') throw new Error('unexpected request');
      const session = await owner.unlock(passphrase());
      try {
        const sig = await session.signOwnerAction(first.action);
        return [{ kind: 'owner-action', signed: { body: first.action, sig } }];
      } finally {
        await session.close();
      }
    },
  };
  return { op, calls };
}

// --- route helpers --------------------------------------------------------------------------------

const readRoute = (path: string): LocalUiReadRoute => {
  const route = rulesRoutes.find((r) => r.method === 'GET' && r.path === path);
  if (route === undefined || route.presence) throw new Error(`no read route ${path}`);
  return route;
};
const ownerRoute = (): LocalUiOwnerRoute => {
  const route = rulesRoutes.find((r) => r.method === 'POST' && r.path === '/api/ui/rules');
  if (route === undefined || !route.presence) throw new Error('no owner route');
  return route;
};

const editParam = (edit: unknown): string => encodeBase64url(encodeUtf8(JSON.stringify(edit)));

async function getRules(context: LocalUiContext): Promise<LocalUiResult> {
  return readRoute('/api/ui/rules').handler(context, {
    params: {},
    query: new URLSearchParams(),
  });
}

async function review(context: LocalUiContext, query: URLSearchParams | unknown) {
  const q =
    query instanceof URLSearchParams ? query : new URLSearchParams({ edit: editParam(query) });
  return readRoute('/api/ui/rules/review').handler(context, { params: {}, query: q });
}

interface Reviewed {
  readonly review: string;
  readonly warnings: readonly { code: string; contacts?: number }[];
  readonly askKeepDeliveryReceipts: boolean;
}

async function reviewOk(context: LocalUiContext, edit: unknown): Promise<Reviewed> {
  const result = await review(context, edit);
  expect(result.status).toBe(200);
  const body = result.body as Record<string, unknown>;
  expect(body.status).toBe('review');
  return body as unknown as Reviewed;
}

async function save(context: LocalUiContext, owner: LocalUiOwnerOperation, input: JsonValue) {
  return ownerRoute().handler(context, { params: {}, query: new URLSearchParams(), input }, owner);
}

const codes = (r: Reviewed): string[] => r.warnings.map((w) => w.code);

// --- registry ------------------------------------------------------------------------------------

describe('routes (M1-11c-a5; I-4)', () => {
  it('two reads without presence and one save behind the presence gate', () => {
    const shape = rulesRoutes.map((r) => `${r.method} ${r.path} ${String(r.presence)}`).sort();
    expect(shape).toEqual([
      'GET /api/ui/rules false',
      'GET /api/ui/rules/review false',
      'POST /api/ui/rules true',
    ]);
    const registered = createLocalUiRoutes()
      .routes()
      .filter((r) => r.path.startsWith('/api/ui/rules'))
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(registered).toEqual([
      'GET /api/ui/rules',
      'GET /api/ui/rules/review',
      'POST /api/ui/rules',
    ]);
  });

  it('the read view gives the policy reads and prepare, never apply or the client', async () => {
    const { client, context } = await setup();
    const view = context.client as unknown as Record<string, unknown>;
    expect(view).not.toBe(client);
    const policy = view.policy as Record<string, unknown>;
    expect(Object.keys(policy).sort()).toEqual(['load', 'prepareEdit', 'recordReceiptsKept']);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(view.ownerActions).toBeUndefined();
    expect(policy.apply).toBeUndefined();
  });
});

// --- GET /api/ui/rules ---------------------------------------------------------------------------

describe('GET /api/ui/rules', () => {
  it('not set up: 409 not_set_up', async () => {
    const context: LocalUiContext = {
      client: undefined,
      ownerContext: () => Promise.resolve(undefined),
      applyOwnerAction: () => Promise.reject(new Error('unreachable')),
      now: () => 0,
    };
    expect(await getRules(context)).toEqual({ status: 409, body: { error: 'not_set_up' } });
  });

  it('the defaults as the page shows them: values, counts, no IDs or folder paths', async () => {
    const { context } = await setup();
    const result = await getRules(context);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      status: 'ok',
      version: 0,
      rules: {
        proofs: {
          notarize: 'allow',
          dailyBudgetUSD: '5',
          perActionMaxUSD: '1',
          allowKeyDisclosure: 'approval',
        },
        contacts: {
          acceptInvites: 'approval',
          unknownSenders: 'queue',
          allowed: 'paired',
          listed: 0,
        },
        files: { maxSendSizeMB: 100, maxReceiveSizeMB: 200, allowedFolders: 0 },
        receipts: { autoDelivered: false },
        commitments: {
          accept: 'approval',
          autoAcceptDirection: 'buy',
          autoAcceptMaxUSD: '0',
          autoAcceptMinUSD: null,
          autoAcceptContacts: 0,
        },
        contactRules: 0,
      },
    });
    const text = JSON.stringify(result.body);
    expect(text).not.toMatch(/0x[0-9a-f]{8}/i);
    expect(text).not.toContain('~/');
    expect(text).not.toMatch(/base|gnosis|chain/i);
  });

  it('rules that fail closed: 200 not_valid (the page shows the recover step, LS-1)', async () => {
    const { context, mark } = await setup();
    mark.value = 3; // the mark says version 3 was applied, but no such policy is stored
    expect(await getRules(context)).toEqual({ status: 200, body: { status: 'not_valid' } });
    expect(await review(context, { base: 0, patch: { proofs: { notarize: 'deny' } } })).toEqual({
      status: 409,
      body: { error: 'rules_not_valid' },
    });
  });

  it('after an edit made elsewhere: the signed version and its values', async () => {
    const { context, applyElsewhere } = await setup();
    await applyElsewhere({ proofs: { notarize: 'approval' } });
    const result = await getRules(context);
    expect(result.body).toMatchObject({
      status: 'ok',
      version: 1,
      rules: { proofs: { notarize: 'approval' } },
    });
  });
});

// --- GET /api/ui/rules/review --------------------------------------------------------------------

describe('GET /api/ui/rules/review: prepare an edit (core preparePolicyEdit)', () => {
  const invalid: [string, () => URLSearchParams][] = [
    ['no edit', () => new URLSearchParams()],
    [
      'an unknown parameter',
      () => new URLSearchParams({ edit: editParam({ base: 0, patch: {} }), x: '1' }),
    ],
    [
      'edit given twice',
      () => {
        const q = new URLSearchParams({ edit: editParam({ base: 0, patch: {} }) });
        q.append('edit', editParam({ base: 0, patch: {} }));
        return q;
      },
    ],
    ['not base64url', () => new URLSearchParams({ edit: 'a+b/c=' })],
    ['not JSON', () => new URLSearchParams({ edit: encodeBase64url(encodeUtf8('{nope')) })],
    ['an over-long edit', () => new URLSearchParams({ edit: 'A'.repeat(4097) })],
  ];
  for (const [name, query] of invalid) {
    it(`400 invalid_query for ${name}, never echoing it`, async () => {
      const { context } = await setup();
      expect(await review(context, query())).toEqual({
        status: 400,
        body: { error: 'invalid_query' },
      });
    });
  }

  const outside: [string, unknown][] = [
    ['an unknown top-level key', { base: 0, patch: {}, extra: 1 }],
    ['a missing base', { patch: { proofs: { notarize: 'approval' } } }],
    ['a fractional base', { base: 0.5, patch: {} }],
    ['a non-boolean keep answer', { base: 0, patch: {}, keepDeliveryReceipts: 'yes' }],
    ['a folder (Files page)', { base: 0, patch: { files: { inboxFolder: '/tmp/x' } } }],
    ['allowed folders (Files page)', { base: 0, patch: { files: { allowedFolders: ['/tmp'] } } }],
    ['the export folder', { base: 0, patch: { proofs: { exportFolder: '/tmp' } } }],
    ['the proof network (Advanced)', { base: 0, patch: { proofs: { defaultChain: 'gnosis' } } }],
    ['file storage', { base: 0, patch: { files: { storage: 'drop' } } }],
    ['the contact list', { base: 0, patch: { contacts: { allowed: 'paired' } } }],
    [
      'the auto-accept contact list',
      { base: 0, patch: { commitments: { autoAcceptContacts: [`0x${'11'.repeat(20)}`] } } },
    ],
    ['contact rules (RU-1, later)', { base: 0, patch: { contactRules: [] } }],
    ['delivery receipts (RU-1, later)', { base: 0, patch: { receipts: { autoDelivered: true } } }],
    ['opened receipts', { base: 0, patch: { receipts: { autoOpened: true } } }],
    ['envelopes', { base: 0, patch: { envelopes: { maxEnvelopeKB: 24 } } }],
    ['an empty edit', { base: 0, patch: {} }],
  ];
  for (const [name, edit] of outside) {
    it(`400 invalid_edit for ${name}: only the page's own fields`, async () => {
      const { context } = await setup();
      expect(await review(context, edit)).toEqual({ status: 400, body: { error: 'invalid_edit' } });
    });
  }

  it('400 invalid_edit when core refuses the patch (a value out of bounds)', async () => {
    const { context } = await setup();
    expect(await review(context, { base: 0, patch: { files: { maxSendSizeMB: 0 } } })).toEqual({
      status: 400,
      body: { error: 'invalid_edit' },
    });
  });

  it('409 stale when the rules changed since the page loaded', async () => {
    const { context, applyElsewhere } = await setup();
    await applyElsewhere({ proofs: { notarize: 'approval' } });
    expect(await review(context, { base: 0, patch: { proofs: { notarize: 'deny' } } })).toEqual({
      status: 409,
      body: { error: 'stale' },
    });
  });

  it('409 not_set_up without an agent identity', async () => {
    const { context } = await setup({ identity: false });
    expect(await review(context, { base: 0, patch: { proofs: { notarize: 'deny' } } })).toEqual({
      status: 409,
      body: { error: 'not_set_up' },
    });
  });

  it('a stricter edit: a body hash and no warnings', async () => {
    const { context } = await setup();
    const r = await reviewOk(context, { base: 0, patch: { proofs: { notarize: 'approval' } } });
    expect(r.review).toMatch(/^[0-9a-f]{64}$/);
    expect(r.warnings).toEqual([]);
    expect(r.askKeepDeliveryReceipts).toBe(false);
    expect(Object.keys(r).sort()).toEqual([
      'askKeepDeliveryReceipts',
      'review',
      'status',
      'warnings',
    ]);
  });

  it('a looser edit: every warning code, in core order, no IDs', async () => {
    const { context } = await setup();
    const r = await reviewOk(context, {
      base: 0,
      patch: {
        contacts: { acceptInvites: 'auto' },
        proofs: { dailyBudgetUSD: '20', perActionMaxUSD: '2' },
        files: { maxSendSizeMB: 500 },
        commitments: { accept: 'allow' },
      },
    });
    expect(codes(r)).toEqual([
      'invites_auto',
      'limits_raised',
      'proofs_spend_raised',
      'commitments_allow',
    ]);
    expect(JSON.stringify(r)).not.toMatch(/0x|fields|proofs\.|files\./);
  });

  it('turning selling on raises the sell warning', async () => {
    const { context } = await setup();
    const r = await reviewOk(context, {
      base: 0,
      patch: { commitments: { autoAcceptDirection: 'sell', autoAcceptMinUSD: '50' } },
    });
    expect(codes(r)).toContain('sell_auto_accept');
  });

  it('two reviews of one edit are two bodies: different hashes', async () => {
    const { context } = await setup();
    const edit = { base: 0, patch: { proofs: { notarize: 'approval' } } };
    const a = await reviewOk(context, edit);
    const b = await reviewOk(context, edit);
    expect(a.review).not.toBe(b.review);
  });
});

// --- POST /api/ui/rules: D-119 -------------------------------------------------------------------

const LOOSER = {
  base: 0,
  patch: { proofs: { dailyBudgetUSD: '20' }, commitments: { accept: 'allow' } },
};

describe('POST /api/ui/rules: sign only an acknowledged prepared body (D-119; I-4)', () => {
  it('every warning acknowledged: signs that exact body once, core applies it', async () => {
    const { context, owner } = await setup();
    const r = await reviewOk(context, LOOSER);
    expect(codes(r)).toEqual(['proofs_spend_raised', 'commitments_allow']);
    const { op, calls } = ownerOp(owner);
    const result = await save(context, op, { review: r.review, acknowledged: codes(r) });
    expect(result).toEqual({ status: 200, body: { status: 'saved', version: 1 } });
    expect(calls).toHaveLength(1);
    const request = calls[0]?.requests[0];
    expect(request?.kind).toBe('owner-action');
    if (request?.kind !== 'owner-action') return;
    // The signed body is the reviewed one: its hash is the review the owner acknowledged.
    expect(encodeHex(sha256(encodeUtf8(canonicalize(request.action))))).toBe(r.review);
    expect(request.action.op).toBe('policy.set');
    expect(await getRules(context)).toMatchObject({
      body: {
        version: 1,
        rules: { proofs: { dailyBudgetUSD: '20' }, commitments: { accept: 'allow' } },
      },
    });
  });

  it('an edit with no warnings signs with an empty acknowledgement', async () => {
    const { context, owner } = await setup();
    const r = await reviewOk(context, { base: 0, patch: { proofs: { notarize: 'deny' } } });
    const { op, calls } = ownerOp(owner);
    expect(await save(context, op, { review: r.review, acknowledged: [] })).toEqual({
      status: 200,
      body: { status: 'saved', version: 1 },
    });
    expect(calls).toHaveLength(1);
  });

  const refusals: [string, (r: Reviewed) => JsonValue][] = [
    ['a missing acknowledgement', (r) => ({ review: r.review, acknowledged: codes(r).slice(1) })],
    ['no acknowledgement at all', (r) => ({ review: r.review, acknowledged: [] })],
    ['an acknowledgement list missing', (r) => ({ review: r.review })],
    [
      'an extra code not raised by this body',
      (r) => ({ review: r.review, acknowledged: [...codes(r), 'invites_auto'] }),
    ],
    ['an unknown code', (r) => ({ review: r.review, acknowledged: [...codes(r), 'nope'] })],
    [
      'a repeated code instead of another',
      (r) => ({ review: r.review, acknowledged: [codes(r)[0] ?? '', codes(r)[0] ?? ''] }),
    ],
    ['another body hash', (r) => ({ review: 'ab'.repeat(32), acknowledged: codes(r) })],
    ['no body hash', (r) => ({ acknowledged: codes(r) })],
    ['an unknown key', (r) => ({ review: r.review, acknowledged: codes(r), patch: {} })],
    ['no input', () => null],
  ];
  for (const [name, input] of refusals) {
    it(`never signs with ${name}; nothing changes`, async () => {
      const { context, owner } = await setup();
      const r = await reviewOk(context, LOOSER);
      const { op, calls } = ownerOp(owner);
      await save(context, op, input(r));
      expect(calls).toHaveLength(0);
      expect(await getRules(context)).toMatchObject({ body: { version: 0 } });
    });
  }

  it('an acknowledgement is bound to its body: codes acknowledged for another review do not count', async () => {
    const { context, owner } = await setup();
    const first = await reviewOk(context, { base: 0, patch: { commitments: { accept: 'allow' } } });
    const second = await reviewOk(context, LOOSER);
    const { op, calls } = ownerOp(owner);
    await save(context, op, { review: second.review, acknowledged: codes(first) });
    expect(calls).toHaveLength(0);
  });

  it('one review signs once: a second save of the same review is refused', async () => {
    const { context, owner } = await setup();
    const r = await reviewOk(context, LOOSER);
    const one = ownerOp(owner);
    await save(context, one.op, { review: r.review, acknowledged: codes(r) });
    expect(one.calls).toHaveLength(1);
    const two = ownerOp(owner);
    await save(context, two.op, { review: r.review, acknowledged: codes(r) });
    expect(two.calls).toHaveLength(0);
  });

  it('a refused attempt uses the review up: the owner reviews again', async () => {
    const { context, owner } = await setup();
    const r = await reviewOk(context, LOOSER);
    const bad = ownerOp(owner);
    await save(context, bad.op, { review: r.review, acknowledged: [] });
    const good = ownerOp(owner);
    await save(context, good.op, { review: r.review, acknowledged: codes(r) });
    expect(good.calls).toHaveLength(0);
  });

  it('an expired review is never signed', async () => {
    const { context, owner, clock } = await setup();
    const r = await reviewOk(context, LOOSER);
    clock.t += 601;
    const { op, calls } = ownerOp(owner);
    await save(context, op, { review: r.review, acknowledged: codes(r) });
    expect(calls).toHaveLength(0);
  });

  it('a review prepared for one server context is unknown to another', async () => {
    const a = await setup();
    const b = await setup();
    const r = await reviewOk(a.context, LOOSER);
    const { op, calls } = ownerOp(b.owner);
    await save(b.context, op, { review: r.review, acknowledged: codes(r) });
    expect(calls).toHaveLength(0);
  });

  it('two prepared from one base: the first applies, the second is answered not saved', async () => {
    const { context, owner } = await setup();
    const a = await reviewOk(context, { base: 0, patch: { proofs: { notarize: 'deny' } } });
    const b = await reviewOk(context, { base: 0, patch: { proofs: { notarize: 'approval' } } });
    expect(await save(context, ownerOp(owner).op, { review: a.review, acknowledged: [] })).toEqual({
      status: 200,
      body: { status: 'saved', version: 1 },
    });
    expect(await save(context, ownerOp(owner).op, { review: b.review, acknowledged: [] })).toEqual({
      status: 409,
      body: { error: 'stale' },
    });
  });

  it('the review lines are fixed text, never a value from the edit', async () => {
    const { context, owner } = await setup();
    const r = await reviewOk(context, LOOSER);
    const { op, calls } = ownerOp(owner);
    await save(context, op, { review: r.review, acknowledged: codes(r) });
    const lines = calls[0]?.review.lines.join('\n') ?? '';
    expect(lines.length).toBeGreaterThan(0);
    expect(lines).not.toContain('20');
  });
});

describe('delivery receipts on from an older default (06 §3, D-109)', () => {
  it('asks; keeping them signs true and records the receipts-kept marker at that version', async () => {
    const { context, owner, kept, client } = await setup();
    // An older default: receipts on, signed elsewhere, with no marker.
    const prepared = await client.ownerActions.preparePolicyEdit({
      receipts: { autoDelivered: true },
    });
    if (prepared.status !== 'prepared') throw new Error('not prepared');
    const session = await owner.unlock(passphrase());
    const body = prepared.body as unknown as JsonObject;
    await client.ownerActions.apply(
      JSON.stringify({ body, sig: await session.signOwnerAction(body) }),
    );
    await session.close();

    const asked = await reviewOk(context, { base: 1, patch: { proofs: { notarize: 'approval' } } });
    expect(asked.askKeepDeliveryReceipts).toBe(true);
    const keep = await reviewOk(context, {
      base: 1,
      patch: { proofs: { notarize: 'approval' } },
      keepDeliveryReceipts: true,
    });
    await save(context, ownerOp(owner).op, { review: keep.review, acknowledged: codes(keep) });
    expect(kept.value).toBe(2);
    expect(await getRules(context)).toMatchObject({
      body: { rules: { receipts: { autoDelivered: true } } },
    });
  });

  it('not keeping them signs false', async () => {
    const { context, owner, applyElsewhere } = await setup();
    await applyElsewhere({ receipts: { autoDelivered: true } });
    const r = await reviewOk(context, { base: 1, patch: { proofs: { notarize: 'approval' } } });
    await save(context, ownerOp(owner).op, { review: r.review, acknowledged: codes(r) });
    expect(await getRules(context)).toMatchObject({
      body: { version: 2, rules: { receipts: { autoDelivered: false } } },
    });
  });
});

describe('acknowledgedExactly (D-119)', () => {
  it('true only for exactly the required codes, each once, in any order', () => {
    expect(acknowledgedExactly(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(acknowledgedExactly([], [])).toBe(true);
    expect(acknowledgedExactly(['a', 'b'], ['a'])).toBe(false);
    expect(acknowledgedExactly(['a'], ['a', 'a'])).toBe(false);
    expect(acknowledgedExactly(['a'], ['a', 'c'])).toBe(false);
    expect(acknowledgedExactly(['a'], 'a')).toBe(false);
    expect(acknowledgedExactly(['a'], [1])).toBe(false);
    expect(acknowledgedExactly([], undefined)).toBe(false);
  });
});

describe('every warning code has plain words on the confirm screen (D-119; 11 §5)', () => {
  it('apps/local-ui rules strings name every core POLICY_EDIT_WARNING_CODES code', () => {
    const source = readFileSync(
      new URL('../../../../../apps/local-ui/src/pages/rules/warnings.ts', import.meta.url),
      'utf8',
    );
    expect(POLICY_EDIT_WARNING_CODES.length).toBeGreaterThanOrEqual(15);
    for (const code of POLICY_EDIT_WARNING_CODES) {
      expect(source, code).toMatch(new RegExp(`\\b${code}:\\s*['"][^'"]{12,}`));
    }
  });
});
