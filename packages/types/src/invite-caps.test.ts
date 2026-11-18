// SEC-INVITE-CAPS (D-156; 04 §2.5.1 `contact.keep`; 06 §3 `contacts.aiInvites`): the owner keeps a
// contact the AI connected (`{contact}`, L(op) = 600 s, never on an envelope), and the owner's caps
// on AI-made invites in the signed policy (absent in a policy signed before: the defaults).
import { describe, expect, it } from 'vitest';
import {
  AI_INVITE_DEFAULTS,
  OWNER_ACTION_MAX_LIFETIME_SECONDS,
  OWNER_ACTION_OPS,
  POLICY_BOUNDS,
  aiInviteLimitsOf,
  contactKeepActionSchema,
  inviteCreateActionSchema,
  defaultPolicy,
  ownerActionSchema,
  policyPatchSchema,
  policySchema,
  signedApprovalOpSchema,
  signedOwnerActionSchema,
} from './index.js';
import { expectReject, expectRoundTrip } from './testing/assert.js';
import { AGENT_EVM, CONTACT_A, OWNER_NOSTR, b64u, signed } from './testing/fixtures.js';

const body = (params: Record<string, unknown> = { contact: CONTACT_A }) => ({
  v: 1,
  agent: AGENT_EVM,
  owner: OWNER_NOSTR,
  op: 'contact.keep',
  params,
  nonce: b64u(16, 'K'),
  issuedAt: 1760000000,
  expiresAt: 1760000600,
});

describe('contact.keep (SEC-INVITE-CAPS)', () => {
  it('is an owner-action op with L(op) = 600 s', () => {
    expect(OWNER_ACTION_OPS).toContain('contact.keep');
    expect(OWNER_ACTION_MAX_LIFETIME_SECONDS['contact.keep']).toBe(600);
  });

  it('accepts exactly {contact}; nothing else, and never as an approval op', () => {
    expectRoundTrip(contactKeepActionSchema, body());
    expectRoundTrip(ownerActionSchema, body());
    expectRoundTrip(signedOwnerActionSchema, signed(body()));
    for (const bad of [
      body({}),
      body({ contact: CONTACT_A, alias: 'x' }),
      body({ contact: '0x' + '1A'.repeat(20) }),
      { ...body(), expiresAt: 0 },
    ]) {
      expectReject(ownerActionSchema, bad);
    }
    expectReject(signedApprovalOpSchema, signed(body()));
  });
});

describe('invite.create (SEC-INVITE-CAPS, owner decision 18 Nov 2026)', () => {
  const create = (params: Record<string, unknown> = {}) => ({
    ...body(),
    op: 'invite.create',
    params,
  });
  it('is an owner-action op with L(op) = 600 s and exactly empty params', () => {
    expect(OWNER_ACTION_OPS).toContain('invite.create');
    expect(OWNER_ACTION_MAX_LIFETIME_SECONDS['invite.create']).toBe(600);
    expectRoundTrip(inviteCreateActionSchema, create());
    expectRoundTrip(signedOwnerActionSchema, signed(create()));
    expectReject(ownerActionSchema, create({ long: true }));
    expectReject(signedApprovalOpSchema, signed(create()));
  });
});

describe('contacts.aiInvites (SEC-INVITE-CAPS)', () => {
  it('defaults: 3 open, 5 per rolling 24 h, 24 h expiry; absent in the default document', () => {
    expect(AI_INVITE_DEFAULTS).toEqual({ maxOpen: 3, perDay: 5, expiryHours: 24 });
    const policy = defaultPolicy();
    expect('aiInvites' in policy.contacts).toBe(false);
    expect(aiInviteLimitsOf(policy)).toEqual(AI_INVITE_DEFAULTS);
  });

  it('takes the owner’s values within the bounds, strict', () => {
    const policy = defaultPolicy();
    policy.contacts.aiInvites = { maxOpen: 0, perDay: 0, expiryHours: 1 };
    expect(policySchema.safeParse(policy).success).toBe(true);
    expect(aiInviteLimitsOf(policy)).toEqual({ maxOpen: 0, perDay: 0, expiryHours: 1 });
    const { maxOpen, perDay, expiryHours } = POLICY_BOUNDS.aiInvites;
    for (const bad of [
      { maxOpen: maxOpen.max + 1, perDay: 5, expiryHours: 24 },
      { maxOpen: 3, perDay: perDay.max + 1, expiryHours: 24 },
      { maxOpen: 3, perDay: 5, expiryHours: expiryHours.max + 1 },
      { maxOpen: 3, perDay: 5, expiryHours: 0 },
      { maxOpen: 3, perDay: 5 },
      { maxOpen: 3, perDay: 5, expiryHours: 24, extra: 1 },
    ]) {
      const p = defaultPolicy() as unknown as { contacts: Record<string, unknown> };
      p.contacts['aiInvites'] = bad;
      expect(policySchema.safeParse(p).success).toBe(false);
    }
    expect(
      policyPatchSchema.safeParse({
        contacts: { aiInvites: { maxOpen: 2, perDay: 4, expiryHours: 12 } },
      }).success,
    ).toBe(true);
  });
});
