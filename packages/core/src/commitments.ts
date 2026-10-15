// The commitments policy (M1-20; D-31, D-55, D-68; 06 §3 "Commitments"; 04 §2.5, §3.4, §3.4.2).
//
// A binding `accept`, a `confirm` (ACCEPTED on the counterparty's ACCEPT record), a `REJECTED`
// receipt and a firm offer are commitments under `commitments.accept` (default `approval`). One
// decision covers one commitment scope, which the core builds from its own store (M1-32); this
// module is the pure rule over that scope and its stored terms. Everything here is pure: no clock,
// no store, no I/O, inputs never changed, and garbage never throws.
//
// Rules:
// - `deny` blocks every commitment. A fail-closed policy (G-6) asks the owner for every commitment:
//   it never allows, and an unreadable deny becomes approval.
// - `allow` allows, as a policy grant with the policy document's hash.
// - Under `approval`, auto-accept applies only when every condition of 04 §3.4.2 holds: the
//   decision is `accept` or `confirm` (never `reject`, never a firm offer); the counterparty is in
//   `autoAcceptContacts`; `price` is not null, its currency is in the USD set (04 §3.4, D-74) and its
//   amount a strict positive decimal; and the direction the owner chose holds (`buy`: we pay at
//   most `autoAcceptMaxUSD` and the contact delivers everything; `sell`: the contact pays at least
//   `autoAcceptMinUSD`, which is set, and we deliver everything). Anything else asks the owner.
// - Only the stored terms the scope binds are evaluated (I-5, D-55): both are re-validated with the
//   strict schemas and the scope's `termsHash` must be the terms' own. A scope or terms that do not
//   check out are `void` (APPROVAL_VOID) under every policy: never allowed, never an owner request.
// - A late accept of one of our own superseded versions always asks, even under `allow`, so the
//   owner sees the warning (04 §3.4.2 "Counter-offers and late accepts"; IR-M1-20-1 F01).
// - A grant is a ledger row, never authority: before each part the core re-runs the rule on the
//   verified policy and requires the same policy hash (recheckCommitmentGrant).
import { verifyTermsHash } from '@agentlink/crypto';
import {
  compareDecimalWithUsd,
  commitmentScopeSchema,
  termsSchema,
  type CommitmentDecision,
  type CommitmentScope,
  type Terms,
} from '@agentlink/types';
import { computeActionDigest } from './owner-action.js';
import type { EffectivePolicy, PolicyDocument } from './policy-engine.js';

/**
 * The currencies auto-accept may compare with a USD limit (04 §3.4 "USD set", IR-D-74-1 F05): `USD`
 * and the D-46 fee-token symbols, all USD-pegged (12 §3.1). Listed explicitly, so a new token symbol
 * in the terms grammar never joins the set without a spec change here.
 */
export const AUTO_ACCEPT_USD_CURRENCIES: readonly string[] = Object.freeze([
  'USD',
  'USDC',
  'USDT',
  'XDAI',
]);

/** What the rule evaluates. Built by the core from its own store, never from inbound text. */
export type CommitmentFacts =
  /** A terms commitment: the scope (04 §3.4.2) and the stored canonical terms it binds. */
  | {
      readonly kind: 'terms';
      /** This agent's ID, from the core's identity (never from the scope). */
      readonly self: string;
      readonly scope: unknown;
      readonly terms: unknown;
      /**
       * From the core's store (M1-32): the answered version is one of this agent's own offers and a
       * newer own version exists (04 §3.4.2 "Counter-offers and late accepts"). Then the owner must
       * see the late-accept warning, so the commitment always asks (IR-M1-20-1 F01).
       */
      readonly supersededByOwnNewer: boolean;
    }
  /** `agentlink_acknowledge` `accepted` / `rejected` on a record without terms (06 §2.4). */
  | { readonly kind: 'acknowledge'; readonly receipt: 'ACCEPTED' | 'REJECTED' };

/** Why auto-accept did not apply. Fixed codes, for the approval card's note (11 §8). */
export type AutoAcceptMiss =
  /** The stored policy is not valid (G-6): nothing is auto-accepted. */
  | 'policy_invalid'
  /** A receipt on a record without terms: there is nothing to compare. */
  | 'not_terms'
  /** A `REJECTED` receipt: never covered by the limits. */
  | 'reject'
  /** A firm offer: never covered by the limits. */
  | 'firm_offer'
  /** A newer own version exists: the owner sees the late-accept warning (IR-M1-20-1 F01). */
  | 'superseded'
  | 'contact_not_listed'
  | 'no_price'
  /** Not USD or a USD stablecoin. */
  | 'currency'
  /** Who pays or who delivers does not match `autoAcceptDirection` (mixed terms always ask). */
  | 'direction'
  /** Buy: above `autoAcceptMaxUSD`. */
  | 'over_maximum'
  /** Sell: `autoAcceptMinUSD` is null (the default), so sell never auto-accepts. */
  | 'sell_off'
  /** Sell: below `autoAcceptMinUSD`. */
  | 'under_minimum';

/** The basis of an allowed commitment: the policy grant the core records (04 §3.4.2). */
export interface CommitmentGrant {
  /** `rule`: `commitments.accept: allow`; `auto_accept`: within the auto-accept limits. */
  readonly basis: 'rule' | 'auto_accept';
  /** sha256(JCS(policy)) of the verified policy that allowed it (policyDocumentHash). */
  readonly policyHash: string;
}

/** Why facts are refused outright: a binding refusal, or facts that are not a commitment at all. */
export type CommitmentVoidReason = CommitmentBindingRefusal | 'facts_invalid';

export type CommitmentEvaluation =
  | { readonly decision: 'deny' }
  /**
   * The scope and its terms do not check out or do not bind each other (04 §3.4.2 void rule 2):
   * refused with `APPROVAL_VOID` under every policy. Nothing is sent or signed and no owner request
   * is created (IR-M1-20-1 F03, OQ3).
   */
  | {
      readonly decision: 'void';
      readonly code: 'APPROVAL_VOID';
      readonly reason: CommitmentVoidReason;
    }
  | { readonly decision: 'allow'; readonly grant: CommitmentGrant }
  | { readonly decision: 'approval'; readonly autoAccept: AutoAcceptMiss };

/** The hash a grant carries: sha256(JCS(policy)), as the store keeps it (07 §3.4 `policy_hash`). */
export function policyDocumentHash(policy: PolicyDocument): string {
  return computeActionDigest(policy);
}

/** Why a scope and its terms do not bind each other. Fixed codes. */
export type CommitmentBindingRefusal =
  'scope_invalid' | 'terms_invalid' | 'not_this_agent' | 'terms_mismatch' | 'terms_hash_mismatch';

export type CommitmentBinding =
  { readonly ok: true } | { readonly ok: false; readonly reason: CommitmentBindingRefusal };

interface Bound {
  readonly scope: CommitmentScope;
  readonly terms: Terms;
}

function bind(
  self: unknown,
  scope: unknown,
  terms: unknown,
): { ok: true; bound: Bound } | { ok: false; reason: CommitmentBindingRefusal } {
  let s: ReturnType<typeof commitmentScopeSchema.safeParse>;
  let t: ReturnType<typeof termsSchema.safeParse>;
  try {
    s = commitmentScopeSchema.safeParse(scope);
    t = termsSchema.safeParse(terms);
  } catch {
    return { ok: false, reason: 'scope_invalid' };
  }
  if (!s.success) return { ok: false, reason: 'scope_invalid' };
  if (!t.success) return { ok: false, reason: 'terms_invalid' };
  const sc = s.data;
  const tm = t.data;
  if (typeof self !== 'string' || sc.agentId !== self)
    return { ok: false, reason: 'not_this_agent' };
  const other = sc.counterparty.agentId;
  const [a, b] = tm.parties;
  const parties = (a === self && b === other) || (a === other && b === self);
  if (!parties || tm.termsId !== sc.termsId || tm.version !== sc.version) {
    return { ok: false, reason: 'terms_mismatch' };
  }
  // The exact terms (04 §3.4): their own hash, recomputed, must be the one the scope binds.
  if (!verifyTermsHash(terms, sc.termsHash)) return { ok: false, reason: 'terms_hash_mismatch' };
  return { ok: true, bound: { scope: sc, terms: tm } };
}

/**
 * Does `scope` bind exactly `terms` for agent `self` (04 §3.4.2)? Both strict schemas, this agent,
 * the two parties, the negotiation and version, and `termsHash(terms) === scope.termsHash`. The core
 * runs it on the stored terms before each part (void rule 2). Pure; never throws.
 */
export function checkCommitmentBinding(
  self: string,
  scope: unknown,
  terms: unknown,
): CommitmentBinding {
  const r = bind(self, scope, terms);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

/** The auto-accept conditions (04 §3.4.2) for bound accept/confirm terms. */
function autoAccept(policy: PolicyDocument, { scope, terms }: Bound): AutoAcceptMiss | undefined {
  const c = policy.commitments;
  const self = scope.agentId;
  const other = scope.counterparty.agentId;
  if (!(c.autoAcceptContacts as readonly string[]).includes(other)) return 'contact_not_listed';
  const price = terms.price;
  if (price === null) return 'no_price';
  if (!AUTO_ACCEPT_USD_CURRENCIES.includes(price.currency)) return 'currency';
  // A strict positive decimal: the schema refused anything else, `0` included.
  if (c.autoAcceptDirection === 'buy') {
    if (price.payer !== self || !terms.deliverables.every((d) => d.by === other)) {
      return 'direction';
    }
    return compareDecimalWithUsd(price.amount, c.autoAcceptMaxUSD) <= 0
      ? undefined
      : 'over_maximum';
  }
  if (price.payer !== other || !terms.deliverables.every((d) => d.by === self)) return 'direction';
  if (c.autoAcceptMinUSD === null) return 'sell_off';
  return compareDecimalWithUsd(price.amount, c.autoAcceptMinUSD) >= 0 ? undefined : 'under_minimum';
}

const voided = (reason: CommitmentVoidReason): CommitmentEvaluation => ({
  decision: 'void',
  code: 'APPROVAL_VOID',
  reason,
});

const ask = (autoAccept: AutoAcceptMiss): CommitmentEvaluation => ({
  decision: 'approval',
  autoAccept,
});

/**
 * The `commitments` rule for one commitment scope (06 §3, 04 §3.4.2): void (`APPROVAL_VOID`, the
 * facts do not bind; checked first, under every policy), deny, allow (with the grant to record) or
 * approval (with why auto-accept did not apply). Pure and deterministic; never throws.
 */
export function evaluateCommitment(
  effective: EffectivePolicy,
  facts: CommitmentFacts,
): CommitmentEvaluation {
  // Integrity first, under every policy: facts that do not bind are void, never a request.
  const f = facts as Partial<Record<string, unknown>> | null | undefined;
  let bound: Bound | undefined;
  let superseded = false;
  if (typeof f === 'object' && f !== null && f.kind === 'acknowledge') {
    if (f.receipt !== 'ACCEPTED' && f.receipt !== 'REJECTED') return voided('facts_invalid');
  } else if (typeof f === 'object' && f !== null && f.kind === 'terms') {
    if (typeof f.supersededByOwnNewer !== 'boolean') return voided('facts_invalid');
    const r = bind(f.self, f.scope, f.terms);
    if (!r.ok) return voided(r.reason);
    bound = r.bound;
    superseded = f.supersededByOwnNewer;
  } else {
    return voided('facts_invalid');
  }

  if (effective.mode === 'fail_closed') return ask('policy_invalid');
  const policy = effective.policy;
  const rule = policy.commitments.accept;
  if (rule === 'deny') return { decision: 'deny' };
  // A late accept of a version we already replaced: the owner sees the warning, even under allow.
  if (superseded) return ask('superseded');
  if (rule === 'allow') {
    return { decision: 'allow', grant: { basis: 'rule', policyHash: policyDocumentHash(policy) } };
  }
  if (bound === undefined) return ask('not_terms');
  const decision: CommitmentDecision = bound.scope.decision;
  if (decision === 'reject') return ask('reject');
  if (decision === 'offer') return ask('firm_offer');
  const miss = autoAccept(policy, bound);
  if (miss !== undefined) return ask(miss);
  return {
    decision: 'allow',
    grant: { basis: 'auto_accept', policyHash: policyDocumentHash(policy) },
  };
}

export type GrantRecheck =
  | { readonly status: 'allow' }
  /** The part needs the owner: the grant is void (06 §3: "the core then asks the owner"). */
  | {
      readonly status: 'ask_owner';
      readonly reason: 'policy_invalid' | 'policy_changed' | 'not_allowed' | 'grant_invalid';
    }
  /** `commitments.accept` is now deny: nothing is sent or signed (04 §3.4.2 rule 4). */
  | { readonly status: 'deny' }
  /** The stored terms no longer bind the scope: `APPROVAL_VOID`, nothing is sent or signed. */
  | { readonly status: 'void'; readonly code: 'APPROVAL_VOID' };

/**
 * Before each part of a granted scope runs (04 §3.4.2, D-55): the grant row is only a ledger, so the
 * rule is re-run on the policy as verified on load. The part runs only when it still gives `allow`
 * on the same basis and the policy hash is the grant's: any change to the policy voids the grant.
 * Pure; never throws.
 */
export function recheckCommitmentGrant(
  effective: EffectivePolicy,
  facts: CommitmentFacts,
  grant: CommitmentGrant,
): GrantRecheck {
  const e = evaluateCommitment(effective, facts);
  if (e.decision === 'void') return { status: 'void', code: 'APPROVAL_VOID' };
  if (e.decision === 'deny') return { status: 'deny' };
  if (effective.mode === 'fail_closed') return { status: 'ask_owner', reason: 'policy_invalid' };
  const g = grant as Partial<CommitmentGrant> | null | undefined;
  if (
    typeof g !== 'object' ||
    g === null ||
    (g.basis !== 'rule' && g.basis !== 'auto_accept') ||
    typeof g.policyHash !== 'string'
  ) {
    return { status: 'ask_owner', reason: 'grant_invalid' };
  }
  if (g.policyHash !== policyDocumentHash(effective.policy)) {
    return { status: 'ask_owner', reason: 'policy_changed' };
  }
  if (e.decision !== 'allow' || e.grant.basis !== g.basis) {
    return { status: 'ask_owner', reason: 'not_allowed' };
  }
  return { status: 'allow' };
}

/**
 * Void rule 4 for an owner-approved commitment (04 §3.4.2): `commitments.accept` is now `deny` in
 * the verified policy. A fail-closed policy's deny cannot be trusted (G-6), so it never voids.
 */
export function commitmentVoidedByPolicy(effective: EffectivePolicy): boolean {
  return effective.mode !== 'fail_closed' && effective.policy.commitments.accept === 'deny';
}

/** One part of a commitment scope (04 §3.4.2 "What one approval authorises"). */
export type CommitmentPart =
  | 'accept_envelope'
  | 'accept_record'
  | 'accepted_receipt'
  | 'rejected_receipt'
  | 'offer_envelope'
  | 'offer_record';

/**
 * The parts one decision authorises, each at most once (04 §3.4.2). For an `accept`, the Record
 * part exists only with `notarize` and runs only if the answered offer has no record (M1-32).
 */
export function commitmentParts(
  scope: Pick<CommitmentScope, 'decision' | 'notarize'>,
): readonly CommitmentPart[] {
  switch (scope.decision) {
    case 'accept':
      return scope.notarize
        ? ['accept_envelope', 'accept_record', 'accepted_receipt']
        : ['accept_envelope', 'accepted_receipt'];
    case 'reject':
      return ['rejected_receipt'];
    case 'confirm':
      return ['accepted_receipt'];
    case 'offer':
      return ['offer_envelope', 'offer_record'];
  }
}

/**
 * Is this stored approval action a commitment (D-31, D-68)? A commitment is never a batch item
 * (04 §2.5.2), so this errs toward true: any `context.scope` key, or `commitments.accept` among its
 * triggers (an `accepted` / `rejected` acknowledgement has no scope, but is a commitment, 06 §2.4),
 * or triggers that cannot be read.
 */
export function isCommitmentAction(action: unknown): boolean {
  if (typeof action !== 'object' || action === null) return false;
  const context = (action as { context?: unknown }).context;
  if (context === undefined) return false;
  if (typeof context !== 'object' || context === null || Array.isArray(context)) return true;
  if ('scope' in context) return true;
  if (!('triggers' in context)) return false;
  const triggers = (context as { triggers?: unknown }).triggers;
  if (!Array.isArray(triggers)) return true;
  return triggers.some((t) => typeof t !== 'string' || t === 'commitments.accept');
}
