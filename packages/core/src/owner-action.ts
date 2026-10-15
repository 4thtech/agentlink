// SignedOwnerAction verification (04 §2.5.1, §2.5.2; G-7, D-58, D-68). Pure: every input, `now`
// included, is passed in, so the G-7 boundaries are exact and the vector suite runs it in every
// runtime. The store side (nonce, record and effects in one transaction) is owner-actions.ts.
//
// Order of the checks (04 §2.5.1): the exact encoding (strict I-JSON text when given text, then the
// strict schema of SignedOwnerAction, OwnerAction and the op's params); `agent`; `owner` against the
// card's ownerNostr as bytes; `sig` over taggedHash("agentlink/owner-action/v1", sha256(JCS(body)));
// `issuedAt ≤ now + S`; `now ≤ expiresAt` and `expiresAt − issuedAt ≤ L(op)` (both skipped only for
// `agent.revoke`); the nonce (`agent.revoke` is exempt: a re-published copy is a no-op); the op's
// rule against the receiving core's state. Everything up to and including the nonce is the "object"
// stage: a failure there drops the object and writes nothing. A failure of the op's rule is the
// "match" stage: the object is authentic and fresh, so for a batch the store burns its nonce
// (04 §2.5.2), and a single op writes nothing.
//
// I-5: the input is untrusted. Nothing from it is interpolated into a refusal: refusals are fixed
// codes, and item refusals carry only the `approvalId`, which has passed its schema.
import {
  TAGS,
  bip340Verify,
  canonicalize,
  canonicalizeToBytes,
  decodeHex,
  decodeHex0x,
  encodeHex,
  equalBytes,
  parseJson,
  sha256,
  taggedHash,
} from '@agentlink/crypto';
import {
  CLOCK_SKEW_SECONDS,
  OWNER_ACTION_MAX_LIFETIME_SECONDS,
  OWNER_ACTION_OPS,
  signedOwnerActionSchema,
  type ApprovalDecideParams,
  type SignedOwnerAction,
} from '@agentlink/types';

/** Why an owner action was refused. Fixed codes; never input text (I-5, I-7). */
export type OwnerActionRefusal =
  // object stage (04 §2.5.1): the object is dropped and nothing is written
  | 'malformed'
  | 'agent_mismatch'
  | 'owner_mismatch'
  | 'signature_invalid'
  | 'issued_in_future'
  | 'expired'
  | 'lifetime_exceeded'
  | 'nonce_used'
  | 'version_not_newer'
  // match stage: the op's rule against the receiving core's state
  | 'approval_unknown'
  | 'not_pending'
  | 'request_expired'
  | 'digest_mismatch'
  | 'outlives_request'
  | 'commitment_in_batch'
  | 'item_refused'
  | 'contact_unknown'
  | 'pairing_unavailable'
  | 'unsupported_op'
  // store side (owner-actions.ts)
  | 'not_approved'
  | 'store_changed'
  | 'identity_missing'
  | 'identity_revoked'
  | 'policy_mark_unavailable';

/** Why one batch item does not match its pending request (04 §2.5.2). */
export type ItemRefusal =
  | 'approval_unknown'
  | 'not_pending'
  | 'request_expired'
  | 'digest_mismatch'
  | 'commitment_in_batch';

export interface ItemRefusalReport {
  readonly approvalId: string;
  readonly reason: ItemRefusal;
}

/** What the receiving core knows about a request an approval names (07 §3 `approvals`). */
export interface ApprovalRequestView {
  readonly approvalId: string;
  /** Recomputed from the stored action, never read from a column (04 §2.5.1). */
  readonly actionDigest: string;
  readonly expiresAt: number;
  /** The request carries a commitment scope (04 §3.4.2): never a batch item. */
  readonly commitment: boolean;
  /** Status `pending`. A decided, cancelled or void request is never decided again. */
  readonly pending: boolean;
}

/** The receiving core, as the checks need it. */
export interface OwnerActionCheckContext {
  /** The agent's EVM address (`0x` + 40 lowercase hex): the own agent, or a contact for a revoke. */
  readonly agent: string;
  /** `ownerNostr` of that agent's card, as the card spells it: `0x` + 64 hex (04 §2.4.1). */
  readonly ownerNostr: string;
  /** Unix seconds, from the verifying core's own clock. */
  readonly now: number;
  /** True when the nonce is already recorded. Absent: the caller checks it in its transaction. */
  readonly nonceUsed?: (nonce: string) => boolean;
  /** The highest applied policy version (the larger of the stored row and the KeyStore mark). */
  readonly appliedPolicyVersion?: number;
  /** The request an `approvalId` names, if this agent has one. */
  readonly approvalRequest?: (approvalId: string) => ApprovalRequestView | undefined;
}

export type OwnerActionVerdict =
  | {
      readonly ok: true;
      readonly signed: SignedOwnerAction;
      /** sha256(JCS(SignedOwnerAction)), 64 lowercase hex (07 §3.4 `action_hash`). */
      readonly actionHash: string;
    }
  | {
      readonly ok: false;
      readonly stage: 'object' | 'match';
      readonly reason: OwnerActionRefusal;
      readonly op: string | null;
      /** Present at the match stage: the authentic object, so a batch's nonce can be burnt. */
      readonly signed?: SignedOwnerAction;
      readonly items?: readonly ItemRefusalReport[];
    };

/** The JCS text, its sha256 and the tagged signature input of an OwnerAction body (04 §2.5.1). */
export function ownerActionSigningParts(body: unknown): {
  readonly jcs: string;
  readonly bodyHash: Uint8Array;
  readonly signatureInput: Uint8Array;
} {
  const jcs = canonicalize(body);
  const bodyHash = sha256(canonicalizeToBytes(body));
  return { jcs, bodyHash, signatureInput: taggedHash(TAGS.ownerAction, bodyHash) };
}

/** `actionDigest` = sha256(JCS(action)) as 64 lowercase hex (04 §3.4.1). */
export function computeActionDigest(action: unknown): string {
  return encodeHex(sha256(canonicalizeToBytes(action)));
}

/** sha256(JCS(SignedOwnerAction)) as 64 lowercase hex (07 §3.4 `action_hash`). */
export function ownerActionHash(signed: unknown): string {
  return encodeHex(sha256(canonicalizeToBytes(signed)));
}

/** Parses wire text strictly: I-JSON, no duplicate keys, integers only (04 §2.4.1). */
export function parseOwnerActionText(text: string): unknown {
  return parseJson(text, { integersOnly: true });
}

const opOf = (input: unknown): string | null => {
  if (typeof input !== 'object' || input === null) return null;
  const body = (input as { body?: unknown }).body;
  if (typeof body !== 'object' || body === null) return null;
  const op = (body as { op?: unknown }).op;
  // Only a known op name is ever reported: an unknown one is inbound text (I-5).
  return (OWNER_ACTION_OPS as readonly unknown[]).includes(op) ? (op as string) : null;
};

function objectRefusal(reason: OwnerActionRefusal, op: string | null) {
  return { ok: false, stage: 'object', reason, op } as const;
}

type ObjectCheck =
  { readonly ok: true; readonly signed: SignedOwnerAction } | ReturnType<typeof objectRefusal>;

/**
 * The object-stage checks: encoding, binding and signature, then (when `fresh`) freshness, the
 * nonce and the policy version. A stored object is re-verified without the freshness checks, which
 * apply once, when it is first applied (04 §2.5.1).
 */
function checkObject(input: unknown, ctx: OwnerActionCheckContext, fresh = true): ObjectCheck {
  const parsed = signedOwnerActionSchema.safeParse(input);
  const op = opOf(input);
  if (!parsed.success) return objectRefusal('malformed', op);
  const signed = parsed.data;
  const { body } = signed;
  if (body.agent !== ctx.agent) return objectRefusal('agent_mismatch', body.op);

  let cardOwner: Uint8Array;
  try {
    cardOwner = decodeHex0x(ctx.ownerNostr, { length: 32 });
  } catch {
    // A card that does not spell its owner key canonically matches nothing (fail closed).
    return objectRefusal('owner_mismatch', body.op);
  }
  const owner = decodeHex(body.owner, { length: 32 });
  if (!equalBytes(owner, cardOwner)) return objectRefusal('owner_mismatch', body.op);

  // The signature covers the body exactly as received: the schema is strict, so the parsed body
  // and the input have the same keys and values, and JCS fixes the order.
  const { signatureInput } = ownerActionSigningParts((input as { body: unknown }).body);
  let valid: boolean;
  try {
    valid = bip340Verify(owner, signatureInput, decodeHex(signed.sig, { length: 64 }));
  } catch {
    valid = false;
  }
  if (!valid) return objectRefusal('signature_invalid', body.op);
  if (!fresh) return { ok: true, signed };

  if (body.issuedAt > ctx.now + CLOCK_SKEW_SECONDS) {
    return objectRefusal('issued_in_future', body.op);
  }
  if (body.op !== 'agent.revoke') {
    if (ctx.now > body.expiresAt) return objectRefusal('expired', body.op);
    const lifetime = OWNER_ACTION_MAX_LIFETIME_SECONDS[body.op];
    if (body.expiresAt - body.issuedAt > lifetime) {
      return objectRefusal('lifetime_exceeded', body.op);
    }
    if (ctx.nonceUsed?.(body.nonce) === true) return objectRefusal('nonce_used', body.op);
  }
  if (body.op === 'policy.set' && body.params.version <= (ctx.appliedPolicyVersion ?? 0)) {
    return objectRefusal('version_not_newer', body.op);
  }
  return { ok: true, signed };
}

/** One decision against its request, as for `approval.decide` (04 §2.5.1, §3.4.1). */
function matchItem(
  item: ApprovalDecideParams,
  ctx: OwnerActionCheckContext,
  inBatch: boolean,
): { request: ApprovalRequestView } | { reason: ItemRefusal } {
  const request = ctx.approvalRequest?.(item.approvalId);
  if (request === undefined || request.approvalId !== item.approvalId) {
    return { reason: 'approval_unknown' };
  }
  if (!request.pending) return { reason: 'not_pending' };
  if (ctx.now > request.expiresAt) return { reason: 'request_expired' };
  if (request.actionDigest !== item.actionDigest) return { reason: 'digest_mismatch' };
  if (inBatch && request.commitment) return { reason: 'commitment_in_batch' };
  return { request };
}

/**
 * Verifies a parsed SignedOwnerAction for the receiving core in `ctx`. Pure; refuses anything that
 * is not exactly canonical. A `contact.check` is refused at the match stage here: its rule needs the
 * pairing digest recomputed from the stored pair, which is verifyContactCheck (contact-check.ts),
 * and OwnerActions.apply routes it there (M1-7c-b, M1-7d).
 */
export function verifyOwnerAction(
  input: unknown,
  ctx: OwnerActionCheckContext,
): OwnerActionVerdict {
  const checked = checkObject(input, ctx);
  if (!checked.ok) return checked;
  const { signed } = checked;
  const { body } = signed;
  const match = (reason: OwnerActionRefusal, items?: readonly ItemRefusalReport[]) =>
    ({
      ok: false,
      stage: 'match',
      reason,
      op: body.op,
      signed,
      ...(items === undefined ? {} : { items }),
    }) as const;

  switch (body.op) {
    case 'approval.decide': {
      const m = matchItem(body.params, ctx, false);
      if ('reason' in m) return match(m.reason);
      if (body.expiresAt > m.request.expiresAt) return match('outlives_request');
      break;
    }
    case 'approval.decideBatch': {
      // Whole or nothing (04 §2.5.2): every item must match; every failing item is reported.
      const refused: ItemRefusalReport[] = [];
      let earliest = Number.POSITIVE_INFINITY;
      for (const item of body.params.items) {
        const m = matchItem(item, ctx, true);
        if ('reason' in m) refused.push({ approvalId: item.approvalId, reason: m.reason });
        else earliest = Math.min(earliest, m.request.expiresAt);
      }
      if (refused.length > 0) return match('item_refused', refused);
      if (body.expiresAt > earliest) return match('outlives_request');
      break;
    }
    case 'contact.check':
      // Not decidable here: the pairing digest is recomputed from the stored handshake pair, which
      // is verifyContactCheck's lookup (M1-7c-b). OwnerActions.apply never calls this for it.
      return match('unsupported_op');
    case 'approval.cancel':
    case 'policy.set':
    case 'agent.revoke':
      // Their rules need the store (cancel: an approved row; policy.set: the version above, already
      // checked; agent.revoke: none) and are applied by the store side.
      break;
  }
  return { ok: true, signed, actionHash: ownerActionHash(input) };
}

/**
 * Re-verifies a stored object on load or use (04 §2.5.1 "Stored objects are re-verified"): the exact
 * encoding, `agent`, `owner` and `sig`; never freshness or the nonce. The text is parsed strictly.
 */
export function verifyStoredOwnerAction(
  text: string,
  ctx: Pick<OwnerActionCheckContext, 'agent' | 'ownerNostr'>,
):
  | { readonly ok: true; readonly signed: SignedOwnerAction }
  | { readonly ok: false; readonly reason: OwnerActionRefusal } {
  let input: unknown;
  try {
    input = parseOwnerActionText(text);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const checked = checkObject(input, { ...ctx, now: 0 }, false);
  return checked.ok ? checked : { ok: false, reason: checked.reason };
}

/** Strict text parse, then verifyOwnerAction. Text that is not strict I-JSON is `malformed`. */
export function verifyOwnerActionText(
  text: string,
  ctx: OwnerActionCheckContext,
): OwnerActionVerdict {
  let input: unknown;
  try {
    input = parseOwnerActionText(text);
  } catch {
    return objectRefusal('malformed', null);
  }
  return verifyOwnerAction(input, ctx);
}
