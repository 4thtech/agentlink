// SEC-RECEIPTS-DEFAULT: `receipts.sendReceived` (06 §3), the owner's "Send received receipts" switch.
import { describe, expect, it } from 'vitest';
import { defaultPolicy, policyPatchSchema, policySchema, sendReceivedOf } from './policy.js';

describe('receipts.sendReceived', () => {
  it('is on when absent (a policy signed before the setting existed)', () => {
    const policy = defaultPolicy();
    expect(policySchema.safeParse(policy).success).toBe(true);
    expect(sendReceivedOf(policy)).toBe(true);
  });

  it('takes a boolean, and off turns it off', () => {
    const policy = defaultPolicy();
    const off = { ...policy, receipts: { ...policy.receipts, sendReceived: false } };
    expect(policySchema.safeParse(off).success).toBe(true);
    expect(sendReceivedOf(off)).toBe(false);
    const bad = { ...policy, receipts: { ...policy.receipts, sendReceived: 'no' } };
    expect(policySchema.safeParse(bad).success).toBe(false);
  });

  it('an owner surface can patch it', () => {
    expect(policyPatchSchema.safeParse({ receipts: { sendReceived: false } }).success).toBe(true);
  });
});
