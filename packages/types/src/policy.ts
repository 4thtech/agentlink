// Policy (06 §3, "Policy JSON form" and "Per-contact rules"; G-32), the document `policy.set` signs
// (04 §2.5.1).
//
// - Strict at every level and every key is required: a missing key is never filled from a default,
//   so a document in any other form is rejected, never completed or normalised. What the core does
//   when no valid policy exists is G-6 (M1-7d): once a policy has been applied, it is never the
//   defaults. Nothing here has a `.default()`, `.catch()` or fallback.
// - Adding a key later is a schema change: an older core refuses such a policy (fail closed).
// - Encodings follow 04 §2.4.1: agent IDs are `0x` + 40 lowercase hex, USD amounts are strings.
import { z } from 'zod';
import {
  evmAddress,
  hasControlOrFormat,
  isStrictlyAscending,
  isWellFormedString,
  utf8ByteLength,
} from './encoding.js';
import { usdAmountSchema } from './usd.js';

const freeze = <T>(value: T): Readonly<T> => Object.freeze(value);

// --- enums (06 §3 table, "Enum") -----------------------------------------------------------------

export const INVITE_ACCEPT_RULES = freeze(['approval', 'auto'] as const);
export const UNKNOWN_SENDER_RULES = freeze(['queue', 'drop'] as const);
export const FILE_STORAGE_MODES = freeze(['auto', 'drop', 'own'] as const);
export const FILE_DELETE_AFTER = freeze(['expiry', 'receipt'] as const);
/** `proofs.notarize`, `commitments.accept` and a contact rule's `notarize`. */
export const POLICY_RULES = freeze(['allow', 'approval', 'deny'] as const);
/** Never `allow`: disclosing a content key is owner-only (04 §2.5). */
export const KEY_DISCLOSURE_RULES = freeze(['approval', 'deny'] as const);
export const AUTO_ACCEPT_DIRECTIONS = freeze(['buy', 'sell'] as const);

export type PolicyRule = (typeof POLICY_RULES)[number];

// --- bounds (06 §3 table) ------------------------------------------------------------------------

export const POLICY_BOUNDS = freeze({
  /** `contacts.allowed` as a list: 1–256 agent IDs. */
  allowedContacts: freeze({ min: 1, max: 256 } as const),
  /** `commitments.autoAcceptContacts`: 0–256 agent IDs. */
  autoAcceptContacts: freeze({ min: 0, max: 256 } as const),
  /** `contactRules`: 0–256 rules. */
  contactRules: freeze({ min: 0, max: 256 } as const),
  /** `files.allowedFolders`: 0–32 unique paths. */
  allowedFolders: freeze({ min: 0, max: 32 } as const),
  /** A path: 1–4096 UTF-8 bytes. */
  pathBytes: freeze({ min: 1, max: 4096 } as const),
  rateLimitPerContactPerHour: freeze({ min: 1, max: 3600 } as const),
  sizeMB: freeze({ min: 1, max: 10_240 } as const),
  defaultExpiryDays: freeze({ min: 1, max: 7 } as const),
  maxEnvelopeKB: freeze({ min: 1, max: 24 } as const),
  /** `files.autoSave.perContactFilesPerDay` and `totalFilesPerDay` (D-142). */
  autoSaveFilesPerDay: freeze({ min: 1, max: 1000 } as const),
  /** `files.autoSave.perContactMBPerDay` and `totalMBPerDay` (D-142). */
  autoSaveMBPerDay: freeze({ min: 1, max: 10_240 } as const),
} as const);

// --- field schemas -------------------------------------------------------------------------------

/** A JSON integer (04 §2.4.1 integer rule) in [min, max]. */
const intIn = ({ min, max }: { readonly min: number; readonly max: number }) =>
  z.int().min(min).max(max);

/**
 * A list of agent IDs in strictly ascending byte order (06 §3 "Agent IDs"). Every ID is canonical
 * lowercase hex of one length, so code-unit order is byte order and one set has one spelling.
 */
const agentIdList = ({ min, max }: { readonly min: number; readonly max: number }) =>
  z
    .array(evmAddress)
    .min(min)
    .max(max)
    .refine(
      isStrictlyAscending,
      'agent IDs must be sorted in strictly ascending order, no duplicates',
    );

/** True when the string has a C0 (U+0000–U+001F) or C1 (U+0080–U+009F) control character. */
function hasC0OrC1(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x80 && c <= 0x9f)) return true;
  }
  return false;
}

/**
 * A local path (06 §3 "Path"): 1–4096 UTF-8 bytes, I-JSON, no C0 or C1 control character and
 * (PROPOSED, IR-M1-2b-1 F-4) no format (Cf: bidi, zero-width) or line/paragraph separator, which
 * could spoof a folder name on owner surfaces. A
 * leading `~/` means the user's home folder. The core resolves it with realpath when it is used
 * (04 §4); nothing here touches the file system.
 */
export const policyPathSchema = z
  .string()
  .refine(isWellFormedString, 'path contains a lone surrogate (not I-JSON)')
  .refine((s) => typeof s === 'string' && !hasC0OrC1(s), 'path contains a control character')
  .refine(
    (s) => typeof s === 'string' && !hasControlOrFormat(s),
    'path contains a format (bidi, zero-width) or separator character',
  )
  .refine((s) => {
    if (typeof s !== 'string') return false;
    const n = utf8ByteLength(s);
    return n >= POLICY_BOUNDS.pathBytes.min && n <= POLICY_BOUNDS.pathBytes.max;
  }, 'path must be 1..4096 UTF-8 bytes');

/** A chain key from 07 §6.3. */
export const chainKeySchema = z
  .string()
  .regex(/^[a-z0-9-]{1,32}$/, 'must be a chain key: 1..32 of a-z, 0-9 and -');

// --- ContactRule (06 §3 "Per-contact rules", G-32) -----------------------------------------------

/**
 * `files.autoSave` (D-142; 06 §3; proposed, owner confirms at merge): incoming files from contacts
 * the owner keeps are saved automatically within these rolling 24-hour limits (04 §4.1). A strict
 * object with all five keys when present. It is the one policy key that may be absent: a policy
 * signed before D-142 has none and is read with AUTO_SAVE_DEFAULTS (auto-save on; Decision 51).
 */
export const autoSaveSchema = z.strictObject({
  on: z.boolean(),
  perContactFilesPerDay: intIn(POLICY_BOUNDS.autoSaveFilesPerDay),
  perContactMBPerDay: intIn(POLICY_BOUNDS.autoSaveMBPerDay),
  totalFilesPerDay: intIn(POLICY_BOUNDS.autoSaveFilesPerDay),
  totalMBPerDay: intIn(POLICY_BOUNDS.autoSaveMBPerDay),
});

export type AutoSavePolicy = z.infer<typeof autoSaveSchema>;

/** The 06 §3 `files.autoSave` defaults (D-142, Decision 51): on, 50/500 per contact, 200/2048. */
export const AUTO_SAVE_DEFAULTS: Readonly<AutoSavePolicy> = freeze({
  on: true,
  perContactFilesPerDay: 50,
  perContactMBPerDay: 500,
  totalFilesPerDay: 200,
  totalMBPerDay: 2048,
});

/**
 * One contact's rule: at least one of `proofs`, `receipts` and `files` (D-109, D-142).
 * - `proofs` holds at least one of `notarize` (replaces `proofs.notarize` for this contact; a
 *   global `deny` still wins) and `perActionMaxUSD` (replaces `proofs.perActionMaxUSD`).
 * - `receipts` holds exactly `autoDelivered`, which replaces `receipts.autoDelivered` for DELIVERED
 *   receipts on this contact's records only; never OPENED, ACCEPTED or REJECTED (06 §3, M1-33a).
 * - `files` holds exactly `askBeforeSaving: true` (D-142): this contact's files are not saved
 *   automatically and wait for Save or the AI's fetch.
 * An absent key is absent: an explicit `undefined` is rejected.
 */
export const contactRuleSchema = z
  .strictObject({
    contact: evmAddress,
    proofs: z
      .strictObject({
        notarize: z.enum(POLICY_RULES).exactOptional(),
        perActionMaxUSD: usdAmountSchema.exactOptional(),
      })
      .refine(
        (p) => p.notarize !== undefined || p.perActionMaxUSD !== undefined,
        'a contact rule sets notarize, perActionMaxUSD or both',
      )
      .exactOptional(),
    receipts: z.strictObject({ autoDelivered: z.boolean() }).exactOptional(),
    // D-142: "Ask before saving" for this contact; only `true` (it can only make saving stricter).
    files: z.strictObject({ askBeforeSaving: z.literal(true) }).exactOptional(),
  })
  .refine(
    (r) => r.proofs !== undefined || r.receipts !== undefined || r.files !== undefined,
    'a contact rule sets proofs, receipts, files or a combination',
  );

const contactRulesSchema = z
  .array(contactRuleSchema)
  .min(POLICY_BOUNDS.contactRules.min)
  .max(POLICY_BOUNDS.contactRules.max)
  .refine(
    // Defensive: Zod may run this check on elements that already failed their own schema.
    (rules) =>
      isStrictlyAscending(
        rules.map((r: unknown) =>
          r !== null && typeof r === 'object' ? (r as { contact?: unknown }).contact : undefined,
        ),
      ),
    'contact rules must be sorted by contact, at most one per contact',
  );

// --- Policy --------------------------------------------------------------------------------------

export const policySchema = z.strictObject({
  contacts: z.strictObject({
    acceptInvites: z.enum(INVITE_ACCEPT_RULES),
    unknownSenders: z.enum(UNKNOWN_SENDER_RULES),
    allowed: z.union([z.literal('paired'), agentIdList(POLICY_BOUNDS.allowedContacts)]),
    rateLimitPerContactPerHour: intIn(POLICY_BOUNDS.rateLimitPerContactPerHour),
  }),
  files: z.strictObject({
    allowedFolders: z
      .array(policyPathSchema)
      .min(POLICY_BOUNDS.allowedFolders.min)
      .max(POLICY_BOUNDS.allowedFolders.max)
      .refine((xs) => new Set<unknown>(xs).size === xs.length, 'allowedFolders must be unique'),
    inboxFolder: policyPathSchema,
    maxSendSizeMB: intIn(POLICY_BOUNDS.sizeMB),
    maxReceiveSizeMB: intIn(POLICY_BOUNDS.sizeMB),
    storage: z.enum(FILE_STORAGE_MODES),
    defaultExpiryDays: intIn(POLICY_BOUNDS.defaultExpiryDays),
    deleteAfter: z.enum(FILE_DELETE_AFTER),
    ownerArchive: z.boolean(),
    // D-142: may be absent only in a policy signed before D-142 (read as AUTO_SAVE_DEFAULTS).
    autoSave: autoSaveSchema.exactOptional(),
  }),
  envelopes: z.strictObject({
    maxEnvelopeKB: intIn(POLICY_BOUNDS.maxEnvelopeKB),
  }),
  proofs: z.strictObject({
    notarize: z.enum(POLICY_RULES),
    dailyBudgetUSD: usdAmountSchema,
    perActionMaxUSD: usdAmountSchema,
    allowKeyDisclosure: z.enum(KEY_DISCLOSURE_RULES),
    exportFolder: policyPathSchema,
    defaultChain: chainKeySchema,
  }),
  receipts: z.strictObject({
    autoDelivered: z.boolean(),
    autoOpened: z.boolean(),
  }),
  commitments: z.strictObject({
    accept: z.enum(POLICY_RULES),
    autoAcceptContacts: agentIdList(POLICY_BOUNDS.autoAcceptContacts),
    autoAcceptMaxUSD: usdAmountSchema,
    autoAcceptDirection: z.enum(AUTO_ACCEPT_DIRECTIONS),
    autoAcceptMinUSD: usdAmountSchema.nullable(),
  }),
  contactRules: contactRulesSchema,
});

export type ContactRule = z.infer<typeof contactRuleSchema>;
export type Policy = z.infer<typeof policySchema>;

// --- Defaults (06 §3) ----------------------------------------------------------------------------

type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function buildDefaults(): Policy {
  return {
    contacts: {
      acceptInvites: 'approval',
      unknownSenders: 'queue',
      allowed: 'paired',
      rateLimitPerContactPerHour: 120,
    },
    files: {
      allowedFolders: [],
      inboxFolder: '~/AgentLink/Inbox',
      maxSendSizeMB: 100,
      maxReceiveSizeMB: 200,
      storage: 'auto',
      defaultExpiryDays: 7,
      deleteAfter: 'expiry',
      ownerArchive: false,
    },
    envelopes: { maxEnvelopeKB: 24 },
    proofs: {
      notarize: 'allow',
      dailyBudgetUSD: '5',
      perActionMaxUSD: '1',
      allowKeyDisclosure: 'approval',
      exportFolder: '~/AgentLink/Proofs',
      defaultChain: 'base',
    },
    // D-109: a delivery receipt is public, so it is off unless the owner turns it on.
    receipts: { autoDelivered: false, autoOpened: false },
    commitments: {
      accept: 'approval',
      autoAcceptContacts: [],
      autoAcceptMaxUSD: '0',
      autoAcceptDirection: 'buy',
      autoAcceptMinUSD: null,
    },
    contactRules: [],
  };
}

/**
 * The 06 §3 defaults in the policy JSON form, deeply frozen. They are the starting document a
 * signing surface edits and the content of the M1-1h `policy.set` signing vector. They are not a
 * fallback for a missing or invalid policy: that is G-6, decided in the core.
 */
export const POLICY_DEFAULTS: DeepReadonly<Policy> = deepFreeze(buildDefaults());

/** A fresh, mutable copy of the 06 §3 defaults (for a signing surface to edit). */
export const defaultPolicy = (): Policy => buildDefaults();

// --- Policy patch (M1-11r-b, D-118) ---------------------------------------------------------------

/** Every field of a strict object section, each optional but never an explicit `undefined`. */
function exactPartial<S extends Record<string, z.ZodType>>(
  shape: S,
): z.ZodObject<{ [K in keyof S]: z.ZodExactOptional<S[K]> }, z.core.$strict> {
  const out: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(shape)) out[key] = field.exactOptional();
  return z.strictObject(out) as unknown as z.ZodObject<
    { [K in keyof S]: z.ZodExactOptional<S[K]> },
    z.core.$strict
  >;
}

const sections = policySchema.shape;

/**
 * A typed edit of the policy for an owner surface (the local UI's Rules and Files pages; M1-11r-b,
 * D-118). It is never signed: the core merges it over the verified policy and builds the complete
 * document `policy.set` signs (04 §2.5.1: "never a partial patch"). Strict like the policy: each
 * object section names only its own fields, each field takes only the values the policy schema
 * takes, a list (`allowedFolders`, `autoAcceptContacts`, `contactRules`, …) is replaced whole, and an
 * unknown key or an explicit `undefined` is rejected, never dropped.
 */
export const policyPatchSchema = z.strictObject({
  contacts: exactPartial(sections.contacts.shape).exactOptional(),
  files: exactPartial(sections.files.shape).exactOptional(),
  envelopes: exactPartial(sections.envelopes.shape).exactOptional(),
  proofs: exactPartial(sections.proofs.shape).exactOptional(),
  receipts: exactPartial(sections.receipts.shape).exactOptional(),
  commitments: exactPartial(sections.commitments.shape).exactOptional(),
  contactRules: sections.contactRules.exactOptional(),
});

export type PolicyPatch = z.infer<typeof policyPatchSchema>;
