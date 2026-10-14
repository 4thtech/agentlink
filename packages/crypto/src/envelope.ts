// The 04 §3.1 envelope (M1-1c): its strict v1 structure, envelopeHash, the payload AEAD's additional
// data, and the BIP-340 signature under the `agentlink/envelope/v1` tag.
//
// Every function that reads an envelope first parses it strictly (04 §2.4.1): unknown or missing
// keys, a wrong type, a non-canonical encoding or a wrong byte length is refused with
// `invalid_envelope`, never normalised. Parsing reads each value once into a fresh frozen copy, and
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
/** The payload AEAD: AES-256-GCM. */
export const AEAD_ALG = 'A256GCM';
/** Raw byte length of `aead.iv`. */
export const AEAD_IV_LENGTH = 12;
/** Raw byte length of the GCM tag at the end of `aead.ct`. */
export const AEAD_TAG_LENGTH = 16;

/** One recipient entry; every value base64url without padding (04 §2.4.1). */
export interface EnvelopeRecipient {
  readonly kid: string;
  readonly enc: string;
  readonly wk: string;
}

/** The payload AEAD; `iv` and `ct` (ciphertext || 16-byte tag) base64url without padding. */
export interface EnvelopeAead {
  readonly alg: typeof AEAD_ALG;
  readonly iv: string;
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
  /** At least one; the order is covered by the AAD and the hash. */
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
const AEAD_KEYS = ['alg', 'iv', 'ct'] as const;

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

/** A base64url string (no padding) that decodes to exactly `length` bytes, or at least `minimum`. */
function readBase64url(
  value: unknown,
  what: string,
  size: { length: number } | { minimum: number },
): string {
  if (typeof value !== 'string') refuse(`${what} must be a string`);
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64url(value);
  } catch {
    refuse(`${what} must be base64url without padding`);
  }
  if ('length' in size ? bytes.length !== size.length : bytes.length < size.minimum) {
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

function readRecipients(value: unknown): readonly EnvelopeRecipient[] {
  if (!Array.isArray(value)) refuse('recipients must be an array');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Array.prototype) refuse('recipients must be a plain JSON array');
  const length = value.length;
  if (length === 0) refuse('recipients must not be empty');
  // Own index properties 0..length-1 and `length`, nothing else: no holes, no extra properties.
  if (Object.getOwnPropertyNames(value).length !== length + 1) {
    refuse('recipients must be a dense JSON array');
  }
  const out: EnvelopeRecipient[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !('value' in descriptor)) {
      refuse('recipients must be a dense JSON array');
    }
    const entry = readObject(descriptor.value, RECIPIENT_KEYS, 'a recipient');
    out.push(
      Object.freeze({
        kid: readBase64url(entry.kid, 'kid', { length: KID_LENGTH }),
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
  const raw = readObject(value, AEAD_KEYS, 'aead');
  if (raw.alg !== AEAD_ALG) refuse('aead.alg must be A256GCM');
  return Object.freeze({
    alg: AEAD_ALG,
    iv: readBase64url(raw.iv, 'aead.iv', { length: AEAD_IV_LENGTH }),
    ct: readBase64url(raw.ct, 'aead.ct', { minimum: AEAD_TAG_LENGTH }),
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
 * 04 §3.1: envelopeHash = sha256(JCS(envelope without "sig")), the value notarized on-chain.
 * Takes a signed or an unsigned envelope; either is parsed strictly first.
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
 * Verifies `sig` as BIP-340 by `from` over envelopeSignatureInput(envelopeHash(envelope)) (04 §3.1).
 * Throws `invalid_envelope` for an envelope that does not parse strictly; returns false for a
 * signature that does not verify, including a `from` that is not an x-only key on the curve.
 * Binding `from` to an agent card (04 §3.4.1) is the caller's step.
 */
export function verifyEnvelope(envelope: Envelope): boolean {
  const parsed = parseEnvelope(envelope);
  const message = envelopeSignatureInput(envelopeHash(parsed));
  return bip340Verify(decodeHex(parsed.from), message, decodeHex(parsed.sig));
}

/**
 * KeyStore implementations only (@agentlink/crypto/keystore): the 64-byte BIP-340 signature of
 * envelopeSignatureInput(envelopeHash) under the agent's Nostr secret key. `auxRand` is for test
 * vectors only; production callers omit it. Attach it as `sig: encodeHex(signature)`.
 */
export function signEnvelopeHash(
  secretKey: Uint8Array,
  envelopeHash: Uint8Array,
  auxRand?: Uint8Array,
): Uint8Array {
  assertDigest(envelopeHash, 'signEnvelopeHash: envelopeHash');
  return bip340Sign(secretKey, envelopeSignatureInput(envelopeHash), auxRand);
}
