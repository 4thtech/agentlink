// OwnerAction / SignedOwnerAction (04 §2.5.1, G-29). Strict at every level; every non-canonical form
// named in the spec (checksummed or uppercase address, uppercase hex, padded base64url, out-of-range
// integer, unknown key) is rejected, never normalised.
import { describe, it } from 'vitest';
import {
  agentRevokeActionSchema,
  approvalCancelActionSchema,
  approvalDecideActionSchema,
  approvalDecideBatchActionSchema,
  contactCheckActionSchema,
  ownerActionSchema,
  policySetActionSchema,
  signedAgentRevokeSchema,
  signedApprovalDecideSchema,
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
  BIP340_SIG,
  contactCheckAction,
  DELETE,
  edit,
  ID16,
  policySetAction,
  signed,
} from './testing/fixtures.js';

const ALL = [
  ['approval.decide', approvalDecideAction, approvalDecideActionSchema],
  ['policy.set', policySetAction, policySetActionSchema],
  ['agent.revoke', agentRevokeAction, agentRevokeActionSchema],
  ['approval.cancel (D-55)', approvalCancelAction, approvalCancelActionSchema],
  ['approval.decideBatch (D-68)', approvalDecideBatchAction, approvalDecideBatchActionSchema],
  ['contact.check (G-28)', contactCheckAction, contactCheckActionSchema],
] as const;

describe('OwnerAction round trips', () => {
  it.each(ALL)('%s parses unchanged (op schema, union and signed wrapper)', (_op, make, schema) => {
    expectRoundTrip(schema, make());
    expectRoundTrip(ownerActionSchema, make());
    expectRoundTrip(signedOwnerActionSchema, signed(make()));
  });

  it('typed signed wrappers accept only their own op', () => {
    expectRoundTrip(signedApprovalDecideSchema, signed(approvalDecideAction()));
    expectRoundTrip(signedPolicySetSchema, signed(policySetAction()));
    expectRoundTrip(signedAgentRevokeSchema, signed(agentRevokeAction()));
    expectReject(signedApprovalDecideSchema, signed(policySetAction()));
    expectReject(signedPolicySetSchema, signed(agentRevokeAction()));
    expectReject(signedAgentRevokeSchema, signed(approvalDecideAction()));
  });

  it('accepts a deny decision and every revoke reason', () => {
    expectRoundTrip(
      ownerActionSchema,
      edit(approvalDecideAction(), ['params', 'decision'], 'deny'),
    );
    for (const reason of ['compromised', 'retired', 'other']) {
      expectRoundTrip(ownerActionSchema, edit(agentRevokeAction(), ['params', 'reason'], reason));
    }
  });
});

describe('OwnerAction rejects every non-canonical or malformed field', () => {
  const cases: [string, readonly (string | number)[], unknown][] = [
    ['v = 2', ['v'], 2],
    ['v as string', ['v'], '1'],
    ['missing v', ['v'], DELETE],
    ['checksummed agent address', ['agent'], '0x1A1a1A1a1A1a1A1a1A1a1A1a1A1a1A1a1A1a1A1a'],
    ['uppercase agent address', ['agent'], `0x${'1A'.repeat(20)}`],
    ['agent without 0x', ['agent'], '1a'.repeat(20)],
    ['agent of 19 bytes', ['agent'], `0x${'1a'.repeat(19)}`],
    ['uppercase owner hex', ['owner'], 'C3'.repeat(32)],
    ['0x-prefixed owner', ['owner'], `0x${'c3'.repeat(32)}`],
    ['owner of 31 bytes', ['owner'], 'c3'.repeat(31)],
    ['unknown op', ['op'], 'storage.add'],
    ['op with different case', ['op'], 'Approval.Decide'],
    ['padded nonce', ['nonce'], `${ID16}==`],
    ['nonce of 15 bytes', ['nonce'], b64u(15)],
    ['nonce of 32 bytes', ['nonce'], b64u(32)],
    ['nonce with non-zero trailing bits', ['nonce'], `${ID16.slice(0, -1)}B`],
    ['issuedAt = 2^53', ['issuedAt'], 2 ** 53],
    ['issuedAt negative', ['issuedAt'], -1],
    ['issuedAt fractional', ['issuedAt'], 1760000000.5],
    ['issuedAt as string', ['issuedAt'], '1760000000'],
    ['expiresAt = 2^53', ['expiresAt'], 2 ** 53],
    ['unknown top-level key', ['agentId'], 'local-1'],
    ['missing params', ['params'], DELETE],
    ['params null', ['params'], null],
  ];

  for (const [op, make, schema] of ALL) {
    describe(op, () => {
      it.each(cases)('rejects %s', (_l, path, value) => {
        const bad = edit(make(), path, value);
        expectReject(schema, bad);
        expectReject(ownerActionSchema, bad);
        expectReject(signedOwnerActionSchema, signed(bad));
      });
    });
  }

  it.each([
    ['approval.decide', approvalDecideAction],
    ['policy.set', policySetAction],
    ['approval.cancel', approvalCancelAction],
    ['approval.decideBatch', approvalDecideBatchAction],
    ['contact.check', contactCheckAction],
  ] as const)('%s requires a non-zero expiresAt after issuedAt', (_op, make) => {
    expectReject(ownerActionSchema, edit(make(), ['expiresAt'], 0));
    expectReject(ownerActionSchema, edit(make(), ['expiresAt'], 1760000000));
    expectReject(ownerActionSchema, edit(make(), ['expiresAt'], 1759999999));
  });

  it('agent.revoke requires expiresAt = 0 (04 §2.5.1: 0 for agent.revoke, and only for it)', () => {
    expectReject(ownerActionSchema, edit(agentRevokeAction(), ['expiresAt'], 1760000600));
  });

  it('rejects an op/params mismatch', () => {
    expectReject(
      ownerActionSchema,
      edit(approvalDecideAction(), ['params'], agentRevokeAction().params),
    );
    expectReject(ownerActionSchema, edit(agentRevokeAction(), ['op'], 'policy.set'));
  });
});

describe('params are strict per op', () => {
  it.each([
    ['unknown key', ['params', 'extra'], 1],
    ['missing approvalId', ['params', 'approvalId'], DELETE],
    ['approvalId without apr_', ['params', 'approvalId'], ID16],
    ['approvalId padded', ['params', 'approvalId'], `apr_${ID16}==`],
    ['uppercase actionDigest', ['params', 'actionDigest'], 'E5'.repeat(32)],
    ['0x actionDigest', ['params', 'actionDigest'], `0x${'e5'.repeat(32)}`],
    ['short actionDigest', ['params', 'actionDigest'], 'e5'.repeat(31)],
    ['decision maybe', ['params', 'decision'], 'maybe'],
    ['decision uppercase', ['params', 'decision'], 'Approve'],
  ] as const)('approval.decide rejects %s', (_l, path, value) => {
    expectReject(ownerActionSchema, edit(approvalDecideAction(), path, value));
  });

  it.each([
    ['unknown key', ['params', 'extra'], 1],
    ['missing version', ['params', 'version'], DELETE],
    ['version = 2^53', ['params', 'version'], 2 ** 53],
    ['version negative', ['params', 'version'], -1],
    ['version fractional', ['params', 'version'], 1.5],
    ['missing policy', ['params', 'policy'], DELETE],
    ['policy array', ['params', 'policy'], []],
    ['policy string', ['params', 'policy'], 'allow all'],
  ] as const)('policy.set rejects %s', (_l, path, value) => {
    expectReject(ownerActionSchema, edit(policySetAction(), path, value));
  });

  it.each([
    ['unknown key', ['params', 'actionDigest'], 'e5'.repeat(32)],
    ['missing approvalId', ['params', 'approvalId'], DELETE],
    ['approvalId without apr_', ['params', 'approvalId'], ID16],
    ['decision (cancel never approves)', ['params', 'decision'], 'approve'],
  ] as const)('approval.cancel rejects %s', (_l, path, value) => {
    expectReject(ownerActionSchema, edit(approvalCancelAction(), path, value));
  });

  it.each([
    ['unknown key', ['params', 'note'], 'x'],
    ['free-text reason', ['params', 'reason'], 'my laptop was stolen'],
    ['missing reason', ['params', 'reason'], DELETE],
  ] as const)('agent.revoke rejects %s', (_l, path, value) => {
    expectReject(ownerActionSchema, edit(agentRevokeAction(), path, value));
  });
});

describe('SignedOwnerAction', () => {
  it.each([
    ['uppercase sig', { body: approvalDecideAction(), sig: BIP340_SIG.toUpperCase() }],
    ['127-char sig', { body: approvalDecideAction(), sig: BIP340_SIG.slice(1) }],
    ['0x sig', { body: approvalDecideAction(), sig: `0x${BIP340_SIG}` }],
    ['base64url sig', { body: approvalDecideAction(), sig: b64u(64) }],
    ['missing sig', { body: approvalDecideAction() }],
    ['missing body', { sig: BIP340_SIG }],
    ['unknown key', { ...signed(approvalDecideAction()), pubkey: 'x' }],
    ['body as JSON text', { body: JSON.stringify(approvalDecideAction()), sig: BIP340_SIG }],
  ])('rejects %s', (_l, value) => {
    expectReject(signedOwnerActionSchema, value);
  });
});
