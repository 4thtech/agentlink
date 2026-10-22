// Owner-operation prepare helpers (M1-11r-b, D-118; 04 §2.5, §2.5.1; 06 §3). The local UI server
// builds the unsigned OwnerAction body here, shows it, takes the owner's presence (M1-11s-b) and only
// then signs it with the owner key, through the same owner-action path as every other surface. The
// browser never signs and never builds a body.
//
// - The builder is pure and byte-exact: the strict OwnerAction schema, then JCS (RFC 8785); any
//   input in another form is refused with a TypeError, never normalised (04 §2.4.1). It reproduces
//   the M1-1h signing vectors for the ops it prepares.
// - The class methods that use it live on OwnerActions (owner-actions.ts), next to the policy loader
//   and the contact rules they read.
//
// I-4: nothing here holds, asks for or uses an owner key or presence. A prepared body is inert: the
// core applies only a SignedOwnerAction whose signature verifies against the owner key in the
// agent's own card. No MCP tool calls these helpers or returns a prepared body.
import { canonicalize, encodeBase64url, randomBytes } from '@4thtech-io/crypto';
import {
  OWNER_ACTION_MAX_LIFETIME_SECONDS,
  PROTOCOL_VERSION,
  ownerActionSchema,
  type ContactCheckParams,
  type ContactRemoveParams,
  type ContactRenameParams,
  type OwnerAction,
  type Policy,
  type PolicyPatch,
  type PolicySetParams,
} from '@4thtech-io/types';

/**
 * How long a prepared body stays valid: 600 s. The local UI applies an action within seconds (04
 * §2.5.1 G-7), so it never uses the 24 h lifetime the console needs for `policy.set` and
 * `contact.check`; it is also exactly L(op) for `contact.rename` and `contact.remove`.
 */
export const PREPARED_OWNER_ACTION_LIFETIME_SECONDS = 600;

/** The ops an owner surface can prepare here. */
export type PreparableOp = 'policy.set' | 'contact.check' | 'contact.rename' | 'contact.remove';

const PREPARABLE: readonly string[] = [
  'policy.set',
  'contact.check',
  'contact.rename',
  'contact.remove',
];

interface ParamsOf {
  readonly 'policy.set': PolicySetParams;
  readonly 'contact.check': ContactCheckParams;
  readonly 'contact.rename': ContactRenameParams;
  readonly 'contact.remove': ContactRemoveParams;
}

export interface OwnerActionBodyInput<O extends PreparableOp = PreparableOp> {
  /** The agent's EVM address, `0x` + 40 lowercase hex. */
  readonly agent: string;
  /** The owner Nostr x-only key, 64 lowercase hex without a prefix (04 §2.5.1). */
  readonly owner: string;
  readonly op: O;
  readonly params: ParamsOf[O];
  /** 16 bytes, base64url without padding. */
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** An unsigned body and its JCS text: the exact bytes the owner signature covers (04 §2.5.1). */
export interface BuiltOwnerAction {
  readonly body: OwnerAction;
  readonly jcs: string;
}

/**
 * Builds an unsigned OwnerAction body in its one encoding. Throws a TypeError (a fixed message, no
 * input text) when the input is not already canonical: an unknown or missing key, a non-canonical
 * address, owner, nonce or integer, `expiresAt` not after `issuedAt`, a lifetime above L(op), or an
 * op this module does not prepare.
 */
export function buildOwnerActionBody<O extends PreparableOp>(
  input: OwnerActionBodyInput<O>,
): BuiltOwnerAction {
  const candidate = {
    v: PROTOCOL_VERSION,
    agent: input.agent,
    owner: input.owner,
    op: input.op,
    params: input.params,
    nonce: input.nonce,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
  if (!PREPARABLE.includes(input.op)) throw new TypeError('owner action: op not preparable');
  const parsed = ownerActionSchema.safeParse(candidate);
  if (!parsed.success) throw new TypeError('owner action: body not canonical');
  const lifetime = OWNER_ACTION_MAX_LIFETIME_SECONDS[input.op];
  if (lifetime === null || input.expiresAt - input.issuedAt > lifetime) {
    throw new TypeError('owner action: lifetime above L(op)');
  }
  // The strict schema returns the same keys and values; JCS of the input must equal JCS of the
  // parsed body, so the body that is shown, signed and verified is exactly this one.
  const jcs = canonicalize(parsed.data as never);
  if (jcs !== canonicalize(candidate as never)) {
    throw new TypeError('owner action: body not canonical');
  }
  return { body: parsed.data, jcs };
}

/** A fresh nonce: 16 CSPRNG bytes, base64url without padding (04 §2.5.1). */
export const newOwnerActionNonce = (): string => encodeBase64url(randomBytes(16));

/** Why a body was not prepared. Fixed codes; never input text (I-5, I-7). */
export type PrepareRefusal =
  | 'identity_missing'
  | 'identity_revoked'
  /** The patch is not a strict PolicyPatch, or the merged document is not a valid policy. */
  | 'patch_invalid'
  /** The policy fails closed (or its mark is unreadable): use `policy recover` (D-100). */
  | 'policy_not_valid'
  /** The caller's `baseVersion` is not the policy in force now: reload and edit again. */
  | 'stale_version'
  | 'contact_unknown'
  | 'contact_revoked'
  | 'pairing_unavailable'
  | 'alias_invalid'
  | 'alias_taken';

export type PreparedOwnerAction =
  | {
      readonly status: 'prepared';
      readonly op: PreparableOp;
      readonly body: OwnerAction;
      /** JCS(body): the bytes under the owner signature, for the server's signing step. */
      readonly jcs: string;
    }
  | { readonly status: 'refused'; readonly op: PreparableOp; readonly reason: PrepareRefusal };

/** What the confirm screen must say before the owner signs (06 §3; 11 §5.6). */
export type PolicyEditWarning =
  /** Sell auto-accept turned on or changed: the 06 §3 sell warning. */
  | 'sell_auto_accept'
  /** Global delivery receipts turned on: what becomes public (D-109). */
  | 'delivery_receipts_public';

export interface PolicyEditOptions {
  /**
   * The version the owner's screen showed (0 for the defaults). When given and not the version in
   * force now, the edit is refused (`stale_version`), so an edit made on an outdated view never
   * silently overwrites a newer policy.
   */
  readonly baseVersion?: number;
  /**
   * The owner's explicit answer to "Keep delivery receipts on?" (06 §3, D-109). Read only when the
   * policy has receipts on from an older default; anything but `true` signs `false`.
   */
  readonly keepDeliveryReceipts?: boolean;
}

export type PreparedPolicyEdit =
  | (Extract<PreparedOwnerAction, { status: 'prepared' }> & {
      /** The version this body signs: above the KeyStore mark and the stored row. */
      readonly version: number;
      /** The version the edit was built on (0 for the defaults). */
      readonly baseVersion: number;
      /** The policy has receipts on from an older default: the screen asks "Keep…?" (D-109). */
      readonly askKeepDeliveryReceipts: boolean;
      /**
       * True when this body keeps receipts on from an older default by the owner's explicit choice:
       * after it is applied, the server records the receipts-kept marker at `version`.
       */
      readonly keepDeliveryReceipts: boolean;
      readonly warnings: readonly PolicyEditWarning[];
    })
  | Extract<PreparedOwnerAction, { status: 'refused' }>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * The complete policy after `patch`: each named field of an object section replaces the base value,
 * a list is replaced whole, and every field the patch does not name is the base value. Pure; the
 * caller validates the patch before and the result after.
 */
export function mergePolicyPatch(base: Policy, patch: PolicyPatch): Policy {
  const out = clone(base);
  const target = out as unknown as Record<string, unknown>;
  for (const [section, value] of Object.entries(patch)) {
    if (Array.isArray(value)) {
      target[section] = clone(value);
      continue;
    }
    const into = target[section] as Record<string, unknown>;
    for (const [field, v] of Object.entries(value as Record<string, unknown>)) {
      into[field] = clone(v);
    }
  }
  return out;
}

/** The warnings for an edit from `base` to `next` (06 §3). */
export function policyEditWarnings(base: Policy, next: Policy): PolicyEditWarning[] {
  const warnings: PolicyEditWarning[] = [];
  const sellOn = (p: Policy) =>
    p.commitments.accept !== 'deny' && p.commitments.autoAcceptMinUSD !== null;
  if (
    sellOn(next) &&
    (!sellOn(base) ||
      base.commitments.autoAcceptMinUSD !== next.commitments.autoAcceptMinUSD ||
      base.commitments.autoAcceptDirection !== next.commitments.autoAcceptDirection ||
      canonicalize(base.commitments.autoAcceptContacts as never) !==
        canonicalize(next.commitments.autoAcceptContacts as never))
  ) {
    warnings.push('sell_auto_accept');
  }
  if (next.receipts.autoDelivered && !base.receipts.autoDelivered) {
    warnings.push('delivery_receipts_public');
  }
  return warnings;
}
