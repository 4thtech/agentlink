// OwnerAction / SignedOwnerAction (04 §2.5.1, decided D-58). Strict at every level (SignedOwnerAction,
// OwnerAction, params): unknown keys are rejected, and every field must already be in its canonical
// encoding. Signing and verification live in @agentlink/crypto and the core; this file fixes the shape.
//
// What a schema cannot see: duplicate keys and textual number forms (`1.0`, `1e3`) in the JSON text
// are gone after JSON.parse. Parsing the wire bytes strictly (I-JSON) is the caller's job.
import { z } from 'zod';
import { APPROVAL_DECISIONS, BYTE_LENGTHS, PROTOCOL_VERSION, REVOKE_REASONS } from './constants.js';
import {
  approvalIdSchema,
  base64url,
  bip340SigHex,
  evmAddress,
  jsonObjectSchema,
  nostrPubkeyHex,
  sha256Hex,
  uint53,
} from './encoding.js';

// --- params per op -------------------------------------------------------------------------------

export const approvalDecideParamsSchema = z.strictObject({
  approvalId: approvalIdSchema,
  actionDigest: sha256Hex,
  decision: z.enum(APPROVAL_DECISIONS),
});

/** `approval.cancel` (D-55): voids unused parts of an approved commitment scope; it never approves. */
export const approvalCancelParamsSchema = z.strictObject({
  approvalId: approvalIdSchema,
});

/**
 * `policy.set` params. `policy` is the complete 06 §3 document; its schema plugs in from M1-2b. Until
 * then it is a bounded JSON object, so this schema fixes only the envelope of the params.
 */
export const policySetParamsSchema = z.strictObject({
  version: uint53,
  policy: jsonObjectSchema,
});

export const agentRevokeParamsSchema = z.strictObject({
  reason: z.enum(REVOKE_REASONS),
});

// --- OwnerAction ---------------------------------------------------------------------------------

const head = {
  v: z.literal(PROTOCOL_VERSION),
  agent: evmAddress,
  owner: nostrPubkeyHex,
};
const tail = {
  nonce: base64url(BYTE_LENGTHS.nonce),
  issuedAt: uint53,
  expiresAt: uint53,
};

/** Every op but `agent.revoke` expires, after it was issued (04 §2.5.1). Lifetimes are G-7, in the core. */
const expiring = (a: { issuedAt: number; expiresAt: number }) =>
  a.expiresAt !== 0 && a.expiresAt > a.issuedAt;
const EXPIRING_MSG = {
  message: 'expiresAt must be non-zero and after issuedAt (0 is allowed only for agent.revoke)',
  path: ['expiresAt'],
};

export const approvalDecideActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('approval.decide'),
    params: approvalDecideParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG);

export const approvalCancelActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('approval.cancel'),
    params: approvalCancelParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG);

export const policySetActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('policy.set'),
    params: policySetParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG);

/** `agent.revoke`: `expiresAt` is exactly 0 (permanent; the core skips expiry and lifetime checks). */
export const agentRevokeActionSchema = z.strictObject({
  ...head,
  op: z.literal('agent.revoke'),
  params: agentRevokeParamsSchema,
  ...tail,
  expiresAt: z.literal(0),
});

export const ownerActionSchema = z.discriminatedUnion('op', [
  approvalDecideActionSchema,
  approvalCancelActionSchema,
  policySetActionSchema,
  agentRevokeActionSchema,
]);

// --- SignedOwnerAction ---------------------------------------------------------------------------

const signedOf = <T extends z.ZodType>(body: T) => z.strictObject({ body, sig: bip340SigHex });

export const signedOwnerActionSchema = signedOf(ownerActionSchema);
export const signedApprovalDecideSchema = signedOf(approvalDecideActionSchema);
export const signedApprovalCancelSchema = signedOf(approvalCancelActionSchema);
export const signedPolicySetSchema = signedOf(policySetActionSchema);
export const signedAgentRevokeSchema = signedOf(agentRevokeActionSchema);
/** What an `approval` envelope carries: `approval.decide` or `approval.cancel` (04 §3.4.1, D-55). */
export const signedApprovalOpSchema = signedOf(
  z.discriminatedUnion('op', [approvalDecideActionSchema, approvalCancelActionSchema]),
);

export type ApprovalDecideParams = z.infer<typeof approvalDecideParamsSchema>;
export type ApprovalCancelParams = z.infer<typeof approvalCancelParamsSchema>;
export type PolicySetParams = z.infer<typeof policySetParamsSchema>;
export type AgentRevokeParams = z.infer<typeof agentRevokeParamsSchema>;
export type ApprovalDecideAction = z.infer<typeof approvalDecideActionSchema>;
export type ApprovalCancelAction = z.infer<typeof approvalCancelActionSchema>;
export type PolicySetAction = z.infer<typeof policySetActionSchema>;
export type AgentRevokeAction = z.infer<typeof agentRevokeActionSchema>;
export type OwnerAction = z.infer<typeof ownerActionSchema>;
export type SignedOwnerAction = z.infer<typeof signedOwnerActionSchema>;
export type SignedApprovalDecide = z.infer<typeof signedApprovalDecideSchema>;
export type SignedApprovalCancel = z.infer<typeof signedApprovalCancelSchema>;
export type SignedPolicySet = z.infer<typeof signedPolicySetSchema>;
export type SignedAgentRevoke = z.infer<typeof signedAgentRevokeSchema>;
export type SignedApprovalOp = z.infer<typeof signedApprovalOpSchema>;
