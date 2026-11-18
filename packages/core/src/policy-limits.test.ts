// SEC-HARD-CEILING and SEC-OUTBOUND-CAPS (D-156; 06 §3; 04 §2.5.3): the hard proof ceilings refuse
// (never an approval card), counted per Record and over the rolling 24 h window; the soft limits are
// read as at most the hard ones; the outgoing caps refuse a send over a per-contact or per-day cap.
// Only an owner-signed `policy.set` changes them: raising one warns and is a spending change.
import {
  OUTGOING_DEFAULTS,
  POLICY_DEFAULTS,
  defaultPolicy,
  policySchema,
  type Policy,
} from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import { checkAndReserveProof, type ProofReservation } from './budget.js';
import { mergePolicyPatch, policyEditWarnings } from './owner-prepare.js';
import { spendingChanges } from './pay-confirm.js';
import {
  BUDGET_WINDOW_SECONDS,
  evaluate,
  evaluateOutgoing,
  evaluateProof,
  type BudgetEntryView,
  type BudgetLedgerView,
  type EffectivePolicy,
  type ProofAction,
} from './policy-engine.js';
import { MemoryStore } from './store/memory-store.js';
import { SINGLETON_SLOT } from './store/schema.js';

const NOW = 1_800_000_000;
const CONTACT = '0x' + '3d'.repeat(20);

const signed = (policy: Policy): EffectivePolicy => ({ mode: 'signed', policy, version: 1 });
const defaults: EffectivePolicy = { mode: 'defaults', policy: POLICY_DEFAULTS };
const failClosed: EffectivePolicy = { mode: 'fail_closed', problem: 'missing' };

const proof = (feeUsd: string, maxFeeUsd = feeUsd, contact?: string): ProofAction => ({
  kind: 'proof',
  feeUsd,
  maxFeeUsd,
  counterparty: contact === undefined ? null : { contact, ruleEligible: true },
});

const entry = (usd: string, t: number): BudgetEntryView => ({
  t,
  ledgerEpoch: 1,
  state: 'charged',
  reservedUsd: usd,
  chargedUsd: usd,
});
const ledger = (...entries: BudgetEntryView[]): BudgetLedgerView => ({
  status: 'ok',
  epoch: 1,
  newestT: entries.reduce((m, e) => Math.max(m, e.t), NOW - 10_000),
  entries,
});
const ctx = (...entries: BudgetEntryView[]) => ({ now: NOW, ledger: ledger(...entries) });

/** A policy signed before D-156: no hard ceilings, no outgoing caps, the old $1 soft limit. */
function preD156(): Policy {
  const p = defaultPolicy() as unknown as Record<string, Record<string, unknown>>;
  delete p.proofs!.hardMaxPerActionUSD;
  delete p.proofs!.hardDailyUSD;
  delete p.outgoing;
  p.proofs!.perActionMaxUSD = '1';
  return policySchema.parse(p);
}

describe('hard per-proof ceiling (D-156): refuses, never asks', () => {
  it('a fee above $0.50 is deny with the ceiling named, and no approval trigger', () => {
    const out = evaluateProof(defaults, proof('0.51'), ctx());
    expect(out.decision).toBe('deny');
    expect(out.ceiling).toBe('per_action');
    expect(evaluate(defaults, proof('0.51'), ctx())).toBe('deny');
  });

  it('a fee between the soft and the hard limit still asks the owner', () => {
    const out = evaluateProof(defaults, proof('0.3'), ctx());
    expect(out.decision).toBe('approval');
    expect(out.triggers).toContain('per_action');
    expect(out.ceiling).toBeUndefined();
  });

  it('at or below the soft limit is allowed', () => {
    expect(evaluateProof(defaults, proof('0.1'), ctx()).decision).toBe('allow');
    expect(evaluateProof(defaults, proof('0.2'), ctx()).decision).toBe('allow');
  });

  it('exactly the hard ceiling is not over it', () => {
    expect(evaluateProof(defaults, proof('0.5'), ctx()).decision).toBe('approval');
  });

  it('compares the reserved maximum fee, not only the quoted fee', () => {
    expect(evaluateProof(defaults, proof('0.1', '0.6'), ctx()).decision).toBe('deny');
  });

  it('a contact rule cannot raise the soft limit above the hard ceiling, nor the ceiling', () => {
    const p = defaultPolicy();
    p.contactRules = [{ contact: CONTACT, proofs: { perActionMaxUSD: '3' } }];
    const e = signed(policySchema.parse(p));
    expect(evaluateProof(e, proof('0.4', '0.4', CONTACT), ctx()).decision).toBe('allow');
    expect(evaluateProof(e, proof('0.6', '0.6', CONTACT), ctx())).toMatchObject({
      decision: 'deny',
      ceiling: 'per_action',
    });
  });

  it('a raised ceiling (signed by the owner) lets a higher fee through to the soft check', () => {
    const p = defaultPolicy();
    p.proofs.hardMaxPerActionUSD = '2';
    p.proofs.perActionMaxUSD = '1';
    const e = signed(policySchema.parse(p));
    expect(evaluateProof(e, proof('0.9'), ctx()).decision).toBe('allow');
    expect(evaluateProof(e, proof('1.5'), ctx()).decision).toBe('approval');
    expect(evaluateProof(e, proof('2.01'), ctx()).decision).toBe('deny');
  });

  it('still refuses above the ceiling when the ledger is broken', () => {
    const out = evaluateProof(defaults, proof('0.6'), { now: NOW, ledger: { status: 'broken' } });
    expect(out).toMatchObject({ decision: 'deny', ceiling: 'per_action' });
  });

  it('refuses above the built-in ceiling while the policy fails closed', () => {
    expect(evaluateProof(failClosed, proof('0.6'), ctx())).toMatchObject({
      decision: 'deny',
      ceiling: 'per_action',
    });
    expect(evaluateProof(failClosed, proof('0.1'), ctx()).decision).toBe('approval');
  });
});

describe('hard daily ceiling over the rolling 24 h window (D-156)', () => {
  it('spent + this proof above $10 is deny; above $5 but within $10 asks', () => {
    expect(evaluateProof(defaults, proof('0.1'), ctx(entry('9.95', NOW - 60)))).toMatchObject({
      decision: 'deny',
      ceiling: 'daily',
    });
    const ask = evaluateProof(defaults, proof('0.1'), ctx(entry('5', NOW - 60)));
    expect(ask.decision).toBe('approval');
    expect(ask.triggers).toContain('budget');
  });

  it('exactly reaching $10 is not over it', () => {
    expect(evaluateProof(defaults, proof('0.1'), ctx(entry('9.9', NOW - 60))).decision).toBe(
      'approval',
    );
  });

  it('the window rolls: spending older than 24 h no longer counts', () => {
    const old = entry('9.95', NOW - BUDGET_WINDOW_SECONDS);
    expect(evaluateProof(defaults, proof('0.1'), ctx(old)).decision).toBe('allow');
    const inside = entry('9.95', NOW - BUDGET_WINDOW_SECONDS + 1);
    expect(evaluateProof(defaults, proof('0.1'), ctx(inside)).decision).toBe('deny');
  });

  it('counts per Record: many proofs each under the per-proof ceiling add up to the daily one', () => {
    const many = Array.from({ length: 99 }, (_, i) => entry('0.1', NOW - 100 - i));
    expect(evaluateProof(defaults, proof('0.1'), ctx(...many)).decision).toBe('approval');
    const more = [...many, entry('0.1', NOW - 5)];
    expect(evaluateProof(defaults, proof('0.1'), ctx(...more))).toMatchObject({
      decision: 'deny',
      ceiling: 'daily',
    });
  });

  it('an owner approval never reserves a proof over the ceiling', async () => {
    const store = new MemoryStore();
    await store.transaction((tx) =>
      tx.insert('budget_state', {
        slot: SINGLETON_SLOT,
        ledger_epoch: 1,
        status: 'ok',
        newest_t: NOW - 1000,
        since: NOW - 1000,
        broken_at: null,
      }),
    );
    const reservation: ProofReservation = {
      entryId: 'e1',
      recordId: '0x' + '01'.padStart(64, '0'),
      chainId: 8453,
      approvalId: 'apr_x',
      deadline: NOW + 3600,
    };
    const out = await store.transaction((tx) =>
      checkAndReserveProof(tx, {
        effective: defaults,
        action: proof('0.6'),
        now: NOW,
        reservation,
        ownerApproved: true,
      }),
    );
    expect(out).toMatchObject({ decision: 'deny', reserved: false });
    expect(await store.transaction((tx) => tx.select('budget_ledger'))).toEqual([]);
  });
});

describe('a policy signed before D-156 (migration: absent = defaults)', () => {
  it('reads its soft per-proof limit as at most the default hard ceiling', () => {
    const e = signed(preD156());
    expect(evaluateProof(e, proof('0.45'), ctx()).decision).toBe('allow');
    expect(evaluateProof(e, proof('0.6'), ctx())).toMatchObject({
      decision: 'deny',
      ceiling: 'per_action',
    });
    expect(evaluateProof(e, proof('0.1'), ctx(entry('9.95', NOW - 1))).decision).toBe('deny');
  });

  it('the next edit carries the ceilings and the outgoing caps, soft clamped to the hard one', () => {
    const merged = mergePolicyPatch(preD156(), { receipts: { autoDelivered: false } });
    expect(merged.proofs.hardMaxPerActionUSD).toBe('0.5');
    expect(merged.proofs.hardDailyUSD).toBe('10');
    expect(merged.proofs.perActionMaxUSD).toBe('0.5');
    expect(merged.outgoing).toEqual(OUTGOING_DEFAULTS);
    expect(policySchema.safeParse(merged).success).toBe(true);
  });

  it('an edit that names a soft limit above the hard ceiling is not a valid policy', () => {
    const merged = mergePolicyPatch(defaultPolicy(), { proofs: { perActionMaxUSD: '0.9' } });
    expect(policySchema.safeParse(merged).success).toBe(false);
  });
});

describe('changing the ceilings and caps is an owner change (04 §2.5.3, 06 §3)', () => {
  it('raising a hard ceiling warns as a spending raise and is a spending change', () => {
    const base = defaultPolicy();
    const next = mergePolicyPatch(base, { proofs: { hardDailyUSD: '25' } });
    expect(policyEditWarnings(base, next).map((w) => w.code)).toContain('proofs_spend_raised');
    expect(spendingChanges(base, next)).toContainEqual(
      expect.objectContaining({ field: 'proofs.hardDailyUSD', old: '10', new: '25' }),
    );
    const per = mergePolicyPatch(base, { proofs: { hardMaxPerActionUSD: '1' } });
    expect(spendingChanges(base, per).map((c) => c.field)).toContain('proofs.hardMaxPerActionUSD');
  });

  it('a pre-D-156 policy filled with the default ceilings is no spending change for them', () => {
    const base = preD156();
    const next = mergePolicyPatch(base, { receipts: { autoDelivered: false } });
    const fields = spendingChanges(base, next).map((c) => c.field);
    expect(fields).not.toContain('proofs.hardDailyUSD');
    expect(fields).not.toContain('proofs.hardMaxPerActionUSD');
  });

  it('raising an outgoing cap warns as a raised limit', () => {
    const base = defaultPolicy();
    const next = mergePolicyPatch(base, { outgoing: { messagesPerDay: 5000 } });
    const warning = policyEditWarnings(base, next).find((w) => w.code === 'limits_raised');
    expect(warning?.fields).toContain('outgoing.messagesPerDay');
    const lower = mergePolicyPatch(base, { outgoing: { messagesPerDay: 10 } });
    expect(policyEditWarnings(base, lower)).toEqual([]);
  });
});

describe('outgoing caps (D-156): per contact and per day, messages and files', () => {
  const zero = { contactMessages: 0, messages: 0, contactFiles: 0, files: 0, bytes: 0 };
  const msg = { contact: CONTACT, files: 0, bytes: 0 };

  it('allows up to the cap and refuses the next message to the same contact', () => {
    expect(evaluateOutgoing(defaults, msg, { ...zero, contactMessages: 299, messages: 299 })).toEqual(
      { decision: 'allow' },
    );
    expect(evaluateOutgoing(defaults, msg, { ...zero, contactMessages: 300, messages: 300 })).toEqual(
      { decision: 'deny', limit: 'messages_contact', max: 300 },
    );
  });

  it('refuses the next message of the day across contacts', () => {
    expect(evaluateOutgoing(defaults, msg, { ...zero, contactMessages: 2, messages: 1000 })).toEqual(
      { decision: 'deny', limit: 'messages_day', max: 1000 },
    );
  });

  it('files per contact, files per day and MB per day', () => {
    const file = { contact: CONTACT, files: 1, bytes: 1024 };
    expect(evaluateOutgoing(defaults, file, { ...zero, contactFiles: 49, files: 49 })).toEqual({
      decision: 'allow',
    });
    expect(evaluateOutgoing(defaults, file, { ...zero, contactFiles: 50, files: 50 })).toEqual({
      decision: 'deny',
      limit: 'files_contact',
      max: 50,
    });
    expect(evaluateOutgoing(defaults, file, { ...zero, contactFiles: 3, files: 200 })).toEqual({
      decision: 'deny',
      limit: 'files_day',
      max: 200,
    });
    const MB = 1024 * 1024;
    const big = { contact: CONTACT, files: 1, bytes: 2 * MB };
    expect(evaluateOutgoing(defaults, big, { ...zero, bytes: 1998 * MB })).toEqual({
      decision: 'allow',
    });
    expect(evaluateOutgoing(defaults, big, { ...zero, bytes: 1998 * MB + 1 })).toEqual({
      decision: 'deny',
      limit: 'file_mb_day',
      max: 2000,
    });
  });

  it('several files in one message count each', () => {
    const three = { contact: CONTACT, files: 3, bytes: 3 };
    expect(evaluateOutgoing(defaults, three, { ...zero, contactFiles: 47, files: 47 })).toEqual({
      decision: 'allow',
    });
    expect(evaluateOutgoing(defaults, three, { ...zero, contactFiles: 48, files: 48 })).toMatchObject(
      { decision: 'deny', limit: 'files_contact' },
    );
  });

  it('reads the owner’s own caps, and the defaults for a pre-D-156 policy or fail closed', () => {
    const p = defaultPolicy();
    (p.outgoing as { messagesPerContactPerDay: number }).messagesPerContactPerDay = 2;
    const e = signed(policySchema.parse(p));
    expect(evaluateOutgoing(e, msg, { ...zero, contactMessages: 2, messages: 2 })).toMatchObject({
      decision: 'deny',
      max: 2,
    });
    const old = signed(preD156());
    expect(evaluateOutgoing(old, msg, { ...zero, contactMessages: 300 })).toMatchObject({
      decision: 'deny',
      max: 300,
    });
    expect(evaluateOutgoing(failClosed, msg, { ...zero, messages: 1000 })).toMatchObject({
      decision: 'deny',
      limit: 'messages_day',
    });
  });
});
