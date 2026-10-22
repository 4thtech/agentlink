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
  compareUsd,
  ownerActionSchema,
  type PolicyRule,
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

/**
 * Every loosening the strict schema allows, as a stable code (06 §3; 11 §5.6), in the order they are
 * reported. The confirm screen shows each one, and the local UI server refuses to sign an edit while
 * any warning it returned is not acknowledged by the owner (M1-11c-a3, M1-11c-a5).
 */
export const POLICY_EDIT_WARNING_CODES = Object.freeze([
  /** `contacts.acceptInvites` → `auto`: new contacts without approval. */
  'invites_auto',
  /** `contacts.allowed` widened: a list → `paired`, or a list gains IDs (`contacts`). */
  'contacts_allowed_widened',
  /** A limit raised (`fields`): rate, send or receive size, file expiry, envelope size. */
  'limits_raised',
  /** `files.allowedFolders` gains folders (`folders`): the agent may send files from them. */
  'allowed_folders_added',
  /** `files.storage` leaves `own`: files may go to the encrypted drop. */
  'files_drop_allowed',
  /** `proofs.notarize` looser (deny → approval → allow). */
  'proofs_notarize_looser',
  /** `proofs.dailyBudgetUSD` or `proofs.perActionMaxUSD` raised (`fields`). */
  'proofs_spend_raised',
  /** `proofs.allowKeyDisclosure` deny → approval. */
  'key_disclosure_approval',
  /** Global DELIVERED receipts turned on: what becomes public (D-109). */
  'delivery_receipts_public',
  /** OPENED receipts signed automatically. */
  'opened_receipts_auto',
  /** `commitments.accept` → `allow`: commitments, firm offers and REJECTED without approval. */
  'commitments_allow',
  /** Buy auto-accept widened: new allowlisted contacts (`contacts`) or a higher maximum. */
  'auto_accept_widened',
  /** Sell auto-accept turned on or changed: the 06 §3 sell warning. */
  'sell_auto_accept',
  /** A contact rule makes proofs looser for these contacts (`contacts`). */
  'contact_proof_rules_looser',
  /** A contact rule turns DELIVERED receipts on for these contacts (`contacts`; 11 §5.6). */
  'contact_receipts_public',
] as const);

export type PolicyEditWarningCode = (typeof POLICY_EDIT_WARNING_CODES)[number];

/** What the confirm screen must say before the owner signs. Owner input only; no inbound text. */
export interface PolicyEditWarning {
  readonly code: PolicyEditWarningCode;
  /** Agent IDs the warning names, sorted. */
  readonly contacts?: readonly string[];
  /** Policy fields the warning names, as `section.field`. */
  readonly fields?: readonly string[];
  /** Folders the warning names, as the owner wrote them. */
  readonly folders?: readonly string[];
}

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

const RULE_RANK: Readonly<Record<PolicyRule, number>> = { allow: 0, approval: 1, deny: 2 };
const added = (from: readonly string[], to: readonly string[]): string[] =>
  to.filter((x) => !from.includes(x)).sort();
const usdRaised = (from: string, to: string): boolean => compareUsd(to, from) > 0;

/** A contact's effective proof rule and DELIVERED setting (06 §3 evaluation; a global deny wins). */
function contactEffect(p: Policy, contact: string) {
  const rule = p.contactRules.find((r) => r.contact === contact);
  return {
    notarize: p.proofs.notarize === 'deny' ? 'deny' : (rule?.proofs?.notarize ?? p.proofs.notarize),
    perActionMaxUSD: rule?.proofs?.perActionMaxUSD ?? p.proofs.perActionMaxUSD,
    autoDelivered: rule?.receipts?.autoDelivered ?? p.receipts.autoDelivered,
  };
}

/**
 * Every loosening from `base` to `next`, as stable codes in POLICY_EDIT_WARNING_CODES order (06 §3;
 * 11 §5.6). A stricter or unchanged value warns nothing. Contact-rule warnings name only contacts
 * whose own rule changes their effective value; a global change is its own warning.
 */
export function policyEditWarnings(base: Policy, next: Policy): PolicyEditWarning[] {
  const out: PolicyEditWarning[] = [];
  const b = base;
  const n = next;

  if (n.contacts.acceptInvites === 'auto' && b.contacts.acceptInvites !== 'auto') {
    out.push({ code: 'invites_auto' });
  }
  if (n.contacts.allowed === 'paired' && b.contacts.allowed !== 'paired') {
    out.push({ code: 'contacts_allowed_widened' });
  } else if (n.contacts.allowed !== 'paired' && b.contacts.allowed !== 'paired') {
    const ids = added(b.contacts.allowed, n.contacts.allowed);
    if (ids.length > 0) out.push({ code: 'contacts_allowed_widened', contacts: ids });
  }
  const limits = [
    [
      'contacts.rateLimitPerContactPerHour',
      b.contacts.rateLimitPerContactPerHour,
      n.contacts.rateLimitPerContactPerHour,
    ],
    ['files.maxSendSizeMB', b.files.maxSendSizeMB, n.files.maxSendSizeMB],
    ['files.maxReceiveSizeMB', b.files.maxReceiveSizeMB, n.files.maxReceiveSizeMB],
    ['files.defaultExpiryDays', b.files.defaultExpiryDays, n.files.defaultExpiryDays],
    ['envelopes.maxEnvelopeKB', b.envelopes.maxEnvelopeKB, n.envelopes.maxEnvelopeKB],
  ] as const;
  const raised = limits.filter(([, from, to]) => to > from).map(([field]) => field);
  if (raised.length > 0) out.push({ code: 'limits_raised', fields: raised });
  const folders = added(b.files.allowedFolders, n.files.allowedFolders);
  if (folders.length > 0) out.push({ code: 'allowed_folders_added', folders });
  if (b.files.storage === 'own' && n.files.storage !== 'own') {
    out.push({ code: 'files_drop_allowed' });
  }
  if (RULE_RANK[n.proofs.notarize] < RULE_RANK[b.proofs.notarize]) {
    out.push({ code: 'proofs_notarize_looser' });
  }
  const spend = (['dailyBudgetUSD', 'perActionMaxUSD'] as const)
    .filter((f) => usdRaised(b.proofs[f], n.proofs[f]))
    .map((f) => `proofs.${f}`);
  if (spend.length > 0) out.push({ code: 'proofs_spend_raised', fields: spend });
  if (n.proofs.allowKeyDisclosure === 'approval' && b.proofs.allowKeyDisclosure === 'deny') {
    out.push({ code: 'key_disclosure_approval' });
  }
  if (n.receipts.autoDelivered && !b.receipts.autoDelivered) {
    out.push({ code: 'delivery_receipts_public' });
  }
  if (n.receipts.autoOpened && !b.receipts.autoOpened) {
    out.push({ code: 'opened_receipts_auto' });
  }
  if (n.commitments.accept === 'allow' && b.commitments.accept !== 'allow') {
    out.push({ code: 'commitments_allow' });
  }
  if (n.commitments.accept !== 'deny') {
    const ids = added(b.commitments.autoAcceptContacts, n.commitments.autoAcceptContacts);
    const higher = usdRaised(b.commitments.autoAcceptMaxUSD, n.commitments.autoAcceptMaxUSD);
    const fromDeny = b.commitments.accept === 'deny' && n.commitments.autoAcceptContacts.length > 0;
    if (ids.length > 0 || higher || fromDeny) {
      out.push({
        code: 'auto_accept_widened',
        ...(ids.length > 0 ? { contacts: ids } : {}),
      });
    }
  }
  const sellOn = (p: Policy) =>
    p.commitments.accept !== 'deny' && p.commitments.autoAcceptMinUSD !== null;
  if (
    sellOn(n) &&
    (!sellOn(b) ||
      b.commitments.autoAcceptMinUSD !== n.commitments.autoAcceptMinUSD ||
      b.commitments.autoAcceptDirection !== n.commitments.autoAcceptDirection ||
      canonicalize(b.commitments.autoAcceptContacts as never) !==
        canonicalize(n.commitments.autoAcceptContacts as never))
  ) {
    out.push({ code: 'sell_auto_accept' });
  }
  const looserProofs: string[] = [];
  const receiptsOn: string[] = [];
  for (const rule of n.contactRules) {
    const before = contactEffect(b, rule.contact);
    const after = contactEffect(n, rule.contact);
    if (
      RULE_RANK[after.notarize] < RULE_RANK[before.notarize] ||
      usdRaised(before.perActionMaxUSD, after.perActionMaxUSD)
    ) {
      looserProofs.push(rule.contact);
    }
    if (after.autoDelivered && !before.autoDelivered) receiptsOn.push(rule.contact);
  }
  if (looserProofs.length > 0) {
    out.push({ code: 'contact_proof_rules_looser', contacts: looserProofs.sort() });
  }
  if (receiptsOn.length > 0) {
    out.push({ code: 'contact_receipts_public', contacts: receiptsOn.sort() });
  }
  return out;
}
