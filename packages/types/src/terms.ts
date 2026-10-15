// Terms (D-32, D-55, D-74): the `terms` object of `offer`, `accept` and `reject` (04 §3.4), its
// canonical form, the agent-facing `TermsInput` (06 §2.2a) and the pure negotiation-chain reducer.
//
// Rules:
// - Received terms are untrusted content (I-5): every string and list is bounded (TERMS_LIMITS)
//   before anything else reads it, and terms are only ever checked here, never rendered or executed.
// - Non-canonical input is refused, never rewritten (04 §3.4): nothing here trims, normalises,
//   re-cases or re-orders. A value that parses is returned unchanged, so what the owner sees is
//   exactly what `termsHash` covers.
// - Characters follow the pinned UCD 15.0.0 table (unicode.ts), never the runtime's categories.
// - No hashing here: `termsHash = sha256(JCS(terms))` is `termsHash` in @agentlink/crypto (04 §8.1).
// - The chain reducer is pure: the core (M1-32) replays its own store through it, keyed by
//   `negotiationKey`, and persists the result. It never trusts the counterparty's pointer.
import { z } from 'zod';
import {
  BYTE_LENGTHS,
  MAX_TERMS_NOTE_CODE_POINTS,
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
  sha256Hex,
  uint53,
  utcTimestampToUnixSeconds,
} from './encoding.js';
import { hasCategory15, isTermsRuntimeSupported, type RefusedCategory } from './unicode.js';

// --- canonical form (04 §3.4, D-55, D-74) ---------------------------------------------------------

const REFUSED: ReadonlySet<RefusedCategory> = new Set(['Cc', 'Cf', 'Zl', 'Zp', 'Co', 'Cs', 'Cn']);

/**
 * True when `value` is canonical terms text (04 §3.4 "Characters", D-74): a well-formed string with
 * no code point whose UCD 15.0.0 General_Category is Cc (DEL included), Cf, Zl, Zp, Co, Cs or Cn
 * (unassigned, noncharacters included), equal to its own NFC form. Always false on a runtime older
 * than Unicode 15.0 (`isTermsRuntimeSupported`). Never throws.
 */
export function isCanonicalTermsText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isTermsRuntimeSupported() &&
    isWellFormedString(value) &&
    !hasCategory15(value, REFUSED) &&
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
        'must be NFC text without control, format, separator, private-use or unassigned characters',
    })
    .refine((s) => {
      const n = codePointLength(s);
      return n >= min && n <= max;
    }, `must be ${min}..${max} characters`);

/** `deliverables[].id` and `deadlines[].ref`: `^[A-Za-z0-9_-]{1,16}$` (D-74). */
const deliverableId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,16}$/, 'must be 1 to 16 characters of A-Z, a-z, 0-9, _ or -');

const AMOUNT = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/;
/**
 * `price.amount` (04 §3.4, D-74): `^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$`, greater than zero,
 * hashed as written (so `"1500.00"` and `"1500"` are different terms). A JSON number is refused.
 */
export const termsAmountSchema = z
  .string()
  .max(25, { abort: true })
  .regex(AMOUNT, 'must be a decimal amount: at most 18 digits, 6 decimals, no sign or leading zero')
  .refine((s) => /[1-9]/.test(s), 'must be greater than zero');

const CURRENCY_GRAMMAR = /^[A-Z]{3}$/;
const TOKEN_SYMBOLS: ReadonlySet<string> = new Set(TERMS_TOKEN_SYMBOLS);
/** `price.currency` (04 §3.4, D-74): the grammar `^[A-Z]{3}$` or exactly USDC, USDT or XDAI. */
export const termsCurrencySchema = z
  .string()
  .refine(
    (s) => CURRENCY_GRAMMAR.test(s) || TOKEN_SYMBOLS.has(s),
    'must be 3 upper-case ASCII letters or one of USDC, USDT, XDAI',
  );

/** `deadlines[].due` (04 §3.4): strict RFC 3339 in UTC, `YYYY-MM-DDTHH:MM:SSZ`, a real date. */
export const termsDueSchema = z
  .string()
  .refine(isUtcTimestamp, 'must be an RFC 3339 UTC timestamp: YYYY-MM-DDTHH:MM:SSZ');

const description = termsText(1, TERMS_LIMITS.descriptionCodePoints);
const subject = termsText(1, TERMS_LIMITS.subjectCodePoints);
const positiveInt = uint53.refine((n) => n >= 1, 'must be an integer from 1 to 2^53 - 1');

/** `note` of an offer or reject body: `null` or 1 to 500 code points of canonical text (D-74). */
export const termsNoteSchema = termsText(1, MAX_TERMS_NOTE_CODE_POINTS).nullable();

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
 * The `terms` object (04 §3.4, D-32, D-74): the body of `offer`, `accept` and `reject`, checked on
 * send and on receipt. Every key is always present; `null` only for `price` (no price),
 * `plaintextSha256` (no file) and `previousTermsHash` (version 1). Encodings per 04 §2.4.1:
 * `termsId` base64url (16 bytes), agent IDs `0x` + 40 lower-case hex, hashes bare 64 lower-case hex.
 * Cross-field rules: two distinct parties in ascending byte order; `payer` and every `by` one of
 * them; unique deliverable ids; deadlines name a deliverable, once each; version 1 exactly when
 * `previousTermsHash` is null.
 */
export const termsSchema = z
  .strictObject({
    termsId: base64url(BYTE_LENGTHS.termsId),
    version: positiveInt,
    parties: z.tuple([evmAddress, evmAddress]),
    subject,
    deliverables: z.array(termsDeliverableSchema).min(1).max(TERMS_LIMITS.deliverables),
    price: termsPriceSchema.nullable(),
    deadlines: z.array(deadlineSchema).max(TERMS_LIMITS.deadlines),
    validUntil: positiveInt,
    previousTermsHash: sha256Hex.nullable(),
  })
  .superRefine((t, ctx) => {
    const issue: IssueFn = (message, path) => ctx.addIssue({ code: 'custom', message, path });
    const [a, b] = Array.isArray(t.parties) ? t.parties : [];
    // Canonical lower-case addresses of one length: string order is byte order.
    if (!(typeof a === 'string' && typeof b === 'string' && a < b)) {
      issue('parties must be two distinct agent IDs in ascending order', ['parties']);
    }
    const isParty = (x: unknown) => x === a || x === b;
    if (t.price !== null && t.price !== undefined && !isParty(t.price.payer)) {
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
  });

export type Terms = z.infer<typeof termsSchema>;
export type TermsDeliverable = z.infer<typeof termsDeliverableSchema>;
export type TermsPrice = z.infer<typeof termsPriceSchema>;

// --- TermsInput (06 §2.2a, D-55, D-74) ------------------------------------------------------------

const side = z.enum(['me', 'them']);

/**
 * `TermsInput` (06 §2.2a, D-55, D-74): the only fields an agent may supply to the terms tools. Strict
 * at every level, so `termsId`, `version`, `parties`, `previousTermsHash` and `termsHash`
 * (core-filled) and any unknown key are refused, and so is an explicit `null` anywhere; ids are given
 * on every deliverable or on none. The same
 * canonical-form rules and TERMS_LIMITS as `terms`. `validUntil` is only the strict UTC form
 * `YYYY-MM-DDTHH:MM:SSZ`; that it is after now is checked by `parseTermsInput`.
 */
export const termsInputSchema = z
  .strictObject({
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
  })
  .superRefine((t, ctx) => {
    // The id rules of `terms`, on the ids the mapping will give (defaults d1, d2, … by position),
    // so a duplicate or an unknown deadline ref is refused at the tool input, never renamed.
    // D-74: ids on every deliverable or on none, so a default can never collide with a given id.
    const given = (t.deliverables ?? []).filter((d) => d?.id !== undefined).length;
    if (given !== 0 && given !== (t.deliverables ?? []).length) {
      ctx.addIssue({
        code: 'custom',
        message: 'give an id on every deliverable or on none',
        path: ['deliverables'],
      });
    }
    const ids = (t.deliverables ?? []).map((d, n) => ({ id: d?.id ?? `d${n + 1}` }));
    checkIdsAndRefs(ids, t.deadlines, (message, path) =>
      ctx.addIssue({ code: 'custom', message, path }),
    );
  });

export type TermsInput = z.infer<typeof termsInputSchema>;

/** A validation result that never throws: the value, or the validation error. */
export type TermsResult<T> =
  | { readonly success: true; readonly data: T; readonly error?: undefined }
  | { readonly success: false; readonly data?: undefined; readonly error: z.ZodError };
export type TermsFromInputResult = TermsResult<Terms>;

const failure = <T>(message: string, path: (string | number)[]): TermsResult<T> => ({
  success: false,
  error: new z.ZodError([{ code: 'custom', message, path, input: undefined }]),
});

/**
 * Parses a `TermsInput` at unix time `now` (06 §2.2a, D-74): the strict schema, and a given
 * `validUntil` must be after `now`. Never throws.
 */
export function parseTermsInput(input: unknown, now: number): TermsResult<TermsInput> {
  try {
    if (!uint53.safeParse(now).success) return failure('invalid now', []);
    const parsed = termsInputSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: parsed.error };
    const until = parsed.data.validUntil;
    if (until !== undefined) {
      const seconds = utcTimestampToUnixSeconds(until);
      if (seconds === null || seconds <= now) {
        return failure('validUntil must be after now', ['validUntil']);
      }
    }
    return { success: true, data: parsed.data };
  } catch {
    return failure('invalid terms input', []);
  }
}

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
 * enforced by `parseTermsInput` when the tool runs. Plain, deeply frozen JSON.
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

/**
 * Maps a `TermsInput` to `terms` (06 §2.2a, D-74): fills `termsId`, `version` and
 * `previousTermsHash` from `context` and `parties` as the two agent IDs in ascending order; maps `me`
 * and `them` in `by` and `payer`; gives deliverables without an id `d1`, `d2`, … by position; sets
 * `plaintextSha256` and `price` to null and `deadlines` to `[]` when absent, and `validUntil` to unix
 * seconds (default now + 604 800). The input must pass `parseTermsInput` and the result `termsSchema`;
 * anything else is a validation failure, never a rewrite. Never throws.
 */
export function termsFromInput(input: unknown, context: TermsContext): TermsFromInputResult {
  try {
    const ctx = termsContextSchema.safeParse(context);
    if (!ctx.success) return failure('invalid terms context', []);
    const { termsId, version, previousTermsHash, self, counterparty, now } = ctx.data;
    const parsed = parseTermsInput(input, now);
    if (!parsed.success) return { success: false, error: parsed.error };
    const i = parsed.data;
    const party = (s: 'me' | 'them') => (s === 'me' ? self : counterparty);
    const validUntil =
      i.validUntil === undefined
        ? now + TERMS_DEFAULT_VALIDITY_SECONDS
        : (utcTimestampToUnixSeconds(i.validUntil) as number);
    const terms = {
      termsId,
      version,
      parties: [self, counterparty].sort(),
      subject: i.subject,
      deliverables: i.deliverables.map((d, n) => ({
        id: d.id ?? `d${n + 1}`,
        description: d.description,
        by: party(d.by),
        plaintextSha256: d.plaintextSha256 ?? null,
      })),
      price:
        i.price === undefined
          ? null
          : { amount: i.price.amount, currency: i.price.currency, payer: party(i.price.payer) },
      deadlines: (i.deadlines ?? []).map((d) => ({ ref: d.ref, due: d.due })),
      validUntil,
      previousTermsHash,
    };
    const result = termsSchema.safeParse(terms);
    return result.success
      ? { success: true, data: result.data }
      : { success: false, error: result.error };
  } catch {
    return failure('invalid terms input', []);
  }
}

// --- negotiation chain (04 §3.4, D-55, D-74) -------------------------------------------------------

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

/** A `terms` envelope as the chain sees it: verified sender and recipient, parsed body. */
export interface TermsEnvelope {
  readonly envelopeId: string;
  /** Agent ID of the verified sender. */
  readonly sender: string;
  /** Agent ID of the recipient. */
  readonly recipient: string;
  /** The signed envelope `createdAt` (unix seconds). */
  readonly createdAt: number;
  readonly type: 'offer' | 'accept' | 'reject';
  /** The payload `replyTo`: the answered offer, or on a resend the other side's conflicting envelope. */
  readonly replyTo: string | null;
  readonly terms: Terms;
  /** The body's `termsHash`, already recomputed and checked by the core with @agentlink/crypto. */
  readonly termsHash: string;
}

/** One stored `offer` (sent or received and taken). Refused envelopes never enter the chain. */
export interface StoredTermsOffer {
  readonly envelopeId: string;
  readonly sender: string;
  readonly version: number;
  readonly termsHash: string;
  readonly validUntil: number;
  /** `conflict`: not acceptable since a concurrent counter (rule 3); never the newest version. */
  readonly state: 'open' | 'conflict';
}

/** A conflict on a version: the envelopes in it, one per side (item 1 records only this side's). */
export interface TermsConflict {
  readonly version: number;
  readonly envelopes: readonly { readonly sender: string; readonly envelopeId: string }[];
}

/** The chain state of one negotiation key, as the core keeps it. */
export interface NegotiationState {
  readonly offers: readonly StoredTermsOffer[];
  /** In order; the last one per version is the latest conflict on it. */
  readonly conflicts: readonly TermsConflict[];
  /** Versions for which an `accept` was sent or received (rule 2). */
  readonly lockedVersions: readonly number[];
}

export const EMPTY_NEGOTIATION: NegotiationState = deepFreeze({
  offers: [],
  conflicts: [],
  lockedVersions: [],
});

const envelopeIdSchema = base64url(BYTE_LENGTHS.id);
const termsEnvelopeSchema = z.strictObject({
  envelopeId: envelopeIdSchema,
  sender: evmAddress,
  recipient: evmAddress,
  createdAt: uint53,
  type: z.enum(['offer', 'accept', 'reject']),
  replyTo: envelopeIdSchema.nullable(),
  terms: termsSchema,
  termsHash: sha256Hex,
});
const stateSchema = z.strictObject({
  offers: z.array(
    z.strictObject({
      envelopeId: envelopeIdSchema,
      sender: evmAddress,
      version: positiveInt,
      termsHash: sha256Hex,
      validUntil: positiveInt,
      state: z.enum(['open', 'conflict']),
    }),
  ),
  conflicts: z.array(
    z.strictObject({
      version: positiveInt,
      envelopes: z
        .array(z.strictObject({ sender: evmAddress, envelopeId: envelopeIdSchema }))
        .min(1)
        .max(2),
    }),
  ),
  lockedVersions: z.array(positiveInt),
});

/** The newest open offer of a negotiation (highest version; conflicted offers are skipped). */
export function newestOpenOffer(offers: readonly StoredTermsOffer[]): StoredTermsOffer | undefined {
  let head: StoredTermsOffer | undefined;
  for (const o of Array.isArray(offers) ? offers : []) {
    if (o?.state === 'open' && (head === undefined || o.version > head.version)) head = o;
  }
  return head;
}

const latestConflict = (state: NegotiationState, version: number): TermsConflict | undefined =>
  [...state.conflicts].reverse().find((c) => c.version === version);

/**
 * The chain link a sending core writes (04 §3.4, D-74): `version` = newest open version + 1 and
 * `previousTermsHash` = its `termsHash` (1 and null for a new negotiation). After a conflict on that
 * version, the offer is this side's resend: `replyTo` names the other side's envelope in the latest
 * conflict; otherwise `replyTo` is null. Invalid input gives the new-negotiation link.
 */
export function nextTermsLink(
  state: NegotiationState,
  self: string,
): { version: number; previousTermsHash: string | null; replyTo: string | null } {
  const fresh = { version: 1, previousTermsHash: null, replyTo: null };
  try {
    const st = stateSchema.safeParse(state);
    if (!st.success) return fresh;
    const head = newestOpenOffer(st.data.offers);
    const version = head === undefined ? 1 : head.version + 1;
    const conflict = latestConflict(st.data, version);
    const other = conflict?.envelopes.find((e) => e.sender !== self);
    return {
      version,
      previousTermsHash: head === undefined ? null : head.termsHash,
      replyTo: other === undefined ? null : other.envelopeId,
    };
  } catch {
    return fresh;
  }
}

/**
 * Records an envelope this side sent (the core checked it before sending): an `offer` is stored
 * open, an `accept` locks its version (rule 2), a `reject` changes nothing. Invalid input leaves the
 * state unchanged. Never throws.
 */
export function recordSentTerms(
  state: NegotiationState,
  envelope: TermsEnvelope,
): NegotiationState {
  try {
    const st = stateSchema.safeParse(state);
    const env = termsEnvelopeSchema.safeParse(envelope);
    if (!st.success || !env.success) return state;
    const e = env.data;
    if (e.type === 'offer') {
      return { ...st.data, offers: [...st.data.offers, storedOffer(e, 'open')] };
    }
    if (e.type === 'accept' && !st.data.lockedVersions.includes(e.terms.version)) {
      return { ...st.data, lockedVersions: [...st.data.lockedVersions, e.terms.version] };
    }
    return st.data;
  } catch {
    return state;
  }
}

const storedOffer = (
  e: z.infer<typeof termsEnvelopeSchema>,
  state: 'open' | 'conflict',
): StoredTermsOffer => ({
  envelopeId: e.envelopeId,
  sender: e.sender,
  version: e.terms.version,
  termsHash: e.termsHash,
  validUntil: e.terms.validUntil,
  state,
});

export type TermsRefusal =
  | 'invalid'
  | 'not_a_party'
  | 'locked'
  | 'same_sender'
  | 'version_gap'
  | 'stale_version'
  | 'previous_mismatch'
  | 'resend_link'
  | 'unknown_offer'
  | 'not_own_offer'
  | 'conflicted'
  | 'hash_mismatch'
  | 'expired';

export interface TermsReceipt {
  /**
   * `valid`: stored and taken. `conflict`: concurrent counters (rule 3): both envelopes are not
   * acceptable and pending scopes on this side's are void, except one whose `accept` part has run
   * (rule 4). `refused`: stored as refused and shown in the activity feed; the state is unchanged.
   */
  readonly outcome: 'valid' | 'conflict' | 'refused';
  readonly reason?: TermsRefusal;
  readonly state: NegotiationState;
}

/** Why `terms` does not link to `head`, or null when it is exactly the next version on it. */
function linkRefusal(terms: Terms, head: StoredTermsOffer | undefined): TermsRefusal | null {
  const expectedVersion = head === undefined ? 1 : head.version + 1;
  if (terms.version > expectedVersion) return 'version_gap';
  if (terms.version < expectedVersion) return 'stale_version';
  if (head === undefined) return terms.previousTermsHash === null ? null : 'previous_mismatch';
  return sameTermsHash(terms.previousTermsHash, head.termsHash) ? null : 'previous_mismatch';
}

/**
 * The receiving core's chain step for one `terms` envelope (04 §3.4, D-55, D-74), computed from its
 * own state only. Duplicates (the same envelopeHash) are dropped before this, on the receive path.
 *
 * Offers, in order: `parties` are exactly the sender and this agent; rule 2 (a locked version)
 * first; then, for a `replyTo` (a resend after a conflict, D-74 Q17): item 1 (it names this side's
 * open envelope for the version, which reveals the conflict) and item 2 (it is the sender's first
 * resend naming this side's envelope in the latest conflict), anything else refused (item 3); two
 * resends are a new conflict (item 4). Without `replyTo`: refused after a conflict on the version;
 * rule 1 (one open envelope per version and sender); rule 3 (this side's own offer for the version
 * is the newest: a conflict); else newest + 1 on the newest `termsHash`.
 *
 * Answers: `replyTo` names an open offer this agent sent, the version is not locked, `termsHash`
 * and version equal that offer's, and the envelope `createdAt` is at most its `validUntil`. A valid
 * `accept` locks the version. An accept of this side's superseded offer is valid (06 §2.2a (b)).
 * Never throws.
 */
export function receiveTerms(
  state: NegotiationState,
  envelope: TermsEnvelope,
  self: string,
): TermsReceipt {
  try {
    const st = stateSchema.safeParse(state);
    const env = termsEnvelopeSchema.safeParse(envelope);
    if (!st.success || !env.success || !evmAddress.safeParse(self).success) {
      return { outcome: 'refused', reason: 'invalid', state };
    }
    const s = st.data;
    const e = env.data;
    const refuse = (reason: TermsRefusal): TermsReceipt => ({ outcome: 'refused', reason, state });
    const [a, b] = e.terms.parties;
    if (
      e.recipient !== self ||
      e.sender === self ||
      !((a === e.sender && b === self) || (a === self && b === e.sender))
    ) {
      return refuse('not_a_party');
    }
    return e.type === 'offer'
      ? receiveOffer(s, e, self, refuse)
      : receiveAnswer(s, e, self, refuse);
  } catch {
    return { outcome: 'refused', reason: 'invalid', state };
  }
}

type Env = z.infer<typeof termsEnvelopeSchema>;
type State = z.infer<typeof stateSchema>;

function receiveOffer(
  s: State,
  e: Env,
  self: string,
  refuse: (reason: TermsRefusal) => TermsReceipt,
): TermsReceipt {
  const n = e.terms.version;
  if (s.lockedVersions.includes(n)) return refuse('locked');
  const open = s.offers.filter((o) => o.state === 'open');
  const ownAtN = open.filter((o) => o.version === n && o.sender === self);
  const senderAtN = open.filter((o) => o.version === n && o.sender === e.sender);
  const base = newestOpenOffer(open.filter((o) => o.version < n));
  const latest = latestConflict(s, n);
  const valid = (offers: StoredTermsOffer[], conflicts = s.conflicts): TermsReceipt => ({
    outcome: 'valid',
    state: { ...s, offers, conflicts },
  });
  const conflict = (mine: readonly StoredTermsOffer[]): TermsReceipt => {
    const ids = new Set(mine.map((o) => o.envelopeId));
    const offers = s.offers.map((o) =>
      ids.has(o.envelopeId) ? { ...o, state: 'conflict' as const } : o,
    );
    return {
      outcome: 'conflict',
      state: {
        ...s,
        offers: [...offers, storedOffer(e, 'conflict')],
        conflicts: [
          ...s.conflicts,
          {
            version: n,
            envelopes: [
              ...mine.map((o) => ({ sender: o.sender, envelopeId: o.envelopeId })),
              { sender: e.sender, envelopeId: e.envelopeId },
            ],
          },
        ],
      },
    };
  };

  if (e.replyTo !== null) {
    const target = s.offers.find((o) => o.envelopeId === e.replyTo);
    // Item 1: it names this side's open envelope for n, so a conflict exists that this side has
    // not seen. This side's envelope becomes not acceptable; the resend is the sender's live one.
    if (
      target !== undefined &&
      target.version === n &&
      target.sender === self &&
      target.state === 'open'
    ) {
      if (senderAtN.length > 0) return refuse('same_sender');
      const link = linkRefusal(e.terms, base);
      if (link !== null) return refuse(link);
      const offers = s.offers.map((o) =>
        o.envelopeId === target.envelopeId ? { ...o, state: 'conflict' as const } : o,
      );
      return valid(
        [...offers, storedOffer(e, 'open')],
        [
          ...s.conflicts,
          { version: n, envelopes: [{ sender: self, envelopeId: target.envelopeId }] },
        ],
      );
    }
    // Item 2: the sender's first resend after the latest conflict, naming this side's envelope in it.
    const mine = latest?.envelopes.find((x) => x.sender === self);
    if (mine === undefined || mine.envelopeId !== e.replyTo) return refuse('resend_link');
    if (senderAtN.length > 0) return refuse('same_sender');
    const link = linkRefusal(e.terms, base);
    if (link !== null) return refuse(link);
    // Item 4: this side's own resend is live too: a new conflict.
    if (ownAtN.length > 0) return conflict(ownAtN);
    return valid([...s.offers, storedOffer(e, 'open')]);
  }

  // After a conflict on n, an envelope for n needs the resend link (item 2).
  if (latest !== undefined) return refuse('resend_link');
  if (senderAtN.length > 0) return refuse('same_sender');
  const head = newestOpenOffer(open);
  if (head !== undefined && head.version === n && head.sender === self) {
    const link = linkRefusal(e.terms, base);
    if (link !== null) return refuse(link);
    return conflict(ownAtN);
  }
  const link = linkRefusal(e.terms, head);
  if (link !== null) return refuse(link);
  return valid([...s.offers, storedOffer(e, 'open')]);
}

function receiveAnswer(
  s: State,
  e: Env,
  self: string,
  refuse: (reason: TermsRefusal) => TermsReceipt,
): TermsReceipt {
  if (e.replyTo === null) return refuse('unknown_offer');
  const answered = s.offers.find((o) => o.envelopeId === e.replyTo);
  if (answered === undefined) return refuse('unknown_offer');
  if (answered.sender !== self) return refuse('not_own_offer');
  // Rule 2 takes precedence: a locked version takes no other envelope (D-74, IR-D-74-1 F04).
  if (s.lockedVersions.includes(answered.version) || s.lockedVersions.includes(e.terms.version)) {
    return refuse('locked');
  }
  if (answered.state !== 'open') return refuse('conflicted');
  if (answered.version !== e.terms.version || !sameTermsHash(answered.termsHash, e.termsHash)) {
    return refuse('hash_mismatch');
  }
  // Judged by the signed createdAt, never the receiver's clock (D-74 Q14, IR-D-74-1 F03).
  if (e.createdAt > answered.validUntil) return refuse('expired');
  const lockedVersions =
    e.type === 'accept' ? [...s.lockedVersions, e.terms.version] : s.lockedVersions;
  return { outcome: 'valid', state: { ...s, lockedVersions } };
}

export type SendAcceptRefusal =
  'invalid' | 'unknown_offer' | 'own_offer' | 'conflicted' | 'superseded' | 'locked' | 'expired';

/**
 * The sending core's check before an `accept` (04 §3.4): the offer is stored, was received from the
 * contact, is not conflicted, is the newest open version of its negotiation (`superseded`,
 * TERMS_SUPERSEDED), its version is not locked, and `now` (this core's clock) is at most its
 * `validUntil` (`expired`, TERMS_EXPIRED; D-74 Q14). Returns the `termsHash` to quote. Never throws.
 */
export function checkSendAccept(
  state: NegotiationState,
  offerEnvelopeId: string,
  self: string,
  now: number,
):
  | { readonly result: 'allowed'; readonly termsHash: string }
  | { readonly result: 'refuse'; readonly reason: SendAcceptRefusal } {
  try {
    const st = stateSchema.safeParse(state);
    if (!st.success || !evmAddress.safeParse(self).success || !uint53.safeParse(now).success) {
      return { result: 'refuse', reason: 'invalid' };
    }
    const { offers, lockedVersions } = st.data;
    const offer = offers.find((o) => o.envelopeId === offerEnvelopeId);
    if (offer === undefined) return { result: 'refuse', reason: 'unknown_offer' };
    if (offer.sender === self) return { result: 'refuse', reason: 'own_offer' };
    if (offer.state !== 'open') return { result: 'refuse', reason: 'conflicted' };
    if (lockedVersions.includes(offer.version)) return { result: 'refuse', reason: 'locked' };
    if (newestOpenOffer(offers)?.envelopeId !== offer.envelopeId) {
      return { result: 'refuse', reason: 'superseded' };
    }
    if (now > offer.validUntil) return { result: 'refuse', reason: 'expired' };
    return { result: 'allowed', termsHash: offer.termsHash };
  } catch {
    return { result: 'refuse', reason: 'invalid' };
  }
}
