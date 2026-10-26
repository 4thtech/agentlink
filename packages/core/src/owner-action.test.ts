// Pure SignedOwnerAction verification (M1-7d; 04 §2.5.1, §2.5.2, G-7, D-68). The store side
// (nonce, record and effects in one transaction) is owner-actions.test.ts. Every boundary here is
// exact because `now` is passed in.
import {
  canonicalize,
  encodeHex,
  sha256,
  taggedHash,
  encodeUtf8,
  type JsonObject,
} from '@4thtech-io/crypto';
import { MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import {
  CLOCK_SKEW_SECONDS,
  OWNER_ACTION_MAX_LIFETIME_SECONDS,
  defaultPolicy,
  type OwnerActionOp,
} from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import {
  computeActionDigest,
  ownerActionHash,
  ownerActionSigningParts,
  verifyOwnerAction,
  verifyOwnerActionText,
  verifyStoredOwnerAction,
  type ApprovalRequestView,
  type OwnerActionCheckContext,
} from './owner-action.js';
import { passphrase, seed } from './testing/fixtures.js';
import { newApprovalId, newNonce, ownerHex, signWith, type Signed } from './testing/owner.js';

const NOW = 1_800_000_000;
const AGENT = `0x${'7b'.repeat(20)}`;
const OTHER_AGENT = `0x${'7c'.repeat(20)}`;

const owner = new MemoryOwnerKeyStore(seed(101), passphrase());
const stranger = new MemoryOwnerKeyStore(seed(102), passphrase());
const OWNER = await ownerHex(owner);
const STRANGER = await ownerHex(stranger);

const digestOf = (n: number) => computeActionDigest({ tool: 'agentlink_send', args: { n } });

function request(over: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
  return {
    approvalId: newApprovalId(),
    actionDigest: digestOf(Math.random()),
    expiresAt: NOW + 86_400,
    commitment: false,
    pending: true,
    ...over,
  };
}

function context(
  requests: readonly ApprovalRequestView[] = [],
  over: Partial<OwnerActionCheckContext> = {},
): OwnerActionCheckContext {
  const byId = new Map(requests.map((r) => [r.approvalId, r]));
  return {
    agent: AGENT,
    ownerNostr: `0x${OWNER}`,
    now: NOW,
    approvalRequest: (id) => byId.get(id),
    ...over,
  };
}

function body(op: OwnerActionOp, params: JsonObject, over: JsonObject = {}): JsonObject {
  return {
    v: 1,
    agent: AGENT,
    owner: OWNER,
    op,
    params,
    nonce: newNonce(),
    issuedAt: NOW,
    expiresAt: op === 'agent.revoke' ? 0 : NOW + 600,
    ...over,
  };
}

const sign = (b: JsonObject): Promise<Signed> => signWith(owner, b);
const REVOKE_SIGNED = await sign(body('agent.revoke', { reason: 'compromised' }));
const decideParams = (r: ApprovalRequestView, decision = 'approve'): JsonObject => ({
  approvalId: r.approvalId,
  actionDigest: r.actionDigest,
  decision,
});
/** Batch items in strictly ascending approvalId order (04 §2.5.2 canonical form). */
const batchParams = (rs: readonly ApprovalRequestView[], decision = 'approve'): JsonObject => ({
  items: [...rs]
    .sort((a, b) => (a.approvalId < b.approvalId ? -1 : 1))
    .map((r) => decideParams(r, decision)),
});

function refused(v: ReturnType<typeof verifyOwnerAction>) {
  if (v.ok) throw new Error('expected a refusal');
  return v;
}

describe('signing parts (04 §2.5.1)', () => {
  it('signs taggedHash("agentlink/owner-action/v1", sha256(JCS(body)))', async () => {
    const b = body('agent.revoke', { reason: 'retired' });
    const parts = ownerActionSigningParts(b);
    expect(parts.jcs).toBe(canonicalize(b));
    expect(encodeHex(parts.bodyHash)).toBe(encodeHex(sha256(encodeUtf8(canonicalize(b)))));
    expect(encodeHex(parts.signatureInput)).toBe(
      encodeHex(taggedHash('agentlink/owner-action/v1', parts.bodyHash)),
    );
    const signed = await sign(b);
    const v = verifyOwnerAction(signed, context());
    expect(v.ok).toBe(true);
    expect(v.ok && v.actionHash).toBe(ownerActionHash(signed));
    expect(ownerActionHash(signed)).toBe(encodeHex(sha256(encodeUtf8(canonicalize(signed)))));
  });

  it('computes actionDigest as sha256(JCS(action)) in lowercase hex', () => {
    const action = { tool: 'agentlink_send', args: { b: 1, a: 'x' } };
    expect(computeActionDigest(action)).toBe(encodeHex(sha256(encodeUtf8(canonicalize(action)))));
  });
});

describe('binding and signature (04 §2.5.1)', () => {
  it('accepts an approval.decide for its pending request', async () => {
    const r = request();
    const v = verifyOwnerAction(await sign(body('approval.decide', decideParams(r))), context([r]));
    expect(v.ok).toBe(true);
  });

  it('refuses another agent, another owner key and another signer', async () => {
    const r = request();
    const forOther = await sign(body('approval.decide', decideParams(r), { agent: OTHER_AGENT }));
    expect(refused(verifyOwnerAction(forOther, context([r])))).toMatchObject({
      stage: 'object',
      reason: 'agent_mismatch',
    });

    const byStranger = await signWith(
      stranger,
      body('approval.decide', decideParams(r), { owner: STRANGER }),
    );
    expect(refused(verifyOwnerAction(byStranger, context([r])))).toMatchObject({
      stage: 'object',
      reason: 'owner_mismatch',
    });

    // The stranger's signature over a body that names the real owner.
    const forged = { body: { ...byStranger.body, owner: OWNER }, sig: byStranger.sig };
    expect(refused(verifyOwnerAction(forged, context([r])))).toMatchObject({
      stage: 'object',
      reason: 'signature_invalid',
    });
  });

  it('refuses a body changed after signing and any non-canonical form', async () => {
    const r = request();
    const signed = await sign(body('approval.decide', decideParams(r)));
    const changed = { ...signed, body: { ...signed.body, expiresAt: NOW + 601 } };
    expect(refused(verifyOwnerAction(changed, context([r]))).reason).toBe('signature_invalid');
    const extraKey = { ...signed, note: 'x' };
    expect(refused(verifyOwnerAction(extraKey, context([r]))).reason).toBe('malformed');
    const upper = { ...signed, sig: signed.sig.toUpperCase() };
    expect(refused(verifyOwnerAction(upper, context([r]))).reason).toBe('malformed');
    expect(refused(verifyOwnerAction('not an object', context([r]))).reason).toBe('malformed');
  });

  it('parses the wire text strictly: duplicate keys and non-integer number forms are refused', async () => {
    const signed = await sign(body('agent.revoke', { reason: 'compromised' }));
    const text = JSON.stringify(signed);
    expect(verifyOwnerActionText(text, context()).ok).toBe(true);
    const dup = text.replace('"op":"agent.revoke"', '"op":"agent.revoke","op":"agent.revoke"');
    expect(refused(verifyOwnerActionText(dup, context())).reason).toBe('malformed');
    const fraction = text.replace(`"issuedAt":${NOW}`, `"issuedAt":${NOW}.0`);
    expect(refused(verifyOwnerActionText(fraction, context())).reason).toBe('malformed');
    expect(refused(verifyOwnerActionText('{', context())).reason).toBe('malformed');
  });

  // M1-1h-b (D-128, 04 §2.5.1 "Received text"): the parsed value of each refused text is the signed
  // object, so the signature would verify; only the text check refuses it.
  describe('received text (M1-1h-b)', () => {
    const signed = REVOKE_SIGNED;
    const text = JSON.stringify(signed);

    it.each([
      ['an escaped `agent`', '"agent":', '"\\u0061gent":'],
      ['an escaped name at depth (params)', '"reason":', '"re\\u0061son":'],
      ['an escaped `sig`', '"sig":', '"\\u0073ig":'],
      [
        'an escaped name equal to another name',
        '"op":"agent.revoke"',
        '"op":"agent.revoke","\\u006fp":"agent.revoke"',
      ],
      [
        'a duplicate name at depth (params)',
        '"reason":"compromised"',
        '"reason":"compromised","reason":"compromised"',
      ],
      ['a duplicate `sig`', '"sig":', `"sig":"${signed.sig}","sig":`],
    ])('refuses %s as malformed, live and stored', (_, from, to) => {
      const candidate = text.replace(from, to);
      expect(candidate).not.toBe(text);
      expect(refused(verifyOwnerActionText(candidate, context())).reason).toBe('malformed');
      expect(
        verifyStoredOwnerAction(candidate, { agent: AGENT, ownerNostr: `0x${OWNER}` }),
      ).toEqual({ ok: false, reason: 'malformed' });
    });

    it('accepts an escape inside a string value, and the JCS form', () => {
      const escaped = text.replace('"op":"agent.revoke"', '"op":"\\u0061gent.revoke"');
      expect(escaped).not.toBe(text);
      expect(verifyOwnerActionText(escaped, context()).ok).toBe(true);
      expect(verifyOwnerActionText(canonicalize(signed), context()).ok).toBe(true);
    });
  });
});

// G-7 boundaries (04 §2.5.1), per op: skew S = 300, `now ≤ expiresAt`, lifetime ≤ L(op).
const EXPIRING_OPS = [
  'approval.decide',
  'approval.decideBatch',
  'approval.cancel',
  'policy.set',
] as const;

describe.each(EXPIRING_OPS)('G-7 boundaries for %s', (op) => {
  const L = OWNER_ACTION_MAX_LIFETIME_SECONDS[op];
  // Requests that never cap the decision here (the request bound has its own tests below).
  const reqs = [request({ expiresAt: NOW + 10 * L }), request({ expiresAt: NOW + 10 * L })];
  const params = (): JsonObject => {
    switch (op) {
      case 'approval.decide':
        return decideParams(reqs[0]!);
      case 'approval.decideBatch':
        return batchParams(reqs);
      case 'approval.cancel':
        return { approvalId: reqs[0]!.approvalId };
      case 'policy.set':
        return { version: 1, policy: defaultPolicy() as unknown as JsonObject };
    }
  };
  const ctx = (now: number) => context(reqs, { now });
  const check = async (times: { issuedAt: number; expiresAt: number }, now: number) =>
    verifyOwnerAction(await sign(body(op, params(), times)), ctx(now));

  it(`issuedAt = now + ${CLOCK_SKEW_SECONDS} is accepted and now + ${CLOCK_SKEW_SECONDS + 1} refused`, async () => {
    const ok = await check({ issuedAt: NOW + 300, expiresAt: NOW + 900 }, NOW);
    expect(ok.ok).toBe(true);
    const late = refused(await check({ issuedAt: NOW + 301, expiresAt: NOW + 900 }, NOW));
    expect(late).toMatchObject({ stage: 'object', reason: 'issued_in_future' });
  });

  it('now = expiresAt is accepted and expiresAt + 1 refused', async () => {
    const times = { issuedAt: NOW - 100, expiresAt: NOW + 100 };
    expect((await check(times, NOW + 100)).ok).toBe(true);
    expect(refused(await check(times, NOW + 101))).toMatchObject({
      stage: 'object',
      reason: 'expired',
    });
  });

  it(`a lifetime of exactly L(op) = ${String(L)} is accepted and L(op) + 1 refused`, async () => {
    expect((await check({ issuedAt: NOW - 100, expiresAt: NOW - 100 + L }, NOW)).ok).toBe(true);
    expect(
      refused(await check({ issuedAt: NOW - 100, expiresAt: NOW - 100 + L + 1 }, NOW)),
    ).toMatchObject({ stage: 'object', reason: 'lifetime_exceeded' });
  });

  it('a used nonce is refused (single use)', async () => {
    const signed = await sign(body(op, params()));
    const nonce = signed.body.nonce;
    const v = verifyOwnerAction(signed, { ...ctx(NOW), nonceUsed: (n) => n === nonce });
    expect(refused(v)).toMatchObject({ stage: 'object', reason: 'nonce_used' });
  });
});

describe('agent.revoke (04 §2.5.1, §3.4.1)', () => {
  it('skips expiry and lifetime, and a re-published copy is a no-op, not a nonce refusal', async () => {
    const signed = await sign(body('agent.revoke', { reason: 'compromised' }, { issuedAt: 1 }));
    const nonce = signed.body.nonce;
    const v = verifyOwnerAction(signed, context([], { nonceUsed: (n) => n === nonce }));
    expect(v.ok).toBe(true);
  });

  it('still refuses an issuedAt beyond the clock skew', async () => {
    const signed = await sign(body('agent.revoke', { reason: 'other' }, { issuedAt: NOW + 301 }));
    expect(refused(verifyOwnerAction(signed, context())).reason).toBe('issued_in_future');
  });
});

describe('approval.decide against its request (04 §2.5.1, §3.4.1)', () => {
  it('expiresAt equal to the request expiry is accepted; one second later is refused', async () => {
    const r = request({ expiresAt: NOW + 500 });
    const at = await sign(body('approval.decide', decideParams(r), { expiresAt: NOW + 500 }));
    expect(verifyOwnerAction(at, context([r])).ok).toBe(true);
    const after = await sign(body('approval.decide', decideParams(r), { expiresAt: NOW + 501 }));
    expect(refused(verifyOwnerAction(after, context([r])))).toMatchObject({
      stage: 'match',
      reason: 'outlives_request',
    });
  });

  it('refuses an unknown, decided or mismatched request, at the match stage', async () => {
    const r = request();
    const unknown = await sign(body('approval.decide', decideParams(request())));
    expect(refused(verifyOwnerAction(unknown, context([r])))).toMatchObject({
      stage: 'match',
      reason: 'approval_unknown',
    });

    const decided = { ...r, pending: false };
    const s = await sign(body('approval.decide', decideParams(r)));
    expect(refused(verifyOwnerAction(s, context([decided]))).reason).toBe('not_pending');

    const other = { ...r, actionDigest: digestOf(42) };
    expect(refused(verifyOwnerAction(s, context([other]))).reason).toBe('digest_mismatch');
  });

  it('a request that has expired cannot be decided, even by an unexpired decision', async () => {
    const r = request({ expiresAt: NOW + 1_000 });
    const s = await sign(body('approval.decide', decideParams(r), { expiresAt: NOW + 1_000 }));
    expect(verifyOwnerAction(s, context([r], { now: NOW + 1_000 })).ok).toBe(true);
    // At expiresAt + 1 both the decision and the request have lapsed.
    expect(verifyOwnerAction(s, context([r], { now: NOW + 1_001 })).ok).toBe(false);
    // A decision that is still live for a request that lapsed first (its bound would forbid this
    // pairing, so the request is checked on its own as well).
    const lapsed = { ...r, expiresAt: NOW - 1 };
    const v = refused(verifyOwnerAction(s, context([lapsed])));
    expect(v.stage).toBe('match');
  });

  it('allows a commitment request to be decided on its own (never in a batch)', async () => {
    const r = request({ commitment: true });
    const s = await sign(body('approval.decide', decideParams(r)));
    expect(verifyOwnerAction(s, context([r])).ok).toBe(true);
  });
});

describe('approval.decideBatch (D-68, 04 §2.5.2)', () => {
  it('accepts a batch whose items all match pending requests of this agent', async () => {
    const rs = [request(), request(), request()];
    const v = verifyOwnerAction(
      await sign(body('approval.decideBatch', batchParams(rs))),
      context(rs),
    );
    expect(v.ok).toBe(true);
  });

  it('refuses items for another agent (the object agent must own every item request)', async () => {
    const mine = request();
    const theirs = request(); // pending at another agent: unknown here
    const s = await sign(body('approval.decideBatch', batchParams([mine, theirs])));
    const v = refused(verifyOwnerAction(s, context([mine])));
    expect(v).toMatchObject({ stage: 'match', reason: 'item_refused' });
    expect(v.items).toEqual([{ approvalId: theirs.approvalId, reason: 'approval_unknown' }]);
  });

  it('refuses a commitment item in a batch', async () => {
    const plain = request();
    const commitment = request({ commitment: true });
    const s = await sign(body('approval.decideBatch', batchParams([plain, commitment])));
    const v = refused(verifyOwnerAction(s, context([plain, commitment])));
    expect(v.stage).toBe('match');
    expect(v.items).toEqual([{ approvalId: commitment.approvalId, reason: 'commitment_in_batch' }]);
  });

  it('expiresAt at the earliest item request expiry is accepted; one later is refused', async () => {
    const early = request({ expiresAt: NOW + 400 });
    const late = request({ expiresAt: NOW + 5_000 });
    const params = batchParams([early, late]);
    const at = await sign(body('approval.decideBatch', params, { expiresAt: NOW + 400 }));
    expect(verifyOwnerAction(at, context([early, late])).ok).toBe(true);
    const over = await sign(body('approval.decideBatch', params, { expiresAt: NOW + 401 }));
    expect(refused(verifyOwnerAction(over, context([early, late])))).toMatchObject({
      stage: 'match',
      reason: 'outlives_request',
    });
  });

  it('refuses a lifetime above L(op) before looking at the requests', async () => {
    const rs = [request({ expiresAt: NOW + 200_000 }), request({ expiresAt: NOW + 200_000 })];
    const s = await sign(
      body('approval.decideBatch', batchParams(rs), {
        issuedAt: NOW - 10,
        expiresAt: NOW - 10 + 86_401,
      }),
    );
    expect(refused(verifyOwnerAction(s, context(rs)))).toMatchObject({
      stage: 'object',
      reason: 'lifetime_exceeded',
    });
  });

  it('refuses an item whose actionDigest does not match its pending request', async () => {
    const a = request();
    const b = request();
    const s = await sign(body('approval.decideBatch', batchParams([a, b])));
    const edited = { ...b, actionDigest: digestOf(7) };
    const v = refused(verifyOwnerAction(s, context([a, edited])));
    expect(v.items).toEqual([{ approvalId: b.approvalId, reason: 'digest_mismatch' }]);
  });

  it('lists every failing item: decided, expired and unknown together', async () => {
    const ok = request();
    const decided = request();
    const expired = request({ expiresAt: NOW - 1 });
    const unknown = request();
    const all = [ok, decided, expired, unknown];
    const s = await sign(
      body('approval.decideBatch', batchParams(all), { expiresAt: NOW - 1 + 1_000 }),
    );
    const v = refused(verifyOwnerAction(s, context([ok, { ...decided, pending: false }, expired])));
    // The earliest request already expired, so the batch outlives it too; the item list still names
    // every item that failed, in batch order.
    expect(v.stage).toBe('match');
    expect(new Map(v.items?.map((i) => [i.approvalId, i.reason]))).toEqual(
      new Map([
        [decided.approvalId, 'not_pending'],
        [expired.approvalId, 'request_expired'],
        [unknown.approvalId, 'approval_unknown'],
      ]),
    );
  });

  it('refuses cross-op replay: a batch signature as a decide, and a decide signature as a batch', async () => {
    const a = request();
    const b = request();
    const batch = await sign(body('approval.decideBatch', batchParams([a, b])));
    const items = (batch.body.params as { items: JsonObject[] }).items;
    const asDecide = {
      body: { ...batch.body, op: 'approval.decide', params: items[0]! },
      sig: batch.sig,
    };
    expect(refused(verifyOwnerAction(asDecide, context([a, b])))).toMatchObject({
      stage: 'object',
      reason: 'signature_invalid',
    });

    const decide = await sign(body('approval.decide', decideParams(a)));
    const asBatch = {
      body: { ...decide.body, op: 'approval.decideBatch', params: batchParams([a, b]) },
      sig: decide.sig,
    };
    expect(refused(verifyOwnerAction(asBatch, context([a, b])))).toMatchObject({
      stage: 'object',
      reason: 'signature_invalid',
    });
  });

  it('refuses a batch signed by a key other than the agent owner key', async () => {
    const rs = [request(), request()];
    const byStranger = await signWith(
      stranger,
      body('approval.decideBatch', batchParams(rs), { owner: STRANGER }),
    );
    expect(refused(verifyOwnerAction(byStranger, context(rs))).reason).toBe('owner_mismatch');
    const forged = { body: { ...byStranger.body, owner: OWNER }, sig: byStranger.sig };
    expect(refused(verifyOwnerAction(forged, context(rs)))).toMatchObject({
      stage: 'object',
      reason: 'signature_invalid',
    });
  });

  it('refuses a non-canonical batch (unsorted items) at the object stage', async () => {
    const rs = [request(), request()];
    const params = batchParams(rs);
    const items = [...(params.items as JsonObject[])].reverse();
    const s = await sign(body('approval.decideBatch', { items }));
    expect(refused(verifyOwnerAction(s, context(rs)))).toMatchObject({
      stage: 'object',
      reason: 'malformed',
    });
  });
});

describe('policy.set version (04 §2.5.1)', () => {
  const policy = defaultPolicy() as unknown as JsonObject;

  it('must be above the highest applied version', async () => {
    const v2 = await sign(body('policy.set', { version: 2, policy }));
    expect(verifyOwnerAction(v2, context([], { appliedPolicyVersion: 1 })).ok).toBe(true);
    expect(refused(verifyOwnerAction(v2, context([], { appliedPolicyVersion: 2 })))).toMatchObject({
      stage: 'object',
      reason: 'version_not_newer',
    });
    expect(refused(verifyOwnerAction(v2, context([], { appliedPolicyVersion: 3 }))).reason).toBe(
      'version_not_newer',
    );
    const v0 = await sign(body('policy.set', { version: 0, policy }));
    expect(refused(verifyOwnerAction(v0, context())).reason).toBe('version_not_newer');
  });
});

describe('contact.check (04 §2.5.1, §3.6.1)', () => {
  it('is not verified here: the pairing recomputation is M1-7c-b, so it is refused', async () => {
    const contact = `0x${'5a'.repeat(20)}`;
    const s = await sign(body('contact.check', { contact, pairingDigest: 'cd'.repeat(32) }));
    expect(refused(verifyOwnerAction(s, context()))).toMatchObject({
      stage: 'match',
      reason: 'unsupported_op',
    });
  });
});
