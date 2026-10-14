// OwnerAction / SignedOwnerAction (04 §2.5.1, decided D-58). Strict at every level (SignedOwnerAction,
// OwnerAction, params): unknown keys are rejected, and every field must already be in its canonical
// encoding. Signing and verification live in @agentlink/crypto and the core; this file fixes the shape.
//
// What a schema cannot see: duplicate keys and textual number forms (`1.0`, `1e3`) in the JSON text
// are gone after JSON.parse. Parsing the wire bytes strictly (I-JSON) is the caller's job.
import { z } from 'zod';
import {
  APPROVAL_BATCH_MAX_ITEMS,
  APPROVAL_BATCH_MIN_ITEMS,
  APPROVAL_DECISIONS,
  BYTE_LENGTHS,
  PROTOCOL_VERSION,
  REVOKE_REASONS,
} from './constants.js';
import {
  approvalIdSchema,
  base64url,
  bip340SigHex,
  evmAddress,
  isStrictlyAscending,
  nostrPubkeyHex,
  sha256Hex,
  uint53,
} from './encoding.js';
import { policySchema } from './policy.js';

// --- params per op -------------------------------------------------------------------------------

export const approvalDecideParamsSchema = z.strictObject({
  approvalId: approvalIdSchema,
  actionDigest: sha256Hex,
  decision: z.enum(APPROVAL_DECISIONS),
});

/**
 * `approval.decideBatch` params (04 §2.5.1, §2.5.2; D-68): 2 to 20 items, each exactly the strict
 * `approval.decide` params, in strictly ascending `approvalId` order compared as byte strings (so a
 * batch has one encoding and no duplicates). Anything else is rejected, never sorted or deduplicated.
 * An `approvalId` that passes its schema is ASCII (`apr_` + base64url), so code-unit order is byte
 * order. That the expiry is within every item's pending request is the core's check (M1-7d).
 */
export const approvalDecideBatchParamsSchema = z.strictObject({
  items: z
    .array(approvalDecideParamsSchema)
    .min(APPROVAL_BATCH_MIN_ITEMS)
    .max(APPROVAL_BATCH_MAX_ITEMS)
    .refine(
      // Defensive: Zod may run this check on items that already failed their own schema.
      (items) =>
        isStrictlyAscending(
          items.map((item: unknown) =>
            item !== null && typeof item === 'object'
              ? (item as { approvalId?: unknown }).approvalId
              : undefined,
          ),
        ),
      'items must be in strictly ascending approvalId byte order, with no duplicates',
    ),
});

/** `approval.cancel` (D-55): voids unused parts of an approved commitment scope; it never approves. */
export const approvalCancelParamsSchema = z.strictObject({
  approvalId: approvalIdSchema,
});

/**
 * `policy.set` params: `policy` is the complete 06 §3 document in the strict policy JSON form
 * (policy.ts, G-32), never a partial patch. `version` ordering is the core's (04 §2.5.1).
 */
export const policySetParamsSchema = z.strictObject({
  version: uint53,
  policy: policySchema,
});

export const agentRevokeParamsSchema = z.strictObject({
  reason: z.enum(REVOKE_REASONS),
});

/**
 * `contact.check` params (04 §2.5.1, §3.6.1; G-28): the owner compared the safety code. `contact` is
 * the contact's agent ID (`0x` + 40 lowercase hex) and `pairingDigest` the transcript digest of its
 * current pairing (bare hex, 64 lowercase), each in its one encoding (04 §2.4.1); any other spelling
 * or key is rejected, never normalised. Matching both against a completed pairing, recomputed from
 * the signed `handshake` and `handshake-ack` on every load, is the core's (M1-7c).
 */
export const contactCheckParamsSchema = z.strictObject({
  contact: evmAddress,
  pairingDigest: sha256Hex,
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

/** One owner signature over exactly the items the owner reviewed (04 §2.5.2). */
export const approvalDecideBatchActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('approval.decideBatch'),
    params: approvalDecideBatchParamsSchema,
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

/** "Safety code checked" for one contact and one pairing (04 §2.5.1). No envelope carries it yet (M2-2e). */
export const contactCheckActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('contact.check'),
    params: contactCheckParamsSchema,
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

/**
 * Discriminated by `op`: each op has its own strict `params`, so an `approval.decide` body with batch
 * params, or a batch body with single-decision params, matches no member (04 §2.5.2).
 */
export const ownerActionSchema = z.discriminatedUnion('op', [
  approvalDecideActionSchema,
  approvalDecideBatchActionSchema,
  approvalCancelActionSchema,
  policySetActionSchema,
  contactCheckActionSchema,
  agentRevokeActionSchema,
]);

// --- SignedOwnerAction ---------------------------------------------------------------------------

const signedOf = <T extends z.ZodType>(body: T) => z.strictObject({ body, sig: bip340SigHex });

export const signedOwnerActionSchema = signedOf(ownerActionSchema);
export const signedApprovalDecideSchema = signedOf(approvalDecideActionSchema);
export const signedApprovalDecideBatchSchema = signedOf(approvalDecideBatchActionSchema);
export const signedApprovalCancelSchema = signedOf(approvalCancelActionSchema);
export const signedPolicySetSchema = signedOf(policySetActionSchema);
export const signedAgentRevokeSchema = signedOf(agentRevokeActionSchema);
/** What `contacts.safety_check` stores (07 §3), re-verified on every load (04 §2.5.1, §3.6.1). */
export const signedContactCheckSchema = signedOf(contactCheckActionSchema);
/**
 * What an `approval` envelope carries: `approval.decide`, `approval.decideBatch` or `approval.cancel`
 * (04 §3.4.1; D-55, D-68). Any other op is dropped.
 */
export const signedApprovalOpSchema = signedOf(
  z.discriminatedUnion('op', [
    approvalDecideActionSchema,
    approvalDecideBatchActionSchema,
    approvalCancelActionSchema,
  ]),
);

export type ApprovalDecideParams = z.infer<typeof approvalDecideParamsSchema>;
export type ApprovalDecideBatchParams = z.infer<typeof approvalDecideBatchParamsSchema>;
export type ApprovalCancelParams = z.infer<typeof approvalCancelParamsSchema>;
export type PolicySetParams = z.infer<typeof policySetParamsSchema>;
export type AgentRevokeParams = z.infer<typeof agentRevokeParamsSchema>;
export type ContactCheckParams = z.infer<typeof contactCheckParamsSchema>;
export type ApprovalDecideAction = z.infer<typeof approvalDecideActionSchema>;
export type ApprovalDecideBatchAction = z.infer<typeof approvalDecideBatchActionSchema>;
export type ApprovalCancelAction = z.infer<typeof approvalCancelActionSchema>;
export type PolicySetAction = z.infer<typeof policySetActionSchema>;
export type AgentRevokeAction = z.infer<typeof agentRevokeActionSchema>;
export type ContactCheckAction = z.infer<typeof contactCheckActionSchema>;
export type OwnerAction = z.infer<typeof ownerActionSchema>;
export type SignedOwnerAction = z.infer<typeof signedOwnerActionSchema>;
export type SignedApprovalDecide = z.infer<typeof signedApprovalDecideSchema>;
export type SignedApprovalDecideBatch = z.infer<typeof signedApprovalDecideBatchSchema>;
export type SignedApprovalCancel = z.infer<typeof signedApprovalCancelSchema>;
export type SignedPolicySet = z.infer<typeof signedPolicySetSchema>;
export type SignedAgentRevoke = z.infer<typeof signedAgentRevokeSchema>;
export type SignedContactCheck = z.infer<typeof signedContactCheckSchema>;
export type SignedApprovalOp = z.infer<typeof signedApprovalOpSchema>;
