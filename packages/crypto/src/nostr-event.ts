// Nostr events (NIP-01) as KeyStore.signNostr and the gift wrap need them (04 §3.5, 07 §4.1). The
// event id is sha256 of the NIP-01 serialization `[0, pubkey, created_at, kind, tags, content]`;
// the signature is BIP-340 over the id. Hashing and signing are @noble through ./hash and ./bip340
// (I-8).
//
// nostrEventId and verifyNostrEvent are public. signNostrEvent takes a secret key: it is internal
// to this package (KeyStore implementations and the gift wrap) and exported from neither entry.
import { bip340PublicKey, bip340Sign, bip340Verify } from './bip340.js';
import { assertBytes } from './bytes.js';
import { decodeHex, encodeHex, encodeUtf8, isWellFormedText } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { sha256 } from './hash.js';

/** NIP-59 seal. */
export const NOSTR_KIND_SEAL = 13;
/** NIP-59 gift wrap. */
export const NOSTR_KIND_GIFT_WRAP = 1059;
/** NIP-42 client authentication (AUTH) to a relay. */
export const NOSTR_KIND_AUTH = 22242;

const MAX_KIND = 65535;
const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;

/** The fields a signer covers, before `pubkey`, `id` and `sig` are set (NIP-01). */
export interface UnsignedNostrEvent {
  readonly kind: number;
  readonly created_at: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
}

/** A signed Nostr event: `pubkey`, `id` and `sig` are lowercase hex (NIP-01). */
export interface NostrEvent extends UnsignedNostrEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly sig: string;
}

function refuse(message: string): never {
  throw new CryptoInputError('invalid_argument', message);
}

/** A frozen copy of exactly the four signed fields, or a CryptoInputError. */
function signedFields(event: unknown): UnsignedNostrEvent {
  if (typeof event !== 'object' || event === null) refuse('nostr event: must be an object');
  const { kind, created_at: createdAt, tags, content } = event as Record<string, unknown>;
  if (typeof kind !== 'number' || !Number.isInteger(kind) || kind < 0 || kind > MAX_KIND) {
    refuse('nostr event: kind must be an integer from 0 to 65535');
  }
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    refuse('nostr event: created_at must be a non-negative integer');
  }
  if (typeof content !== 'string' || !isWellFormedText(content)) {
    refuse('nostr event: content must be well-formed text');
  }
  if (!Array.isArray(tags)) refuse('nostr event: tags must be an array');
  const copied = tags.map((tag: unknown) => {
    if (!Array.isArray(tag)) refuse('nostr event: every tag must be an array');
    return Object.freeze(
      tag.map((item: unknown) => {
        if (typeof item !== 'string' || !isWellFormedText(item)) {
          refuse('nostr event: every tag item must be well-formed text');
        }
        return item;
      }),
    );
  });
  return Object.freeze({ kind, created_at: createdAt, tags: Object.freeze(copied), content });
}

function idOf(pubkey: string, fields: UnsignedNostrEvent): string {
  const serialized = JSON.stringify([
    0,
    pubkey,
    fields.created_at,
    fields.kind,
    fields.tags,
    fields.content,
  ]);
  return encodeHex(sha256(encodeUtf8(serialized)));
}

/**
 * NIP-01 event id: lowercase hex of sha256(utf8(JSON [0, pubkey, created_at, kind, tags,
 * content])). `pubkey` must be 64 lowercase hex. Refuses a kind outside 0..65535, a negative or
 * unsafe created_at, tags that are not arrays of strings and text with a lone surrogate.
 */
export function nostrEventId(pubkey: string, event: UnsignedNostrEvent): string {
  decodeHex(pubkey, { length: 32 });
  return idOf(pubkey, signedFields(event));
}

/**
 * True only for a well-formed event whose `id` is its NIP-01 id and whose `sig` is a valid BIP-340
 * signature by `pubkey` over that id. Never throws: anything malformed is false (fail closed).
 */
export function verifyNostrEvent(event: NostrEvent): boolean {
  try {
    const { id, pubkey, sig } = event as unknown as Record<string, unknown>;
    if (typeof id !== 'string' || typeof pubkey !== 'string' || typeof sig !== 'string') {
      return false;
    }
    if (!HEX_32.test(id) || !HEX_32.test(pubkey) || !HEX_64.test(sig)) return false;
    if (idOf(pubkey, signedFields(event)) !== id) return false;
    return bip340Verify(decodeHex(pubkey), decodeHex(id), decodeHex(sig));
  } catch {
    return false;
  }
}

/**
 * Signs the four NIP-01 fields of `event` with `secretKey` (BIP-340, fresh aux randomness) and
 * returns a frozen signed event. Only kind, created_at, tags and content are read; any pubkey, id
 * or sig on the input is ignored. Internal: KeyStore implementations and the gift wrap.
 */
export function signNostrEvent(secretKey: Uint8Array, event: UnsignedNostrEvent): NostrEvent {
  assertBytes(secretKey, 'nostr event: the secret key');
  const fields = signedFields(event);
  // bip340PublicKey validates the key (32 bytes, in [1, n)).
  const pubkey = encodeHex(bip340PublicKey(secretKey));
  const id = idOf(pubkey, fields);
  const sig = encodeHex(bip340Sign(secretKey, decodeHex(id)));
  return Object.freeze({ ...fields, id, pubkey, sig });
}
