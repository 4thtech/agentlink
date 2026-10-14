// Contact-name rule vocabulary (06 §2.1, D-53). `restrictName` itself is built in M1-7c; this file
// fixes the words and makes the rule visible in the types: a counterparty's name can be shown only as
// a RestrictedName, and only owner-set text may be an OwnerAlias. Both are compile-time brands, so a
// raw (untrusted) string cannot be passed where either is required.

const freeze = <T>(value: T): Readonly<T> => Object.freeze(value);

/** Identity labels that follow every shown name (11 §5.2). A label is never derived from a name. */
export const IDENTITY_LABELS = freeze([
  'self-declared',
  'safety-code-checked',
  'registered',
  'verified-domain',
] as const);
export type IdentityLabel = (typeof IDENTITY_LABELS)[number];

export const NAME_SOURCES = freeze(['counterparty', 'owner'] as const);
export type NameSource = (typeof NAME_SOURCES)[number];

/** Words reserved for system labels; a name containing one (case-insensitively) falls back (06 §2.1). */
export const RESERVED_NAME_WORDS = freeze([
  'verified',
  'registered',
  'self-declared',
  'safety code',
  'checked',
  'AgentLink',
  'system',
  'approved',
  'owner',
] as const);

/** The fallback name, followed by the short owner fingerprint (06 §2.1). */
export const RESTRICTED_NAME_FALLBACK = 'Contact';
/** Maximum length of a restricted name, in code points after NFKC (06 §2.1). */
export const RESTRICTED_NAME_MAX_CODE_POINTS = 32;

declare const restrictedNameBrand: unique symbol;
declare const ownerAliasBrand: unique symbol;

/** Output of `restrictName` (M1-7c) only. Never cast a raw name to this type. */
export type RestrictedName = string & { readonly [restrictedNameBrand]: true };
/** Text the owner typed or confirmed (06 §2.1 rule 1). Never cast agent-written text to this type. */
export type OwnerAlias = string & { readonly [ownerAliasBrand]: true };

/** How a contact or signer is shown outside the untrusted block (06 §2.1). */
export type ContactDisplayName =
  | { name: OwnerAlias; label: IdentityLabel; nameSource: 'owner' }
  | { name: RestrictedName; label: IdentityLabel; nameSource: 'counterparty' };
