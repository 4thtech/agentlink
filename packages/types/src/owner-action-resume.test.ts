// W4-PAUSE (D-143 (5); 04 §2.5.1 op table `agent.resume`; proposed, owner confirms at merge): Resume
// is the local owner action `agent.resume` with params exactly `{agent}`, the agent's `agentId`, equal
// to the body's `agent`; it expires, with L(op) = 600 s, and no envelope carries it. Pausing signs
// nothing, so there is no pause op.
import { describe, expect, it } from 'vitest';
import {
  OWNER_ACTION_MAX_LIFETIME_SECONDS,
  OWNER_ACTION_OPS,
  agentResumeActionSchema,
  ownerActionSchema,
  signedApprovalOpSchema,
  signedOwnerActionSchema,
} from './index.js';
import { expectReject, expectRoundTrip } from './testing/assert.js';
import { AGENT_EVM, CONTACT_A, OWNER_NOSTR, b64u, signed } from './testing/fixtures.js';

const resume = (params: Record<string, unknown> = { agent: AGENT_EVM }) => ({
  v: 1,
  agent: AGENT_EVM,
  owner: OWNER_NOSTR,
  op: 'agent.resume',
  params,
  nonce: b64u(16, 'R'),
  issuedAt: 1760000000,
  expiresAt: 1760000600,
});

describe('agent.resume (W4-PAUSE)', () => {
  it('is an owner-action op with L(op) = 600 s; there is no pause op', () => {
    expect(OWNER_ACTION_OPS).toContain('agent.resume');
    expect(OWNER_ACTION_MAX_LIFETIME_SECONDS['agent.resume']).toBe(600);
    expect(OWNER_ACTION_OPS.filter((op) => /pause/.test(op))).toEqual([]);
  });

  it('accepts exactly {agent}', () => {
    expectRoundTrip(agentResumeActionSchema, resume());
    expectRoundTrip(ownerActionSchema, resume());
    expectRoundTrip(signedOwnerActionSchema, signed(resume()));
  });

  it('refuses another agent, other keys, no expiry and an envelope carrier', () => {
    for (const body of [
      resume({ agent: CONTACT_A }),
      resume({}),
      resume({ agent: AGENT_EVM, generation: 3 }),
      resume({ agent: AGENT_EVM, label: 'Work' }),
      resume({ agent: '0x' + '1A'.repeat(20) }),
      { ...resume(), expiresAt: 0 },
      { ...resume(), expiresAt: 1760000000 },
    ]) {
      expectReject(ownerActionSchema, body);
      expectReject(signedOwnerActionSchema, signed(body));
    }
    expectReject(signedApprovalOpSchema, signed(resume()));
  });
});
