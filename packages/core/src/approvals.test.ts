// M1-7e: approval requests, use-once, expiry, cancel and batch use (04 §2.5.1, §2.5.2, §3.4.1;
// 06 §2.5; 07 §3 `approvals`). Verifying and applying the owner's signed objects is M1-7d
// (owner-actions.test.ts); here: what a tool call can do with a request and an approved ID.
// I-4: nothing here decides, widens or creates an approved approval without the owner's signature.
// I-5: errors and log lines carry fixed text only.
import {
  canonicalize,
  encodeBase64url,
  encodeHex,
  randomBytes,
  type JsonObject,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import { APPROVAL_TTL_SECONDS, type OwnerActionOp } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import { feeContextFromQuote } from './approvals.js';
import { AgentLinkClient } from './client.js';
import { CoreError } from './errors.js';
import { computeActionDigest } from './owner-action.js';
import { MemoryStore } from './store/memory-store.js';
import { rowKeyOf } from './store/store.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import { MemoryPolicyMark, newNonce, ownerHex, signWith } from './testing/owner.js';

/** A random 16-byte id, base64url (derived at runtime: no literal ids in tests). */
const b64id = (): string => encodeBase64url(randomBytes(16));
const SECRET = 'SECRET-ARG-TEXT-7e';
const hex64 = () => encodeHex(randomBytes(32));
const hex0x = () => `0x${hex64()}`;
const FEE_TOKEN = `0x${'ab'.repeat(20)}`;

/** A valid `agentlink_export_proof_pack` action (06 §2.0; types approval.ts). */
const exportAction = (note = 'x'): JsonObject => ({
  tool: 'agentlink_export_proof_pack',
  args: { recordId: '0x01', includeKey: true, note },
  context: {
    triggers: ['proofs.allowKeyDisclosure'],
    recordId: `0x${'ab'.repeat(32)}`,
    envelopeHash: `0x${'cd'.repeat(32)}`,
  },
});

async function setup() {
  const keyStore = new MemoryKeyStore(seed(1));
  const owner = new MemoryOwnerKeyStore(seed(101), passphrase());
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const clock = new FakeClock();
  const channel = new RecordingApprovalChannel();
  const lines: string[] = [];
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: channel,
    clock: clock.now,
    policyMark: new MemoryPolicyMark(),
    logger: createLogger({ name: 'core', level: 'debug', sink: (_l, line) => lines.push(line) }),
  });
  const session = await owner.unlock(passphrase());
  await client.identity.init({
    owner: session,
    ownerKeys: await owner.getPublicKeys(),
    name: 'Agent',
    relays: RELAYS,
  });
  await session.close();
  const OWNER = await ownerHex(owner);

  const signed = async (op: OwnerActionOp, params: JsonObject, over: JsonObject = {}) =>
    JSON.stringify(
      await signWith(owner, {
        v: 1,
        agent: client.agentId,
        owner: OWNER,
        op,
        params,
        nonce: newNonce(),
        issuedAt: clock.t,
        expiresAt: clock.t + 600,
        ...over,
      }),
    );

  /** A pending request made through the service, as a tool call would. */
  const request = async (action: JsonObject = exportAction()) => {
    const pending = await client.approvalService.request({
      action,
      summary: 'Include the document key in an export',
    });
    return { ...pending, action };
  };
  type Req = Awaited<ReturnType<typeof request>>;
  const decide = (r: Req, decision = 'approve'): JsonObject => ({
    approvalId: r.approvalId,
    actionDigest: computeActionDigest(r.action),
    decision,
  });
  const approve = async (r: Req, decision = 'approve') => {
    // Near the request's expiry the decision must expire with it, and be issued before it.
    const over =
      r.expiresAt < clock.t + 600 ? { issuedAt: clock.t - 60, expiresAt: r.expiresAt } : {};
    return client.ownerActions.apply(await signed('approval.decide', decide(r, decision), over));
  };
  const row = (approvalId: string) =>
    store.transaction((tx) => tx.get('approvals', { approval_id: approvalId }));

  return { client, store, cipher, clock, channel, lines, signed, request, decide, approve, row };
}

describe('creating a request (04 §3.4.1, 06 §2.5)', () => {
  it('stores a pending row bound to the action digest, sealed, with the 24 h TTL', async () => {
    const t = await setup();
    const action = exportAction(SECRET);
    const pending = await t.client.approvalService.request({
      action,
      summary: 'Include the document key in an export',
    });
    expect(pending).toMatchObject({
      status: 'pending_approval',
      summary: 'Include the document key in an export',
      actionDigest: computeActionDigest(action),
      expiresAt: t.clock.t + APPROVAL_TTL_SECONDS,
    });
    expect(pending.approvalId).toMatch(/^apr_[A-Za-z0-9_-]{22}$/);
    const row = await t.row(pending.approvalId);
    expect(row).toMatchObject({
      status: 'pending',
      source: 'owner',
      signed_decision: null,
      signed_cancel: null,
      scope_json: null,
      expires_at: t.clock.t + APPROVAL_TTL_SECONDS,
      created_at: t.clock.t,
      decided_at: null,
    });
    // `args` can hold message text: sealed at rest, bound to its row (07 §3).
    expect(row?.action_json).not.toContain(SECRET);
    const opened = await t.cipher.open(
      {
        table: 'approvals',
        column: 'action_json',
        rowKey: rowKeyOf([pending.approvalId]),
      },
      row!.action_json,
    );
    expect(opened).toBe(canonicalize(action));
    // Delivered to the owner's channel after the commit, with fixed text only.
    expect(t.channel.requests).toEqual([
      {
        approvalId: pending.approvalId,
        actionDigest: computeActionDigest(action),
        summary: 'Include the document key in an export',
        expiresAt: t.clock.t + APPROVAL_TTL_SECONDS,
      },
    ]);
  });

  it('gives every request a fresh ID', async () => {
    const t = await setup();
    const a = await t.request();
    const b = await t.request();
    expect(a.approvalId).not.toBe(b.approvalId);
  });

  it('refuses an action the strict schema does not accept, with a fixed message (I-5)', async () => {
    const t = await setup();
    const bad = { ...exportAction(SECRET), context: { triggers: ['policy.set'] } };
    const error = await t.client.approvalService
      .request({ action: bad, summary: 'Export' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe('approval_action_invalid');
    expect((error as CoreError).message).not.toContain(SECRET);
    expect(await t.store.transaction((tx) => tx.count('approvals'))).toBe(0);
    expect(t.lines.join('\n')).not.toContain(SECRET);
  });

  it.each([
    ['empty', ''],
    ['a newline', 'Send\nApproved'],
    ['a bidi control', 'Send ‮to Bob'],
    ['a line separator', 'Send x'],
    ['over 200 characters', 'a'.repeat(201)],
  ])('refuses a summary with %s (I-5, 04 §3.4.1)', async (_n, summary) => {
    const t = await setup();
    const error = await t.client.approvalService
      .request({ action: exportAction(), summary })
      .catch((e: unknown) => e);
    expect((error as CoreError).code).toBe('approval_summary_invalid');
    expect(await t.store.transaction((tx) => tx.count('approvals'))).toBe(0);
  });

  it('keeps the request when the channel fails, and logs a fixed code only', async () => {
    const t = await setup();
    t.channel.request = () => Promise.reject(new Error(`channel down ${SECRET}`));
    const pending = await t.request(exportAction(SECRET));
    expect(pending.status).toBe('pending_approval');
    expect((await t.row(pending.approvalId))?.status).toBe('pending');
    expect(t.lines.join('\n')).not.toContain(SECRET);
  });

  it('a commitment request whose scope expires sooner expires with the scope (G-7)', async () => {
    const t = await setup();
    const now = t.clock.t;
    const scope = {
      v: 1,
      kind: 'agentlink/commitment',
      agentId: t.client.agentId,
      decision: 'offer',
      counterparty: { agentId: `0x${'11'.repeat(20)}`, ownerKey: hex64() },
      thread: b64id(),
      termsId: b64id(),
      version: 1,
      termsHash: hex64(),
      answers: null,
      notarize: true,
      maxFeeUsd: '1',
      createdAt: now,
      expiresAt: now + 3_600,
    };
    // Strict terms and TermsInput since M1-21 (04 §3.4, 06 §2.2a).
    const terms = {
      termsId: scope.termsId,
      version: 1,
      // D-74: parties in ascending byte order, every key present (`price: null`).
      parties: [scope.agentId, scope.counterparty.agentId].sort(),
      subject: 'Milestone 3',
      deliverables: [
        { id: 'd1', description: 'Spec', by: scope.counterparty.agentId, plaintextSha256: null },
      ],
      price: null,
      deadlines: [],
      validUntil: now + 3_600,
      previousTermsHash: null,
    };
    const action = {
      tool: 'agentlink_propose_terms',
      args: {
        to: scope.counterparty.agentId,
        terms: { subject: 'Milestone 3', deliverables: [{ description: 'Spec', by: 'them' }] },
        notarize: true,
      },
      context: {
        triggers: ['commitments.accept'],
        scope,
        terms,
        fee: { token: FEE_TOKEN, amount: '100000', usd: '0.1' },
      },
    };
    const pending = await t.client.approvalService.request({
      action,
      summary: 'Make a firm offer',
    });
    expect(pending.expiresAt).toBe(now + 3_600);
    const row = await t.row(pending.approvalId);
    expect(row?.expires_at).toBe(now + 3_600);
    expect(row?.scope_json).toBe(canonicalize(scope));
    // Commitment parts are M1-32: until then an approved commitment is never used as a whole.
    expect(await t.client.approvalService.use(pending.approvalId, action, 'approval')).toEqual({
      status: 'refused',
      reason: 'commitment_scope',
    });
  });

  it('a commitment request starts at its scope createdAt: a later clock second is fine, a stale or future scope is not (M1-32-d)', async () => {
    const t = await setup();
    const createdAt = t.clock.t;
    const actionAt = (at: number) => {
      const scope = {
        v: 1,
        kind: 'agentlink/commitment',
        agentId: t.client.agentId,
        decision: 'offer',
        counterparty: { agentId: `0x${'11'.repeat(20)}`, ownerKey: hex64() },
        thread: b64id(),
        termsId: b64id(),
        version: 1,
        termsHash: hex64(),
        answers: null,
        notarize: true,
        maxFeeUsd: '1',
        createdAt: at,
        expiresAt: at + 3_600,
      };
      const terms = {
        termsId: scope.termsId,
        version: 1,
        parties: [scope.agentId, scope.counterparty.agentId].sort(),
        subject: 'Milestone 3',
        deliverables: [
          { id: 'd1', description: 'Spec', by: scope.counterparty.agentId, plaintextSha256: null },
        ],
        price: null,
        deadlines: [],
        validUntil: at + 3_600,
        previousTermsHash: null,
      };
      return {
        tool: 'agentlink_propose_terms',
        args: {
          to: scope.counterparty.agentId,
          terms: { subject: 'Milestone 3', deliverables: [{ description: 'Spec', by: 'them' }] },
          notarize: true,
        },
        context: {
          triggers: ['commitments.accept'],
          scope,
          terms,
          fee: { token: FEE_TOKEN, amount: '100000', usd: '0.1' },
        },
      };
    };
    const ask = (action: unknown) =>
      t.client.approvalService.request({ action, summary: 'Make a firm offer' });
    // Built one second before the request is stored: the request starts at the scope's createdAt.
    const built = actionAt(createdAt);
    t.clock.t = createdAt + 1;
    const pending = await ask(built);
    expect(pending.expiresAt).toBe(createdAt + 3_600);
    const row = await t.row(pending.approvalId);
    expect(row?.created_at).toBe(createdAt);
    expect(row?.status).toBe('pending');
    // A scope from the future, or one older than a core call takes, is refused and stores nothing.
    for (const at of [t.clock.t + 1, t.clock.t - 61]) {
      const error = await ask(actionAt(at)).catch((e: unknown) => e);
      expect((error as CoreError).code).toBe('approval_action_invalid');
    }
  });

  it('refuses a request when the agent has no identity', async () => {
    const client = await AgentLinkClient.create({
      keyStore: new MemoryKeyStore(seed(3)),
      store: new MemoryStore(),
      cipher: new TestStoreCipher(),
      approvals: new RecordingApprovalChannel(),
    });
    const error = await client.approvalService
      .request({ action: exportAction(), summary: 'Export' })
      .catch((e: unknown) => e);
    expect((error as CoreError).code).toBe('identity_missing');
  });
});

describe('use once (04 §3.4.1, 06 §2.5)', () => {
  it('an approved ID lets the identical action proceed once; then it is void', async () => {
    const t = await setup();
    const r = await t.request();
    expect(await t.approve(r)).toMatchObject({ status: 'applied' });
    expect(await t.client.ownerActions.checkApproval(r.approvalId, r.action)).toEqual({
      status: 'approved',
    });
    expect(await t.client.approvalService.use(r.approvalId, r.action, 'approval')).toEqual({
      status: 'used',
    });
    expect((await t.row(r.approvalId))?.status).toBe('void');
    expect(await t.client.approvalService.use(r.approvalId, r.action, 'approval')).toEqual({
      status: 'void',
    });
    expect(await t.client.ownerActions.checkApproval(r.approvalId, r.action)).toEqual({
      status: 'void',
    });
  });

  it('an approved ID is refused for a different action, and stays usable for its own', async () => {
    const t = await setup();
    const r = await t.request(exportAction('one'));
    await t.approve(r);
    expect(
      await t.client.approvalService.use(r.approvalId, exportAction('two'), 'approval'),
    ).toEqual({ status: 'refused', reason: 'digest_mismatch' });
    expect((await t.row(r.approvalId))?.status).toBe('approved');
    expect(await t.client.approvalService.use(r.approvalId, r.action, 'approval')).toEqual({
      status: 'used',
    });
  });

  it('a pending, a denied or an unknown ID authorises nothing', async () => {
    const t = await setup();
    const pending = await t.request();
    expect(
      await t.client.approvalService.use(pending.approvalId, pending.action, 'approval'),
    ).toEqual({ status: 'pending' });
    const denied = await t.request();
    await t.approve(denied, 'deny');
    expect(
      await t.client.approvalService.use(denied.approvalId, denied.action, 'approval'),
    ).toEqual({ status: 'denied' });
    expect(
      await t.client.approvalService.use(`apr_${'A'.repeat(22)}`, exportAction(), 'approval'),
    ).toEqual({ status: 'refused', reason: 'approval_unknown' });
    expect(await t.client.approvalService.use('not-an-id', exportAction(), 'approval')).toEqual({
      status: 'refused',
      reason: 'approval_unknown',
    });
  });

  it('a rule changed to deny after approval refuses the approved call and keeps it unused', async () => {
    const t = await setup();
    const r = await t.request();
    await t.approve(r);
    expect(await t.client.approvalService.use(r.approvalId, r.action, 'deny')).toEqual({
      status: 'refused',
      reason: 'policy_deny',
    });
    expect((await t.row(r.approvalId))?.status).toBe('approved');
  });

  it('two concurrent uses of one approved ID: exactly one proceeds', async () => {
    const t = await setup();
    const r = await t.request();
    await t.approve(r);
    const results = await Promise.all([
      t.client.approvalService.use(r.approvalId, r.action, 'approval'),
      t.client.approvalService.use(r.approvalId, r.action, 'approval'),
      t.client.approvalService.use(r.approvalId, r.action, 'approval'),
    ]);
    expect(results.filter((x) => x.status === 'used')).toHaveLength(1);
    expect(results.filter((x) => x.status !== 'used').every((x) => x.status === 'void')).toBe(true);
  });

  it('authorize hands out a claim for the effect transaction; a refused claim writes nothing', async () => {
    const t = await setup();
    const r = await t.request();
    await t.approve(r);
    const first = await t.client.approvalService.authorize(r.approvalId, r.action, 'approval');
    const second = await t.client.approvalService.authorize(r.approvalId, r.action, 'approval');
    expect(first.status).toBe('authorized');
    expect(second.status).toBe('authorized');
    if (first.status !== 'authorized' || second.status !== 'authorized') return;
    expect(await t.store.transaction((tx) => first.claim(tx))).toBe(true);
    // The second claim finds the row already used: the caller's effect transaction must abort.
    expect(await t.store.transaction((tx) => second.claim(tx))).toBe(false);
  });

  it('a status edited in the store never grants: approved without a signed decision is pending', async () => {
    const t = await setup();
    const r = await t.request();
    await t.store.transaction((tx) =>
      tx.update('approvals', { approval_id: r.approvalId }, { status: 'approved' }),
    );
    expect(await t.client.approvalService.use(r.approvalId, r.action, 'approval')).toEqual({
      status: 'pending',
    });
    expect((await t.row(r.approvalId))?.status).toBe('approved');
  });

  it('a decision copied from another request does not verify for this one', async () => {
    const t = await setup();
    const a = await t.request();
    const b = await t.request();
    await t.approve(a);
    const decided = await t.row(a.approvalId);
    await t.store.transaction((tx) =>
      tx.update(
        'approvals',
        { approval_id: b.approvalId },
        { status: 'approved', signed_decision: decided!.signed_decision },
      ),
    );
    expect(await t.client.approvalService.use(b.approvalId, b.action, 'approval')).toEqual({
      status: 'refused',
      reason: 'decision_invalid',
    });
  });
});

describe('expiry (G-7, 04 §3.4.1)', () => {
  it('expiresAt = requestedAt + 86 400; a decision at expiresAt applies, at expiresAt + 1 it does not', async () => {
    const t = await setup();
    const r = await t.request();
    const late = await t.request();
    expect(r.expiresAt).toBe(t.clock.t + 86_400);
    t.clock.t = r.expiresAt;
    expect(await t.approve(r)).toMatchObject({ status: 'applied' });
    t.clock.t = late.expiresAt + 1;
    const text = await t.signed('approval.decide', t.decide(late), {
      issuedAt: t.clock.t,
      expiresAt: late.expiresAt,
    });
    expect(await t.client.ownerActions.apply(text)).toMatchObject({ status: 'refused' });
    expect((await t.row(late.approvalId))?.status).toBe('pending');
  });

  it('an approved, unused approval runs at expiresAt and is expired at expiresAt + 1', async () => {
    const t = await setup();
    const a = await t.request();
    const b = await t.request();
    await t.approve(a);
    await t.approve(b);
    t.clock.t = a.expiresAt;
    expect(await t.client.approvalService.use(a.approvalId, a.action, 'approval')).toEqual({
      status: 'used',
    });
    t.clock.t = b.expiresAt + 1;
    expect(await t.client.approvalService.use(b.approvalId, b.action, 'approval')).toEqual({
      status: 'expired',
    });
    expect((await t.row(b.approvalId))?.status).toBe('approved');
    // The next call asks again: a new pending request with a new ID.
    const again = await t.request(b.action);
    expect(again.approvalId).not.toBe(b.approvalId);
    expect(again.expiresAt).toBe(t.clock.t + 86_400);
  });

  it('expireDue marks lapsed pending and approved rows expired, and leaves the rest', async () => {
    const t = await setup();
    const pending = await t.request();
    const approved = await t.request();
    await t.approve(approved);
    const fresh = await t.request();
    const used = await t.request();
    await t.approve(used);
    await t.client.approvalService.use(used.approvalId, used.action, 'approval');
    t.clock.t = pending.expiresAt + 1;
    const later = await t.request();
    expect(await t.client.approvalService.expireDue()).toBe(3);
    expect((await t.row(pending.approvalId))?.status).toBe('expired');
    expect((await t.row(approved.approvalId))?.status).toBe('expired');
    expect((await t.row(fresh.approvalId))?.status).toBe('expired');
    expect((await t.row(used.approvalId))?.status).toBe('void');
    expect((await t.row(later.approvalId))?.status).toBe('pending');
    // A status that only takes authority away is honoured.
    expect(await t.client.ownerActions.checkApproval(approved.approvalId, approved.action)).toEqual(
      { status: 'expired' },
    );
  });
});

describe('approval.cancel (04 §2.5.1)', () => {
  it('voids an approved, unused approval; the retry needs a new request', async () => {
    const t = await setup();
    const r = await t.request();
    await t.approve(r);
    const cancel = await t.signed('approval.cancel', { approvalId: r.approvalId });
    expect(await t.client.ownerActions.apply(cancel)).toMatchObject({ status: 'applied' });
    expect(await t.client.approvalService.use(r.approvalId, r.action, 'approval')).toEqual({
      status: 'cancelled',
    });
  });

  it('on a used approval changes nothing', async () => {
    const t = await setup();
    const r = await t.request();
    await t.approve(r);
    await t.client.approvalService.use(r.approvalId, r.action, 'approval');
    const cancel = await t.signed('approval.cancel', { approvalId: r.approvalId });
    expect(await t.client.ownerActions.apply(cancel)).toMatchObject({
      status: 'refused',
      reason: 'not_approved',
    });
    expect(await t.row(r.approvalId)).toMatchObject({ status: 'void', signed_cancel: null });
  });
});

describe('batch use (D-68, 04 §2.5.2)', () => {
  const batchOf = (
    t: Awaited<ReturnType<typeof setup>>,
    rs: Awaited<ReturnType<typeof t.request>>[],
  ) =>
    t.signed('approval.decideBatch', {
      items: [...rs].sort((a, b) => (a.approvalId < b.approvalId ? -1 : 1)).map((r) => t.decide(r)),
    });

  it('a batch of 3 approves exactly those 3, and each proceeds once', async () => {
    const t = await setup();
    const rs = [await t.request(), await t.request(), await t.request()];
    const other = await t.request();
    expect(await t.client.ownerActions.apply(await batchOf(t, rs))).toMatchObject({
      status: 'applied',
    });
    for (const r of rs) {
      expect(await t.client.approvalService.use(r.approvalId, r.action, 'approval')).toEqual({
        status: 'used',
      });
      expect(await t.client.approvalService.use(r.approvalId, r.action, 'approval')).toEqual({
        status: 'void',
      });
    }
    expect(await t.client.approvalService.use(other.approvalId, other.action, 'approval')).toEqual({
      status: 'pending',
    });
  });

  it('approval.cancel on one item voids only that item', async () => {
    const t = await setup();
    const rs = [await t.request(), await t.request(), await t.request()];
    await t.client.ownerActions.apply(await batchOf(t, rs));
    const [a, b, c] = rs as [(typeof rs)[0], (typeof rs)[0], (typeof rs)[0]];
    await t.client.ownerActions.apply(
      await t.signed('approval.cancel', { approvalId: b.approvalId }),
    );
    expect(await t.client.approvalService.use(a.approvalId, a.action, 'approval')).toEqual({
      status: 'used',
    });
    expect(await t.client.approvalService.use(b.approvalId, b.action, 'approval')).toEqual({
      status: 'cancelled',
    });
    expect(await t.client.approvalService.use(c.approvalId, c.action, 'approval')).toEqual({
      status: 'used',
    });
  });

  it('refuses a batch that contains a paid item, whole (04 §2.5.3 rule 7, M1-PAY-CONFIRM-a)', async () => {
    const t = await setup();
    const fee = feeContextFromQuote({ token: FEE_TOKEN, amount: 100_000n, decimals: 6 });
    const plain = await t.request();
    const paid = await t.request({
      tool: 'agentlink_notarize',
      args: { envelopeId: b64id() },
      context: { triggers: ['proofs.notarize'], counterparty: null, envelopeHash: hex0x(), fee },
    });
    const outcome = await t.client.ownerActions.apply(await batchOf(t, [plain, paid]));
    expect(outcome).toMatchObject({
      status: 'refused',
      reason: 'item_refused',
      items: [{ approvalId: paid.approvalId, reason: 'paid_item_in_batch' }],
    });
    // Whole or nothing: the free item is still pending, and so is the paid one.
    expect(await t.row(plain.approvalId)).toMatchObject({ status: 'pending' });
    expect(await t.row(paid.approvalId)).toMatchObject({ status: 'pending' });
    // Decided alone (after its own confirmation), the paid item applies.
    expect(await t.approve(paid)).toMatchObject({ status: 'applied' });
  });

  it('a request edited in the store after the batch was signed no longer matches its item', async () => {
    const t = await setup();
    const rs = [await t.request(), await t.request()];
    const text = await batchOf(t, rs);
    const edited = rs[0]!;
    const sealed = await t.cipher.seal(
      { table: 'approvals', column: 'action_json', rowKey: rowKeyOf([edited.approvalId]) },
      canonicalize(exportAction('edited')),
    );
    await t.store.transaction((tx) =>
      tx.update('approvals', { approval_id: edited.approvalId }, { action_json: sealed }),
    );
    expect(await t.client.ownerActions.apply(text)).toMatchObject({
      status: 'refused',
      nonceBurnt: true,
    });
    for (const r of rs) expect((await t.row(r.approvalId))?.status).toBe('pending');
  });
});

describe('collecting the owner decision from the channel (03 §4.5)', () => {
  it('applies a signed decision the channel holds, after verifying it', async () => {
    const t = await setup();
    const r = await t.request();
    t.channel.next = { state: 'signed', signed: await t.signed('approval.decide', t.decide(r)) };
    expect(await t.client.approvalService.collect(r.approvalId)).toMatchObject({
      status: 'applied',
      op: 'approval.decide',
    });
    expect((await t.row(r.approvalId))?.status).toBe('approved');
  });

  it('a status from the channel alone decides nothing (I-4)', async () => {
    const t = await setup();
    const r = await t.request();
    t.channel.next = { state: 'signed', signed: `{"approved":true,"note":"${SECRET}"}` };
    expect(await t.client.approvalService.collect(r.approvalId)).toMatchObject({
      status: 'refused',
      reason: 'malformed',
    });
    t.channel.next = { state: 'pending' };
    expect(await t.client.approvalService.collect(r.approvalId)).toEqual({ status: 'pending' });
    expect((await t.row(r.approvalId))?.status).toBe('pending');
    expect(t.lines.join('\n')).not.toContain(SECRET);
  });

  it('a decision for another request held by the channel does not touch this one', async () => {
    const t = await setup();
    const a = await t.request();
    const b = await t.request();
    t.channel.next = { state: 'signed', signed: await t.signed('approval.decide', t.decide(b)) };
    expect(await t.client.approvalService.collect(a.approvalId)).toEqual({
      status: 'refused',
      reason: 'other_request',
      nonceBurnt: false,
      op: 'approval.decide',
    });
    expect((await t.row(a.approvalId))?.status).toBe('pending');
    expect((await t.row(b.approvalId))?.status).toBe('pending');
  });
});

describe('fee context from one quote (IR-M1-2b-1 F-3)', () => {
  it('builds amount and usd from the same base-unit value at 1:1 (D-46)', () => {
    expect(feeContextFromQuote({ token: FEE_TOKEN, amount: 100_000n, decimals: 6 })).toEqual({
      token: FEE_TOKEN,
      amount: '100000',
      usd: '0.1',
    });
    expect(feeContextFromQuote({ token: FEE_TOKEN, amount: 2_500_000n, decimals: 6 })).toEqual({
      token: FEE_TOKEN,
      amount: '2500000',
      usd: '2.5',
    });
    expect(feeContextFromQuote({ token: FEE_TOKEN, amount: 0n, decimals: 6 }).usd).toBe('0');
  });

  it('rounds a value finer than 6 decimals up, never down', () => {
    // 18-decimal token: 1 wei is above zero, so the fee shown is the smallest step, $0.000001.
    expect(feeContextFromQuote({ token: FEE_TOKEN, amount: 1n, decimals: 18 }).usd).toBe(
      '0.000001',
    );
    expect(
      feeContextFromQuote({ token: FEE_TOKEN, amount: 1_000_000_000_000_000_001n, decimals: 18 })
        .usd,
    ).toBe('1.000001');
  });

  it.each([
    ['a negative amount', { token: FEE_TOKEN, amount: -1n, decimals: 6 }],
    [
      'an upper-case token',
      { token: FEE_TOKEN.toUpperCase().replace('0X', '0x'), amount: 1n, decimals: 6 },
    ],
    ['fractional decimals', { token: FEE_TOKEN, amount: 1n, decimals: 6.5 }],
    ['too many decimals', { token: FEE_TOKEN, amount: 1n, decimals: 78 }],
    ['an amount above the USD range', { token: FEE_TOKEN, amount: 10n ** 30n, decimals: 6 }],
  ])('refuses %s', (_n, quote) => {
    expect(() => feeContextFromQuote(quote)).toThrow(CoreError);
  });

  it('the fee it builds is accepted in a request action', async () => {
    const t = await setup();
    const fee = feeContextFromQuote({ token: FEE_TOKEN, amount: 100_000n, decimals: 6 });
    const action = {
      tool: 'agentlink_notarize',
      args: { envelopeId: b64id() },
      context: { triggers: ['proofs.notarize'], counterparty: null, envelopeHash: hex0x(), fee },
    };
    const pending = await t.client.approvalService.request({ action, summary: 'Record a proof' });
    expect(pending.status).toBe('pending_approval');
  });
});

describe('reading one approval by ID (06 §2.5 agentlink_get_approval; M1-7e-3)', () => {
  /** The only keys a read may carry: no signature, decision payload, summary or action. */
  const READ_KEYS = new Set(['status', 'reason', 'actionDigest', 'expiresAt', 'decidedAt']);
  const keysOk = (value: object) => Object.keys(value).every((k) => READ_KEYS.has(k));

  it('a pending request reads pending, bound to its stored action digest', async () => {
    const t = await setup();
    const r = await t.request();
    expect(await t.client.approvalService.read(r.approvalId)).toEqual({
      status: 'pending',
      actionDigest: computeActionDigest(r.action),
      expiresAt: r.expiresAt,
    });
  });

  it('an approved request reads approved with decidedAt; reading changes nothing', async () => {
    const t = await setup();
    const r = await t.request();
    await t.approve(r);
    const before = await t.row(r.approvalId);
    const read = await t.client.approvalService.read(r.approvalId);
    expect(read).toEqual({
      status: 'approved',
      actionDigest: computeActionDigest(r.action),
      expiresAt: r.expiresAt,
      decidedAt: t.clock.t,
    });
    // Read-only: it never claims the approval, and it can still be used once.
    expect(await t.row(r.approvalId)).toEqual(before);
    expect(await t.client.approvalService.use(r.approvalId, r.action, 'approval')).toEqual({
      status: 'used',
    });
  });

  it('a used approval reads used, never approved', async () => {
    const t = await setup();
    const r = await t.request();
    await t.approve(r);
    await t.client.approvalService.use(r.approvalId, r.action, 'approval');
    expect(await t.client.approvalService.read(r.approvalId)).toMatchObject({ status: 'used' });
  });

  it('resumeOf (M1-22) names only the tool of a non-terms action: never its args, which may hold agent-written text', async () => {
    const t = await setup();
    const r = await t.request(exportAction('CANARY note from inbound text'));
    expect(await t.client.approvalService.resumeOf(r.approvalId)).toEqual({
      tool: 'agentlink_export_proof_pack',
    });
    await t.approve(r);
    expect(await t.client.approvalService.resumeOf(r.approvalId)).toEqual({
      tool: 'agentlink_export_proof_pack',
    });
    await t.client.approvalService.use(r.approvalId, r.action, 'approval');
    expect(await t.client.approvalService.resumeOf(r.approvalId)).toBeUndefined();
  });

  it('an expired request reads expired, whether it was pending or approved and unused', async () => {
    const t = await setup();
    const pending = await t.request();
    const approved = await t.request();
    await t.approve(approved);
    t.clock.t = approved.expiresAt;
    expect(await t.client.approvalService.read(approved.approvalId)).toMatchObject({
      status: 'approved',
    });
    t.clock.t = pending.expiresAt + 1;
    expect(await t.client.approvalService.read(pending.approvalId)).toMatchObject({
      status: 'expired',
    });
    expect(await t.client.approvalService.read(approved.approvalId)).toMatchObject({
      status: 'expired',
    });
    // The expiry cache gives the same answer.
    await t.client.approvalService.expireDue();
    expect(await t.client.approvalService.read(pending.approvalId)).toMatchObject({
      status: 'expired',
    });
    expect(await t.client.approvalService.read(approved.approvalId)).toMatchObject({
      status: 'expired',
    });
  });

  it('a denial reads denied; a cancel reads cancelled, or denied when never decided', async () => {
    const t = await setup();
    const denied = await t.request();
    const cancelled = await t.request();
    const withdrawn = await t.request();
    await t.approve(denied, 'deny');
    await t.approve(cancelled);
    for (const r of [cancelled, withdrawn]) {
      const cancel = await t.signed('approval.cancel', { approvalId: r.approvalId });
      expect(await t.client.ownerActions.apply(cancel)).toMatchObject({ status: 'applied' });
    }
    expect(await t.client.approvalService.read(denied.approvalId)).toMatchObject({
      status: 'denied',
    });
    expect(await t.client.approvalService.read(cancelled.approvalId)).toMatchObject({
      status: 'cancelled',
    });
    expect(await t.client.approvalService.read(withdrawn.approvalId)).toMatchObject({
      status: 'denied',
    });
  });

  it('a request voided before any decision reads void, not used', async () => {
    const t = await setup();
    const r = await t.request();
    await t.store.transaction((tx) =>
      tx.update('approvals', { approval_id: r.approvalId }, { status: 'void' }),
    );
    expect(await t.client.approvalService.read(r.approvalId)).toMatchObject({ status: 'void' });
  });

  it('an unknown or malformed ID reads unknown (not_found)', async () => {
    const t = await setup();
    for (const id of [`apr_${b64id()}`, 'apr_short', 'nope', '']) {
      expect(await t.client.approvalService.read(id)).toEqual({
        status: 'unknown',
        reason: 'not_found',
      });
    }
  });

  it('a status edited to approved without a signed decision reads pending (I-4)', async () => {
    const t = await setup();
    const r = await t.request();
    await t.store.transaction((tx) =>
      tx.update('approvals', { approval_id: r.approvalId }, { status: 'approved' }),
    );
    expect(await t.client.approvalService.read(r.approvalId)).toMatchObject({ status: 'pending' });
  });

  it('a tampered row reads unknown (invalid): an edited row authorises nothing', async () => {
    const t = await setup();
    const a = await t.request(exportAction('a'));
    const b = await t.request(exportAction('b'));
    const c = await t.request(exportAction('c'));
    const d = await t.request(exportAction('d'));
    await t.approve(a);
    await t.approve(c);
    await t.approve(d);
    const rowA = (await t.row(a.approvalId))!;
    const rowD = (await t.row(d.approvalId))!;
    await t.store.transaction((tx) => {
      // A decision copied from another request.
      tx.update(
        'approvals',
        { approval_id: b.approvalId },
        { status: 'approved', signed_decision: rowA.signed_decision },
      );
      // A sealed action moved from another row (its AAD binds it to that row).
      tx.update('approvals', { approval_id: c.approvalId }, { action_json: rowA.action_json });
      // A signed decision whose bytes were edited.
      tx.update(
        'approvals',
        { approval_id: d.approvalId },
        { signed_decision: rowD.signed_decision!.replace('"approve"', '"deny"') },
      );
    });
    for (const r of [b, c, d]) {
      expect(await t.client.approvalService.read(r.approvalId)).toEqual({
        status: 'unknown',
        reason: 'invalid',
      });
    }
    // And an edited row still authorises nothing on use.
    expect(await t.client.approvalService.use(b.approvalId, b.action, 'approval')).toMatchObject({
      status: 'refused',
    });
  });

  it('a used approval whose decision was swapped reads unknown (invalid), never used', async () => {
    const t = await setup();
    const a = await t.request(exportAction('a'));
    const b = await t.request(exportAction('b'));
    await t.approve(a);
    await t.approve(b);
    await t.client.approvalService.use(b.approvalId, b.action, 'approval');
    const rowA = (await t.row(a.approvalId))!;
    await t.store.transaction((tx) =>
      tx.update(
        'approvals',
        { approval_id: b.approvalId },
        { signed_decision: rowA.signed_decision },
      ),
    );
    expect(await t.client.approvalService.read(b.approvalId)).toEqual({
      status: 'unknown',
      reason: 'invalid',
    });
  });

  it('never returns the owner signature, the decision payload, the summary or the action', async () => {
    const t = await setup();
    const pending = await t.request(exportAction(SECRET));
    const approved = await t.request(exportAction(SECRET));
    await t.approve(approved);
    const used = await t.request(exportAction(SECRET));
    await t.approve(used);
    await t.client.approvalService.use(used.approvalId, used.action, 'approval');
    const denied = await t.request(exportAction(SECRET));
    await t.approve(denied, 'deny');
    for (const r of [pending, approved, used, denied]) {
      const read = await t.client.approvalService.read(r.approvalId);
      expect(keysOk(read)).toBe(true);
      const text = JSON.stringify(read);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('Include the document key');
      expect(text).not.toContain('nonce');
      const row = (await t.row(r.approvalId))!;
      if (row.signed_decision !== null) {
        const signed = JSON.parse(row.signed_decision) as Record<string, unknown>;
        for (const [k, v] of Object.entries(signed)) {
          if (k !== 'body') expect(text).not.toContain(JSON.stringify(v));
        }
      }
    }
    expect(t.lines.join('\n')).not.toContain(SECRET);
  });
});

describe('counting pending approvals (06 §2.1 agentlink_status pendingApprovals; M1-7e-3)', () => {
  it('counts only undecided, unexpired requests: not void, used, approved, denied or lapsed', async () => {
    const t = await setup();
    expect(await t.client.approvalService.countPending()).toBe(0);
    const p1 = await t.request();
    await t.request();
    const approved = await t.request();
    const used = await t.request();
    const denied = await t.request();
    const voided = await t.request();
    const cancelled = await t.request();
    expect(await t.client.approvalService.countPending()).toBe(7);
    await t.approve(approved);
    await t.approve(used);
    await t.client.approvalService.use(used.approvalId, used.action, 'approval');
    await t.approve(denied, 'deny');
    await t.store.transaction((tx) =>
      tx.update('approvals', { approval_id: voided.approvalId }, { status: 'void' }),
    );
    await t.client.ownerActions.apply(
      await t.signed('approval.cancel', { approvalId: cancelled.approvalId }),
    );
    expect(await t.client.approvalService.countPending()).toBe(2);
    // A lapsed request no longer counts, before and after the expiry cache runs.
    t.clock.t = p1.expiresAt + 1;
    await t.request();
    expect(await t.client.approvalService.countPending()).toBe(1);
    await t.client.approvalService.expireDue();
    expect(await t.client.approvalService.countPending()).toBe(1);
  });
});

describe('finding the open request for an identical action (06 §2.5 reuse; M1-13a follow-up)', () => {
  /** The only keys a find may carry: no signature, decision payload, summary or action. */
  const FIND_KEYS = new Set(['approvalId', 'status', 'expiresAt']);

  it('a pending request for the identical action is found; nothing else is returned', async () => {
    const t = await setup();
    const r = await t.request(exportAction(SECRET));
    const found = await t.client.approvalService.findOpen(exportAction(SECRET));
    expect(found).toEqual({ approvalId: r.approvalId, status: 'pending', expiresAt: r.expiresAt });
    expect(Object.keys(found ?? {}).every((k) => FIND_KEYS.has(k))).toBe(true);
    expect(t.lines.join('\n')).not.toContain(SECRET);
  });

  it('a request for a different action is not found', async () => {
    const t = await setup();
    await t.request(exportAction('one'));
    expect(await t.client.approvalService.findOpen(exportAction('two'))).toBeUndefined();
  });

  it('finding is read-only: the row is unchanged and no new request is made', async () => {
    const t = await setup();
    const r = await t.request();
    const before = await t.row(r.approvalId);
    await t.client.approvalService.findOpen(r.action);
    expect(await t.row(r.approvalId)).toEqual(before);
    expect(await t.client.approvalService.countPending()).toBe(1);
  });

  it('an approved, unused request is found as approved and stays usable once (I-4)', async () => {
    const t = await setup();
    const r = await t.request();
    await t.approve(r);
    expect(await t.client.approvalService.findOpen(r.action)).toEqual({
      approvalId: r.approvalId,
      status: 'approved',
      expiresAt: r.expiresAt,
    });
    expect((await t.row(r.approvalId))?.status).toBe('approved');
    expect(await t.client.approvalService.use(r.approvalId, r.action, 'approval')).toEqual({
      status: 'used',
    });
  });

  it('used, denied, cancelled, withdrawn, voided and expired requests are not found', async () => {
    const t = await setup();
    const used = await t.request();
    await t.approve(used);
    await t.client.approvalService.use(used.approvalId, used.action, 'approval');
    expect(await t.client.approvalService.findOpen(used.action)).toBeUndefined();

    const denied = await t.request();
    await t.approve(denied, 'deny');
    expect(await t.client.approvalService.findOpen(denied.action)).toBeUndefined();

    const cancelled = await t.request();
    await t.approve(cancelled);
    await t.client.ownerActions.apply(
      await t.signed('approval.cancel', { approvalId: cancelled.approvalId }),
    );
    expect(await t.client.approvalService.findOpen(cancelled.action)).toBeUndefined();

    const withdrawn = await t.request();
    await t.client.ownerActions.apply(
      await t.signed('approval.cancel', { approvalId: withdrawn.approvalId }),
    );
    expect(await t.client.approvalService.findOpen(withdrawn.action)).toBeUndefined();

    const voided = await t.request();
    await t.store.transaction((tx) =>
      tx.update('approvals', { approval_id: voided.approvalId }, { status: 'void' }),
    );
    expect(await t.client.approvalService.findOpen(voided.action)).toBeUndefined();

    const lapsed = await t.request();
    t.clock.t = lapsed.expiresAt + 1;
    expect(await t.client.approvalService.findOpen(lapsed.action)).toBeUndefined();
    await t.client.approvalService.expireDue();
    expect(await t.client.approvalService.findOpen(lapsed.action)).toBeUndefined();
  });

  it('an approved request is preferred over a pending one for the same action', async () => {
    const t = await setup();
    const first = await t.request();
    const second = await t.request();
    await t.approve(second);
    await t.request();
    expect(await t.client.approvalService.findOpen(first.action)).toMatchObject({
      approvalId: second.approvalId,
      status: 'approved',
    });
  });

  it('a status edited to approved without a signed decision is found as pending, never approved (I-4)', async () => {
    const t = await setup();
    const r = await t.request();
    await t.store.transaction((tx) =>
      tx.update('approvals', { approval_id: r.approvalId }, { status: 'approved' }),
    );
    expect(await t.client.approvalService.findOpen(r.action)).toEqual({
      approvalId: r.approvalId,
      status: 'pending',
      expiresAt: r.expiresAt,
    });
  });

  it('a row whose stored action does not open is skipped (fail closed)', async () => {
    const t = await setup();
    const r = await t.request();
    const other = await t.request(exportAction('other'));
    const moved = await t.row(other.approvalId);
    await t.store.transaction((tx) =>
      tx.update('approvals', { approval_id: r.approvalId }, { action_json: moved!.action_json }),
    );
    // `r`'s row now holds a sealed action bound to another row's key: it does not open.
    await t.store.transaction((tx) =>
      tx.update('approvals', { approval_id: other.approvalId }, { status: 'void' }),
    );
    expect(await t.client.approvalService.findOpen(r.action)).toBeUndefined();
  });

  it('an action the strict schema refuses is never matched', async () => {
    const t = await setup();
    await t.request();
    expect(await t.client.approvalService.findOpen({ tool: 'nope' })).toBeUndefined();
    expect(await t.client.approvalService.findOpen('x')).toBeUndefined();
  });
});
