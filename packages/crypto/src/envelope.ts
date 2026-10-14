// The 04 §3.1 envelope (M1-1c): its strict v1 structure, envelopeHash, the payload AEAD's additional
// data, and the BIP-340 signature under the `agentlink/envelope/v1` tag.
//
// Every function that reads an envelope first parses it strictly (04 §2.4.1): unknown or missing
// keys, a wrong type, a non-canonical encoding or a wrong byte length is refused with
// `invalid_envelope`, never normalised. The parser also enforces the 04 §3.1.1 limits it owns
// (G-2): 1 to 8 recipients with distinct `kid`s, checked before any entry is read, and `aead.ct` of
// at most 17 152 bytes, checked on the string before decoding. Parsing reads each value once into a fresh frozen copy, and
// the hash, the AAD and the signature check all work on that copy, so an input changed afterwards
// (or a getter) cannot make what is checked differ from what is hashed.
//
// The parser works on parsed JSON values. Checks on the JSON text itself (duplicate keys, integer
// tokens such as `1.0`) belong to the text parser (parseJson, and @agentlink/types in M1-2a).
//
// Errors never contain the input (I-7): see errors.ts.
import { bip340Sign, bip340Verify } from './bip340.js';
import { assertBytes } from './bytes.js';
import { decodeBase64url, decodeHex } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { TAGS, sha256, taggedHash } from './hash.js';
import { canonicalizeToBytes } from './jcs.js';

/** 04 §3.1: the only envelope version. */
export const ENVELOPE_VERSION = 1;
/** Raw byte length of the envelope `id` (16 random bytes). */
export const ENVELOPE_ID_LENGTH = 16;
/** Raw byte length of `thread`. */
export const THREAD_ID_LENGTH = 16;
/** Raw byte length of a recipient `kid`: the first 16 bytes of sha256(encPub). */
export const KID_LENGTH = 16;
/** Raw byte length of a recipient `enc`: the HPKE encapsulated X25519 key. */
export const HPKE_ENC_LENGTH = 32;
/** Raw byte length of a recipient `wk`: the sealed 32-byte CEK plus the 16-byte tag. */
export const WRAPPED_CEK_LENGTH = 48;
/** The content encryption key: 32 random bytes per envelope (04 §3.3). */
export const CEK_LENGTH = 32;
/**
 * The payload AEAD (04 §3.1, §3.3; G-46, D-66): AES-256-GCM under a payload key derived from the
 * CEK, with the 32-byte key commitment `kc`. The earlier `A256GCM` form is refused.
 */
export const AEAD_ALG = 'A256GCM-KC';
/** Raw byte length of `aead.kc`, the key commitment derived from the CEK (04 §3.3). */
export const KEY_COMMITMENT_LENGTH = 32;
/** Raw byte length of `aead.iv`. */
export const AEAD_IV_LENGTH = 12;
/** Raw byte length of the GCM tag at the end of `aead.ct`. */
export const AEAD_TAG_LENGTH = 16;
/** 04 §3.1.1 (G-2): at most 8 recipient entries, each with a distinct `kid`. */
export const MAX_RECIPIENTS = 8;
/**
 * 04 §3.1.1 (G-2): `aead.ct` decodes to at most 17 152 bytes (payload plaintext ≤ 17 136 bytes), so
 * every envelope that passes the parser fits the 24 576-byte envelope limit as JCS.
 */
export const AEAD_CT_MAX_LENGTH = 17_152;
/** The base64url length (no padding) of AEAD_CT_MAX_LENGTH bytes, checked before decoding. */
export const AEAD_CT_MAX_ENCODED_LENGTH = 22_870;

/** One recipient entry; every value base64url without padding (04 §2.4.1). */
export interface EnvelopeRecipient {
  readonly kid: string;
  readonly enc: string;
  readonly wk: string;
}

/**
 * The payload AEAD; `iv`, `kc` (the 32-byte key commitment) and `ct` (ciphertext || 16-byte tag)
 * base64url without padding (04 §3.1).
 */
export interface EnvelopeAead {
  readonly alg: typeof AEAD_ALG;
  readonly iv: string;
  readonly kc: string;
  readonly ct: string;
}

/** The fields the payload AEAD authenticates as its additional data (04 §3.1). */
export interface EnvelopeHeader {
  readonly v: typeof ENVELOPE_VERSION;
  /** base64url, 16 bytes. */
  readonly id: string;
  /** base64url, 16 bytes. */
  readonly thread: string;
  /** The sender's x-only Nostr key: 64 lowercase hex, no `0x`. */
  readonly from: string;
  /** Unix seconds: an integer in [0, 2^53 - 1]. */
  readonly createdAt: number;
  /** 1 to 8, with distinct `kid`s; the order is covered by the AAD and the hash. */
  readonly recipients: readonly EnvelopeRecipient[];
}

/** An envelope before signing: what envelopeHash covers. */
export interface UnsignedEnvelope extends EnvelopeHeader {
  readonly aead: EnvelopeAead;
}

/** A signed envelope (04 §3.1). */
export interface Envelope extends UnsignedEnvelope {
  /** BIP-340 signature by `from`: 128 lowercase hex, no `0x`. */
  readonly sig: string;
}

const HEADER_KEYS = ['v', 'id', 'thread', 'from', 'createdAt', 'recipients'] as const;
const UNSIGNED_KEYS = [...HEADER_KEYS, 'aead'] as const;
const SIGNED_KEYS = [...UNSIGNED_KEYS, 'sig'] as const;
const RECIPIENT_KEYS = ['kid', 'enc', 'wk'] as const;
const AEAD_KEYS = ['alg', 'iv', 'kc', 'ct'] as const;

function refuse(rule: string): never {
  throw new CryptoInputError('invalid_envelope', `envelope: ${rule}`);
}

/**
 * The own data properties of a plain object, read once, and exactly `keys`: no prototype other
 * than Object.prototype or null, no symbol keys, no accessors, no missing or extra key.
 */
function readObject<K extends string>(
  value: unknown,
  keys: readonly K[],
  what: string,
): Record<K, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    refuse(`${what} must be a JSON object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    refuse(`${what} must be a plain JSON object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) refuse(`${what} has a symbol key`);
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length) refuse(`${what} must have exactly the keys of 04 §3.1`);
  const out = {} as Record<K, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) refuse(`${what} is missing a required key`);
    if (!('value' in descriptor)) refuse(`${what} has an accessor instead of a value`);
    out[key] = descriptor.value as unknown;
  }
  return out;
}

/** A base64url string (no padding) that decodes to exactly `length` bytes, or minimum..maximum. */
function readBase64url(
  value: unknown,
  what: string,
  size: { length: number } | { minimum: number; maximum: number },
): string {
  if (typeof value !== 'string') refuse(`${what} must be a string`);
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64url(value);
  } catch {
    refuse(`${what} must be base64url without padding`);
  }
  if (
    'length' in size
      ? bytes.length !== size.length
      : bytes.length < size.minimum || bytes.length > size.maximum
  ) {
    refuse(`${what} has the wrong byte length`);
  }
  return value;
}

/** Bare lowercase hex of exactly `length` bytes. */
function readHex(value: unknown, what: string, length: number): string {
  if (typeof value !== 'string') refuse(`${what} must be a string`);
  try {
    decodeHex(value, { length });
  } catch {
    refuse(`${what} must be ${length * 2} lowercase hex digits without 0x`);
  }
  return value;
}

/**
 * `aead.ct`: 16 to 17 152 decoded bytes (04 §3.1.1, G-2). The length of the string is checked before
 * it is decoded, so an oversized `ct` costs no decoding. The envelope's own 24 576-byte limit, and
 * the relay frame limit, are checked on the raw text before JSON.parse by the transport (M1-5a/b).
 */
function readCiphertext(value: unknown): string {
  if (typeof value !== 'string') refuse('aead.ct must be a string');
  if (value.length > AEAD_CT_MAX_ENCODED_LENGTH) refuse('aead.ct is longer than 17152 bytes');
  // 22 870 characters decode to at most 17 152 bytes; the maximum is the rule itself.
  return readBase64url(value, 'aead.ct', { minimum: AEAD_TAG_LENGTH, maximum: AEAD_CT_MAX_LENGTH });
}

function readRecipients(value: unknown): readonly EnvelopeRecipient[] {
  if (!Array.isArray(value)) refuse('recipients must be an array');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Array.prototype) refuse('recipients must be a plain JSON array');
  const length = value.length;
  // 04 §3.1.1 (G-2): checked on the length before any entry is read.
  if (length < 1 || length > MAX_RECIPIENTS) refuse('recipients must have 1 to 8 entries');
  // Own index properties 0..length-1 and `length`, nothing else: no holes, no extra properties.
  if (Object.getOwnPropertyNames(value).length !== length + 1) {
    refuse('recipients must be a dense JSON array');
  }
  const out: EnvelopeRecipient[] = [];
  const kids = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !('value' in descriptor)) {
      refuse('recipients must be a dense JSON array');
    }
    const entry = readObject(descriptor.value, RECIPIENT_KEYS, 'a recipient');
    const kid = readBase64url(entry.kid, 'kid', { length: KID_LENGTH });
    // The canonical encoding is unique (04 §2.4.1), so equal bytes are equal strings.
    if (kids.has(kid)) refuse('recipients must have distinct kids');
    kids.add(kid);
    out.push(
      Object.freeze({
        kid,
        enc: readBase64url(entry.enc, 'enc', { length: HPKE_ENC_LENGTH }),
        wk: readBase64url(entry.wk, 'wk', { length: WRAPPED_CEK_LENGTH }),
      }),
    );
  }
  return Object.freeze(out);
}

function readHeaderFields(raw: Record<(typeof HEADER_KEYS)[number], unknown>): EnvelopeHeader {
  if (raw.v !== ENVELOPE_VERSION) refuse('v must be the number 1');
  const createdAt = raw.createdAt;
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    refuse('createdAt must be an integer in [0, 2^53 - 1]');
  }
  return {
    v: ENVELOPE_VERSION,
    id: readBase64url(raw.id, 'id', { length: ENVELOPE_ID_LENGTH }),
    thread: readBase64url(raw.thread, 'thread', { length: THREAD_ID_LENGTH }),
    from: readHex(raw.from, 'from', 32),
    createdAt,
    recipients: readRecipients(raw.recipients),
  };
}

function readAead(value: unknown): EnvelopeAead {
  // 04 §3.1 (G-46, D-66): exactly {alg, iv, kc, ct}, alg A256GCM-KC and a 32-byte kc, so no
  // envelope of the earlier form (alg A256GCM, no kc) is accepted.
  const raw = readObject(value, AEAD_KEYS, 'aead');
  if (raw.alg !== AEAD_ALG) refuse('aead.alg must be A256GCM-KC');
  return Object.freeze({
    alg: AEAD_ALG,
    iv: readBase64url(raw.iv, 'aead.iv', { length: AEAD_IV_LENGTH }),
    kc: readBase64url(raw.kc, 'aead.kc', { length: KEY_COMMITMENT_LENGTH }),
    ct: readCiphertext(raw.ct),
  });
}

/** Parses exactly the six header fields {v, id, thread, from, createdAt, recipients}. */
export function parseEnvelopeHeader(value: unknown): EnvelopeHeader {
  return Object.freeze(readHeaderFields(readObject(value, HEADER_KEYS, 'the header')));
}

/** Parses an envelope without `sig` (strict: an envelope that has `sig` is refused). */
export function parseUnsignedEnvelope(value: unknown): UnsignedEnvelope {
  const raw = readObject(value, UNSIGNED_KEYS, 'the unsigned envelope');
  return Object.freeze({ ...readHeaderFields(raw), aead: readAead(raw.aead) });
}

/** Parses a signed envelope: the 04 §3.1 v1 structure and the §2.4.1 encodings of every path. */
export function parseEnvelope(value: unknown): Envelope {
  const raw = readObject(value, SIGNED_KEYS, 'the envelope');
  return Object.freeze({
    ...readHeaderFields(raw),
    aead: readAead(raw.aead),
    sig: readHex(raw.sig, 'sig', 64),
  });
}

function hasOwnSig(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, 'sig');
}

/**
 * A signed or an unsigned envelope, parsed strictly by which one it is (has an own `sig` or not).
 * Internal to the package (aead.ts); not exported from any entry.
 */
export function parseSignedOrUnsignedEnvelope(value: unknown): UnsignedEnvelope | Envelope {
  return hasOwnSig(value) ? parseEnvelope(value) : parseUnsignedEnvelope(value);
}

function unsignedPart(envelope: UnsignedEnvelope): UnsignedEnvelope {
  const { v, id, thread, from, createdAt, recipients, aead } = envelope;
  return { v, id, thread, from, createdAt, recipients, aead };
}

function headerPart(header: EnvelopeHeader): EnvelopeHeader {
  const { v, id, thread, from, createdAt, recipients } = header;
  return { v, id, thread, from, createdAt, recipients };
}

/**
 * 04 §3.1, §3.1.1: envelopeHash = sha256(JCS(envelope without "sig")), the value notarized on-chain.
 * Takes a signed or an unsigned envelope; either is parsed strictly first, and the hash is computed
 * from the parsed copy, so what is hashed is what was checked.
 */
export function envelopeHash(envelope: UnsignedEnvelope | Envelope): Uint8Array {
  return sha256(canonicalizeToBytes(unsignedPart(parseSignedOrUnsignedEnvelope(envelope))));
}

/**
 * 04 §3.1: the payload AEAD's additional data, the 32 bytes of
 * sha256(JCS({v, id, thread, from, createdAt, recipients})). Takes the header alone (exactly its six
 * keys) or a signed or unsigned envelope; either is parsed strictly first.
 */
export function envelopeAad(
  headerOrEnvelope: EnvelopeHeader | UnsignedEnvelope | Envelope,
): Uint8Array {
  const value: unknown = headerOrEnvelope;
  const isHeader = typeof value === 'object' && value !== null && !Object.hasOwn(value, 'aead');
  const header = isHeader ? parseEnvelopeHeader(value) : parseSignedOrUnsignedEnvelope(value);
  return sha256(canonicalizeToBytes(headerPart(header)));
}

function assertDigest(digest: Uint8Array, what: string): void {
  assertBytes(digest, what);
  if (digest.length !== 32)
    throw new CryptoInputError('invalid_length', `${what} must be 32 bytes`);
}

/**
 * 04 §3.1: what `sig` signs, taggedHash("agentlink/envelope/v1", envelopeHash). The tag keeps an
 * envelope signature from ever being valid as a Nostr event or owner-action signature.
 */
export function envelopeSignatureInput(envelopeHash: Uint8Array): Uint8Array {
  assertDigest(envelopeHash, 'envelopeSignatureInput: envelopeHash');
  return taggedHash(TAGS.envelope, envelopeHash);
}

/**
 * Verifies `sig` as BIP-340 by `from` over envelopeSignatureInput(envelopeHash(envelope)): steps 3
 * and 4 of 04 §3.1.1. Throws `invalid_envelope` for an envelope that does not parse strictly
 * (including the recipient and `ct` limits); returns false for a signature that does not verify,
 * including a `from` that does not lift to a curve point. Only the envelope tag is tried: a
 * signature over the untagged envelopeHash, another tag or a NIP-01 id never verifies. Binding
 * `from` to a card, the type ↔ key table and steps 5 to 9 are the caller's (core, M1-7b).
 */
export function verifyEnvelope(envelope: Envelope): boolean {
  const parsed = parseEnvelope(envelope);
  const message = envelopeSignatureInput(envelopeHash(parsed));
  return bip340Verify(decodeHex(parsed.from), message, decodeHex(parsed.sig));
}

/**
 * KeyStore and OwnerSession implementations only (@agentlink/crypto/keystore;
 * EnvelopeKeys.signEnvelopeHash, 04 §3.1.1): the 64-byte BIP-340 signature of
 * envelopeSignatureInput(envelopeHash) under the Nostr secret key of `from` (the agent key at its
 * current epoch, or the owner key for `approval`, `policy` and `revoke`). It applies the tag itself,
 * so it never signs an untagged digest. Compute envelopeHash from the parsed envelope. `auxRand` is
 * for test vectors only; production callers omit it and get 32 fresh CSPRNG bytes. Attach the
 * result as `sig: encodeHex(signature)`.
 */
export function signEnvelopeHash(
  secretKey: Uint8Array,
  envelopeHash: Uint8Array,
  auxRand?: Uint8Array,
): Uint8Array {
  assertDigest(envelopeHash, 'signEnvelopeHash: envelopeHash');
  return bip340Sign(secretKey, envelopeSignatureInput(envelopeHash), auxRand);
}
