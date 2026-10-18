// M1-1g-e (IR-M1-6c-1): the drop-request signer behind KeyStore.signDropRequest (04 §2.1 drop key,
// §4; 07 §5.4 signature format). Every KeyStore backend calls signDropRequest(secretKey, …) with the
// drop key it derived for the current epoch; it is exported only from the restricted
// @4thtech-io/crypto/keystore entry.
//
// The signer is deliberately narrow, so a drop key can only ever sign a request the drop accepts:
// - the event is built here by dropAuthEvent, so kind 27235, the empty content and the `domain` tag
//   `agentlink/v1/drop` are fixed; the caller passes exactly {method, url, body} and nothing else;
// - only POST and DELETE (PUT and GET use the drop's URL MAC instead);
// - the URL is https, without credentials or fragment, in its WHATWG-serialised form (the Worker
//   compares `u` with the URL as its runtime serialises it, 07 §5.4);
// - the body is the drop's signed JSON (at most 1024 bytes, strict JSON, an object with v: 1, a
//   16-byte base64url nonce and an integer ts), and `createdAt` equals its `ts`.
// Anything else is refused with one fixed error that names no input (I-7). Each request field is
// read once and the snapshot is what is checked and signed.
import { assertBytes } from './bytes.js';
import { dropAuthEvent, encodeDropAuthorization, type DropAuthRequest } from './drop-auth.js';
import { decodeBase64url, decodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { parseJson } from './jcs.js';
import { signNostrEvent, type UnsignedNostrEvent } from './nostr-event.js';

/** The one message every refused drop request gets. It names no input (I-7). */
export const DROP_REQUEST_REFUSED = 'signDropRequest: not a drop request this key signs';

/** Largest signed drop body (upload, commit, DELETE), as the drop Worker reads it (M1-27a). */
const MAX_SIGNED_BODY = 1024;
const REQUEST_KEYS = ['body', 'method', 'url'];

function refused(): CryptoInputError {
  return new CryptoInputError('invalid_argument', DROP_REQUEST_REFUSED);
}

function isNonce(value: unknown): boolean {
  if (typeof value !== 'string' || value.length !== 22) return false;
  try {
    decodeBase64url(value, { length: 16 });
    return true;
  } catch {
    return false;
  }
}

/** The WHATWG URL parser of the runtime (Node, browsers, workerd); the package builds without DOM types. */
interface ParsedUrl {
  readonly href: string;
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly hash: string;
}
type UrlConstructor = new (url: string) => ParsedUrl;

function isCanonicalUrl(url: string): boolean {
  const Url = (globalThis as { URL?: UrlConstructor }).URL;
  // No URL parser: refuse rather than sign a URL the drop might read differently.
  if (typeof Url !== 'function') return false;
  let parsed: ParsedUrl;
  try {
    parsed = new Url(url);
  } catch {
    return false;
  }
  return (
    parsed.href === url &&
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.hash === ''
  );
}

/** The `ts` of a drop signed body, or null when the body is not one. */
function bodyTimestamp(body: Uint8Array): number | null {
  if (body.length > MAX_SIGNED_BODY) return null;
  let value: unknown;
  try {
    value = parseJson(decodeUtf8(body), { integersOnly: true });
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { v, nonce, ts } = value as Record<string, unknown>;
  if (v !== 1 || !isNonce(nonce)) return null;
  if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts < 0) return null;
  return ts;
}

/**
 * Checks a drop request against the rules above and returns a frozen plain copy of it (each field
 * read once), or throws the fixed refusal. Public inputs only: backends call it before they read a
 * seed, so a refused request never touches key material. Never takes a kind, tag or event.
 */
export function dropRequestSnapshot(request: unknown, createdAt: unknown): DropAuthRequest {
  if (typeof request !== 'object' || request === null) throw refused();
  let snapshot: DropAuthRequest;
  try {
    const keys = Object.keys(request).sort();
    if (keys.length !== REQUEST_KEYS.length || keys.some((k, i) => k !== REQUEST_KEYS[i])) {
      throw refused();
    }
    const { method, url, body } = request as Record<string, unknown>;
    if (method !== 'POST' && method !== 'DELETE') throw refused();
    if (typeof url !== 'string' || !isCanonicalUrl(url)) throw refused();
    if (!(body instanceof Uint8Array)) throw refused();
    // A plain copy of the real bytes: what is checked is what is hashed into the event.
    snapshot = Object.freeze({ method, url, body: new Uint8Array(body) });
  } catch {
    throw refused();
  }
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw refused();
  }
  if (bodyTimestamp(snapshot.body) !== createdAt) throw refused();
  return snapshot;
}

function dropRequestEvent(request: unknown, createdAt: number): UnsignedNostrEvent {
  const snapshot = dropRequestSnapshot(request, createdAt);
  try {
    return dropAuthEvent(snapshot, createdAt);
  } catch {
    throw refused();
  }
}

/**
 * Signs a drop request with `dropSecretKey` (the 32-byte BIP-340 drop key of the current epoch) and
 * returns the `Authorization` header value, `Nostr <base64url(JSON event)>`. KeyStore backends only:
 * the key is the caller's to derive and wipe. Refuses anything but a drop request (see above).
 */
export function signDropRequest(
  dropSecretKey: Uint8Array,
  request: DropAuthRequest,
  createdAt: number,
): string {
  assertBytes(dropSecretKey, 'signDropRequest: dropSecretKey');
  if (dropSecretKey.length !== 32) {
    throw new CryptoInputError('invalid_length', 'signDropRequest: dropSecretKey must be 32 bytes');
  }
  const event = dropRequestEvent(request, createdAt);
  return encodeDropAuthorization(signNostrEvent(dropSecretKey, event));
}
