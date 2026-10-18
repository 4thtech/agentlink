// M1-5a: the Nostr wrapping of an envelope (04 §3.5, 07 §4.1, §4.2) and the transport step of
// inbound verification (04 §3.1.1, steps 1 and 2).
//
// Send: rumor (unsigned kind 14, tag ["agentlink","1"], content = JCS(envelope)) -> per recipient, a
// seal (kind 13, NIP-44 v2 of the rumor to the recipient, signed through EnvelopeKeys.signNostr) ->
// a gift wrap (kind 1059, NIP-44 v2 of the seal under an ephemeral key created inside
// @4thtech-io/crypto). Seal and gift-wrap created_at are back-dated by up to 2 days (NIP-59).
//
// Receive (fail closed): the gift wrap and seal signatures verify, the rumor key equals the seal key,
// the agentlink tag is present, the rumor content is at most 24 576 bytes before it is parsed, the
// envelope passes the strict parser, and the seal key equals envelope.from as bytes. The envelope
// signature (step 4) and everything after it are core (M1-7b).
//
// All secret-key work goes through EnvelopeKeys and @4thtech-io/crypto (04 §8.1, I-1); this module
// never sees a secret key. Inbound events are untrusted (I-5): every field is read once into a
// plain copy, and errors never echo the input (I-7).
import {
  KeyStoreError,
  MAX_RECIPIENTS,
  NOSTR_KIND_GIFT_WRAP,
  NOSTR_KIND_SEAL,
  canonicalize,
  createGiftWrap,
  decodeHex,
  encodeUtf8,
  equalBytes,
  isBip340PublicKey,
  nostrEventId,
  parseEnvelope,
  parseJson,
  randomBytes,
  verifyNostrEvent,
  type Envelope,
  type EnvelopeKeys,
  type EpochOptions,
  type NostrEvent,
} from '@4thtech-io/crypto';
import { TransportError, type TransportErrorCode } from './errors.js';

/** NIP-17 private direct message: the rumor kind (04 §3.5). */
export const NOSTR_KIND_RUMOR = 14;
/** The rumor tag that marks an AgentLink envelope, protocol version 1 (04 §3.5). */
export const AGENTLINK_TAG: readonly ['agentlink', '1'] = Object.freeze([
  'agentlink',
  '1',
] as const);
/** 04 §3.1.1: the envelope (rumor `content`, JCS on send) is at most 24 576 bytes of UTF-8. */
export const ENVELOPE_MAX_BYTES = 24_576;
/** NIP-59: seal and gift-wrap created_at are back-dated by up to 2 days (04 §3.5). */
export const GIFT_WRAP_MAX_BACKDATE_SECONDS = 2 * 24 * 60 * 60;

const HEX_32 = /^[0-9a-f]{64}$/;
const EVENT_KEYS = ['content', 'created_at', 'id', 'kind', 'pubkey', 'sig', 'tags'];
const RUMOR_KEYS = ['content', 'created_at', 'id', 'kind', 'pubkey', 'tags'];

/** One gift wrap for one recipient key, with its final size for the relay checks (M1-5b). */
export interface GiftWrap {
  /** The recipient's Nostr key (64 lowercase hex), the gift wrap's `p` tag. */
  readonly recipient: string;
  /** The signed kind 1059 event. */
  readonly event: NostrEvent;
  /** UTF-8 bytes of JSON.stringify(event). */
  readonly eventBytes: number;
  /** UTF-8 bytes of the relay frame ["EVENT", event], what NIP-11 max_message_length limits. */
  readonly frameBytes: number;
}

/** The result of wrapping one envelope. */
export interface WrappedEnvelope {
  /** The strictly parsed envelope that was sent: its JCS is every rumor's content. */
  readonly envelope: Envelope;
  /** One gift wrap per distinct recipient key, in the order the keys first appear. */
  readonly wraps: readonly GiftWrap[];
}

/** Options for wrapEnvelope. */
export interface WrapOptions {
  /** The clock in Unix seconds (default: the wall clock). The rumor carries it; seal and wrap are back-dated from it. */
  readonly now?: () => number;
}

/** An unwrapped inbound envelope with the gift-wrap metadata sync needs (M1-5c dedup). */
export interface UnwrappedEnvelope {
  /** The strictly parsed envelope. Its signature is not yet checked (04 §3.1.1 step 4, core). */
  readonly envelope: Envelope;
  /** The gift wrap's event id. */
  readonly giftWrapId: string;
  /** The gift wrap's (randomised) created_at. */
  readonly giftWrapCreatedAt: number;
}

function fail(code: TransportErrorCode, message: string): never {
  throw new TransportError(code, message);
}

function utf8Length(text: string): number {
  return encodeUtf8(text).length;
}

/** True when `text` is more than ENVELOPE_MAX_BYTES of UTF-8. A string's UTF-8 is never shorter than its UTF-16 length. */
function overEnvelopeLimit(text: string): boolean {
  return text.length > ENVELOPE_MAX_BYTES || utf8Length(text) > ENVELOPE_MAX_BYTES;
}

function checkClock(now: unknown): number {
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) {
    fail('invalid_argument', 'transport: the clock must be a non-negative integer of seconds');
  }
  return now;
}

/** A uniform integer in [0, bound] from the CSPRNG (rejection sampling, no modulo bias). */
function uniformUpTo(bound: number): number {
  const range = bound + 1;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  for (;;) {
    const bytes = randomBytes(4);
    const value = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
    if (value < limit) return value % range;
  }
}

/**
 * A created_at drawn uniformly from [now - 2 days, now] (NIP-59; 04 §3.5), never below 0. `now` is
 * Unix seconds, a non-negative safe integer.
 */
export function randomPastTimestamp(now: number): number {
  return Math.max(0, checkClock(now) - uniformUpTo(GIFT_WRAP_MAX_BACKDATE_SECONDS));
}

function sameKey(a: string, b: string): boolean {
  return equalBytes(decodeHex(a, { length: 32 }), decodeHex(b, { length: 32 }));
}

/** The distinct recipient keys in first-seen order, or invalid_recipient. */
function recipientKeys(recipients: unknown): string[] {
  if (!Array.isArray(recipients)) fail('invalid_recipient', 'gift wrap: recipients must be a list');
  const distinct: string[] = [];
  for (const key of recipients as unknown[]) {
    if (typeof key !== 'string' || !HEX_32.test(key) || !isBip340PublicKey(decodeHex(key))) {
      fail('invalid_recipient', 'gift wrap: every recipient must be a Nostr public key');
    }
    if (!distinct.includes(key)) distinct.push(key);
  }
  if (distinct.length < 1 || distinct.length > MAX_RECIPIENTS) {
    fail('invalid_recipient', 'gift wrap: there must be 1 to 8 distinct recipient keys');
  }
  return distinct;
}

/** A frozen plain copy of a signed event from the KeyStore, each field read once. */
function copySigned(event: NostrEvent): NostrEvent {
  const { kind, created_at: createdAt, tags, content, id, pubkey, sig } = event;
  return Object.freeze({ kind, created_at: createdAt, tags, content, id, pubkey, sig });
}

/**
 * Wraps `envelope` for each distinct key in `recipients` (64 lowercase hex Nostr keys, 1 to 8
 * distinct), sealed with `keys` (the agent's KeyStore, or an OwnerSession for owner-authored
 * envelopes; 04 §3.1.1). The rumor content is JCS(envelope), checked against the 24 576-byte limit
 * and then against the strict parser before any key is used. Refuses keys whose seal key is not
 * `envelope.from`.
 */
export async function wrapEnvelope(
  envelope: Envelope,
  recipients: readonly string[],
  keys: EnvelopeKeys,
  options: WrapOptions = {},
): Promise<WrappedEnvelope> {
  let content: string;
  try {
    content = canonicalize(envelope);
  } catch {
    fail('invalid_envelope', 'gift wrap: the envelope is not a v1 envelope');
  }
  if (overEnvelopeLimit(content)) {
    fail('envelope_too_large', 'gift wrap: the envelope is larger than 24 576 bytes');
  }
  // Parse the text that is sent, so what is sent is what was checked.
  let parsed: Envelope;
  try {
    parsed = parseEnvelope(parseJson(content, { integersOnly: true }));
  } catch {
    fail('invalid_envelope', 'gift wrap: the envelope is not a v1 envelope');
  }
  const targets = recipientKeys(recipients);
  const now = checkClock(options.now === undefined ? Math.floor(Date.now() / 1000) : options.now());

  const rumorFields = {
    kind: NOSTR_KIND_RUMOR,
    created_at: now,
    tags: [[...AGENTLINK_TAG]],
    content,
  };
  const rumorId = nostrEventId(parsed.from, rumorFields);
  const rumorJson = JSON.stringify({
    id: rumorId,
    pubkey: parsed.from,
    created_at: rumorFields.created_at,
    kind: rumorFields.kind,
    tags: rumorFields.tags,
    content,
  });

  const wraps: GiftWrap[] = [];
  for (const recipient of targets) {
    const sealContent = await keys.nip44Encrypt(recipient, rumorJson);
    const sealCreatedAt = randomPastTimestamp(now);
    const seal = copySigned(
      await keys.signNostr({
        kind: NOSTR_KIND_SEAL,
        created_at: sealCreatedAt,
        tags: [],
        content: sealContent,
      }),
    );
    if (typeof seal.pubkey !== 'string' || !HEX_32.test(seal.pubkey)) {
      fail('sender_mismatch', 'gift wrap: the seal key is not the envelope sender');
    }
    if (!sameKey(seal.pubkey, parsed.from)) {
      fail('sender_mismatch', 'gift wrap: the seal key is not the envelope sender');
    }
    // IR-M1-5a-1 L-4: the seal is exactly what was requested (kind 13, no tags, the back-dated
    // created_at, the encrypted rumor), so a faulty signer cannot emit wraps receivers refuse.
    if (
      seal.kind !== NOSTR_KIND_SEAL ||
      seal.content !== sealContent ||
      seal.created_at !== sealCreatedAt ||
      !Array.isArray(seal.tags) ||
      seal.tags.length !== 0
    ) {
      fail('invalid_seal', 'gift wrap: the signer returned a different seal');
    }
    // createGiftWrap verifies the seal signature and wipes its ephemeral key (M1-1g).
    const event = createGiftWrap(seal, recipient, randomPastTimestamp(now));
    wraps.push(
      Object.freeze({
        recipient,
        event,
        eventBytes: utf8Length(JSON.stringify(event)),
        frameBytes: utf8Length(JSON.stringify(['EVENT', event])),
      }),
    );
  }
  return Object.freeze({ envelope: parsed, wraps: Object.freeze(wraps) });
}

// --- receive --------------------------------------------------------------------------------------

/**
 * A frozen copy of exactly `keys` (own data properties of a plain object, each read once), or null.
 * Symbol keys are ignored (some libraries mark verified events with one).
 */
function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length || !keys.every((key) => names.includes(key))) return null;
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function isTags(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.every((tag) => Array.isArray(tag) && tag.every((item) => typeof item === 'string'))
  );
}

/** A plain copy of a signed event of `kind` whose signature verifies, or null. */
function verifiedEvent(value: unknown, kind: number): NostrEvent | null {
  const copy = exactObject(value, EVENT_KEYS);
  if (copy === null) return null;
  const { kind: k, created_at: createdAt, tags, content, id, pubkey, sig } = copy;
  if (k !== kind || typeof createdAt !== 'number' || typeof content !== 'string') return null;
  if (typeof id !== 'string' || typeof pubkey !== 'string' || typeof sig !== 'string') return null;
  if (!isTags(tags)) return null;
  const event: NostrEvent = Object.freeze({
    kind,
    created_at: createdAt,
    tags,
    content,
    id,
    pubkey,
    sig,
  });
  return verifyNostrEvent(event) ? event : null;
}

function parseText(text: string, code: TransportErrorCode, message: string): unknown {
  try {
    return parseJson(text, { integersOnly: true });
  } catch {
    fail(code, message);
  }
}

/** NIP-44 decryption through the keys. A KeyStore state error passes through; anything else is decrypt_failed. */
async function decrypt(
  keys: EnvelopeKeys,
  peer: string,
  payload: string,
  options: EpochOptions | undefined,
): Promise<string> {
  let text: unknown;
  try {
    text = await (options === undefined
      ? keys.nip44Decrypt(peer, payload)
      : keys.nip44Decrypt(peer, payload, options));
  } catch (error) {
    if (error instanceof KeyStoreError) throw error;
    fail('decrypt_failed', 'gift wrap: decryption failed');
  }
  if (typeof text !== 'string') fail('decrypt_failed', 'gift wrap: decryption failed');
  return text;
}

/**
 * Opens an inbound gift wrap (untrusted, I-5) with `keys` (the recipient's KeyStore, or an
 * OwnerSession for owner copies). `options.epoch` selects the key epoch for both decryptions.
 * Fails closed with a TransportError at the first rule that does not hold (04 §3.1.1 steps 1-3,
 * §3.5): see the module header. A KeyStoreError (closed store, locked session, unknown epoch) is
 * rethrown unchanged.
 */
export async function unwrapGiftWrap(
  giftWrap: unknown,
  keys: EnvelopeKeys,
  options?: EpochOptions,
): Promise<UnwrappedEnvelope> {
  const wrap = verifiedEvent(giftWrap, NOSTR_KIND_GIFT_WRAP);
  if (wrap === null) fail('invalid_gift_wrap', 'gift wrap: not a validly signed kind 1059 event');

  const sealText = await decrypt(keys, wrap.pubkey, wrap.content, options);
  const seal = verifiedEvent(
    parseText(
      sealText,
      'invalid_seal',
      'gift wrap: the seal is not a validly signed kind 13 event',
    ),
    NOSTR_KIND_SEAL,
  );
  if (seal === null || seal.tags.length !== 0) {
    fail('invalid_seal', 'gift wrap: the seal is not a validly signed kind 13 event');
  }

  const rumorText = await decrypt(keys, seal.pubkey, seal.content, options);
  const rumorValue = exactObject(
    parseText(rumorText, 'invalid_rumor', 'gift wrap: the rumor is not a kind 14 event'),
    RUMOR_KEYS,
  );
  if (rumorValue === null) fail('invalid_rumor', 'gift wrap: the rumor is not a kind 14 event');
  const { kind, created_at: createdAt, tags, content, id, pubkey } = rumorValue;
  if (
    kind !== NOSTR_KIND_RUMOR ||
    typeof createdAt !== 'number' ||
    typeof content !== 'string' ||
    typeof id !== 'string' ||
    typeof pubkey !== 'string' ||
    !HEX_32.test(pubkey) ||
    !isTags(tags)
  ) {
    fail('invalid_rumor', 'gift wrap: the rumor is not a kind 14 event');
  }
  let expectedId: string;
  try {
    expectedId = nostrEventId(pubkey, { kind, created_at: createdAt, tags, content });
  } catch {
    fail('invalid_rumor', 'gift wrap: the rumor is not a kind 14 event');
  }
  if (id !== expectedId) fail('invalid_rumor', 'gift wrap: the rumor id is not its event id');
  if (!sameKey(pubkey, seal.pubkey)) {
    fail('rumor_mismatch', 'gift wrap: the rumor key is not the seal key');
  }
  if (
    !tags.some(
      (tag) => tag.length === 2 && tag[0] === AGENTLINK_TAG[0] && tag[1] === AGENTLINK_TAG[1],
    )
  ) {
    fail('missing_agentlink_tag', 'gift wrap: the rumor has no agentlink tag');
  }

  // 04 §3.1.1 step 1: the size of the content string, before it is parsed.
  if (overEnvelopeLimit(content)) {
    fail('envelope_too_large', 'gift wrap: the envelope is larger than 24 576 bytes');
  }
  let envelope: Envelope;
  try {
    envelope = parseEnvelope(parseJson(content, { integersOnly: true }));
  } catch {
    fail('invalid_envelope', 'gift wrap: the rumor content is not a v1 envelope');
  }
  if (!sameKey(envelope.from, seal.pubkey)) {
    fail('sender_mismatch', 'gift wrap: the seal key is not the envelope sender');
  }
  return Object.freeze({ envelope, giftWrapId: wrap.id, giftWrapCreatedAt: wrap.created_at });
}
