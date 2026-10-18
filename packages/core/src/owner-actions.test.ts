// Applying owner actions and loading the signed policy (M1-7d; 04 §2.5.1, §2.5.2; 06 §3 G-6;
// 07 §3.4). The pure checks are owner-action.test.ts; here: the nonce, the record and the effects in
// one store transaction, whole-or-nothing batches with the nonce burnt, the policy-version mark,
// re-verification on load and on use, and the store edits that must not count (I-4).
import { canonicalize, type JsonObject } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { defaultPolicy, type OwnerActionOp } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { computeActionDigest } from './owner-action.js';
import { evaluate } from './policy-engine.js';
import { MemoryStore } from './store/memory-store.js';
import { rowKeyOf, type StoreTx } from './store/store.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import { MemoryPolicyMark, newApprovalId, newNonce, ownerHex, signWith } from './testing/owner.js';

/**
 * A MemoryStore that can run one write of its own just before a later transaction, to model a
 * same-user process editing a row between the core's read and its apply transaction.
 */
class RacingStore extends MemoryStore {
  #pending: { skip: number; write: (tx: StoreTx) => void } | undefined;

  /** Runs `write` in its own transaction right before the `skip`-th transaction from now. */
  raceBefore(skip: number, write: (tx: StoreTx) => void): void {
    this.#pending = { skip, write };
  }

  override async transaction<R>(body: (tx: StoreTx) => R): Promise<R> {
    const p = this.#pending;
    if (p !== undefined && --p.skip === 0) {
      this.#pending = undefined;
      await super.transaction(p.write);
    }
    return super.transaction(body);
  }
}

async function setup(options: { mark?: MemoryPolicyMark | null } = {}) {
  const keyStore = new MemoryKeyStore(seed(1));
  const owner = new MemoryOwnerKeyStore(seed(101), passphrase());
  const store = new RacingStore();
  const cipher = new TestStoreCipher();
  const clock = new FakeClock();
  const mark = options.mark === undefined ? new MemoryPolicyMark() : options.mark;
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    ...(mark === null ? {} : { policyMark: mark }),
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

  const body = (op: OwnerActionOp, params: JsonObject, over: JsonObject = {}): JsonObject => ({
    v: 1,
    agent: client.agentId,
    owner: OWNER,
    op,
    params,
    nonce: newNonce(),
    issuedAt: clock.t,
    expiresAt: op === 'agent.revoke' ? 0 : clock.t + 600,
    ...over,
  });
  /** The exact JSON text a surface sends (04 §2.5.1). */
  const signed = async (op: OwnerActionOp, params: JsonObject, over: JsonObject = {}) =>
    JSON.stringify(await signWith(owner, body(op, params, over)));

  /** A pending request row as M1-7e will write it: `action_json` sealed, digest not stored. */
  async function addRequest(
    opts: {
      commitment?: boolean;
      expiresAt?: number;
      status?: 'pending' | 'approved';
      action?: JsonObject;
    } = {},
  ) {
    const approvalId = newApprovalId();
    const action = opts.action ?? {
      tool: 'agentlink_send',
      args: { to: 'Bob', text: `hi ${approvalId}` },
    };
    const sealedAction = await cipher.seal(
      { table: 'approvals', column: 'action_json', rowKey: rowKeyOf([approvalId]) },
      canonicalize(action),
    );
    const summary = await cipher.seal(
      { table: 'approvals', column: 'summary', rowKey: rowKeyOf([approvalId]) },
      'Send a message to Bob',
    );
    const expiresAt = opts.expiresAt ?? clock.t + 86_400;
    await store.transaction((tx) =>
      tx.insert('approvals', {
        approval_id: approvalId,
        action_json: sealedAction,
        scope_json: opts.commitment === true ? '{"kind":"agentlink/commitment"}' : null,
        answers_envelope_id: null,
        scope_key: opts.commitment === true ? `scope-${approvalId}` : null,
        source: 'owner',
        policy_hash: null,
        signed_decision: null,
        signed_cancel: null,
        summary,
        status: opts.status ?? 'pending',
        expires_at: expiresAt,
        created_at: clock.t,
        decided_at: null,
      }),
    );
    return { approvalId, action, actionDigest: computeActionDigest(action), expiresAt };
  }

  type Req = Awaited<ReturnType<typeof addRequest>>;
  const decide = (r: Req, decision = 'approve'): JsonObject => ({
    approvalId: r.approvalId,
    actionDigest: r.actionDigest,
    decision,
  });
  const batch = (rs: readonly Req[], decision = 'approve'): JsonObject => ({
    items: [...rs]
      .sort((a, b) => (a.approvalId < b.approvalId ? -1 : 1))
      .map((r) => decide(r, decision)),
  });
  const row = (approvalId: string) =>
    store.transaction((tx) => tx.get('approvals', { approval_id: approvalId }));
  const nonces = () => store.transaction((tx) => tx.select('owner_action_nonces'));
  const policyRow = () => store.transaction((tx) => tx.get('policies', { slot: 'current' }));
  const policySet = (
    version: number,
    edit: (p: ReturnType<typeof defaultPolicy>) => void = () => {},
  ) => {
    const policy = defaultPolicy();
    edit(policy);
    return signed('policy.set', { version, policy: policy as unknown as JsonObject });
  };

  return {
    client,
    owner,
    store,
    cipher,
    clock,
    mark,
    OWNER,
    body,
    signed,
    addRequest,
    decide,
    batch,
    row,
    nonces,
    policyRow,
    policySet,
  };
}

describe('approval.decide (04 §2.5.1)', () => {
  it('applies to the pending request: decision, signed object and nonce in one transaction', async () => {
    const t = await setup();
    const r = await t.addRequest();
    const text = await t.signed('approval.decide', t.decide(r));
    const out = await t.client.ownerActions.apply(text);
    expect(out).toMatchObject({ status: 'applied', op: 'approval.decide' });

    const row = await t.row(r.approvalId);
    expect(row).toMatchObject({ status: 'approved', signed_decision: text, decided_at: t.clock.t });
    const [nonce] = await t.nonces();
    const parsed = JSON.parse(text) as {
      body: { nonce: string; issuedAt: number; expiresAt: number };
    };
    expect(nonce).toMatchObject({
      nonce: parsed.body.nonce,
      op: 'approval.decide',
      issued_at: parsed.body.issuedAt,
      expires_at: parsed.body.expiresAt,
      applied_at: t.clock.t,
    });
    expect(nonce?.action_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records a signed deny too', async () => {
    const t = await setup();
    const r = await t.addRequest();
    await t.client.ownerActions.apply(await t.signed('approval.decide', t.decide(r, 'deny')));
    expect((await t.row(r.approvalId))?.status).toBe('denied');
  });

  it('refuses a replay of the same object by its nonce, and changes nothing', async () => {
    const t = await setup();
    const r = await t.addRequest();
    const text = await t.signed('approval.decide', t.decide(r));
    await t.client.ownerActions.apply(text);
    const before = await t.row(r.approvalId);
    expect(await t.client.ownerActions.apply(text)).toMatchObject({
      status: 'refused',
      reason: 'nonce_used',
      nonceBurnt: false,
    });
    expect(await t.row(r.approvalId)).toEqual(before);
    expect(await t.nonces()).toHaveLength(1);
  });

  it('applies two concurrent deliveries of one object once', async () => {
    const t = await setup();
    const r = await t.addRequest();
    const text = await t.signed('approval.decide', t.decide(r));
    const results = await Promise.all([
      t.client.ownerActions.apply(text),
      t.client.ownerActions.apply(text),
    ]);
    expect(results.filter((x) => x.status === 'applied')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'refused')).toHaveLength(1);
    expect(await t.nonces()).toHaveLength(1);
  });

  it('recomputes the digest from the stored request: a request edited after signing does not match', async () => {
    const t = await setup();
    const r = await t.addRequest();
    const text = await t.signed('approval.decide', t.decide(r));
    // A same-user edit of the stored action (another recipient), sealed correctly for its row.
    const edited = await t.cipher.seal(
      { table: 'approvals', column: 'action_json', rowKey: rowKeyOf([r.approvalId]) },
      canonicalize({ ...r.action, args: { to: 'Mallory', text: 'hi' } }),
    );
    await t.store.transaction((tx) =>
      tx.update('approvals', { approval_id: r.approvalId }, { action_json: edited }),
    );
    expect(await t.client.ownerActions.apply(text)).toMatchObject({
      status: 'refused',
      reason: 'digest_mismatch',
      nonceBurnt: false,
    });
    expect((await t.row(r.approvalId))?.status).toBe('pending');
    expect(await t.nonces()).toHaveLength(0);
  });

  it('refuses a decision whose expiresAt is after the request expiry', async () => {
    const t = await setup();
    const r = await t.addRequest({ expiresAt: t.clock.t + 300 });
    const text = await t.signed('approval.decide', t.decide(r), { expiresAt: t.clock.t + 301 });
    expect(await t.client.ownerActions.apply(text)).toMatchObject({
      status: 'refused',
      reason: 'outlives_request',
    });
  });

  it('refuses a request that is no longer pending, and an unknown one', async () => {
    const t = await setup();
    const r = await t.addRequest({ status: 'approved' });
    expect(
      await t.client.ownerActions.apply(await t.signed('approval.decide', t.decide(r, 'deny'))),
    ).toMatchObject({ status: 'refused', reason: 'not_pending' });
    const ghost = { ...r, approvalId: newApprovalId() };
    expect(
      await t.client.ownerActions.apply(await t.signed('approval.decide', t.decide(ghost))),
    ).toMatchObject({ status: 'refused', reason: 'approval_unknown' });
  });

  it('refuses malformed text and a forged signature without writing anything', async () => {
    const t = await setup();
    const r = await t.addRequest();
    const text = await t.signed('approval.decide', t.decide(r));
    const forged = text.replace('"decision":"approve"', '"decision":"deny"');
    expect(await t.client.ownerActions.apply(forged)).toMatchObject({
      status: 'refused',
      reason: 'signature_invalid',
      nonceBurnt: false,
    });
    expect(await t.client.ownerActions.apply('{"body":')).toMatchObject({
      status: 'refused',
      reason: 'malformed',
    });
    expect(await t.nonces()).toHaveLength(0);
  });
});

describe('approval.decideBatch (D-68, 04 §2.5.2)', () => {
  it('applies a batch of 3 whole: each row gets the batch object, one nonce', async () => {
    const t = await setup();
    const rs = [await t.addRequest(), await t.addRequest(), await t.addRequest()];
    const other = await t.addRequest();
    const text = await t.signed('approval.decideBatch', t.batch(rs));
    expect(await t.client.ownerActions.apply(text)).toMatchObject({
      status: 'applied',
      op: 'approval.decideBatch',
    });
    for (const r of rs) {
      expect(await t.row(r.approvalId)).toMatchObject({
        status: 'approved',
        signed_decision: text,
      });
    }
    expect((await t.row(other.approvalId))?.status).toBe('pending');
    expect(await t.nonces()).toHaveLength(1);
  });

  const refusedBatch = async (
    make: (t: Awaited<ReturnType<typeof setup>>) => Promise<{ text: string; ids: string[] }>,
    reason: string,
  ) => {
    const t = await setup();
    const { text, ids } = await make(t);
    const before = await Promise.all(ids.map((id) => t.row(id)));
    const out = await t.client.ownerActions.apply(text);
    expect(out).toMatchObject({ status: 'refused', nonceBurnt: true });
    expect(out.status === 'refused' && out.reason).toBe(reason);
    // Nothing applied: every row is as before.
    expect(await Promise.all(ids.map((id) => t.row(id)))).toEqual(before);
    // The nonce is burnt in the same transaction, so the same object can never apply later.
    expect(await t.nonces()).toHaveLength(1);
    expect(await t.client.ownerActions.apply(text)).toMatchObject({
      status: 'refused',
      reason: 'nonce_used',
    });
    return out;
  };

  it('a batch with an already-decided item applies none and burns its nonce', async () => {
    const out = await refusedBatch(async (t) => {
      const a = await t.addRequest();
      const b = await t.addRequest({ status: 'approved' });
      return {
        text: await t.signed('approval.decideBatch', t.batch([a, b])),
        ids: [a.approvalId, b.approvalId],
      };
    }, 'item_refused');
    expect(out.status === 'refused' && out.items?.map((i) => i.reason)).toEqual(['not_pending']);
  });

  it('a batch with a commitment item applies none and burns its nonce', async () => {
    await refusedBatch(async (t) => {
      const a = await t.addRequest();
      const b = await t.addRequest({ commitment: true });
      return {
        text: await t.signed('approval.decideBatch', t.batch([a, b])),
        ids: [a.approvalId, b.approvalId],
      };
    }, 'item_refused');
  });

  it('a batch with an accepted acknowledgement (a commitment without a scope, D-31) applies none (M1-20)', async () => {
    await refusedBatch(async (t) => {
      const a = await t.addRequest();
      const b = await t.addRequest({
        action: {
          tool: 'agentlink_acknowledge',
          args: { envelopeId: 'AgICAgICAgICAgICAgICAg', type: 'accepted' },
          context: {
            triggers: ['commitments.accept'],
            counterparty: { agentId: `0x${'3d'.repeat(20)}`, ownerKey: 'c4'.repeat(32) },
            recordId: `0x${'e2'.repeat(32)}`,
            receipt: 'ACCEPTED',
          },
        },
      });
      return {
        text: await t.signed('approval.decideBatch', t.batch([a, b])),
        ids: [a.approvalId, b.approvalId],
      };
    }, 'item_refused');
  });

  it('a batch naming another agent request (unknown here) applies none and burns its nonce', async () => {
    await refusedBatch(async (t) => {
      const a = await t.addRequest();
      const theirs = { ...(await t.addRequest()), approvalId: newApprovalId() };
      return {
        text: await t.signed('approval.decideBatch', t.batch([a, theirs])),
        ids: [a.approvalId],
      };
    }, 'item_refused');
  });

  it('a batch with a mismatched digest applies none and burns its nonce', async () => {
    await refusedBatch(async (t) => {
      const a = await t.addRequest();
      const b = await t.addRequest();
      const wrong = { ...b, actionDigest: computeActionDigest({ tool: 'x' }) };
      return {
        text: await t.signed('approval.decideBatch', t.batch([a, wrong])),
        ids: [a.approvalId, b.approvalId],
      };
    }, 'item_refused');
  });

  it('a batch outliving its earliest request applies none and burns its nonce', async () => {
    await refusedBatch(async (t) => {
      const a = await t.addRequest({ expiresAt: t.clock.t + 100 });
      const b = await t.addRequest();
      return {
        text: await t.signed('approval.decideBatch', t.batch([a, b]), {
          expiresAt: t.clock.t + 101,
        }),
        ids: [a.approvalId, b.approvalId],
      };
    }, 'outlives_request');
  });

  it('a batch with an expired request applies none and burns its nonce', async () => {
    await refusedBatch(async (t) => {
      const a = await t.addRequest({ expiresAt: t.clock.t - 1 });
      const b = await t.addRequest();
      return {
        text: await t.signed('approval.decideBatch', t.batch([a, b]), {
          expiresAt: t.clock.t - 1 + 500,
          issuedAt: t.clock.t - 10,
        }),
        ids: [a.approvalId, b.approvalId],
      };
    }, 'item_refused');
  });

  it('a forged or cross-op batch is dropped: nothing applied and no nonce recorded', async () => {
    const t = await setup();
    const a = await t.addRequest();
    const b = await t.addRequest();
    const text = await t.signed('approval.decideBatch', t.batch([a, b]));
    const parsed = JSON.parse(text) as { body: JsonObject; sig: string };
    const asDecide = JSON.stringify({
      body: { ...parsed.body, op: 'approval.decide', params: t.decide(a) },
      sig: parsed.sig,
    });
    expect(await t.client.ownerActions.apply(asDecide)).toMatchObject({
      status: 'refused',
      reason: 'signature_invalid',
      nonceBurnt: false,
    });
    expect(await t.nonces()).toHaveLength(0);
    expect((await t.row(a.approvalId))?.status).toBe('pending');
  });

  it('a commitment scope set between the read and the apply transaction refuses the batch (IR-M1-7d-1 F-5)', async () => {
    const t = await setup();
    const a = await t.addRequest();
    const b = await t.addRequest();
    const text = await t.signed('approval.decideBatch', t.batch([a, b]));
    // apply(): identity read (1), nonce read (2), request read (3), then the apply transaction (4).
    t.store.raceBefore(4, (tx) =>
      tx.update(
        'approvals',
        { approval_id: b.approvalId },
        { scope_json: '{"kind":"agentlink/commitment"}', scope_key: `scope-${b.approvalId}` },
      ),
    );
    const out = await t.client.ownerActions.apply(text);
    expect(out).toMatchObject({ status: 'refused', reason: 'store_changed', nonceBurnt: true });
    expect(out.status === 'refused' && out.items?.map((i) => i.approvalId)).toEqual([b.approvalId]);
    expect((await t.row(a.approvalId))?.status).toBe('pending');
    expect((await t.row(b.approvalId))?.status).toBe('pending');
  });

  it('a request edited in the store after the batch was signed no longer matches its item', async () => {
    const t = await setup();
    const a = await t.addRequest();
    const b = await t.addRequest();
    const text = await t.signed('approval.decideBatch', t.batch([a, b]));
    const edited = await t.cipher.seal(
      { table: 'approvals', column: 'action_json', rowKey: rowKeyOf([b.approvalId]) },
      canonicalize({ tool: 'agentlink_send', args: { to: 'Mallory' } }),
    );
    await t.store.transaction((tx) =>
      tx.update('approvals', { approval_id: b.approvalId }, { action_json: edited }),
    );
    const out = await t.client.ownerActions.apply(text);
    expect(out).toMatchObject({ status: 'refused', nonceBurnt: true });
    expect(out.status === 'refused' && out.items).toEqual([
      { approvalId: b.approvalId, reason: 'digest_mismatch' },
    ]);
    expect((await t.row(a.approvalId))?.status).toBe('pending');
  });
});

describe('approval.cancel (D-55, G-7)', () => {
  it('voids an approved approval, and a replay within its lifetime is refused by its nonce', async () => {
    const t = await setup();
    const r = await t.addRequest();
    await t.client.ownerActions.apply(await t.signed('approval.decide', t.decide(r)));
    const cancel = await t.signed(
      'approval.cancel',
      { approvalId: r.approvalId },
      {
        expiresAt: t.clock.t + 604_800,
      },
    );
    expect(await t.client.ownerActions.apply(cancel)).toMatchObject({ status: 'applied' });
    expect(await t.row(r.approvalId)).toMatchObject({ status: 'cancelled', signed_cancel: cancel });
    t.clock.t += 600_000;
    expect(await t.client.ownerActions.apply(cancel)).toMatchObject({
      status: 'refused',
      reason: 'nonce_used',
    });
  });

  it('a cancel of a pending request denies it (04 §2.5.1; IR-M1-7d-1 F-4)', async () => {
    const t = await setup();
    const r = await t.addRequest();
    const cancel = await t.signed('approval.cancel', { approvalId: r.approvalId });
    expect(await t.client.ownerActions.apply(cancel)).toMatchObject({
      status: 'applied',
      op: 'approval.cancel',
    });
    expect(await t.row(r.approvalId)).toMatchObject({
      status: 'denied',
      signed_cancel: cancel,
      signed_decision: null,
      decided_at: t.clock.t,
    });
    expect(await t.nonces()).toHaveLength(1);
    expect(await t.client.ownerActions.checkApproval(r.approvalId, r.action)).toEqual({
      status: 'denied',
    });
    // A later approval of the same request no longer finds it pending.
    expect(
      await t.client.ownerActions.apply(await t.signed('approval.decide', t.decide(r))),
    ).toMatchObject({ status: 'refused', reason: 'not_pending' });
  });

  it('a cancel of a denied request has nothing to void and writes nothing', async () => {
    const t = await setup();
    const r = await t.addRequest();
    await t.client.ownerActions.apply(await t.signed('approval.decide', t.decide(r, 'deny')));
    const cancel = await t.signed('approval.cancel', { approvalId: r.approvalId });
    expect(await t.client.ownerActions.apply(cancel)).toMatchObject({
      status: 'refused',
      reason: 'not_approved',
    });
    expect(await t.nonces()).toHaveLength(1);
    expect((await t.row(r.approvalId))?.signed_cancel).toBeNull();
  });
});

describe('policy.set and the version mark (04 §2.5.1, 07 §3.4)', () => {
  it('applies a newer version, stores the row first and then raises the mark', async () => {
    const t = await setup();
    const text = await t.policySet(1, (p) => (p.contacts.acceptInvites = 'auto'));
    expect(await t.client.ownerActions.apply(text)).toMatchObject({
      status: 'applied',
      op: 'policy.set',
      policyVersion: 1,
      markRaised: true,
    });
    expect(t.mark?.value).toBe(1);
    expect((await t.policyRow())?.version).toBe(1);
    const loaded = await t.client.ownerActions.loadPolicy();
    expect(loaded).toMatchObject({ mode: 'signed', version: 1 });
    expect(evaluate(loaded, { kind: 'invite.accept' })).toBe('allow');
  });

  it('refuses a version that is not above the stored row and the mark', async () => {
    const t = await setup();
    await t.client.ownerActions.apply(await t.policySet(2));
    expect(await t.client.ownerActions.apply(await t.policySet(2))).toMatchObject({
      status: 'refused',
      reason: 'version_not_newer',
    });
    expect(await t.client.ownerActions.apply(await t.policySet(1))).toMatchObject({
      status: 'refused',
      reason: 'version_not_newer',
    });
    // The mark alone is enough: a store whose row was deleted still refuses an old version.
    await t.store.transaction((tx) => tx.delete('policies', {}));
    expect(await t.client.ownerActions.apply(await t.policySet(2))).toMatchObject({
      status: 'refused',
      reason: 'version_not_newer',
    });
    expect(await t.client.ownerActions.apply(await t.policySet(3))).toMatchObject({
      status: 'applied',
    });
  });

  it('refuses policy.set without a readable mark (fail closed)', async () => {
    const none = await setup({ mark: null });
    expect(await none.client.ownerActions.apply(await none.policySet(1))).toMatchObject({
      status: 'refused',
      reason: 'policy_mark_unavailable',
    });
    const broken = await setup();
    broken.mark!.failRead = true;
    expect(await broken.client.ownerActions.apply(await broken.policySet(1))).toMatchObject({
      status: 'refused',
      reason: 'policy_mark_unavailable',
    });
    expect(await broken.policyRow()).toBeUndefined();
  });

  it('reports a mark that could not be raised, and the load then fails closed', async () => {
    const t = await setup();
    t.mark!.failRaise = true;
    expect(await t.client.ownerActions.apply(await t.policySet(1))).toMatchObject({
      status: 'applied',
      markRaised: false,
    });
    expect(await t.client.ownerActions.loadPolicy()).toEqual({
      mode: 'fail_closed',
      problem: 'mark_mismatch',
    });
  });

  it('starts a fresh budget ledger when the ledger is broken (07 §3.5)', async () => {
    const t = await setup();
    await t.store.transaction((tx) =>
      tx.update('budget_state', {}, { status: 'broken', broken_at: t.clock.t - 5 }),
    );
    const before = await t.store.transaction((tx) => tx.select('budget_state')[0]);
    t.clock.t += 10;
    await t.client.ownerActions.apply(await t.policySet(1));
    expect(await t.store.transaction((tx) => tx.select('budget_state')[0])).toEqual({
      slot: 'current',
      ledger_epoch: (before?.ledger_epoch ?? 0) + 1,
      status: 'ok',
      newest_t: t.clock.t,
      since: t.clock.t,
      broken_at: null,
    });
  });
});

describe('loading the signed policy (G-6, 06 §3)', () => {
  it('uses the defaults only while the mark is 0 and no row exists', async () => {
    const t = await setup();
    expect(await t.client.ownerActions.loadPolicy()).toMatchObject({ mode: 'defaults' });
  });

  it('fails closed without a mark, even with no row (the mark cannot be shown to be 0)', async () => {
    const t = await setup({ mark: null });
    expect(await t.client.ownerActions.loadPolicy()).toEqual({
      mode: 'fail_closed',
      problem: 'mark_unavailable',
    });
  });

  const failClosedAfter = async (
    edit: (t: Awaited<ReturnType<typeof setup>>) => Promise<void>,
    problem: string,
  ) => {
    const t = await setup();
    await t.client.ownerActions.apply(
      await t.policySet(1, (p) => {
        p.proofs.notarize = 'deny';
        p.contacts.unknownSenders = 'drop';
      }),
    );
    await edit(t);
    const loaded = await t.client.ownerActions.loadPolicy();
    expect(loaded).toEqual({ mode: 'fail_closed', problem });
    // Never the defaults: their `notarize: allow` and `autoDelivered: true` would loosen it, and
    // the stored deny becomes approval, never allow.
    expect(
      evaluate(loaded, { kind: 'proof', feeUsd: '0.01', maxFeeUsd: '0.01', counterparty: null }),
    ).toBe('approval');
    // G-6 owner decision (Tali, 2026-10-15): paired contacts Talk without approval; commitments
    // (D-31) and paid proofs still need the owner.
    expect(
      evaluate(loaded, { kind: 'commitment', facts: { kind: 'acknowledge', receipt: 'ACCEPTED' } }),
    ).toBe('approval');
    expect(
      evaluate(
        loaded,
        {
          kind: 'envelope.receive',
          sender: { kind: 'contact', contact: `0x${'0a'.repeat(20)}` },
          sizeBytes: 1,
        },
        { contactEnvelopesLastHour: 0 },
      ),
    ).toBe('allow');
    expect(
      evaluate(loaded, { kind: 'envelope.send', contact: `0x${'0a'.repeat(20)}`, sizeBytes: 1 }),
    ).toBe('allow');
    expect(evaluate(loaded, { kind: 'receipt.auto', receipt: 'delivered' })).toBe('deny');
    expect(
      evaluate(loaded, { kind: 'envelope.receive', sender: { kind: 'unknown' }, sizeBytes: 1 }),
    ).toBe('approval');
    return t;
  };

  it('a deleted policy row fails closed', async () => {
    await failClosedAfter(async (t) => {
      await t.store.transaction((tx) => tx.delete('policies', {}));
    }, 'missing');
  });

  it('a row that does not open fails closed', async () => {
    await failClosedAfter(async (t) => {
      await t.store.transaction((tx) =>
        tx.update('policies', {}, { signed_json: 'garbage' as never }),
      );
    }, 'unreadable');
  });

  it('a row edited directly in the store is ignored (I-4): unsigned or tampered fails closed', async () => {
    await failClosedAfter(async (t) => {
      const p = defaultPolicy();
      p.proofs.notarize = 'allow';
      const tampered = JSON.stringify({
        body: { ...t.body('policy.set', { version: 1, policy: p as unknown as JsonObject }) },
        sig: '00'.repeat(64),
      });
      const sealed = await t.cipher.seal(
        { table: 'policies', column: 'signed_json', rowKey: rowKeyOf(['current']) },
        tampered,
      );
      await t.store.transaction((tx) => tx.update('policies', {}, { signed_json: sealed }));
    }, 'signature_invalid');
  });

  it('an edited version column is ignored: a mismatch fails closed', async () => {
    await failClosedAfter(async (t) => {
      await t.store.transaction((tx) => tx.update('policies', {}, { version: 7 }));
    }, 'tampered');
  });

  it('an edited policy_hash column is ignored: a mismatch fails closed', async () => {
    await failClosedAfter(async (t) => {
      const sealed = await t.cipher.seal(
        { table: 'policies', column: 'policy_hash', rowKey: rowKeyOf(['current']) },
        '00'.repeat(32),
      );
      await t.store.transaction((tx) => tx.update('policies', {}, { policy_hash: sealed }));
    }, 'tampered');
  });

  it('an older signed policy put back in the store is detected against the mark', async () => {
    const t = await setup();
    const v1 = await t.policySet(1);
    await t.client.ownerActions.apply(v1);
    const oldRow = await t.policyRow();
    await t.client.ownerActions.apply(await t.policySet(2, (p) => (p.proofs.notarize = 'deny')));
    await t.store.transaction((tx) => {
      tx.delete('policies', {});
      tx.insert('policies', oldRow!);
    });
    expect(await t.client.ownerActions.loadPolicy()).toEqual({
      mode: 'fail_closed',
      problem: 'rolled_back',
    });
  });

  it('a stored policy with a mark of 0 (the KeyStore item was deleted) fails closed', async () => {
    await failClosedAfter(async (t) => {
      t.mark!.value = 0;
    }, 'mark_mismatch');
  });

  it('a signed but schema-invalid stored policy (the old number-USD form) fails closed', async () => {
    await failClosedAfter(async (t) => {
      const p = defaultPolicy() as unknown as { proofs: Record<string, unknown> };
      p.proofs.dailyBudgetUSD = 5;
      const old = JSON.stringify(
        await signWith(
          t.owner,
          t.body('policy.set', { version: 1, policy: p as unknown as JsonObject }),
        ),
      );
      const sealed = await t.cipher.seal(
        { table: 'policies', column: 'signed_json', rowKey: rowKeyOf(['current']) },
        old,
      );
      await t.store.transaction((tx) => tx.update('policies', {}, { signed_json: sealed }));
    }, 'invalid');
  });

  it('an unreadable mark fails closed', async () => {
    await failClosedAfter(async (t) => {
      t.mark!.failRead = true;
    }, 'mark_unavailable');
  });

  it('a policy signed for another agent fails closed', async () => {
    await failClosedAfter(async (t) => {
      const forOther = JSON.stringify(
        await signWith(
          t.owner,
          t.body(
            'policy.set',
            { version: 1, policy: defaultPolicy() as unknown as JsonObject },
            {
              agent: `0x${'99'.repeat(20)}`,
            },
          ),
        ),
      );
      const sealed = await t.cipher.seal(
        { table: 'policies', column: 'signed_json', rowKey: rowKeyOf(['current']) },
        forOther,
      );
      await t.store.transaction((tx) => tx.update('policies', {}, { signed_json: sealed }));
    }, 'agent_mismatch');
  });

  it('a fresh freshness window does not matter on load (freshness applies once)', async () => {
    const t = await setup();
    await t.client.ownerActions.apply(await t.policySet(1));
    t.clock.t += 365 * 86_400;
    expect(await t.client.ownerActions.loadPolicy()).toMatchObject({ mode: 'signed', version: 1 });
  });
});

describe('using a stored approval (04 §2.5.1 "Stored objects are re-verified")', () => {
  it('re-verifies the stored decision and recomputes the digest from the current call', async () => {
    const t = await setup();
    const r = await t.addRequest();
    await t.client.ownerActions.apply(await t.signed('approval.decide', t.decide(r)));
    expect(await t.client.ownerActions.checkApproval(r.approvalId, r.action)).toEqual({
      status: 'approved',
    });
    expect(
      await t.client.ownerActions.checkApproval(r.approvalId, { ...r.action, args: { to: 'Eve' } }),
    ).toEqual({ status: 'refused', reason: 'digest_mismatch' });
  });

  it('re-verifies a batch for exactly the one item presented', async () => {
    const t = await setup();
    const a = await t.addRequest();
    const b = await t.addRequest();
    await t.client.ownerActions.apply(
      await t.signed('approval.decideBatch', t.batch([a, b], 'deny')),
    );
    expect(await t.client.ownerActions.checkApproval(a.approvalId, a.action)).toEqual({
      status: 'denied',
    });
    // b's action presented under a's approvalId: a's item binds a's digest.
    expect(await t.client.ownerActions.checkApproval(a.approvalId, b.action)).toEqual({
      status: 'refused',
      reason: 'digest_mismatch',
    });
  });

  it('a status column set to approved without a signed decision is only a cache', async () => {
    const t = await setup();
    const r = await t.addRequest();
    await t.store.transaction((tx) =>
      tx.update('approvals', { approval_id: r.approvalId }, { status: 'approved' }),
    );
    expect(await t.client.ownerActions.checkApproval(r.approvalId, r.action)).toEqual({
      status: 'pending',
    });
  });

  it('a decision copied from another row does not cover this row', async () => {
    const t = await setup();
    const a = await t.addRequest();
    const b = await t.addRequest();
    const text = await t.signed('approval.decide', t.decide(a));
    await t.client.ownerActions.apply(text);
    await t.store.transaction((tx) =>
      tx.update(
        'approvals',
        { approval_id: b.approvalId },
        { status: 'approved', signed_decision: text },
      ),
    );
    expect(await t.client.ownerActions.checkApproval(b.approvalId, b.action)).toEqual({
      status: 'refused',
      reason: 'decision_invalid',
    });
  });

  it('reports expired after the request expiry, and cancelled after a signed cancel', async () => {
    const t = await setup();
    const r = await t.addRequest({ expiresAt: t.clock.t + 1_000 });
    await t.client.ownerActions.apply(
      await t.signed('approval.decide', t.decide(r), { expiresAt: t.clock.t + 1_000 }),
    );
    t.clock.t += 1_000;
    expect(await t.client.ownerActions.checkApproval(r.approvalId, r.action)).toEqual({
      status: 'approved',
    });
    t.clock.t += 1;
    expect(await t.client.ownerActions.checkApproval(r.approvalId, r.action)).toEqual({
      status: 'expired',
    });

    const s = await t.addRequest();
    await t.client.ownerActions.apply(await t.signed('approval.decide', t.decide(s)));
    await t.client.ownerActions.apply(
      await t.signed('approval.cancel', { approvalId: s.approvalId }),
    );
    expect(await t.client.ownerActions.checkApproval(s.approvalId, s.action)).toEqual({
      status: 'cancelled',
    });
  });

  it('an unknown approvalId is refused', async () => {
    const t = await setup();
    expect(await t.client.ownerActions.checkApproval(newApprovalId(), {})).toEqual({
      status: 'refused',
      reason: 'approval_unknown',
    });
  });
});

describe('ops applied elsewhere', () => {
  it('agent.revoke is not applied here (M1-7h) and writes nothing', async () => {
    const t = await setup();
    const revoke = await t.signed('agent.revoke', { reason: 'retired' });
    expect(await t.client.ownerActions.apply(revoke)).toMatchObject({
      status: 'refused',
      reason: 'unsupported_op',
    });
    expect(await t.nonces()).toHaveLength(0);
  });

  it('contact.check is routed to the contact book (M1-7c-b): an unknown contact is refused by its rule', async () => {
    const t = await setup();
    const check = await t.signed('contact.check', {
      contact: `0x${'5a'.repeat(20)}`,
      pairingDigest: 'ab'.repeat(32),
    });
    expect(await t.client.ownerActions.apply(check)).toEqual({
      status: 'refused',
      op: 'contact.check',
      reason: 'contact_unknown',
      nonceBurnt: false,
    });
    expect(await t.nonces()).toHaveLength(0);
  });

  it('a refused action is reported with a fixed reason code, never with the object content', async () => {
    const t = await setup();
    const r = await t.addRequest();
    const out = await t.client.ownerActions.apply(
      await t.signed('approval.decide', t.decide(r), { agent: `0x${'99'.repeat(20)}` }),
    );
    expect(out).toEqual({
      status: 'refused',
      op: 'approval.decide',
      reason: 'agent_mismatch',
      nonceBurnt: false,
    });
  });
});
