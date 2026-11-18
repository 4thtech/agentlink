// SEC-HARD-CEILING and SEC-OUTBOUND-CAPS (D-156; 06 §3; 04 §2.5.3): the owner's hard proof ceilings
// and the rolling 24 h caps on outgoing messages and files, in the policy document.
// - Defaults: soft $0.20 / hard $0.50 per proof, soft $5 / hard $10 per rolling 24 h; outgoing 300
//   messages per contact and 1000 in all, 50 files per contact, 200 files and 2000 MB in all.
// - A soft limit above its hard ceiling is not a valid policy.
// - A policy signed before these fields existed still parses and reads as the defaults.
import { describe, expect, it } from 'vitest';
import {
  OUTGOING_DEFAULTS,
  POLICY_DEFAULTS,
  PROOF_CEILING_DEFAULTS,
  defaultPolicy,
  outgoingOf,
  policyPatchSchema,
  policySchema,
  proofCeilingsOf,
} from './index.js';

const withoutNewFields = () => {
  const p = defaultPolicy() as unknown as Record<string, Record<string, unknown>>;
  delete p.proofs!.hardMaxPerActionUSD;
  delete p.proofs!.hardDailyUSD;
  delete p.outgoing;
  return p;
};

describe('policy defaults for the hard ceilings and outgoing caps (D-156)', () => {
  it('soft $0.20 / hard $0.50 per proof, soft $5 / hard $10 per day', () => {
    expect(POLICY_DEFAULTS.proofs.perActionMaxUSD).toBe('0.2');
    expect(POLICY_DEFAULTS.proofs.dailyBudgetUSD).toBe('5');
    expect(POLICY_DEFAULTS.proofs.hardMaxPerActionUSD).toBe('0.5');
    expect(POLICY_DEFAULTS.proofs.hardDailyUSD).toBe('10');
    expect(PROOF_CEILING_DEFAULTS).toEqual({ hardMaxPerActionUSD: '0.5', hardDailyUSD: '10' });
  });

  it('outgoing: 300 / 1000 messages, 50 / 200 files, 2000 MB a day', () => {
    expect(OUTGOING_DEFAULTS).toEqual({
      messagesPerContactPerDay: 300,
      messagesPerDay: 1000,
      filesPerContactPerDay: 50,
      filesPerDay: 200,
      fileMBPerDay: 2000,
    });
    expect(POLICY_DEFAULTS.outgoing).toEqual(OUTGOING_DEFAULTS);
  });

  it('the defaults are a valid policy', () => {
    expect(policySchema.safeParse(defaultPolicy()).success).toBe(true);
  });
});

describe('soft limit at most the hard ceiling (D-156)', () => {
  it('rejects a soft per-proof limit above the hard per-proof ceiling', () => {
    const p = defaultPolicy();
    p.proofs.perActionMaxUSD = '0.51';
    expect(policySchema.safeParse(p).success).toBe(false);
    p.proofs.perActionMaxUSD = '0.5';
    expect(policySchema.safeParse(p).success).toBe(true);
  });

  it('rejects a soft daily limit above the hard daily ceiling', () => {
    const p = defaultPolicy();
    p.proofs.dailyBudgetUSD = '10.01';
    expect(policySchema.safeParse(p).success).toBe(false);
    p.proofs.dailyBudgetUSD = '10';
    expect(policySchema.safeParse(p).success).toBe(true);
  });

  it('rejects one hard ceiling without the other', () => {
    const p = defaultPolicy() as unknown as { proofs: Record<string, unknown> };
    delete p.proofs.hardDailyUSD;
    expect(policySchema.safeParse(p).success).toBe(false);
  });

  it('rejects outgoing caps out of bounds or with an unknown key', () => {
    const zero = defaultPolicy();
    (zero.outgoing as { messagesPerDay: number }).messagesPerDay = 0;
    expect(policySchema.safeParse(zero).success).toBe(false);
    const extra = defaultPolicy() as unknown as { outgoing: Record<string, unknown> };
    extra.outgoing.receiptsPerDay = 5;
    expect(policySchema.safeParse(extra).success).toBe(false);
    const fraction = defaultPolicy();
    (fraction.outgoing as { fileMBPerDay: number }).fileMBPerDay = 1.5;
    expect(policySchema.safeParse(fraction).success).toBe(false);
  });
});

describe('a policy signed before D-156 (migration: absent = defaults)', () => {
  it('still parses, with an older soft limit above the new hard default', () => {
    const old = withoutNewFields();
    old.proofs!.perActionMaxUSD = '1';
    const parsed = policySchema.safeParse(old);
    expect(parsed.success).toBe(true);
  });

  it('reads the hard ceilings and the outgoing caps as the defaults', () => {
    const old = policySchema.parse(withoutNewFields());
    expect(proofCeilingsOf(old)).toEqual(PROOF_CEILING_DEFAULTS);
    expect(outgoingOf(old)).toEqual(OUTGOING_DEFAULTS);
  });

  it('reads its own values when present', () => {
    const p = defaultPolicy();
    p.proofs.hardMaxPerActionUSD = '0.3';
    p.proofs.perActionMaxUSD = '0.1';
    (p.outgoing as { messagesPerDay: number }).messagesPerDay = 10;
    const parsed = policySchema.parse(p);
    expect(proofCeilingsOf(parsed).hardMaxPerActionUSD).toBe('0.3');
    expect(outgoingOf(parsed).messagesPerDay).toBe(10);
  });
});

describe('the policy patch names the new fields (Rules page)', () => {
  it('accepts a hard ceiling and an outgoing cap', () => {
    expect(
      policyPatchSchema.safeParse({
        proofs: { hardDailyUSD: '20', hardMaxPerActionUSD: '0.5' },
        outgoing: { messagesPerContactPerDay: 50 },
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown outgoing key', () => {
    expect(policyPatchSchema.safeParse({ outgoing: { acksPerDay: 1 } }).success).toBe(false);
  });
});
