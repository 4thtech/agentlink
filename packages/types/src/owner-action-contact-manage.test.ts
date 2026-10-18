// contact.rename and contact.remove (M1-9za; 04 §2.5, §2.5.1 op table; 06 §2.1 rule 1; 07 §3).
// Written from the spec text (proposed, owner confirms at merge):
// - `contact.rename` params are exactly `{contact, alias}`; `contact.remove` params are exactly
//   `{contact}`;
// - `contact` is the contact's agent ID: `0x` + 40 lowercase hex (04 §2.4.1, §2.9);
// - `alias` is a non-empty string of at most 32 code points. That it is its own restricted form
//   (06 §2.1 `restrictName`) is the core's rule, not the schema's;
// - any other key, another spelling of `contact`, or another op's params is rejected, never
//   normalised;
// - both expire like every op but `agent.revoke`, with L(op) = 600 s (the default for later ops);
// - no envelope carries them: they are applied only on the agent's own machine.
import { describe, expect, it } from 'vitest';
import {
  OWNER_ACTION_MAX_LIFETIME_SECONDS,
  OWNER_ACTION_OPS,
  contactRemoveActionSchema,
  contactRenameActionSchema,
  ownerActionSchema,
  signedApprovalOpSchema,
  signedOwnerActionSchema,
} from './index.js';
import { expectReject, expectRoundTrip } from './testing/assert.js';
import { AGENT_EVM, CONTACT_A, OWNER_NOSTR, signed } from './testing/fixtures.js';

const NONCE = 'X'.repeat(22);

const renameAction = (
  params: Record<string, unknown> = { contact: CONTACT_A, alias: 'Tali laptop' },
) => ({
  v: 1,
  agent: AGENT_EVM,
  owner: OWNER_NOSTR,
  op: 'contact.rename',
  params,
  nonce: NONCE,
  issuedAt: 1760000000,
  expiresAt: 1760000600,
});

const removeAction = (params: Record<string, unknown> = { contact: CONTACT_A }) => ({
  ...renameAction(),
  op: 'contact.remove',
  params,
});

describe('contact.rename and contact.remove schemas (M1-9za)', () => {
  it('are owner-action ops with L(op) = 600 s', () => {
    expect(OWNER_ACTION_OPS).toContain('contact.rename');
    expect(OWNER_ACTION_OPS).toContain('contact.remove');
    expect(OWNER_ACTION_MAX_LIFETIME_SECONDS['contact.rename']).toBe(600);
    expect(OWNER_ACTION_MAX_LIFETIME_SECONDS['contact.remove']).toBe(600);
  });

  it('accept the exact forms through every schema they pass', () => {
    for (const [schema, body] of [
      [contactRenameActionSchema, renameAction()],
      [contactRemoveActionSchema, removeAction()],
    ] as const) {
      expectRoundTrip(schema, body);
      expectRoundTrip(ownerActionSchema, body);
      expectRoundTrip(signedOwnerActionSchema, signed(body));
    }
    expectRoundTrip(ownerActionSchema, renameAction({ contact: CONTACT_A, alias: 'a'.repeat(32) }));
    expectRoundTrip(ownerActionSchema, renameAction({ contact: CONTACT_A, alias: 'Ana Kovač' }));
  });

  it('reject other keys, spellings, sizes and the other op params', () => {
    const upper = '0x' + '3D'.repeat(20);
    for (const body of [
      renameAction({ contact: CONTACT_A }),
      renameAction({ contact: CONTACT_A, alias: '' }),
      renameAction({ contact: CONTACT_A, alias: 'a'.repeat(33) }),
      renameAction({ contact: CONTACT_A, alias: 7 }),
      renameAction({ contact: upper, alias: 'Tali' }),
      renameAction({ contact: CONTACT_A.slice(2), alias: 'Tali' }),
      renameAction({ contact: CONTACT_A, alias: 'Tali', extra: 1 }),
      removeAction({ contact: CONTACT_A, alias: 'Tali' }),
      removeAction({ contact: upper }),
      removeAction({}),
      { ...removeAction(), expiresAt: 0 },
      { ...renameAction(), expiresAt: 1760000000 },
    ]) {
      expectReject(ownerActionSchema, body);
      expectReject(signedOwnerActionSchema, signed(body));
    }
  });

  it('no envelope carries them (local owner surfaces only)', () => {
    expectReject(signedApprovalOpSchema, signed(renameAction()));
    expectReject(signedApprovalOpSchema, signed(removeAction()));
  });
});
