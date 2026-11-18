// D-156 (IR L2): a terms Record over a hard ceiling is reported as SPEND_CEILING with its ceiling
// and amount, in the same plain words as agentlink_notarize; never an approval.
import { describe, expect, it } from 'vitest';
import { ceilingOf, termsRefusal } from './terms-common.js';

describe('terms tools: SPEND_CEILING (D-156)', () => {
  it('maps to a rejected result with the ceiling, the amount and the owner words', () => {
    const fields = ceilingOf({ code: 'SPEND_CEILING', ceiling: 'daily', limitUsd: '10' });
    const out = termsRefusal('SPEND_CEILING', true, fields);
    expect(out.result).toMatchObject({
      status: 'rejected',
      code: 'SPEND_CEILING',
      ceiling: 'daily',
      limitUsd: '10',
    });
    expect(String(out.result.summary)).toContain('$10 a day');
    expect(String(out.result.nextStep)).toContain('This is over your limit.');
    expect(out.result.approvalId).toBeUndefined();
  });

  it('carries no ceiling fields for another code', () => {
    expect(ceilingOf({ code: 'POLICY_DENIED' })).toEqual({});
  });
});
