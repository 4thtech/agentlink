// M1-11c-a4 (IR-M1-11c-a4-1 M-1): the price of one proof comes from the chain package's published
// schedule (12 §2), so the local UI's "proofs left" and price line never drift from it.
import { FEE_SCHEDULE_USD_MICROS } from '@4thtech-io/chain';
import { describe, expect, it } from 'vitest';
import { PROOF_PRICE_USD_MICROS } from '../index.js';

describe('PROOF_PRICE_USD_MICROS', () => {
  it("is the schedule's NOTARIZE fee, in micro-dollars", () => {
    expect(PROOF_PRICE_USD_MICROS).toBe(FEE_SCHEDULE_USD_MICROS.NOTARIZE.fee);
    expect(typeof PROOF_PRICE_USD_MICROS).toBe('bigint');
    expect(PROOF_PRICE_USD_MICROS > 0n).toBe(true);
  });
});
