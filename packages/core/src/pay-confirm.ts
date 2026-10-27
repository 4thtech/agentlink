// M1-PAY-CONFIRM-a: confirming paid actions (04 §2.5.3; 06 §3; 12 §4.6; D-132; I-1, I-4, I-5).
//
// What this module is: the pure part of the paid-action confirmation. From the exact owner flow the
// owner is about to sign it builds the confirmation statement (what the sheet shows) and the
// unsigned action body, and from those and a fresh nonce the WebAuthn challenge of rule 2:
//
//   challenge = SHA-256("agentlink-pay-confirm-v1" ‖ nonce ‖ SHA-256(JCS(statement))
//                       ‖ SHA-256(JCS(unsigned action body)))
//
// - A proof approval: the body is the pending request's `action`; the statement amount is exactly
//   that action's `context.fee.usd`. The owner signs `approval.decide` `{approvalId, actionDigest,
//   decision}`, never a fee: the amount is bound through `actionDigest = sha256(JCS(action))`.
// - "Remember for this contact": the body is `[pending action, unsigned policy.set]`, and the
//   statement carries the fee and the contact rule's old and new values. The policy.set may change
//   nothing but that contact's proof rule (06 §3).
// - A limits change: the body is the complete unsigned `policy.set`; the statement lists each
//   spending field's old and new value (`proofs.notarize`, `proofs.dailyBudgetUSD`,
//   `proofs.perActionMaxUSD`, `contactRules[].proofs`). A `policy.set` that changes no spending field
//   is not a paid flow: it keeps the ordinary owner prompt.
//
// Every value in a statement comes from stored, verified data: the pending action, the policy in
// force and the unsigned body the server built. The only text is the counterparty's name, which the
// caller resolves under the 11 §5.2 name rule from the stored contact (never inbound text, I-5). No
// function here reads a URL, a tool argument or inbound content; an input with any other key is
// refused. Nothing here signs, unlocks or writes (I-4): the node ceremony (packages/node
// pay-confirm.ts) runs the gesture and signs only the bodies whose digests are in the challenge.
import {
  canonicalizeToBytes,
  concatBytes,
  encodeUtf8,
  sha256,
  type JsonObject,
  type JsonValue,
} from '@4thtech-io/crypto';
import {
  approvalFeeSchema,
  isUsdAmount,
  policySchema,
  roundUpUsdToCents,
  type ContactRule,
  type Policy,
} from '@4thtech-io/types';
import { CoreError } from './errors.js';

/** Rule 2: the challenge's domain separator. */
export const PAY_CONFIRM_DOMAIN = 'agentlink-pay-confirm-v1';
/** Rule 2: a challenge is valid for 120 s. */
export const PAY_CONFIRM_TTL_MS = 120_000;
/** Rule 2: the nonce is 32 fresh random bytes. */
export const PAY_CONFIRM_NONCE_BYTES = 32;
/** Statement format version. */
export const PAY_CONFIRM_STATEMENT_VERSION = 1;
/** The longest counterparty name a statement carries (the 11 §5.2 rendering is shorter). */
const MAX_NAME_CHARS = 200;

/** The spending fields of a policy (04 §2.5.3 "Which actions"). */
export type SpendingField =
  | 'proofs.notarize'
  | 'proofs.dailyBudgetUSD'
  | 'proofs.perActionMaxUSD'
  | 'contactRules.proofs.notarize'
  | 'contactRules.proofs.perActionMaxUSD';

/** One spending field's old and new value; `null` is "not set" (a contact rule without it). */
export interface SpendingChange {
  readonly field: SpendingField;
  /** For a `contactRules` field: the contact's agent ID (bound; the sheet names the contact). */
  readonly contact?: string;
  readonly old: string | null;
  readonly new: string | null;
}

/** The fixed purpose keys a statement names (the sheet maps them to 11 §5 copy). */
export type PayConfirmPurpose = 'proof' | 'limits_change';
export type PayConfirmKind = 'proof' | 'proof_remember' | 'limits';

/** What the sheet shows and the challenge binds (04 §2.5.3 rule 2). */
export interface PayConfirmStatement {
  readonly v: typeof PAY_CONFIRM_STATEMENT_VERSION;
  readonly kind: PayConfirmKind;
  /** The amount in USD (a USD amount, 04 §2.4.1), or null for a limits change. */
  readonly amountUsd: string | null;
  readonly purpose: PayConfirmPurpose;
  /** The counterparty under the 11 §5.2 name rule, or null (none, or a note to self). */
  readonly counterparty: string | null;
  /** The spending changes, in a fixed order; empty for a plain proof approval. */
  readonly changes: readonly SpendingChange[];
}

/** A paid flow, ready for the challenge: the statement and the unsigned action body. */
export interface PayConfirmFlow {
  readonly statement: PayConfirmStatement;
  /** The pending action, the unsigned `policy.set`, or `[pending action, unsigned policy.set]`. */
  readonly body: JsonValue;
}

/** Why a flow is not built. Fixed codes; never an input value (I-7). */
export type PayConfirmRefusal =
  /** The input is malformed, carries an unknown key, or its pieces do not fit together. */
  | 'invalid'
  /** The pending request carries no fee: it is not a paid action (the ordinary prompt). */
  | 'not_paid'
  /** The `policy.set` changes no spending field: the ordinary owner prompt. */
  | 'no_spending_change'
  /** "Remember for this contact" is not offered for this request (06 §3). */
  | 'remember_not_offered'
  /** The `policy.set` changes more than the contact's proof rule. */
  | 'remember_mismatch';

/** A refused flow; `reason` is a fixed code, never an input value (I-7). */
export class PayConfirmError extends CoreError {
  readonly reason: PayConfirmRefusal;

  constructor(reason: PayConfirmRefusal) {
    super('pay_confirm_refused', `The paid-action confirmation was refused (${reason}).`);
    this.name = 'PayConfirmError';
    this.reason = reason;
  }
}

const refuse = (reason: PayConfirmRefusal): PayConfirmError => new PayConfirmError(reason);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Throws `invalid` unless `value` is an object whose keys are exactly within `allowed`. */
function onlyKeys(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isObject(value)) throw refuse('invalid');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw refuse('invalid');
  return value;
}

/** A deep, JSON-only copy (fresh objects; the caller's value is never kept). */
const copyJson = <T extends JsonValue>(value: T): T =>
  JSON.parse(new TextDecoder().decode(canonicalizeToBytes(value))) as T;

/**
 * The fee a pending request carries (`action.context.fee`, 04 §3.4.1), or null when it carries none.
 * A defensive read of stored data: a fee that does not parse is treated as present and invalid, so
 * a damaged request is never mistaken for a free one.
 */
export function pendingRequestFee(action: unknown): { readonly usd: string } | 'invalid' | null {
  if (!isObject(action)) return null;
  const context = action['context'];
  if (!isObject(context)) return null;
  if (!('fee' in context)) return null;
  const fee = context['fee'];
  if (fee === null || fee === undefined) return null;
  const parsed = approvalFeeSchema.safeParse(fee);
  return parsed.success ? { usd: parsed.data.usd } : 'invalid';
}

/** True when a pending request carries a fee (rule 7: never a batch item). Fail closed. */
export function isPaidPendingAction(action: unknown): boolean {
  return pendingRequestFee(action) !== null;
}

type ProofRule = NonNullable<ContactRule['proofs']>;

function proofRulesByContact(policy: Policy): Map<string, ProofRule> {
  const out = new Map<string, ProofRule>();
  for (const rule of policy.contactRules)
    if (rule.proofs !== undefined) out.set(rule.contact, rule.proofs);
  return out;
}

/**
 * The spending changes from `before` to `after`, in a fixed order: the three global fields, then
 * each contact (ascending agent ID) with `notarize` before `perActionMaxUSD`. Empty when no spending
 * field changes.
 */
export function spendingChanges(before: Policy, after: Policy): readonly SpendingChange[] {
  const out: SpendingChange[] = [];
  const globals = ['notarize', 'dailyBudgetUSD', 'perActionMaxUSD'] as const;
  for (const key of globals) {
    const old = before.proofs[key];
    const now = after.proofs[key];
    if (old !== now) out.push({ field: `proofs.${key}`, old, new: now });
  }
  const a = proofRulesByContact(before);
  const b = proofRulesByContact(after);
  const contacts = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) =>
    x < y ? -1 : x > y ? 1 : 0,
  );
  for (const contact of contacts) {
    for (const key of ['notarize', 'perActionMaxUSD'] as const) {
      const old = a.get(contact)?.[key] ?? null;
      const now = b.get(contact)?.[key] ?? null;
      if (old !== now) out.push({ field: `contactRules.proofs.${key}`, contact, old, new: now });
    }
  }
  return Object.freeze(out.map((c) => Object.freeze(c)));
}

/** The policy without its spending fields: equal for two policies that differ only in spending. */
function nonSpending(policy: Policy): JsonValue {
  const proofs: Record<string, unknown> = { ...policy.proofs };
  for (const key of ['notarize', 'dailyBudgetUSD', 'perActionMaxUSD']) delete proofs[key];
  const contactRules = policy.contactRules
    .filter((r) => r.receipts !== undefined)
    .map((r) => ({ contact: r.contact, receipts: r.receipts }));
  return { ...policy, proofs, contactRules } as unknown as JsonValue;
}

const sameJson = (a: JsonValue, b: JsonValue): boolean => {
  const x = canonicalizeToBytes(a);
  const y = canonicalizeToBytes(b);
  return x.length === y.length && x.every((byte, i) => byte === y[i]);
};

/** A policy.set body's policy, strictly parsed; `invalid` otherwise. */
function policyOfSet(policySet: unknown): Policy {
  const body = onlyKeys(policySet, [
    'v',
    'op',
    'agent',
    'owner',
    'nonce',
    'issuedAt',
    'expiresAt',
    'params',
  ]);
  if (body['op'] !== 'policy.set') throw refuse('invalid');
  const params = onlyKeys(body['params'], ['version', 'policy']);
  const parsed = policySchema.safeParse(params['policy']);
  if (!parsed.success) throw refuse('invalid');
  return parsed.data;
}

/**
 * The spending changes a `policy.set` body makes against the policy in force, or `invalid` when the
 * body is not a well-formed `policy.set` (the caller fails closed). For an owner surface that must
 * send a spending change through the confirmation (04 §2.5.3 table) and keep the ordinary prompt
 * for any other policy change.
 */
export function policySetSpendingChanges(
  before: unknown,
  policySet: unknown,
): readonly SpendingChange[] | 'invalid' {
  try {
    return spendingChanges(beforePolicy(before), policyOfSet(policySet));
  } catch {
    return 'invalid';
  }
}

/** The counterparty name: a printable, bounded string exactly when the action has a counterparty. */
function counterpartyName(action: Record<string, unknown>, name: unknown): string | null {
  const context = action['context'] as Record<string, unknown>;
  const has = isObject(context['counterparty']);
  if (!has) {
    if (name !== null) throw refuse('invalid');
    return null;
  }
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > MAX_NAME_CHARS ||
    // eslint-disable-next-line no-control-regex -- control characters are refused in copy
    /[\u0000-\u001f\u007f-\u009f]/u.test(name)
  ) {
    throw refuse('invalid');
  }
  return name;
}

/** The pending action (an object with a valid fee), or a refusal. */
function paidAction(action: unknown): { action: Record<string, unknown>; usd: string } {
  if (!isObject(action)) throw refuse('invalid');
  const fee = pendingRequestFee(action);
  if (fee === null) throw refuse('not_paid');
  if (fee === 'invalid' || !isUsdAmount(fee.usd)) throw refuse('invalid');
  return { action, usd: fee.usd };
}

/** The triggers a pending action names (06 §3), as strings. */
function triggersOf(action: Record<string, unknown>): readonly string[] {
  const context = action['context'] as Record<string, unknown>;
  const triggers = context['triggers'];
  return Array.isArray(triggers) ? triggers.filter((t): t is string => typeof t === 'string') : [];
}

/**
 * 06 §3 "Remember for this contact": the contact rules after remembering this proof for its
 * counterparty, or null when it is not offered (the daily budget triggered it, it is a commitment,
 * a note to self, or neither step 2 nor step 3 triggered it). Built only from the verified policy
 * and the stored action: step 2 gives `notarize: "allow"`, step 3 `perActionMaxUSD` = the fee
 * rounded up to whole cents; any other field of an existing rule stays as it is.
 */
export function rememberContactRules(
  policy: Policy,
  pendingAction: unknown,
): readonly ContactRule[] | null {
  let paid: { action: Record<string, unknown>; usd: string };
  try {
    paid = paidAction(pendingAction);
  } catch {
    return null;
  }
  const { action, usd } = paid;
  const tool = action['tool'];
  if (tool !== 'agentlink_notarize' && tool !== 'agentlink_send') return null;
  const context = action['context'] as Record<string, unknown>;
  if ('scope' in context) return null;
  const counterparty = context['counterparty'];
  if (!isObject(counterparty) || typeof counterparty['agentId'] !== 'string') return null;
  const contact = counterparty['agentId'];
  const triggers = triggersOf(action);
  if (triggers.length === 0 || triggers.includes('proofs.dailyBudgetUSD')) return null;
  if (triggers.some((t) => t !== 'proofs.notarize' && t !== 'proofs.perActionMaxUSD')) return null;
  const existing = policy.contactRules.find((r) => r.contact === contact);
  const proofs: { notarize?: ProofRule['notarize']; perActionMaxUSD?: string } = {
    ...(existing?.proofs ?? {}),
  };
  if (triggers.includes('proofs.notarize')) proofs.notarize = 'allow';
  if (triggers.includes('proofs.perActionMaxUSD')) proofs.perActionMaxUSD = roundUpUsdToCents(usd);
  const rule: ContactRule = {
    contact,
    proofs: proofs as ProofRule,
    ...(existing?.receipts === undefined ? {} : { receipts: existing.receipts }),
  };
  const rules = policy.contactRules.filter((r) => r.contact !== contact);
  rules.push(rule);
  rules.sort((x, y) => (x.contact < y.contact ? -1 : x.contact > y.contact ? 1 : 0));
  return Object.freeze(rules);
}

/** The input of buildPayConfirmFlow. Every piece is stored, verified data (see the file header). */
export type PayConfirmInput =
  | {
      readonly kind: 'proof';
      /** The pending request's stored `action`. */
      readonly pendingAction: JsonValue;
      /** The stored contact under the 11 §5.2 name rule; null exactly when there is no counterparty. */
      readonly counterpartyName: string | null;
    }
  | {
      readonly kind: 'proof_remember';
      readonly pendingAction: JsonValue;
      readonly counterpartyName: string | null;
      /** The policy in force. */
      readonly before: Policy;
      /** The complete unsigned `policy.set` the server built. */
      readonly policySet: JsonObject;
    }
  | {
      readonly kind: 'limits';
      readonly before: Policy;
      readonly policySet: JsonObject;
    };

const INPUT_KEYS: Readonly<Record<PayConfirmKind, readonly string[]>> = Object.freeze({
  proof: ['kind', 'pendingAction', 'counterpartyName'],
  proof_remember: ['kind', 'pendingAction', 'counterpartyName', 'before', 'policySet'],
  limits: ['kind', 'before', 'policySet'],
});

function beforePolicy(value: unknown): Policy {
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) throw refuse('invalid');
  return parsed.data;
}

/**
 * Builds the statement and the unsigned body of one paid flow (04 §2.5.3 rule 2). Refuses
 * (`CoreError` `pay_confirm_refused`, reason in `details`) an input with an unknown key (no amount,
 * name or limit is ever taken from elsewhere), a request without a fee, a limits change without a
 * spending change, and a "Remember" `policy.set` that changes anything but that contact's proof
 * rule as 06 §3 builds it. The result is a fresh deep copy; nothing of the input is kept.
 */
export function buildPayConfirmFlow(input: PayConfirmInput): PayConfirmFlow {
  if (!isObject(input)) throw refuse('invalid');
  const kind = input['kind'];
  if (kind !== 'proof' && kind !== 'proof_remember' && kind !== 'limits') throw refuse('invalid');
  onlyKeys(input, INPUT_KEYS[kind]);

  if (input.kind === 'limits') {
    const before = beforePolicy(input.before);
    const after = policyOfSet(input.policySet);
    const changes = spendingChanges(before, after);
    if (changes.length === 0) throw refuse('no_spending_change');
    const statement: PayConfirmStatement = {
      v: PAY_CONFIRM_STATEMENT_VERSION,
      kind: 'limits',
      amountUsd: null,
      purpose: 'limits_change',
      counterparty: null,
      changes,
    };
    return freezeFlow(statement, copyJson(input.policySet));
  }

  const { action, usd } = paidAction(input.pendingAction);
  const name = counterpartyName(action, input.counterpartyName);
  if (input.kind === 'proof') {
    const statement: PayConfirmStatement = {
      v: PAY_CONFIRM_STATEMENT_VERSION,
      kind: 'proof',
      amountUsd: usd,
      purpose: 'proof',
      counterparty: name,
      changes: [],
    };
    return freezeFlow(statement, copyJson(input.pendingAction));
  }

  // "Remember for this contact": the policy.set must be exactly the 06 §3 rule for this contact.
  const before = beforePolicy(input.before);
  const after = policyOfSet(input.policySet);
  const expected = rememberContactRules(before, action);
  if (expected === null) throw refuse('remember_not_offered');
  if (
    !sameJson(nonSpending(before), nonSpending(after)) ||
    before.proofs.notarize !== after.proofs.notarize ||
    before.proofs.dailyBudgetUSD !== after.proofs.dailyBudgetUSD ||
    before.proofs.perActionMaxUSD !== after.proofs.perActionMaxUSD ||
    !sameJson(expected as unknown as JsonValue, after.contactRules as unknown as JsonValue)
  ) {
    throw refuse('remember_mismatch');
  }
  const changes = spendingChanges(before, after);
  if (changes.length === 0) throw refuse('no_spending_change');
  const statement: PayConfirmStatement = {
    v: PAY_CONFIRM_STATEMENT_VERSION,
    kind: 'proof_remember',
    amountUsd: usd,
    purpose: 'proof',
    counterparty: name,
    changes,
  };
  return freezeFlow(statement, copyJson([input.pendingAction, input.policySet] as JsonValue));
}

function freezeFlow(statement: PayConfirmStatement, body: JsonValue): PayConfirmFlow {
  const s = copyJson(statement as unknown as JsonValue) as unknown as PayConfirmStatement;
  return Object.freeze({ statement: s, body });
}

/** SHA-256(JCS(statement)) and SHA-256(JCS(body)): what a finish compares against its begin. */
export function payConfirmDigests(flow: PayConfirmFlow): {
  readonly statement: Uint8Array;
  readonly body: Uint8Array;
} {
  return {
    statement: sha256(canonicalizeToBytes(flow.statement as unknown as JsonValue)),
    body: sha256(canonicalizeToBytes(flow.body)),
  };
}

/**
 * Rule 2: SHA-256("agentlink-pay-confirm-v1" ‖ nonce ‖ SHA-256(JCS(statement)) ‖
 * SHA-256(JCS(unsigned action body))). The nonce is 32 fresh random bytes from the caller.
 */
export function payConfirmChallenge(nonce: Uint8Array, flow: PayConfirmFlow): Uint8Array {
  if (!(nonce instanceof Uint8Array) || nonce.length !== PAY_CONFIRM_NONCE_BYTES) {
    throw refuse('invalid');
  }
  const d = payConfirmDigests(flow);
  return sha256(concatBytes(encodeUtf8(PAY_CONFIRM_DOMAIN), nonce, d.statement, d.body));
}
