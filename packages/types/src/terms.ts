// Terms (D-32, D-55): the `terms` object of `offer`, `accept` and `reject` (04 §3.4), its canonical
// form, the agent-facing `TermsInput` (06 §2.2a) and the pure negotiation-chain rules.
//
// Rules:
// - Received terms are untrusted content (I-5): every string, list and the whole object are bounded
//   (TERMS_LIMITS) before anything else reads them, and they are only ever checked, never rendered
//   or executed here.
// - Non-canonical input is refused, never rewritten (04 §3.4): nothing here trims, normalises,
//   re-cases or re-orders. A value that parses is returned unchanged, so what the owner sees is
//   exactly what `termsHash` covers.
// - No hashing here: `termsHash = sha256(JCS(terms))` is `termsHash` in @agentlink/crypto (04 §8.1).
// - The chain helpers are pure: the core (M1-32) reads its own store, passes the offers of one
//   negotiation key and applies the result. They never trust the counterparty's pointer.
import { z } from 'zod';
import {
  BYTE_LENGTHS,
  TERMS_DEFAULT_VALIDITY_SECONDS,
  TERMS_LIMITS,
  TERMS_TOKEN_SYMBOLS,
} from './constants.js';
import {
  base64url,
  bytesEqual,
  codePointLength,
  evmAddress,
  hexToBytes,
  isUtcTimestamp,
  isWellFormedString,
  jsonByteLength,
  sha256Hex,
  uint53,
  utcTimestampToUnixSeconds,
} from './encoding.js';

// --- canonical form (04 §3.4, IR-D55-1 F07) -------------------------------------------------------

// C0 and C1 controls and DEL (Cc); every format character (Cf), which includes the bidi controls
// U+200E, U+200F, U+202A-U+202E, U+2066-U+2069 and the zero-width characters; private use (Co);
// surrogates (Cs: only a lone one can occur in a JS string).
const NOT_CANONICAL_CHAR = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u;

/**
 * True when `value` is canonical terms text (04 §3.4): a well-formed string in Unicode NFC with no C0
 * or C1 control, no bidi control, no other format character (zero-width characters included) and
 * no private-use code point. Never throws.
 */
export function isCanonicalTermsText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isWellFormedString(value) &&
    !NOT_CANONICAL_CHAR.test(value) &&
    value.normalize('NFC') === value
  );
}

/** Canonical terms text of `min`..`max` code points. */
const termsText = (min: number, max: number) =>
  z
    .string()
    // A code point is at most 2 UTF-16 units: refuse anything longer before any other check reads it.
    .max(max * 2, { abort: true })
    .refine(isCanonicalTermsText, {
      message:
        'must be NFC text without control, bidi, zero-width or other format, or private-use characters',
    })
    .refine((s) => {
      const n = codePointLength(s);
      return n >= min && n <= max;
    }, `must be ${min}..${max} characters`);

const AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;
/**
 * `price.amount` (04 §3.4, §2.4.1 "Other decimal amounts"): `^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$`,
 * greater than zero, hashed as written (so `"1500.00"` and `"1500"` are different terms). A JSON
 * number is refused.
 */
export const termsAmountSchema = z
  .string()
  .max(TERMS_LIMITS.amountLength)
  .regex(AMOUNT, 'must be a decimal amount with at most 6 decimals, no sign and no leading zero')
  .refine((s) => /[1-9]/.test(s), 'must be greater than zero');

const ISO_4217 = /^[A-Z]{3}$/;
const TOKEN_SYMBOLS: ReadonlySet<string> = new Set(TERMS_TOKEN_SYMBOLS);
/** `price.currency` (04 §3.4): `^[A-Z]{3}$` (ISO 4217) or exactly an allowlisted token symbol. */
export const termsCurrencySchema = z
  .string()
  .refine(
    (s) => ISO_4217.test(s) || TOKEN_SYMBOLS.has(s),
    'must be an ISO 4217 code (3 upper-case ASCII letters) or an allowlisted token symbol',
  );

/** `deadlines[].due` (04 §3.4): strict RFC 3339 in UTC, `YYYY-MM-DDTHH:MM:SSZ`. */
export const termsDueSchema = z
  .string()
  .refine(isUtcTimestamp, 'must be an RFC 3339 UTC timestamp: YYYY-MM-DDTHH:MM:SSZ');

const deliverableId = termsText(1, TERMS_LIMITS.deliverableIdCodePoints);
const description = termsText(1, TERMS_LIMITS.descriptionCodePoints);
const subject = termsText(1, TERMS_LIMITS.subjectCodePoints);
const positiveInt = uint53.refine((n) => n >= 1, 'must be a positive integer');

const deadlineSchema = z.strictObject({ ref: deliverableId, due: termsDueSchema });

// --- terms (04 §3.4) ------------------------------------------------------------------------------

export const termsDeliverableSchema = z.strictObject({
  id: deliverableId,
  description,
  /** The party that delivers. */
  by: evmAddress,
  plaintextSha256: sha256Hex.nullable(),
});

export const termsPriceSchema = z.strictObject({
  amount: termsAmountSchema,
  currency: termsCurrencySchema,
  /** The party that pays. `price` is informational: AgentLink moves no money (04 §3.4). */
  payer: evmAddress,
});

type IssueFn = (message: string, path: (string | number)[]) => void;

/** Deliverable ids unique; every deadline names a deliverable, at most once. */
function checkIdsAndRefs(
  deliverables: readonly { id?: unknown }[] | undefined,
  deadlines: readonly { ref?: unknown }[] | undefined,
  issue: IssueFn,
): void {
  const ids = new Set<unknown>();
  (deliverables ?? []).forEach((d, i) => {
    if (ids.has(d?.id)) issue('deliverable ids must be unique', ['deliverables', i, 'id']);
    ids.add(d?.id);
  });
  const refs = new Set<unknown>();
  (deadlines ?? []).forEach((d, i) => {
    if (!ids.has(d?.ref)) issue('deadline ref must name a deliverable', ['deadlines', i, 'ref']);
    if (refs.has(d?.ref)) issue('one deadline per deliverable', ['deadlines', i, 'ref']);
    refs.add(d?.ref);
  });
}

/**
 * The `terms` object (04 §3.4, D-32): the body of `offer`, `accept` and `reject`, checked on send
 * and on receipt. Every field is required except `price` (absent, never null, when there is none);
 * `deadlines` is `[]` when there are none. Encodings per 04 §2.4.1: `termsId` base64url (16 bytes),
 * agent IDs `0x` + 40 lower-case hex, hashes bare 64 lower-case hex. Cross-field rules: two distinct
 * parties (written in either order and hashed as written); `payer` and every `by` one of them;
 * unique deliverable ids; deadlines name a deliverable, once each; version 1 exactly when there is
 * no `previousTermsHash`; the whole object at most TERMS_LIMITS.maxBytes.
 */
export const termsSchema = z
  .strictObject({
    termsId: base64url(BYTE_LENGTHS.termsId),
    version: positiveInt,
    parties: z.tuple([evmAddress, evmAddress]),
    subject,
    deliverables: z.array(termsDeliverableSchema).min(1).max(TERMS_LIMITS.deliverables),
    price: termsPriceSchema.exactOptional(),
    deadlines: z.array(deadlineSchema).max(TERMS_LIMITS.deadlines),
    validUntil: positiveInt,
    previousTermsHash: sha256Hex.nullable(),
  })
  .superRefine((t, ctx) => {
    const issue: IssueFn = (message, path) => ctx.addIssue({ code: 'custom', message, path });
    const [a, b] = Array.isArray(t.parties) ? t.parties : [];
    if (a === b) issue('the two parties must differ', ['parties']);
    const isParty = (x: unknown) => x === a || x === b;
    if (t.price !== undefined && !isParty(t.price?.payer)) {
      issue('payer must be one of the parties', ['price', 'payer']);
    }
    (t.deliverables ?? []).forEach((d, i) => {
      if (!isParty(d?.by)) issue('by must be one of the parties', ['deliverables', i, 'by']);
    });
    checkIdsAndRefs(t.deliverables, t.deadlines, issue);
    if ((t.version === 1) !== (t.previousTermsHash === null)) {
      issue('version 1 has no previousTermsHash and every later version has one', [
        'previousTermsHash',
      ]);
    }
    if (jsonByteLength(t) > TERMS_LIMITS.maxBytes) {
      issue(`terms exceed ${TERMS_LIMITS.maxBytes} bytes`, []);
    }
  });

export type Terms = z.infer<typeof termsSchema>;
export type TermsDeliverable = z.infer<typeof termsDeliverableSchema>;
export type TermsPrice = z.infer<typeof termsPriceSchema>;

// --- TermsInput (06 §2.2a, D-55) ------------------------------------------------------------------

const side = z.enum(['me', 'them']);

/**
 * `TermsInput` (06 §2.2a, D-55): the only fields an agent may supply to the terms tools. Strict at
 * every level, so `termsId`, `version`, `parties`, `previousTermsHash` and `termsHash` (core-filled)
 * and any unknown key are refused. The same canonical-form rules and TERMS_LIMITS as `terms`.
 * `validUntil` is the strict UTC form `YYYY-MM-DDTHH:MM:SSZ`; `by` and `payer` are `me` or `them`.
 */
export const termsInputSchema = z.strictObject({
  subject,
  deliverables: z
    .array(
      z.strictObject({
        id: deliverableId.exactOptional(),
        description,
        by: side,
        plaintextSha256: sha256Hex.exactOptional(),
      }),
    )
    .min(1)
    .max(TERMS_LIMITS.deliverables),
  price: z
    .strictObject({ amount: termsAmountSchema, currency: termsCurrencySchema, payer: side })
    .exactOptional(),
  deadlines: z.array(deadlineSchema).max(TERMS_LIMITS.deadlines).exactOptional(),
  validUntil: termsDueSchema.exactOptional(),
});

export type TermsInput = z.infer<typeof termsInputSchema>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * The JSON Schema of `TermsInput` for the MCP tool list (06 §2.2a). It describes the shape, with
 * every object closed (`additionalProperties: false`); the canonical-form and length rules are
 * enforced by `termsInputSchema` when the tool runs. Plain, deeply frozen JSON.
 */
export const termsInputJsonSchema: Readonly<Record<string, unknown>> = deepFreeze(
  JSON.parse(
    JSON.stringify(z.toJSONSchema(termsInputSchema, { io: 'input', unrepresentable: 'any' })),
  ) as Record<string, unknown>,
);

/** What the core fills in (06 §2.2a): from its own store and its own identity, never from the agent. */
export interface TermsContext {
  /** Base64url of 16 bytes: a new random ID for version 1, else the negotiation's ID. */
  readonly termsId: string;
  /** From `nextTermsLink` over the core's own store. */
  readonly version: number;
  readonly previousTermsHash: string | null;
  /** This agent's ID (`me`). */
  readonly self: string;
  /** The contact's agent ID (`them`). */
  readonly counterparty: string;
  /** Unix seconds now. */
  readonly now: number;
}

const termsContextSchema = z.strictObject({
  termsId: base64url(BYTE_LENGTHS.termsId),
  version: positiveInt,
  previousTermsHash: sha256Hex.nullable(),
  self: evmAddress,
  counterparty: evmAddress,
  now: uint53,
});

/** The result of `termsFromInput`: the terms, or the validation error (never a throw). */
export type TermsFromInputResult =
  | { readonly success: true; readonly data: Terms; readonly error?: undefined }
  | { readonly success: false; readonly data?: undefined; readonly error: z.ZodError };

const failure = (message: string, path: (string | number)[]): TermsFromInputResult => ({
  success: false,
  error: new z.ZodError([{ code: 'custom', message, path, input: undefined }]),
});

/**
 * Maps a `TermsInput` to `terms` (06 §2.2a): fills `termsId`, `version`, `parties` (`[self,
 * counterparty]`) and `previousTermsHash` from `context`; maps `me` and `them` in `by` and `payer`
 * to the two agent IDs; gives deliverables without an id `d1`, `d2`, … by position; sets
 * `plaintextSha256` to null when absent, `deadlines` to `[]` when absent and `validUntil` to unix
 * seconds (default now + 7 days). The result must parse as `terms`, and `validUntil` must be after
 * `now`. Anything else is a validation failure: a default id that collides with a given one is
 * refused, never renamed. Never throws.
 */
export function termsFromInput(input: unknown, context: TermsContext): TermsFromInputResult {
  try {
    const parsed = termsInputSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: parsed.error };
    const ctx = termsContextSchema.safeParse(context);
    if (!ctx.success) return failure('invalid terms context', []);
    const { termsId, version, previousTermsHash, self, counterparty, now } = ctx.data;
    const i = parsed.data;
    const party = (s: 'me' | 'them') => (s === 'me' ? self : counterparty);
    const validUntil =
      i.validUntil === undefined
        ? now + TERMS_DEFAULT_VALIDITY_SECONDS
        : utcTimestampToUnixSeconds(i.validUntil);
    if (validUntil === null || validUntil <= now) {
      return failure('validUntil must be after now', ['validUntil']);
    }
    const terms: Record<string, unknown> = {
      termsId,
      version,
      parties: [self, counterparty],
      subject: i.subject,
      deliverables: i.deliverables.map((d, n) => ({
        id: d.id ?? `d${n + 1}`,
        description: d.description,
        by: party(d.by),
        plaintextSha256: d.plaintextSha256 ?? null,
      })),
    };
    if (i.price !== undefined) {
      terms.price = {
        amount: i.price.amount,
        currency: i.price.currency,
        payer: party(i.price.payer),
      };
    }
    terms.deadlines = (i.deadlines ?? []).map((d) => ({ ref: d.ref, due: d.due }));
    terms.validUntil = validUntil;
    terms.previousTermsHash = previousTermsHash;
    const result = termsSchema.safeParse(terms);
    return result.success
      ? { success: true, data: result.data }
      : { success: false, error: result.error };
  } catch {
    return failure('invalid terms input', []);
  }
}

// --- negotiation chain (04 §3.4, IR-D55-1 F04, IR-D55-2) ------------------------------------------

/**
 * The negotiation key (04 §3.4): `termsId` plus the unordered pair of parties, so a `termsId` from
 * one pair never affects another. Use it on parsed terms only (canonical spellings).
 */
export function negotiationKey(termsId: string, parties: readonly string[]): string {
  const [a, b] = [...parties].sort();
  return `${termsId}/${a}/${b}`;
}

/** Byte equality of two canonical `termsHash` values (bare 64 lower-case hex). Any other form: false. */
export function sameTermsHash(a: unknown, b: unknown): boolean {
  if (!sha256Hex.safeParse(a).success || !sha256Hex.safeParse(b).success) return false;
  return bytesEqual(hexToBytes(a), hexToBytes(b));
}

/**
 * One stored `offer` of a negotiation, from the core's own store (sent or received). Refused
 * envelopes never enter the chain and are not passed. `conflict`: marked not acceptable by a
 * concurrent counter (no-fork rule 3); it no longer counts as the newest version.
 */
export interface StoredTermsOffer {
  readonly envelopeId: string;
  /** Agent ID of the party that sent it. */
  readonly sender: string;
  readonly version: number;
  readonly termsHash: string;
  readonly state: 'open' | 'conflict';
}

/** The newest open offer of a negotiation (highest version; conflicted offers are skipped). */
export function newestOpenOffer(offers: readonly StoredTermsOffer[]): StoredTermsOffer | undefined {
  let head: StoredTermsOffer | undefined;
  for (const o of offers) {
    if (o.state === 'open' && (head === undefined || o.version > head.version)) head = o;
  }
  return head;
}

/** The chain link a sending core writes (04 §3.4): newest version + 1 and its `termsHash`. */
export function nextTermsLink(offers: readonly StoredTermsOffer[]): {
  version: number;
  previousTermsHash: string | null;
} {
  const head = newestOpenOffer(offers);
  return head === undefined
    ? { version: 1, previousTermsHash: null }
    : { version: head.version + 1, previousTermsHash: head.termsHash };
}

export type OfferRefusal =
  | 'invalid'
  | 'not_a_party'
  | 'locked'
  | 'same_sender'
  | 'version_gap'
  | 'stale_version'
  | 'previous_mismatch';

export type OfferEvaluation =
  | { readonly result: 'accept' }
  /** The same envelope is already stored: nothing to do. */
  | { readonly result: 'duplicate' }
  /** Store the envelope as refused and show it in the activity feed (04 §3.4). */
  | { readonly result: 'refuse'; readonly reason: OfferRefusal }
  /**
   * Concurrent counters (no-fork rule 3): mark both this envelope and `with` (this side's own
   * offer for the same version) not acceptable and void pending scopes on them, except one whose
   * `accept` part has run (rule 4). The previous version stays the newest.
   */
  | { readonly result: 'conflict'; readonly with: string };

export interface IncomingOffer {
  readonly envelopeId: string;
  /** The verified sender's agent ID. */
  readonly sender: string;
  /** This agent's ID (the receiver). */
  readonly self: string;
  readonly terms: Terms;
}

export interface NegotiationState {
  /** The stored offers of this negotiation key (`negotiationKey`), both directions. */
  readonly offers: readonly StoredTermsOffer[];
  /** Versions for which an `accept` was sent or received (no-fork rule 2). */
  readonly lockedVersions: readonly number[];
}

const storedOfferSchema = z.strictObject({
  envelopeId: base64url(BYTE_LENGTHS.id),
  sender: evmAddress,
  version: positiveInt,
  termsHash: sha256Hex,
  state: z.enum(['open', 'conflict']),
});
const incomingSchema = z.strictObject({
  envelopeId: base64url(BYTE_LENGTHS.id),
  sender: evmAddress,
  self: evmAddress,
  terms: termsSchema,
});
const stateSchema = z.strictObject({
  offers: z.array(storedOfferSchema),
  lockedVersions: z.array(positiveInt),
});

/** Why `terms` does not link to `head`, or null when it is exactly the next version on it. */
function linkRefusal(terms: Terms, head: StoredTermsOffer | undefined): OfferRefusal | null {
  const expected = nextTermsLink(head === undefined ? [] : [head]);
  if (terms.version > expected.version) return 'version_gap';
  if (terms.version < expected.version) return 'stale_version';
  if (expected.previousTermsHash === null)
    return terms.previousTermsHash === null ? null : 'previous_mismatch';
  return sameTermsHash(terms.previousTermsHash, expected.previousTermsHash)
    ? null
    : 'previous_mismatch';
}

/**
 * The receiving core's chain check for an incoming `offer` (04 §3.4, D-55), computed from its own
 * store only. In order:
 * 1. `parties` must be exactly the sender and this agent (`not_a_party`).
 * 2. An envelope already stored is a `duplicate`.
 * 3. A version with a sent or received `accept` is `locked` (no-fork rule 2).
 * 4. A second open offer for the same version from the same sender is refused (`same_sender`,
 *    rule 1; the first one seen wins). Conflicted offers do not count, so after a conflict either
 *    side may send that version again (rule 3).
 * 5. If the newest open offer is this side's own offer for the same version, and the incoming one
 *    links to the same base, it is a `conflict` (rule 3, no tie-break). Otherwise it is refused
 *    with its link error.
 * 6. Else the offer must be the newest version + 1 with `previousTermsHash` equal to the newest
 *    `termsHash` (`version_gap`, `stale_version`, `previous_mismatch`).
 * Invalid input is refused (`invalid`); never throws.
 */
export function evaluateIncomingOffer(
  incoming: IncomingOffer,
  state: NegotiationState,
): OfferEvaluation {
  try {
    const inc = incomingSchema.safeParse(incoming);
    const st = stateSchema.safeParse(state);
    if (!inc.success || !st.success) return { result: 'refuse', reason: 'invalid' };
    const { envelopeId, sender, self, terms } = inc.data;
    const { offers, lockedVersions } = st.data;
    const [a, b] = terms.parties;
    if (sender === self || !((a === sender && b === self) || (a === self && b === sender))) {
      return { result: 'refuse', reason: 'not_a_party' };
    }
    if (offers.some((o) => o.envelopeId === envelopeId)) return { result: 'duplicate' };
    if (lockedVersions.includes(terms.version)) return { result: 'refuse', reason: 'locked' };
    const open = offers.filter((o) => o.state === 'open');
    if (open.some((o) => o.version === terms.version && o.sender === sender)) {
      return { result: 'refuse', reason: 'same_sender' };
    }
    const head = newestOpenOffer(open);
    if (head !== undefined && head.version === terms.version && head.sender !== sender) {
      const base = newestOpenOffer(open.filter((o) => o.version < terms.version));
      const refusal = linkRefusal(terms, base);
      return refusal === null
        ? { result: 'conflict', with: head.envelopeId }
        : { result: 'refuse', reason: refusal };
    }
    const refusal = linkRefusal(terms, head);
    return refusal === null ? { result: 'accept' } : { result: 'refuse', reason: refusal };
  } catch {
    return { result: 'refuse', reason: 'invalid' };
  }
}
