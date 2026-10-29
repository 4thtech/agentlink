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
  type AgentLabelParams,
  type AppChangeParams,
  type FileSaveParams,
  type ContactCheckParams,
  type ContactRule,
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
export type PreparableOp =
  | 'policy.set'
  | 'contact.check'
  | 'contact.rename'
  | 'contact.remove'
  | 'agent.label'
  | 'app.connect'
  | 'app.disconnect'
  | 'file.save';

const PREPARABLE: readonly string[] = [
  'policy.set',
  'contact.check',
  'contact.rename',
  'contact.remove',
  // U3-d (D-138): the owner names this agent from the local app.
  'agent.label',
  // U3-f (D-138): the owner connects, moves or disconnects an AI app from the local app.
  'app.connect',
  'app.disconnect',
  // W4-FILES-SAVE: the owner saves one received file into the Inbox folder from the local app.
  'file.save',
];

interface ParamsOf {
  readonly 'policy.set': PolicySetParams;
  readonly 'contact.check': ContactCheckParams;
  readonly 'contact.rename': ContactRenameParams;
  readonly 'contact.remove': ContactRemoveParams;
  readonly 'agent.label': AgentLabelParams;
  readonly 'app.connect': AppChangeParams;
  readonly 'app.disconnect': AppChangeParams;
  readonly 'file.save': FileSaveParams;
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
  | 'alias_taken'
  /** U3-d: the label is not 1 to 32 code points already in its own restricted form (06 §2.1). */
  | 'label_invalid'
  /** U3-f: the app is not in the fixed table, or `changeId` is not 64 lowercase hex. */
  | 'change_invalid'
  /** W4-FILES-SAVE: not a received item ID `<envelope ID>.<index>` (index 00 to 15). */
  | 'item_invalid';

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
 * any warning it returned is not acknowledged by the owner (M1-11c-a3, M1-11c-a5). Which field can
 * raise which code is POLICY_FIELD_LOOSENING: every policy field has an entry.
 */
export const POLICY_EDIT_WARNING_CODES = Object.freeze([
  /** `contacts.acceptInvites` → `auto`: new contacts without approval. */
  'invites_auto',
  /** `contacts.unknownSenders` drop → queue: unknown senders reach the owner's queue. */
  'unknown_senders_queued',
  /** `contacts.allowed` widened: a list → `paired`, or a list gains IDs (`contacts`). */
  'contacts_allowed_widened',
  /** A limit raised (`fields`): rate, send or receive size, file expiry, envelope size. */
  'limits_raised',
  /** Files kept longer (`fields`): `deleteAfter` receipt → expiry, `ownerArchive` on. */
  'retention_longer',
  /** `files.allowedFolders` gains folders: the agent may send files from them. */
  'allowed_folders_added',
  /**
   * The inbox or proof export folder changed (`fields`): where the agent writes. Any change may widen
   * it (a path is resolved only when used, 04 §4), so every change warns. No path is in the warning.
   */
  'folder_changed',
  /** `files.storage` leaves `own`: files may go to the encrypted drop. */
  'files_drop_allowed',
  /** `proofs.notarize` looser (deny → approval → allow). */
  'proofs_notarize_looser',
  /** `proofs.dailyBudgetUSD` or `proofs.perActionMaxUSD` raised (`fields`). */
  'proofs_spend_raised',
  /** `proofs.allowKeyDisclosure` deny → approval. */
  'key_disclosure_approval',
  /** `proofs.defaultChain` changed: proofs are recorded and paid on another network. */
  'proofs_chain_changed',
  /** Global DELIVERED receipts turned on: what becomes public (D-109). */
  'delivery_receipts_public',
  /** OPENED receipts signed automatically. */
  'opened_receipts_auto',
  /** `commitments.accept` deny → approval: commitments become possible, with approval. */
  'commitments_looser',
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
  /**
   * A removed contact rule was stricter than the global rule these contacts now fall back to
   * (`contacts`: agent IDs only).
   */
  'contact_rule_removed_loosens',
] as const);

export type PolicyEditWarningCode = (typeof POLICY_EDIT_WARNING_CODES)[number];

/** What the confirm screen must say before the owner signs. Codes and IDs only; never a path. */
export interface PolicyEditWarning {
  readonly code: PolicyEditWarningCode;
  /** Agent IDs the warning names, sorted. */
  readonly contacts?: readonly string[];
  /** Policy fields the warning names, as `section.field`. */
  readonly fields?: readonly string[];
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
const looserRule = (from: PolicyRule, to: PolicyRule): boolean => RULE_RANK[to] < RULE_RANK[from];
const added = (from: readonly string[], to: readonly string[]): string[] =>
  to.filter((x) => !from.includes(x)).sort();
const usdRaised = (from: string, to: string): boolean => compareUsd(to, from) > 0;

/** One field's loosening check: the warning it raises from `b` to `n`, or none. */
export type FieldLoosening = (b: Policy, n: Policy) => readonly PolicyEditWarning[];

type ObjectSection = Exclude<keyof Policy, 'contactRules'>;

const when = (cond: boolean, warning: PolicyEditWarning): readonly PolicyEditWarning[] =>
  cond ? [warning] : [];
const raisedInt =
  (code: PolicyEditWarningCode, field: string, get: (p: Policy) => number): FieldLoosening =>
  (b, n) =>
    when(get(n) > get(b), { code, fields: [field] });
const anyChange =
  (code: PolicyEditWarningCode, field: string, get: (p: Policy) => string): FieldLoosening =>
  (b, n) =>
    when(get(n) !== get(b), { code, fields: [field] });

// --- auto-accept, per direction (06 §3 "Commitments", D-55) ---------------------------------------

type Direction = Policy['commitments']['autoAcceptDirection'];

/** What auto-accepts in one direction: off, or on for these contacts within this bound. */
interface AutoAccept {
  readonly on: boolean;
  readonly contacts: readonly string[];
  /** buy: the maximum price; sell: the minimum. */
  readonly bound: string | null;
}

/**
 * The effective auto-accept of `p` in `dir`. Only the configured direction is ever live, and never
 * under `accept: deny`. Buy needs an allowlisted contact and a maximum above 0 (a price is > 0 and
 * at most the maximum). Sell needs `autoAcceptMinUSD`; it is counted as on even with an empty
 * allowlist (the stricter reading for warnings).
 */
function autoAccept(p: Policy, dir: Direction): AutoAccept {
  const c = p.commitments;
  const live = c.accept !== 'deny' && c.autoAcceptDirection === dir;
  if (dir === 'buy') {
    const on = live && c.autoAcceptContacts.length > 0 && compareUsd(c.autoAcceptMaxUSD, '0') > 0;
    return { on, contacts: c.autoAcceptContacts, bound: c.autoAcceptMaxUSD };
  }
  return {
    on: live && c.autoAcceptMinUSD !== null,
    contacts: c.autoAcceptContacts,
    bound: c.autoAcceptMinUSD,
  };
}

/** More permissive in one direction: turned on, or on with new contacts or a looser bound. */
function autoAcceptLooser(b: Policy, n: Policy, dir: Direction): readonly string[] | undefined {
  const before = autoAccept(b, dir);
  const after = autoAccept(n, dir);
  if (!after.on) return undefined;
  if (!before.on) return [...after.contacts].sort();
  const ids = added(before.contacts, after.contacts);
  const bound =
    dir === 'buy'
      ? usdRaised(before.bound!, after.bound!)
      : compareUsd(after.bound!, before.bound!) < 0;
  return ids.length > 0 || bound ? ids : undefined;
}

/**
 * Every direction transition (sell → buy, buy → sell, off → either, a bound or allowlist change, the
 * `accept` rule) compares the effective auto-accept of both directions before and after, and warns
 * for each direction that became more permissive. The direction is one value, so both directions
 * are never on at once.
 */
const autoAcceptLoosening: FieldLoosening = (b, n) => {
  const out: PolicyEditWarning[] = [];
  const buy = autoAcceptLooser(b, n, 'buy');
  if (buy !== undefined) {
    out.push({ code: 'auto_accept_widened', ...(buy.length > 0 ? { contacts: buy } : {}) });
  }
  const sell = autoAcceptLooser(b, n, 'sell');
  if (sell !== undefined) {
    out.push({ code: 'sell_auto_accept', ...(sell.length > 0 ? { contacts: sell } : {}) });
  }
  return out;
};

// --- contact rules (06 §3 "Per-contact rules") ----------------------------------------------------

type RuleSection = Exclude<keyof ContactRule, 'contact'>;

/** One contact-rule field's check: true when the field's effective value for `contact` loosened. */
type RuleFieldLoosening = (b: Policy, n: Policy, contact: string) => boolean;

const ruleOf = (p: Policy, contact: string) => p.contactRules.find((r) => r.contact === contact);
/** The effective `notarize` for a contact's proofs: a global deny always wins (06 §3 step 1). */
const effNotarize = (p: Policy, contact: string): PolicyRule =>
  p.proofs.notarize === 'deny'
    ? 'deny'
    : (ruleOf(p, contact)?.proofs?.notarize ?? p.proofs.notarize);

/**
 * The loosening check for every field of a ContactRule, and the code it raises for a kept or new
 * rule. The type makes a new ContactRule field a compile error here until it is classified, and a
 * test compares the keys with the schema. `contact` is the rule's key, not a setting.
 */
export const CONTACT_RULE_FIELD_LOOSENING: {
  readonly [S in RuleSection]-?: {
    readonly code: PolicyEditWarningCode;
    readonly fields: { readonly [F in keyof NonNullable<ContactRule[S]>]-?: RuleFieldLoosening };
  };
} = {
  proofs: {
    code: 'contact_proof_rules_looser',
    fields: {
      notarize: (b, n, c) => looserRule(effNotarize(b, c), effNotarize(n, c)),
      perActionMaxUSD: (b, n, c) =>
        usdRaised(
          ruleOf(b, c)?.proofs?.perActionMaxUSD ?? b.proofs.perActionMaxUSD,
          ruleOf(n, c)?.proofs?.perActionMaxUSD ?? n.proofs.perActionMaxUSD,
        ),
    },
  },
  receipts: {
    code: 'contact_receipts_public',
    fields: {
      autoDelivered: (b, n, c) =>
        (ruleOf(n, c)?.receipts?.autoDelivered ?? n.receipts.autoDelivered) &&
        !(ruleOf(b, c)?.receipts?.autoDelivered ?? b.receipts.autoDelivered),
    },
  },
};

/**
 * Per contact in the old or new rules: each ContactRule field's check. A loosening under a kept or
 * new rule raises its section's code; under a removed rule (the contact now falls back to the global
 * values) it raises `contact_rule_removed_loosens`. Only agent IDs are carried.
 */
const contactRulesLoosening: FieldLoosening = (b, n) => {
  const contacts = new Set([...b.contactRules, ...n.contactRules].map((r) => r.contact));
  const hits = new Map<PolicyEditWarningCode, string[]>();
  const hit = (code: PolicyEditWarningCode, contact: string) => {
    const list = hits.get(code) ?? [];
    if (!list.includes(contact)) list.push(contact);
    hits.set(code, list);
  };
  for (const contact of contacts) {
    const removed = ruleOf(n, contact) === undefined;
    for (const section of Object.values(CONTACT_RULE_FIELD_LOOSENING)) {
      const checks = Object.values(section.fields) as RuleFieldLoosening[];
      if (checks.some((looser) => looser(b, n, contact))) {
        hit(removed ? 'contact_rule_removed_loosens' : section.code, contact);
      }
    }
  }
  return [...hits].map(([code, list]) => ({ code, contacts: list.sort() }));
};

/**
 * The loosening check for every field of the policy (06 §3), one entry per field: the type makes a
 * new schema field a compile error here until it is classified, and a test compares the keys with
 * the defaults. A field whose every change can loosen (a folder, the chain) warns on any change.
 */
export const POLICY_FIELD_LOOSENING: {
  readonly [S in ObjectSection]: { readonly [F in keyof Policy[S]]-?: FieldLoosening };
} & { readonly contactRules: FieldLoosening } = {
  contacts: {
    acceptInvites: (b, n) =>
      when(n.contacts.acceptInvites === 'auto' && b.contacts.acceptInvites !== 'auto', {
        code: 'invites_auto',
      }),
    unknownSenders: (b, n) =>
      when(n.contacts.unknownSenders === 'queue' && b.contacts.unknownSenders === 'drop', {
        code: 'unknown_senders_queued',
      }),
    allowed: (b, n) => {
      if (n.contacts.allowed === 'paired') {
        return when(b.contacts.allowed !== 'paired', { code: 'contacts_allowed_widened' });
      }
      if (b.contacts.allowed === 'paired') return [];
      const ids = added(b.contacts.allowed, n.contacts.allowed);
      return when(ids.length > 0, { code: 'contacts_allowed_widened', contacts: ids });
    },
    rateLimitPerContactPerHour: raisedInt(
      'limits_raised',
      'contacts.rateLimitPerContactPerHour',
      (p) => p.contacts.rateLimitPerContactPerHour,
    ),
  },
  files: {
    allowedFolders: (b, n) =>
      when(added(b.files.allowedFolders, n.files.allowedFolders).length > 0, {
        code: 'allowed_folders_added',
      }),
    inboxFolder: anyChange('folder_changed', 'files.inboxFolder', (p) => p.files.inboxFolder),
    maxSendSizeMB: raisedInt('limits_raised', 'files.maxSendSizeMB', (p) => p.files.maxSendSizeMB),
    maxReceiveSizeMB: raisedInt(
      'limits_raised',
      'files.maxReceiveSizeMB',
      (p) => p.files.maxReceiveSizeMB,
    ),
    storage: (b, n) =>
      when(b.files.storage === 'own' && n.files.storage !== 'own', { code: 'files_drop_allowed' }),
    defaultExpiryDays: raisedInt(
      'limits_raised',
      'files.defaultExpiryDays',
      (p) => p.files.defaultExpiryDays,
    ),
    deleteAfter: (b, n) =>
      when(b.files.deleteAfter === 'receipt' && n.files.deleteAfter === 'expiry', {
        code: 'retention_longer',
        fields: ['files.deleteAfter'],
      }),
    ownerArchive: (b, n) =>
      when(n.files.ownerArchive && !b.files.ownerArchive, {
        code: 'retention_longer',
        fields: ['files.ownerArchive'],
      }),
  },
  envelopes: {
    maxEnvelopeKB: raisedInt(
      'limits_raised',
      'envelopes.maxEnvelopeKB',
      (p) => p.envelopes.maxEnvelopeKB,
    ),
  },
  proofs: {
    notarize: (b, n) =>
      when(looserRule(b.proofs.notarize, n.proofs.notarize), { code: 'proofs_notarize_looser' }),
    dailyBudgetUSD: (b, n) =>
      when(usdRaised(b.proofs.dailyBudgetUSD, n.proofs.dailyBudgetUSD), {
        code: 'proofs_spend_raised',
        fields: ['proofs.dailyBudgetUSD'],
      }),
    perActionMaxUSD: (b, n) =>
      when(usdRaised(b.proofs.perActionMaxUSD, n.proofs.perActionMaxUSD), {
        code: 'proofs_spend_raised',
        fields: ['proofs.perActionMaxUSD'],
      }),
    allowKeyDisclosure: (b, n) =>
      when(n.proofs.allowKeyDisclosure === 'approval' && b.proofs.allowKeyDisclosure === 'deny', {
        code: 'key_disclosure_approval',
      }),
    exportFolder: anyChange('folder_changed', 'proofs.exportFolder', (p) => p.proofs.exportFolder),
    defaultChain: (b, n) =>
      when(n.proofs.defaultChain !== b.proofs.defaultChain, { code: 'proofs_chain_changed' }),
  },
  receipts: {
    autoDelivered: (b, n) =>
      when(n.receipts.autoDelivered && !b.receipts.autoDelivered, {
        code: 'delivery_receipts_public',
      }),
    autoOpened: (b, n) =>
      when(n.receipts.autoOpened && !b.receipts.autoOpened, { code: 'opened_receipts_auto' }),
  },
  commitments: {
    accept: (b, n) => {
      if (!looserRule(b.commitments.accept, n.commitments.accept)) return [];
      return [
        { code: n.commitments.accept === 'allow' ? 'commitments_allow' : 'commitments_looser' },
      ];
    },
    autoAcceptContacts: autoAcceptLoosening,
    autoAcceptMaxUSD: autoAcceptLoosening,
    autoAcceptDirection: autoAcceptLoosening,
    autoAcceptMinUSD: autoAcceptLoosening,
  },
  contactRules: contactRulesLoosening,
};

/**
 * Every loosening from `base` to `next`: each field's check in POLICY_FIELD_LOOSENING, merged by code
 * (their `contacts` and `fields` joined) and reported in POLICY_EDIT_WARNING_CODES order (06 §3;
 * 11 §5.6). A stricter or unchanged value warns nothing.
 */
export function policyEditWarnings(base: Policy, next: Policy): PolicyEditWarning[] {
  const raised: PolicyEditWarning[] = [];
  const table = POLICY_FIELD_LOOSENING as unknown as Record<
    string,
    FieldLoosening | Record<string, FieldLoosening>
  >;
  for (const entry of Object.values(table)) {
    const checks = typeof entry === 'function' ? [entry] : Object.values(entry);
    for (const check of checks) raised.push(...check(base, next));
  }
  const out: PolicyEditWarning[] = [];
  for (const code of POLICY_EDIT_WARNING_CODES) {
    const hits = raised.filter((w) => w.code === code);
    if (hits.length === 0) continue;
    const contacts = [...new Set(hits.flatMap((w) => w.contacts ?? []))].sort();
    const fields = [...new Set(hits.flatMap((w) => w.fields ?? []))];
    out.push({
      code,
      ...(contacts.length > 0 ? { contacts } : {}),
      ...(fields.length > 0 ? { fields } : {}),
    });
  }
  return out;
}
