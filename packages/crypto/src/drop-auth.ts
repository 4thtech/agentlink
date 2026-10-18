// The encrypted-drop request signature and URL MAC (M1-27a; 07 §5.4, 04 §4, D-48).
//
// Request signature (proposed, owner confirms at merge): a NIP-98-style HTTP-auth event, kind 27235,
// signed with the agent's drop key (BIP-340, 04 §2.1) and sent as
//   Authorization: Nostr <base64url(utf8(JSON event))>
// with empty `content` and exactly these tags, in this order:
//   ["u", <the exact request URL>], ["method", "POST" | "DELETE"],
//   ["payload", <lowercase hex sha256 of the exact request body bytes>],
//   ["domain", "agentlink/v1/drop"].
// `created_at` is the request time (the body's `ts`). The kind and the `domain` tag separate it from
// envelopes, records, receipts and relay AUTH (kind 22242); the drop key signs nothing else. The
// signature travels in a header, never in the URL. The body carries the nonce (04 §4).
//
// URL MAC: the drop's signed PUT and GET URLs carry
//   HMAC-SHA256(urlKey, utf8("agentlink/v1/drop-url") ‖ 0x00 ‖ purpose (0x01 put, 0x02 get)
//               ‖ objectId (16 bytes) ‖ u16be(part) ‖ u64be(expiresAt seconds))
// where urlKey is a 32-byte Worker secret. GET URLs have part 0; a single PUT has part 0 and a
// multipart PUT parts 1..10000.
//
// Everything here takes public inputs or the Worker's URL key, never a drop key: signing happens in
// a KeyStore (KeyStore.signDropRequest, M1-1g-e), whose checks and raw-key signer are in
// keystore-drop.ts; the signer is exported only from the restricted @4thtech-io/crypto/keystore entry.
import { bip340Verify } from './bip340.js';
import { assertBytes, concatBytes, equalBytes } from './bytes.js';
import {
  decodeBase64url,
  decodeHex,
  decodeUtf8,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
} from './encoding.js';
import { CryptoInputError } from './errors.js';
import { sha256 } from './hash.js';
import { parseJson } from './jcs.js';
import {
  nostrEventId,
  signedEventSnapshot,
  type NostrEvent,
  type UnsignedNostrEvent,
} from './nostr-event.js';
import { hmacSha256 } from './pairing.js';

/** NIP-98 HTTP auth event kind, used for drop requests only. */
export const DROP_AUTH_KIND = 27235;
/** Value of the `domain` tag: separates drop requests from every other signed object. */
export const DROP_AUTH_DOMAIN = 'agentlink/v1/drop';
/** The Authorization scheme. */
export const DROP_AUTH_SCHEME = 'Nostr';
/** Allowed distance between `created_at` and the verifier's clock, either way. */
export const DROP_AUTH_MAX_SKEW_SECONDS = 60;
/** Longest Authorization header the verifier reads. */
export const DROP_AUTH_MAX_HEADER_LENGTH = 2048;
/** Longest request URL a drop request may be signed over. */
export const DROP_AUTH_MAX_URL_LENGTH = 512;
/** Methods that carry a drop signature (PUT and GET use the URL MAC instead). */
export const DROP_AUTH_METHODS = Object.freeze(['POST', 'DELETE'] as const);

export const DROP_URL_MAC_LABEL = 'agentlink/v1/drop-url';
export const DROP_URL_KEY_LENGTH = 32;
export const DROP_URL_MAC_LENGTH = 32;
export const DROP_OBJECT_ID_LENGTH = 16;
/** Highest multipart part number (R2 and S3 allow 10 000 parts). */
export const DROP_MAX_PART = 10_000;

/** What a drop signature covers. `body` is the exact bytes sent. */
export interface DropAuthRequest {
  readonly method: string;
  readonly url: string;
  readonly body: Uint8Array;
}

export type DropAuthFailure = 'malformed' | 'request_mismatch' | 'stale' | 'invalid_signature';

export type DropAuthResult =
  | { readonly ok: true; readonly pubkey: string; readonly createdAt: number }
  | { readonly ok: false; readonly reason: DropAuthFailure };

const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;
const EVENT_KEYS = ['content', 'created_at', 'id', 'kind', 'pubkey', 'sig', 'tags'];

function refuse(message: string): never {
  throw new CryptoInputError('invalid_argument', message);
}

function isMethod(method: unknown): method is (typeof DROP_AUTH_METHODS)[number] {
  return (DROP_AUTH_METHODS as readonly unknown[]).includes(method);
}

function isUrl(url: unknown): url is string {
  return (
    typeof url === 'string' &&
    url.length <= DROP_AUTH_MAX_URL_LENGTH &&
    url.startsWith('https://') &&
    // No whitespace or control characters: the URL is compared as an exact string.
    /^[\x21-\x7e]+$/.test(url)
  );
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function tagsFor(request: DropAuthRequest): string[][] {
  return [
    ['u', request.url],
    ['method', request.method],
    ['payload', encodeHex(sha256(request.body))],
    ['domain', DROP_AUTH_DOMAIN],
  ];
}

/**
 * The unsigned kind-27235 event for a drop request, to be signed by the drop key in a KeyStore.
 * Refuses a method other than POST or DELETE, a URL that is not https or longer than 512
 * characters, and a `createdAt` that is not a non-negative integer. Frozen.
 */
export function dropAuthEvent(request: DropAuthRequest, createdAt: number): UnsignedNostrEvent {
  if (typeof request !== 'object' || request === null) refuse('dropAuthEvent: request missing');
  const { method, url, body } = request;
  if (!isMethod(method)) refuse('dropAuthEvent: method must be POST or DELETE');
  if (!isUrl(url)) refuse('dropAuthEvent: url must be https and at most 512 characters');
  if (!(body instanceof Uint8Array)) refuse('dropAuthEvent: body must be a Uint8Array');
  if (!isTimestamp(createdAt)) refuse('dropAuthEvent: createdAt must be a non-negative integer');
  const tags = tagsFor({ method, url, body }).map((tag) => Object.freeze(tag));
  return Object.freeze({
    kind: DROP_AUTH_KIND,
    created_at: createdAt,
    tags: Object.freeze(tags),
    content: '',
  });
}

/** The Authorization header value for a signed drop event: `Nostr <base64url(JSON)>`. */
export function encodeDropAuthorization(event: NostrEvent): string {
  const e = signedEventSnapshot(event);
  const json = JSON.stringify({
    id: e.id,
    pubkey: e.pubkey,
    created_at: e.created_at,
    kind: e.kind,
    tags: e.tags,
    content: e.content,
    sig: e.sig,
  });
  return `${DROP_AUTH_SCHEME} ${encodeBase64url(encodeUtf8(json))}`;
}

function parseHeader(authorization: unknown): NostrEvent | null {
  if (typeof authorization !== 'string') return null;
  if (authorization.length > DROP_AUTH_MAX_HEADER_LENGTH) return null;
  const prefix = `${DROP_AUTH_SCHEME} `;
  if (!authorization.startsWith(prefix)) return null;
  let value: unknown;
  try {
    value = parseJson(decodeUtf8(decodeBase64url(authorization.slice(prefix.length))), {
      integersOnly: true,
    });
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== EVENT_KEYS.length || keys.some((key, i) => key !== EVENT_KEYS[i])) {
    return null;
  }
  const e = value as Record<string, unknown>;
  if (
    e.kind !== DROP_AUTH_KIND ||
    e.content !== '' ||
    !isTimestamp(e.created_at) ||
    typeof e.id !== 'string' ||
    !HEX_32.test(e.id) ||
    typeof e.pubkey !== 'string' ||
    !HEX_32.test(e.pubkey) ||
    typeof e.sig !== 'string' ||
    !HEX_64.test(e.sig) ||
    !Array.isArray(e.tags) ||
    e.tags.length !== 4
  ) {
    return null;
  }
  const names = ['u', 'method', 'payload', 'domain'];
  for (let i = 0; i < 4; i += 1) {
    const tag: unknown = e.tags[i];
    if (!Array.isArray(tag) || tag.length !== 2 || tag[0] !== names[i]) return null;
    if (typeof tag[1] !== 'string') return null;
  }
  if ((e.tags[3] as string[])[1] !== DROP_AUTH_DOMAIN) return null;
  return e as unknown as NostrEvent;
}

/**
 * Verifies a drop request's Authorization header against the request the Worker received and its
 * clock (`now`, unix seconds). Checks, in order: the header form (`malformed`), the binding to the
 * method, exact URL and body hash (`request_mismatch`), the time window of ±60 s (`stale`), then
 * the event id and BIP-340 signature (`invalid_signature`). On success returns the drop key
 * (`pubkey`, lowercase hex) and `createdAt`; the caller checks the nonce. Never throws.
 */
export function verifyDropAuthorization(
  authorization: string | null | undefined,
  request: DropAuthRequest,
  now: number,
): DropAuthResult {
  try {
    const event = parseHeader(authorization);
    if (event === null) return { ok: false, reason: 'malformed' };
    if (typeof request !== 'object' || request === null) {
      return { ok: false, reason: 'request_mismatch' };
    }
    const { method, url, body } = request;
    if (!isMethod(method) || !isUrl(url) || !(body instanceof Uint8Array)) {
      return { ok: false, reason: 'request_mismatch' };
    }
    const expected = tagsFor({ method, url, body });
    for (let i = 0; i < 3; i += 1) {
      if (event.tags[i]?.[1] !== expected[i]?.[1]) {
        return { ok: false, reason: 'request_mismatch' };
      }
    }
    if (!isTimestamp(now) || Math.abs(now - event.created_at) > DROP_AUTH_MAX_SKEW_SECONDS) {
      return { ok: false, reason: 'stale' };
    }
    if (nostrEventId(event.pubkey, event) !== event.id) {
      return { ok: false, reason: 'invalid_signature' };
    }
    const valid = bip340Verify(decodeHex(event.pubkey), decodeHex(event.id), decodeHex(event.sig));
    if (!valid) return { ok: false, reason: 'invalid_signature' };
    return { ok: true, pubkey: event.pubkey, createdAt: event.created_at };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

export type DropUrlPurpose = 'put' | 'get';

/** What a drop URL MAC covers. */
export interface DropUrlFields {
  readonly purpose: DropUrlPurpose;
  readonly objectId: Uint8Array;
  readonly part: number;
  readonly expiresAt: number;
}

function urlMacMessage(fields: DropUrlFields): Uint8Array {
  if (typeof fields !== 'object' || fields === null) refuse('dropUrlMac: fields missing');
  const { purpose, objectId, part, expiresAt } = fields;
  if (purpose !== 'put' && purpose !== 'get') refuse('dropUrlMac: purpose must be put or get');
  assertBytes(objectId, 'dropUrlMac: objectId');
  if (objectId.length !== DROP_OBJECT_ID_LENGTH) {
    throw new CryptoInputError('invalid_length', 'dropUrlMac: objectId must be 16 bytes');
  }
  if (typeof part !== 'number' || !Number.isInteger(part) || part < 0 || part > DROP_MAX_PART) {
    refuse('dropUrlMac: part must be an integer from 0 to 10000');
  }
  if (purpose === 'get' && part !== 0) refuse('dropUrlMac: a GET URL has part 0');
  if (!isTimestamp(expiresAt)) refuse('dropUrlMac: expiresAt must be a non-negative integer');
  const tail = new Uint8Array(11);
  const view = new DataView(tail.buffer);
  view.setUint8(0, purpose === 'put' ? 1 : 2);
  // objectId goes between the purpose byte and the part, so it is spliced below.
  view.setUint16(1, part);
  view.setUint32(3, Math.floor(expiresAt / 2 ** 32));
  view.setUint32(7, expiresAt >>> 0);
  return concatBytes(
    encodeUtf8(DROP_URL_MAC_LABEL),
    new Uint8Array([0]),
    tail.subarray(0, 1),
    objectId,
    tail.subarray(1),
  );
}

function assertUrlKey(key: Uint8Array): void {
  assertBytes(key, 'dropUrlMac: key');
  if (key.length !== DROP_URL_KEY_LENGTH) {
    throw new CryptoInputError('invalid_length', 'dropUrlMac: key must be 32 bytes');
  }
}

/** The 32-byte MAC of a drop PUT or GET URL. The caller owns the key. */
export function dropUrlMac(key: Uint8Array, fields: DropUrlFields): Uint8Array {
  assertUrlKey(key);
  return hmacSha256(key, urlMacMessage(fields));
}

/** True only when `mac` is the MAC of `fields` under `key`, compared in constant time. Never throws. */
export function verifyDropUrlMac(key: Uint8Array, fields: DropUrlFields, mac: Uint8Array): boolean {
  try {
    if (!(mac instanceof Uint8Array) || mac.length !== DROP_URL_MAC_LENGTH) return false;
    return equalBytes(dropUrlMac(key, fields), mac);
  } catch {
    return false;
  }
}
