// The policy engine (07 §2; 06 §3; G-6). `evaluate(policy, action, context)` is pure: no clock, no
// store, no I/O, and it never changes its inputs, so every rule has a table test.
//
// Minimal for M1a (D-33): the contacts and envelopes rules, the `commitments` rule with its
// auto-accept limits (M1-20, commitments.ts), the key-disclosure rule and the automatic receipts.
// Until their cards land, the remaining rules fail toward the owner: a proof or a file send that the
// policy does not deny needs approval (M1-7i), never `allow`.
//
// G-6 (06 §3): the loaded policy is one of three modes. `defaults` only while no version was ever
// applied and no row exists; `signed` for a stored policy that verified on load; `fail_closed`
// otherwise. A fail-closed policy carries no document, so no decision value can be read from the
// defaults or from an invalid row: every paid action, commitment and owner-gated action needs
// approval, unknown senders are queued, no `contacts.allowed` list, contact rule or auto-accept
// applies (an unreadable deny becomes approval, never allow), and limits that grant nothing stay at
// the built-in hard caps of FAIL_CLOSED_LIMITS.
import { POLICY_DEFAULTS, type Policy } from '@agentlink/types';
import { evaluateCommitment, type CommitmentFacts } from './commitments.js';
import { CoreError } from './errors.js';

/** A policy document as the engine reads it (06 §3 JSON form). */
export type PolicyDocument = Policy | typeof POLICY_DEFAULTS;

/** Why a stored policy is not used (G-6). Fixed codes. */
export type PolicyProblem =
  | 'mark_unavailable'
  | 'missing'
  | 'unreadable'
  | 'invalid'
  | 'agent_mismatch'
  | 'owner_mismatch'
  | 'signature_invalid'
  | 'rolled_back'
  | 'mark_mismatch'
  | 'tampered'
  | 'identity_unavailable';

export type EffectivePolicy =
  | { readonly mode: 'defaults'; readonly policy: PolicyDocument }
  | { readonly mode: 'signed'; readonly policy: PolicyDocument; readonly version: number }
  | { readonly mode: 'fail_closed'; readonly problem: PolicyProblem };

export type PolicyDecision = 'allow' | 'approval' | 'deny';

/** What the core is about to do. Built by the core from verified data, never from inbound text. */
export type PolicyAction =
  /** `agentlink_accept_invite` (contacts.acceptInvites). */
  | { readonly kind: 'invite.accept' }
  /** An inbound envelope after its signature checks: from a paired contact or an unknown sender. */
  | {
      readonly kind: 'envelope.receive';
      readonly sender:
        { readonly kind: 'contact'; readonly contact: string } | { readonly kind: 'unknown' };
      readonly sizeBytes: number;
    }
  /** An outbound envelope to a paired contact. */
  | { readonly kind: 'envelope.send'; readonly contact: string; readonly sizeBytes: number }
  /** A commitment: its scope and stored terms, or a receipt without terms (04 §3.4.2, M1-20). */
  | { readonly kind: 'commitment'; readonly facts: CommitmentFacts }
  /** A paid proof action (the budget and contact rules are M1-7i). */
  | { readonly kind: 'proof' }
  /** Sending a local file (folders and storage are M1-7i, M1-7f). */
  | { readonly kind: 'file.send'; readonly sizeBytes: number }
  /** Disclosing a content key (proofs.allowKeyDisclosure). */
  | { readonly kind: 'key.disclose' }
  /** Signing a DELIVERED or OPENED receipt without being asked (receipts.*). */
  | { readonly kind: 'receipt.auto'; readonly receipt: 'delivered' | 'opened' };

/** Facts the core passes in, so `evaluate` stays pure. */
export interface PolicyContext {
  /**
   * Envelopes already accepted from this contact in the sliding hour (07 §3.2 rate_counters), not
   * counting this one. Required for `envelope.receive` from a contact.
   */
  readonly contactEnvelopesLastHour?: number;
}

/** The defaults (06 §3), only while no policy version was ever applied and no row exists (G-6). */
export const POLICY_DEFAULTS_EFFECTIVE: EffectivePolicy = Object.freeze({
  mode: 'defaults',
  policy: POLICY_DEFAULTS,
});

/** The limits that grant nothing, as the engine and the core apply them (06 §3). */
export interface PolicyLimits {
  readonly maxEnvelopeBytes: number;
  readonly maxSendBytes: number;
  readonly maxReceiveBytes: number;
  readonly rateLimitPerContactPerHour: number;
  readonly defaultExpiryDays: number;
  readonly deleteAfter: 'expiry' | 'receipt';
  readonly allowedFolders: readonly string[];
  readonly autoDelivered: boolean;
  readonly autoOpened: boolean;
}

const KB = 1024;
const MB = 1024 * 1024;

/**
 * The hard caps under G-6 fail closed (06 §3): the built-in values of the 06 §3 listing, written out
 * here so the fail-closed path never reads the defaults document. No folder, no automatic receipt.
 */
export const FAIL_CLOSED_LIMITS: PolicyLimits = Object.freeze({
  maxEnvelopeBytes: 24 * KB,
  maxSendBytes: 100 * MB,
  maxReceiveBytes: 200 * MB,
  rateLimitPerContactPerHour: 120,
  defaultExpiryDays: 7,
  deleteAfter: 'expiry',
  allowedFolders: Object.freeze([]) as readonly string[],
  autoDelivered: false,
  autoOpened: false,
});

/** The limits of a loaded policy: its own when verified or defaults, the hard caps otherwise. */
export function policyLimits(effective: EffectivePolicy): PolicyLimits {
  if (effective.mode === 'fail_closed') return FAIL_CLOSED_LIMITS;
  const p = effective.policy;
  return {
    maxEnvelopeBytes: p.envelopes.maxEnvelopeKB * KB,
    maxSendBytes: p.files.maxSendSizeMB * MB,
    maxReceiveBytes: p.files.maxReceiveSizeMB * MB,
    rateLimitPerContactPerHour: p.contacts.rateLimitPerContactPerHour,
    defaultExpiryDays: p.files.defaultExpiryDays,
    deleteAfter: p.files.deleteAfter,
    allowedFolders: p.files.allowedFolders,
    autoDelivered: p.receipts.autoDelivered,
    autoOpened: p.receipts.autoOpened,
  };
}

function hourlyCount(context: PolicyContext | undefined): number {
  const n = context?.contactEnvelopesLastHour;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
    throw new CoreError(
      'policy_context_invalid',
      'The policy check needs the hourly envelope count for this contact.',
    );
  }
  return n;
}

/** `contacts.allowed`: "paired", or a sorted list of agent IDs (06 §3). */
function isAllowedContact(policy: PolicyDocument, contact: string): boolean {
  const allowed = policy.contacts.allowed;
  return allowed === 'paired' || (allowed as readonly string[]).includes(contact);
}

/**
 * What a paired contact's envelope gets while the policy fails closed (06 §3, G-6; D-70, decided by
 * the owner on 2026-10-15, IR-M1-7d-1 F-1): `contacts.allowed` reads as "paired", so a paired
 * contact may Talk (receive and send) without approval, within the hard caps. Residual: a narrower
 * `allowed` list is not honoured while the policy is invalid. Commitments, paid actions and
 * owner-gated actions still need approval, and unknown senders are still queued.
 */
export const FAIL_CLOSED_CONTACTS = 'paired' as 'strict' | 'paired';

/** A paired contact's envelope while the policy fails closed (see FAIL_CLOSED_CONTACTS). */
const failClosedContact = (): PolicyDecision =>
  FAIL_CLOSED_CONTACTS === 'paired' ? 'allow' : 'approval';

const unknownSender = (policy: PolicyDocument): PolicyDecision =>
  policy.contacts.unknownSenders === 'drop' ? 'deny' : 'approval';

/**
 * allow | approval | deny for one action. Pure and deterministic. Throws only when a required
 * context fact is missing (`policy_context_invalid`), never guesses one.
 */
export function evaluate(
  effective: EffectivePolicy,
  action: PolicyAction,
  context?: PolicyContext,
): PolicyDecision {
  const limits = policyLimits(effective);
  const policy = effective.mode === 'fail_closed' ? undefined : effective.policy;

  switch (action.kind) {
    case 'invite.accept':
      return policy?.contacts.acceptInvites === 'auto' ? 'allow' : 'approval';

    case 'envelope.receive': {
      if (action.sizeBytes > limits.maxEnvelopeBytes) return 'deny';
      if (action.sender.kind === 'unknown') {
        // Fail closed: queued for the owner, never dropped (06 §3).
        return policy === undefined ? 'approval' : unknownSender(policy);
      }
      const count = hourlyCount(context);
      // The Nth envelope of the hour passes; the N + 1th is dropped (07 §3.2, decided at #44).
      if (count >= limits.rateLimitPerContactPerHour) return 'deny';
      if (policy === undefined) return failClosedContact();
      return isAllowedContact(policy, action.sender.contact) ? 'allow' : unknownSender(policy);
    }

    case 'envelope.send':
      if (action.sizeBytes > limits.maxEnvelopeBytes) return 'deny';
      if (policy === undefined) return failClosedContact();
      return isAllowedContact(policy, action.contact) ? 'allow' : 'deny';

    case 'commitment':
      // The rule and its grant are evaluateCommitment (commitments.ts); this is its decision.
      return evaluateCommitment(effective, action.facts).decision;

    case 'proof':
      // A global deny always wins (06 §3 step 1); the allow paths are M1-7i.
      return policy?.proofs.notarize === 'deny' ? 'deny' : 'approval';

    case 'file.send':
      if (action.sizeBytes > limits.maxSendBytes) return 'deny';
      return 'approval';

    case 'key.disclose':
      return policy?.proofs.allowKeyDisclosure === 'deny' ? 'deny' : 'approval';

    case 'receipt.auto': {
      const on = action.receipt === 'delivered' ? limits.autoDelivered : limits.autoOpened;
      return on ? 'allow' : 'deny';
    }
  }
}
