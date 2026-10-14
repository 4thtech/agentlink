// contact.check (04 §2.5.1 op table, §2.4.1, §3.6.1; 07 §3; G-28). Written from the spec text:
// - params are exactly `{contact, pairingDigest}`;
// - `contact` is the contact's agent ID: `0x` + 40 lowercase hex (04 §2.4.1, §2.9);
// - `pairingDigest` is the safety-code transcript digest as bare hex, 64 lowercase characters
//   (04 §2.4.1 "digest under a Nostr key only", §3.6.1);
// - any other key, another spelling of either value, or another op's params is rejected, never
//   normalised;
// - it expires like every op but `agent.revoke`, with L(op) = 86 400 s, as for `policy.set` (G-7);
// - no envelope carries it yet (04 §3.4.1 "Not yet carried"; the console carrier is M2-2e).
// Comparing `pairingDigest` with the digest recomputed from the signed `handshake` and
// `handshake-ack`, and storing it in `contacts.safety_check`, are the core's (M1-7c), not the schema's.
import { describe, expect, it } from 'vitest';
import {
  OWNER_ACTION_MAX_LIFETIME_SECONDS,
  OWNER_ACTION_OPS,
  agentRevokeActionSchema,
  approvalCancelActionSchema,
  approvalDecideActionSchema,
  approvalDecideBatchActionSchema,
  contactCheckActionSchema,
  contactCheckParamsSchema,
  ownerActionSchema,
  payloadSchema,
  policySetActionSchema,
  signedApprovalOpSchema,
  signedContactCheckSchema,
  signedOwnerActionSchema,
  signedPolicySetSchema,
} from './index.js';
import { expectReject, expectRoundTrip } from './testing/assert.js';
import {
  agentRevokeAction,
  approvalCancelAction,
  approvalDecideAction,
  approvalDecideBatchAction,
  b64u,
  CONTACT_B,
  contactCheckAction,
  DELETE,
  edit,
  PAIRING_DIGEST,
  payloads,
  policySetAction,
  signed,
} from './testing/fixtures.js';

/** Every schema a `contact.check` body passes through; each must agree. */
const accepts = (body: unknown) => {
  expectRoundTrip(contactCheckActionSchema, body);
  expectRoundTrip(ownerActionSchema, body);
  expectRoundTrip(signedOwnerActionSchema, signed(body));
  expectRoundTrip(signedContactCheckSchema, signed(body));
};
const rejects = (body: unknown) => {
  expectReject(contactCheckActionSchema, body);
  expectReject(ownerActionSchema, body);
  expectReject(signedOwnerActionSchema, signed(body));
  expectReject(signedContactCheckSchema, signed(body));
};
const withParams = (path: readonly (string | number)[], value: unknown) =>
  edit(contactCheckAction(), ['params', ...path], value);

describe('contact.check constants (04 §2.5.1, G-7)', () => {
  it('is an owner-action op with L(op) = 86 400 s, as for policy.set', () => {
    expect(OWNER_ACTION_OPS).toContain('contact.check');
    expect(OWNER_ACTION_MAX_LIFETIME_SECONDS['contact.check']).toBe(86_400);
    expect(OWNER_ACTION_MAX_LIFETIME_SECONDS['contact.check']).toBe(
      OWNER_ACTION_MAX_LIFETIME_SECONDS['policy.set'],
    );
  });
});

describe('contact.check accepts the canonical form unchanged', () => {
  it('the fixture body, through every schema that carries it', () => {
    accepts(contactCheckAction());
  });

  it('the params schema alone accepts {contact, pairingDigest}', () => {
    expectRoundTrip(contactCheckParamsSchema, contactCheckAction().params);
  });

  it('any lowercase agent ID and digest, including all-zero and all-f values', () => {
    accepts(withParams(['contact'], CONTACT_B));
    accepts(withParams(['contact'], `0x${'0'.repeat(40)}`));
    accepts(withParams(['contact'], `0x${'f'.repeat(40)}`));
    accepts(withParams(['pairingDigest'], '0'.repeat(64)));
    accepts(withParams(['pairingDigest'], 'f'.repeat(64)));
    accepts(withParams(['pairingDigest'], '0123456789abcdef'.repeat(4)));
  });

  it('an expiry of exactly L(op) and of one second (the lifetime bound is the core’s)', () => {
    accepts(edit(contactCheckAction(), ['expiresAt'], 1760000000 + 86_400));
    accepts(edit(contactCheckAction(), ['expiresAt'], 1760000001));
  });
});

describe('contact.check params are strict (04 §2.5.1)', () => {
  it.each([
    ['an unknown key', ['note'], 'x'],
    ['an unknown key "op"', ['op'], 'contact.check'],
    ['a code beside the digest', ['safetyCode'], '048210937551'],
    ['a "checked" flag', ['checked'], true],
    ['missing contact', ['contact'], DELETE],
    ['missing pairingDigest', ['pairingDigest'], DELETE],
  ] as const)('rejects %s', (_l, path, value) => {
    rejects(withParams(path, value));
    expectReject(contactCheckParamsSchema, edit(contactCheckAction().params, path, value));
  });

  it.each([
    ['null', null],
    ['an empty object', {}],
    ['an array', [contactCheckAction().params.contact, PAIRING_DIGEST]],
    ['JSON text', JSON.stringify(contactCheckAction().params)],
  ] as const)('rejects params that are %s', (_l, value) => {
    rejects(edit(contactCheckAction(), ['params'], value));
  });
});

describe('contact.check `contact` is exactly an agent ID: 0x + 40 lowercase hex (04 §2.4.1)', () => {
  const c = contactCheckAction().params.contact.slice(2);
  it.each([
    ['EIP-55 mixed case', '0x3D3d3D3d3D3d3D3d3D3d3D3d3D3d3D3d3D3d3D3d'],
    ['uppercase hex', `0x${c.toUpperCase()}`],
    ['uppercase prefix', `0X${c}`],
    ['no 0x prefix', c],
    ['19 bytes', `0x${c.slice(2)}`],
    ['21 bytes', `0x${c}3d`],
    ['32-byte padded', `0x${'00'.repeat(12)}${c}`],
    ['non-hex', `0x${'g'.repeat(40)}`],
    ['surrounding space', ` 0x${c}`],
    ['a Nostr key', PAIRING_DIGEST],
    ['a number', 0x3d],
    ['null', null],
  ] as const)('rejects %s', (_l, value) => {
    rejects(withParams(['contact'], value));
  });
});

describe('contact.check `pairingDigest` is exactly bare hex, 64 lowercase (04 §2.4.1, §3.6.1)', () => {
  it.each([
    ['uppercase', PAIRING_DIGEST.toUpperCase()],
    ['mixed case', `6B${PAIRING_DIGEST.slice(2)}`],
    ['0x-prefixed', `0x${PAIRING_DIGEST}`],
    ['0x-prefixed, 31 bytes', `0x${PAIRING_DIGEST.slice(2)}`],
    ['base64url', b64u(32)],
    ['31 bytes', PAIRING_DIGEST.slice(2)],
    ['33 bytes', `${PAIRING_DIGEST}6b`],
    ['empty', ''],
    ['non-hex', 'g'.repeat(64)],
    ['trailing newline', `${PAIRING_DIGEST}\n`],
    ['the 12-digit code', '048210937551'],
    ['the grouped code', '0482 1093 7551'],
    ['a number', 1],
    ['null', null],
  ] as const)('rejects %s', (_l, value) => {
    rejects(withParams(['pairingDigest'], value));
  });
});

describe('contact.check expiry shape (04 §2.5.1)', () => {
  it('requires a non-zero expiresAt after issuedAt (0 is only for agent.revoke)', () => {
    rejects(edit(contactCheckAction(), ['expiresAt'], 0));
    rejects(edit(contactCheckAction(), ['expiresAt'], 1760000000));
    rejects(edit(contactCheckAction(), ['expiresAt'], 1759999999));
  });
});

describe('contact.check cannot be confused with another op (04 §2.5.1)', () => {
  const others = [
    ['approval.decide', approvalDecideAction, approvalDecideActionSchema],
    ['approval.decideBatch', approvalDecideBatchAction, approvalDecideBatchActionSchema],
    ['approval.cancel', approvalCancelAction, approvalCancelActionSchema],
    ['policy.set', policySetAction, policySetActionSchema],
    ['agent.revoke', agentRevokeAction, agentRevokeActionSchema],
  ] as const;

  it.each(others)('a contact.check body carrying %s params is rejected', (_op, make) => {
    rejects(edit(contactCheckAction(), ['params'], make().params));
  });

  it.each(others)('a %s body carrying contact.check params is rejected', (_op, make, schema) => {
    const bad = edit(make(), ['params'], contactCheckAction().params);
    expectReject(schema, bad);
    expectReject(ownerActionSchema, bad);
    expectReject(signedOwnerActionSchema, signed(bad));
  });

  it('params mixing contact.check and approval.decide keys are rejected under either op', () => {
    const mixed = { ...contactCheckAction().params, ...approvalDecideAction().params };
    rejects(edit(contactCheckAction(), ['params'], mixed));
    expectReject(ownerActionSchema, edit(approvalDecideAction(), ['params'], mixed));
  });

  it('the typed wrapper accepts only contact.check, and no other wrapper accepts it', () => {
    expectReject(signedContactCheckSchema, signed(approvalDecideAction()));
    expectReject(signedContactCheckSchema, signed(policySetAction()));
    expectReject(signedContactCheckSchema, signed(agentRevokeAction()));
    expectReject(signedPolicySetSchema, signed(contactCheckAction()));
    expectReject(signedApprovalOpSchema, signed(contactCheckAction()));
  });

  it.each(['contact.Check', 'Contact.check', 'contact.verify', 'contacts.check', 'contact.check '])(
    'rejects the op spelled %j',
    (op) => {
      rejects(edit(contactCheckAction(), ['op'], op));
    },
  );
});

describe('no envelope carries contact.check yet (04 §3.4.1 "Not yet carried", M2-2e)', () => {
  it('an approval or a policy envelope with a signed contact.check is rejected', () => {
    expectReject(payloadSchema, {
      ...payloads().approval,
      body: { signed: signed(contactCheckAction()) },
    });
    expectReject(payloadSchema, {
      ...payloads().policy,
      body: { signed: signed(contactCheckAction()) },
    });
  });
});

describe('SignedContactCheck', () => {
  it.each([
    ['uppercase sig', { ...signed(contactCheckAction()), sig: 'F6'.repeat(64) }],
    ['0x sig', { ...signed(contactCheckAction()), sig: `0x${'f6'.repeat(64)}` }],
    ['missing sig', { body: contactCheckAction() }],
    ['unknown key', { ...signed(contactCheckAction()), pubkey: 'x' }],
  ])('rejects %s', (_l, value) => {
    expectReject(signedContactCheckSchema, value);
    expectReject(signedOwnerActionSchema, value);
  });
});
