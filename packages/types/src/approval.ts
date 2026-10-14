// Approvals: the per-tool `approval-request.action` (04 §3.4.1) and the commitment scope (04 §3.4.2).
//
// `action` = `{tool, args, context}` and `actionDigest = sha256(JCS(action))` (M1-7e), which the
// owner's `approval.decide` signs. `args` is the tool input (free JSON here; the MCP layer owns the
// tool input schemas). `context` holds the facts the core bound when it evaluated policy. Its
// fields per tool are fixed here (PROPOSED in M1-2b; the spec names only examples: the contact's
// agent address, a file's `plaintextSha256`, the fee `{token, amount, usd}` and, for commitments,
// `scope` and `terms`). Every context is strict, so the digest covers exactly these facts.
//
// I-4: these are shapes the core produces and the owner's surfaces read. Nothing here lets an MCP
// tool create, decide or widen an approval: no context carries a decision or a signature.
import { z } from 'zod';
import {
  BYTE_LENGTHS,
  COMMITMENT_SCOPE_MAX_LIFETIME_SECONDS,
  PROTOCOL_VERSION,
  type ApprovalToolName,
} from './constants.js';
import {
  base64url,
  bytes32Hex,
  evmAddress,
  isStrictlyAscending,
  jsonObjectSchema,
  nostrPubkeyHex,
  sha256Hex,
  uint256Decimal,
  uint53,
} from './encoding.js';
import { compareUsd, isUsdAmount, usdAmountSchema } from './usd.js';

const freeze = <T>(value: T): Readonly<T> => Object.freeze(value);

// --- CommitmentScope v1 (04 §3.4.2) --------------------------------------------------------------

/** The other agent and its owner key, as the core holds them (04 §3.4.2 `counterparty`). */
export const counterpartySchema = z.strictObject({
  agentId: evmAddress,
  ownerKey: nostrPubkeyHex,
});

/** The counterparty envelope a scope answers. `envelopeHash` is EVM-native, so `0x` (04 §2.4.1). */
export const commitmentAnswersSchema = z.strictObject({
  envelopeId: base64url(BYTE_LENGTHS.id),
  envelopeHash: bytes32Hex,
});

/** `confirm` = ACCEPTED on their ACCEPT record; `offer` = a firm offer (04 §3.4.2). */
export const COMMITMENT_DECISIONS = freeze(['accept', 'reject', 'confirm', 'offer'] as const);
export type CommitmentDecision = (typeof COMMITMENT_DECISIONS)[number];

export const COMMITMENT_SCOPE_KIND = 'agentlink/commitment';

/**
 * CommitmentScope v1. Static rules (no clock): a firm offer answers nothing and is always
 * notarized, every other decision answers one envelope; nothing is paid without notarize; the
 * scope ends after it starts and lasts at most 7 days; the counterparty is another agent.
 */
export const commitmentScopeSchema = z
  .strictObject({
    v: z.literal(PROTOCOL_VERSION),
    kind: z.literal(COMMITMENT_SCOPE_KIND),
    agentId: evmAddress,
    decision: z.enum(COMMITMENT_DECISIONS),
    counterparty: counterpartySchema,
    thread: base64url(BYTE_LENGTHS.thread),
    termsId: base64url(16),
    version: uint53.refine((n) => n >= 1, 'version starts at 1'),
    termsHash: sha256Hex,
    answers: commitmentAnswersSchema.nullable(),
    notarize: z.boolean(),
    maxFeeUsd: usdAmountSchema.nullable(),
    createdAt: uint53,
    expiresAt: uint53,
  })
  .superRefine((s, ctx) => {
    const issue = (message: string, path: string[]) =>
      ctx.addIssue({ code: 'custom', message, path });
    if ((s.answers === null) !== (s.decision === 'offer')) {
      issue('answers is null exactly for a firm offer (decision "offer")', ['answers']);
    }
    if (s.decision === 'offer' && s.notarize !== true) {
      issue('a firm offer is always notarized', ['notarize']);
    }
    if (s.notarize === false && s.maxFeeUsd !== null) {
      issue('maxFeeUsd must be null when nothing is notarized', ['maxFeeUsd']);
    }
    if (!(s.expiresAt > s.createdAt)) {
      issue('expiresAt must be after createdAt', ['expiresAt']);
    } else if (s.expiresAt - s.createdAt > COMMITMENT_SCOPE_MAX_LIFETIME_SECONDS) {
      issue('a commitment scope lasts at most 7 days', ['expiresAt']);
    }
    if (s.counterparty?.agentId === s.agentId) {
      issue('the counterparty must be another agent', ['counterparty', 'agentId']);
    }
  });

// --- fees and triggers ---------------------------------------------------------------------------

/**
 * The fee a paid action binds: `token` and `amount` are the Record's `feeToken` and `maxFee`
 * (04 §2.4.1: a tool or context value uses the row of the protocol path it mirrors), `usd` the same
 * fee in USD (1:1 for stablecoins, D-46) as policy evaluated it.
 */
export const approvalFeeSchema = z.strictObject({
  token: evmAddress,
  amount: uint256Decimal,
  usd: usdAmountSchema,
});

/** The proof rules (06 §3 steps 2–4) that can make a paid action wait for the owner. */
export const PROOF_TRIGGERS = freeze([
  'proofs.dailyBudgetUSD',
  'proofs.notarize',
  'proofs.perActionMaxUSD',
] as const);

/**
 * Which policy rules asked for this approval, as policy key paths. The owner's surface needs them:
 * "Remember for this contact" is offered only when the only triggers are `proofs.notarize` and/or
 * `proofs.perActionMaxUSD` (06 §3), and the daily budget is known only to the agent's core.
 */
export const APPROVAL_TRIGGERS = freeze([
  'commitments.accept',
  'contacts.acceptInvites',
  'proofs.allowKeyDisclosure',
  ...PROOF_TRIGGERS,
] as const);
export type ApprovalTrigger = (typeof APPROVAL_TRIGGERS)[number];

/** A non-empty, sorted, duplicate-free list of the triggers a tool can have. */
const triggersOf = <T extends readonly [ApprovalTrigger, ...ApprovalTrigger[]]>(allowed: T) =>
  z
    .array(z.enum(allowed))
    .min(1)
    .max(allowed.length)
    .refine(isStrictlyAscending, 'triggers must be sorted and unique');

const COMMITMENT_TRIGGERS = ['commitments.accept', ...PROOF_TRIGGERS] as const;
const isProofTrigger = (t: unknown) => (PROOF_TRIGGERS as readonly unknown[]).includes(t);

// --- per-tool contexts ---------------------------------------------------------------------------

/** `agentlink_accept_invite` (policy `contacts.acceptInvites`): the invite and the inviter. */
const acceptInviteContext = z.strictObject({
  triggers: triggersOf(['contacts.acceptInvites']),
  inviteId: base64url(BYTE_LENGTHS.inviteId),
  counterparty: counterpartySchema,
});

/**
 * `agentlink_send` with `notarize` (policy `proofs.*`): the recipient, the attached file (its
 * realpath is in `args.path`; the core re-hashes the file when the approved action runs, 06 §2.5)
 * and the fee.
 */
const sendContext = z.strictObject({
  triggers: triggersOf(PROOF_TRIGGERS),
  counterparty: counterpartySchema,
  file: z.strictObject({ plaintextSha256: sha256Hex, size: uint53 }).nullable(),
  fee: approvalFeeSchema,
});

/** `agentlink_notarize` (policy `proofs.*`): the envelope recorded, its other agent and the fee. */
const notarizeContext = z.strictObject({
  triggers: triggersOf(PROOF_TRIGGERS),
  /** The other agent of the envelope; null for a note to self (no counterparty, no contact rule). */
  counterparty: counterpartySchema.nullable(),
  envelopeHash: bytes32Hex,
  fee: approvalFeeSchema,
});

/** `agentlink_acknowledge` `accepted` / `rejected` on a record without terms (`commitments.accept`). */
const acknowledgeContext = z.strictObject({
  triggers: triggersOf(['commitments.accept']),
  counterparty: counterpartySchema,
  recordId: bytes32Hex,
  receipt: z.enum(['ACCEPTED', 'REJECTED']),
});

/** `agentlink_export_proof_pack` with the content key (`proofs.allowKeyDisclosure`). */
const exportProofPackContext = z.strictObject({
  triggers: triggersOf(['proofs.allowKeyDisclosure']),
  recordId: bytes32Hex,
  envelopeHash: bytes32Hex,
});

/**
 * The terms tools: the commitment scope, the stored canonical terms it is bound to (strict schema
 * from M1-21) and the fee. Fee rules: a fee exists exactly when the scope caps one, it is within
 * that cap, and a proof trigger always comes with a fee.
 */
const commitmentContext = (decisions: readonly CommitmentDecision[]) =>
  z
    .strictObject({
      triggers: triggersOf(COMMITMENT_TRIGGERS),
      scope: commitmentScopeSchema.refine(
        (s) => decisions.includes(s.decision),
        `scope.decision must be one of: ${decisions.join(', ')}`,
      ),
      terms: jsonObjectSchema,
      fee: approvalFeeSchema.nullable(),
    })
    .superRefine((c, ctx) => {
      const issue = (message: string, path: string[]) =>
        ctx.addIssue({ code: 'custom', message, path });
      const cap = c.scope?.maxFeeUsd;
      if ((c.fee === null) !== (cap === null)) {
        issue('fee is present exactly when scope.maxFeeUsd is set', ['fee']);
      } else if (c.fee !== null && isUsdAmount(c.fee?.usd) && isUsdAmount(cap)) {
        if (compareUsd(c.fee.usd, cap) > 0)
          issue('fee.usd is above scope.maxFeeUsd', ['fee', 'usd']);
      }
      if (c.fee === null && Array.isArray(c.triggers) && c.triggers.some(isProofTrigger)) {
        issue('a proof trigger needs the fee it evaluated', ['fee']);
      }
    });

const actionOf = <T extends ApprovalToolName, C extends z.ZodType>(tool: T, context: C) =>
  z.strictObject({ tool: z.literal(tool), args: jsonObjectSchema, context });

// `satisfies`: exactly one action per tool of the 06 §2.0 "Approval" column (APPROVAL_TOOL_NAMES).
const ACTIONS = {
  agentlink_accept_invite: actionOf('agentlink_accept_invite', acceptInviteContext),
  agentlink_send: actionOf('agentlink_send', sendContext),
  agentlink_propose_terms: actionOf('agentlink_propose_terms', commitmentContext(['offer'])),
  agentlink_respond_to_terms: actionOf(
    'agentlink_respond_to_terms',
    commitmentContext(['accept', 'reject', 'confirm']),
  ),
  agentlink_notarize: actionOf('agentlink_notarize', notarizeContext),
  agentlink_acknowledge: actionOf('agentlink_acknowledge', acknowledgeContext),
  agentlink_export_proof_pack: actionOf('agentlink_export_proof_pack', exportProofPackContext),
} as const satisfies Record<ApprovalToolName, z.ZodType>;

/** `approval-request.action`: one strict context per approval tool (06 §2.0 "Approval" column). */
export const approvalActionSchema = z.discriminatedUnion('tool', [
  ACTIONS.agentlink_accept_invite,
  ACTIONS.agentlink_send,
  ACTIONS.agentlink_propose_terms,
  ACTIONS.agentlink_respond_to_terms,
  ACTIONS.agentlink_notarize,
  ACTIONS.agentlink_acknowledge,
  ACTIONS.agentlink_export_proof_pack,
]);

/**
 * A commitment's action: the terms tools, whose context carries `scope` and `terms`. Only this kind
 * of action may appear in a proof pack (07 §8; 04 §3.4: other actions' `args` can hold local paths
 * and message text).
 */
export const commitmentApprovalActionSchema = z.discriminatedUnion('tool', [
  ACTIONS.agentlink_propose_terms,
  ACTIONS.agentlink_respond_to_terms,
]);

/** The commitment scope of an action, if it has one (a defensive read of unvalidated data). */
export function commitmentScopeOf(
  action: unknown,
): { agentId?: unknown; expiresAt?: unknown } | undefined {
  if (action === null || typeof action !== 'object') return undefined;
  const context = (action as { context?: unknown }).context;
  if (context === null || typeof context !== 'object') return undefined;
  const scope = (context as { scope?: unknown }).scope;
  if (scope === null || typeof scope !== 'object') return undefined;
  return scope as { agentId?: unknown; expiresAt?: unknown };
}

export type Counterparty = z.infer<typeof counterpartySchema>;
export type CommitmentAnswers = z.infer<typeof commitmentAnswersSchema>;
export type CommitmentScope = z.infer<typeof commitmentScopeSchema>;
export type ApprovalFee = z.infer<typeof approvalFeeSchema>;
export type ApprovalAction = z.infer<typeof approvalActionSchema>;
export type CommitmentApprovalAction = z.infer<typeof commitmentApprovalActionSchema>;
