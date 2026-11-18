// D-156 (IR L2): a terms Record over a hard ceiling is reported as SPEND_CEILING with its ceiling
// and amount, in the same plain words as agentlink_notarize; never an approval.
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { findTool } from './registry.js';
import { ceilingOf, termsRefusal, termsSendLimit } from './terms-common.js';

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

// SEC-TERMS-CAPS: an offer, accept or reject over an outgoing cap is SEND_LIMIT in the same words as
// agentlink_send; the result still matches the terms tools' output schemas (unchanged surface).
describe('terms tools: SEND_LIMIT (SEC-TERMS-CAPS, D-156)', () => {
  const core = {
    code: 'SEND_LIMIT',
    limit: 'messages_contact',
    max: 300,
    retryAt: '2026-10-16T10:00:00Z',
  } as const;

  it('uses the agentlink_send words: the cap, the contact, the time and who can change it', () => {
    const out = termsSendLimit(core, 'Ana');
    expect(out.result).toMatchObject({ status: 'rejected', code: 'SEND_LIMIT' });
    expect(String(out.result.summary)).toContain('300 messages a day');
    expect(String(out.result.summary)).toContain('Ana');
    expect(String(out.result.nextStep)).toContain('This is over your limit.');
    expect(String(out.result.nextStep)).toContain('2026-10-16T10:00:00Z');
    expect(out.result.approvalId).toBeUndefined();
  });

  it('matches the propose and respond output schemas', () => {
    const out = termsSendLimit({ ...core, limit: 'messages_day', max: 1000 }, 'Ana');
    for (const name of ['agentlink_propose_terms', 'agentlink_respond_to_terms']) {
      const validate = new Ajv({ strict: false }).compile(findTool(name)!.outputSchema);
      expect(validate(out.result), name).toBe(true);
    }
  });

  it('a malformed refusal is a fixed internal error', () => {
    expect(termsSendLimit({ ...core, retryAt: 'soon' }, 'Ana').result.code).not.toBe('SEND_LIMIT');
  });
});
