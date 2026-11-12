// UX1112 WP-12 (F-2; 02 F-14; D-72; 04 §2.5.1 op table `contact.block`, `contact.unblock`; proposed,
// owner confirms at merge): the owner blocks or unblocks one existing contact from the People page.
// Each is a local owner action with params exactly `{contact}`, the contact's agent ID; it expires,
// with L(op) = 600 s, and no envelope carries it (an `approval` envelope never does).
import { describe, expect, it } from 'vitest';
import {
  OWNER_ACTION_MAX_LIFETIME_SECONDS,
  OWNER_ACTION_OPS,
  contactBlockActionSchema,
  contactUnblockActionSchema,
  ownerActionSchema,
  signedApprovalOpSchema,
  signedOwnerActionSchema,
} from './index.js';
import { expectReject, expectRoundTrip } from './testing/assert.js';
import { AGENT_EVM, CONTACT_A, OWNER_NOSTR, b64u, signed } from './testing/fixtures.js';

const body = (op: string, params: Record<string, unknown> = { contact: CONTACT_A }) => ({
  v: 1,
  agent: AGENT_EVM,
  owner: OWNER_NOSTR,
  op,
  params,
  nonce: b64u(16, 'B'),
  issuedAt: 1760000000,
  expiresAt: 1760000600,
});

describe('contact.block and contact.unblock (WP-12, F-2)', () => {
  it('are owner-action ops with L(op) = 600 s', () => {
    for (const op of ['contact.block', 'contact.unblock'] as const) {
      expect(OWNER_ACTION_OPS).toContain(op);
      expect(OWNER_ACTION_MAX_LIFETIME_SECONDS[op]).toBe(600);
    }
  });

  it('accept exactly {contact}', () => {
    expectRoundTrip(contactBlockActionSchema, body('contact.block'));
    expectRoundTrip(contactUnblockActionSchema, body('contact.unblock'));
    for (const op of ['contact.block', 'contact.unblock']) {
      expectRoundTrip(ownerActionSchema, body(op));
      expectRoundTrip(signedOwnerActionSchema, signed(body(op)));
    }
  });

  it('refuse other params, a non-canonical ID, no expiry and an envelope carrier', () => {
    for (const op of ['contact.block', 'contact.unblock']) {
      for (const bad of [
        body(op, {}),
        body(op, { contact: CONTACT_A, alias: 'x' }),
        body(op, { contact: '0x' + '1A'.repeat(20) }),
        body(op, { contact: 'marko' }),
        { ...body(op), expiresAt: 0 },
        { ...body(op), expiresAt: 1760000000 },
      ]) {
        expectReject(ownerActionSchema, bad);
        expectReject(signedOwnerActionSchema, signed(bad));
      }
      expectReject(signedApprovalOpSchema, signed(body(op)));
    }
  });
});
