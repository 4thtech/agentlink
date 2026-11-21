// RELAY-SHARED-CONN: the frame codec of the local channel between a program and the shared relay link
// (one relay connection per computer). Pure and transport-agnostic: the endpoints (a Unix socket, a
// Windows named pipe) are built elsewhere and carry these frames.
//
// A frame is a one-line JSON header, then, for frames that carry relay text, "\n" and that text raw
// (not JSON-escaped, so it cannot grow past the relay frame limit). Parsing is strict: a frame with
// an unknown type, a missing or extra field, a value out of range, or over the size limits is refused
// with a fixed reason that never repeats any of its content (I-5, I-7). On a byte stream, each frame
// is sent with a 4-byte big-endian length in front (`linkFrameBytes`, `LinkFrameReader`).
//
// Handshake (04 §4 "Local relay link"): the token is never sent. The program sends `hello` with the
// protocol version, its CLI version and a random nonce; the link answers `challenge` with its own
// nonce and its proof (HMAC-SHA-256 under the token over the server label and both nonces); the
// program checks it in constant time and only then answers `prove` with its own proof under the
// client label; the link checks that and sends `accept`. A wrong proof on either side ends the
// channel before any relay frame is read.
import {
  concatBytes,
  decodeHex,
  decodeUtf8,
  encodeHex,
  encodeUtf8,
  equalBytes,
  hmacSha256,
} from '@4thtech-io/crypto';
import { MAX_FRAME_BYTES } from './relay-pool.js';

/** The protocol version in the handshake. A program and a shared link that differ do not share. */
export const SHARED_LINK_VERSION = 1;
/** The largest header (the JSON line before any relay text). */
export const SHARED_LINK_HEADER_MAX_BYTES = 1024;
/** The largest whole frame: a header and one relay frame of at most MAX_FRAME_BYTES. */
export const SHARED_LINK_MAX_FRAME_BYTES = MAX_FRAME_BYTES + SHARED_LINK_HEADER_MAX_BYTES + 1;
/** The longest relay URL a frame may carry (the relay URL rule is applied by the shared link). */
export const SHARED_LINK_MAX_URL_LENGTH = 2048;
/** Bytes of the shared secret a program presents in the handshake. */
export const SHARED_LINK_TOKEN_BYTES = 32;
/**
 * How long either side waits for the handshake. Well inside the pool's 10 s connect budget
 * (CONNECT_TIMEOUT_MS), so a stalled shared link still leaves time to connect directly.
 */
export const SHARED_HANDSHAKE_TIMEOUT_MS = 2_000;

/** Why the shared link refused a handshake. */
export type SharedLinkRejectReason = 'version' | 'token' | 'protocol' | 'busy';
/**
 * Why a virtual link ended: `refused` (the relay URL rule or the address check), `limit` (a cap on
 * the shared link; the program may connect on its own), the connect failure classes of
 * RelaySocketHandlers.onFailure, or `closed` (anything else, including the relay closing).
 */
export type SharedLinkCloseReason = 'closed' | 'refused' | 'limit' | 'tls' | 'upgrade' | 'connect';
/** The answer of the check lane for one event id; `found` carries the relay's event, raw. */
export type SharedCheckAnswer = 'found' | 'missing' | 'unchecked';

/** Frames a program sends to the shared link. */
export type ClientFrame =
  | {
      readonly t: 'hello';
      readonly v: number;
      readonly cli: string;
      readonly nonce: string;
      /**
       * `aux`: a short-lived channel (a server test, a check, a status question) that is not an ID's
       * client and is not counted as one. Absent: an ID's client.
       */
      readonly kind?: 'aux';
    }
  | { readonly t: 'prove'; readonly proof: string }
  | {
      readonly t: 'open';
      readonly link: number;
      readonly url: string;
      /**
       * Whether this program may log in on this relay (its `mayAuthenticate`). Absent: it may. A
       * program that may log in moves to a connection of its own when the relay asks for a login.
       */
      readonly auth?: boolean;
    }
  | { readonly t: 'send'; readonly link: number; readonly data: string }
  | { readonly t: 'close'; readonly link: number }
  | { readonly t: 'check'; readonly q: number; readonly url: string; readonly id: string };

/** Frames the shared link sends to a program. */
export type ServerFrame =
  | {
      readonly t: 'challenge';
      readonly v: number;
      readonly nonce: string;
      readonly proof: string;
    }
  | { readonly t: 'accept'; readonly v: number }
  | { readonly t: 'reject'; readonly reason: SharedLinkRejectReason }
  | { readonly t: 'opened'; readonly link: number }
  | { readonly t: 'msg'; readonly link: number; readonly data: string }
  | { readonly t: 'closed'; readonly link: number; readonly why: SharedLinkCloseReason }
  | {
      readonly t: 'checked';
      readonly q: number;
      readonly outcome: SharedCheckAnswer;
      readonly data?: string;
    };

export type LinkFrame = ClientFrame | ServerFrame;

/** Why a frame was refused: fixed classes, never content. */
export type LinkDecodeFailure = 'too_large' | 'malformed' | 'unknown';

export type LinkDecodeResult<F> =
  | { readonly ok: true; readonly frame: F }
  | { readonly ok: false; readonly reason: LinkDecodeFailure };

const HEX_32 = /^[0-9a-f]{64}$/;
const CLI_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const MAX_ID = 2 ** 31 - 1;

/** UTF-8 length of a string, without encoding it when the answer is already clear. */
export function utf8Length(text: string, limit: number): number {
  if (text.length > limit) return text.length; // at least one byte per UTF-16 unit: over the limit
  if (text.length * 3 <= limit) return text.length * 3; // an upper bound within the limit
  return encodeUtf8(text).length;
}

/** Encodes one frame as text. The caller builds frames from typed values; nothing is validated. */
export function encodeLinkFrame(frame: LinkFrame): string {
  const { data, ...head } = frame as LinkFrame & { data?: string };
  const header = JSON.stringify(head);
  return data === undefined ? header : `${header}\n${data}`;
}

type Fields = Record<string, unknown>;

const isId = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= MAX_ID;
const isUrl = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= SHARED_LINK_MAX_URL_LENGTH;
const hasKeys = (o: Fields, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
};
const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T =>
  typeof v === 'string' && (values as readonly string[]).includes(v);

interface Split {
  head: Fields;
  data: string | undefined;
}

/** Size checks, then the header split and parse. */
function split(text: unknown): Split | LinkDecodeFailure {
  if (typeof text !== 'string' || text.length === 0) return 'malformed';
  if (utf8Length(text, SHARED_LINK_MAX_FRAME_BYTES) > SHARED_LINK_MAX_FRAME_BYTES) {
    return 'too_large';
  }
  const at = text.indexOf('\n');
  const headText = at === -1 ? text : text.slice(0, at);
  const data = at === -1 ? undefined : text.slice(at + 1);
  if (utf8Length(headText, SHARED_LINK_HEADER_MAX_BYTES) > SHARED_LINK_HEADER_MAX_BYTES) {
    return 'too_large';
  }
  if (data !== undefined && utf8Length(data, MAX_FRAME_BYTES) > MAX_FRAME_BYTES) return 'too_large';
  let head: unknown;
  try {
    head = JSON.parse(headText);
  } catch {
    return 'malformed';
  }
  if (typeof head !== 'object' || head === null || Array.isArray(head)) return 'malformed';
  if (typeof (head as Fields).t !== 'string') return 'malformed';
  return { head: head as Fields, data };
}

const fail = (reason: LinkDecodeFailure): { ok: false; reason: LinkDecodeFailure } => ({
  ok: false,
  reason,
});

/** Decodes and validates a frame a program sent. Untrusted input: never throws. */
export function decodeClientFrame(text: unknown): LinkDecodeResult<ClientFrame> {
  const parts = split(text);
  if (typeof parts === 'string') return fail(parts);
  const { head: h, data } = parts;
  const noData = data === undefined;
  switch (h.t) {
    case 'hello': {
      const withKind = hasKeys(h, ['t', 'v', 'cli', 'nonce', 'kind']);
      if (!noData || !(withKind || hasKeys(h, ['t', 'v', 'cli', 'nonce']))) {
        return fail('malformed');
      }
      if (withKind && h.kind !== 'aux') return fail('malformed');
      if (typeof h.v !== 'number' || !Number.isSafeInteger(h.v) || h.v < 0 || h.v > 65535)
        return fail('malformed');
      if (typeof h.cli !== 'string' || !CLI_VERSION.test(h.cli)) return fail('malformed');
      if (typeof h.nonce !== 'string' || !HEX_32.test(h.nonce)) return fail('malformed');
      return {
        ok: true,
        frame: withKind
          ? { t: 'hello', v: h.v, cli: h.cli, nonce: h.nonce, kind: 'aux' }
          : { t: 'hello', v: h.v, cli: h.cli, nonce: h.nonce },
      };
    }
    case 'prove':
      if (!noData || !hasKeys(h, ['t', 'proof'])) return fail('malformed');
      if (typeof h.proof !== 'string' || !HEX_32.test(h.proof)) return fail('malformed');
      return { ok: true, frame: { t: 'prove', proof: h.proof } };
    case 'open': {
      const withAuth = hasKeys(h, ['t', 'link', 'url', 'auth']);
      if (!noData || !(withAuth || hasKeys(h, ['t', 'link', 'url']))) return fail('malformed');
      if (!isId(h.link) || !isUrl(h.url)) return fail('malformed');
      if (withAuth && typeof h.auth !== 'boolean') return fail('malformed');
      return {
        ok: true,
        frame: withAuth
          ? { t: 'open', link: h.link, url: h.url, auth: h.auth as boolean }
          : { t: 'open', link: h.link, url: h.url },
      };
    }
    case 'send':
      if (noData || !hasKeys(h, ['t', 'link']) || !isId(h.link)) return fail('malformed');
      return { ok: true, frame: { t: 'send', link: h.link, data } };
    case 'close':
      if (!noData || !hasKeys(h, ['t', 'link']) || !isId(h.link)) return fail('malformed');
      return { ok: true, frame: { t: 'close', link: h.link } };
    case 'check':
      if (!noData || !hasKeys(h, ['t', 'q', 'url', 'id']) || !isId(h.q) || !isUrl(h.url))
        return fail('malformed');
      if (typeof h.id !== 'string' || !HEX_32.test(h.id)) return fail('malformed');
      return { ok: true, frame: { t: 'check', q: h.q, url: h.url, id: h.id } };
    default:
      return fail('unknown');
  }
}

/** Decodes and validates a frame the shared link sent. Untrusted input: never throws. */
export function decodeServerFrame(text: unknown): LinkDecodeResult<ServerFrame> {
  const parts = split(text);
  if (typeof parts === 'string') return fail(parts);
  const { head: h, data } = parts;
  const noData = data === undefined;
  switch (h.t) {
    case 'challenge':
      if (!noData || !hasKeys(h, ['t', 'v', 'nonce', 'proof'])) return fail('malformed');
      if (typeof h.v !== 'number' || !Number.isSafeInteger(h.v)) return fail('malformed');
      if (typeof h.nonce !== 'string' || !HEX_32.test(h.nonce)) return fail('malformed');
      if (typeof h.proof !== 'string' || !HEX_32.test(h.proof)) return fail('malformed');
      return { ok: true, frame: { t: 'challenge', v: h.v, nonce: h.nonce, proof: h.proof } };
    case 'accept':
      if (
        !noData ||
        !hasKeys(h, ['t', 'v']) ||
        typeof h.v !== 'number' ||
        !Number.isSafeInteger(h.v)
      )
        return fail('malformed');
      return { ok: true, frame: { t: 'accept', v: h.v } };
    case 'reject':
      if (!noData || !hasKeys(h, ['t', 'reason'])) return fail('malformed');
      if (!oneOf(h.reason, ['version', 'token', 'protocol', 'busy'] as const))
        return fail('malformed');
      return { ok: true, frame: { t: 'reject', reason: h.reason } };
    case 'opened':
      if (!noData || !hasKeys(h, ['t', 'link']) || !isId(h.link)) return fail('malformed');
      return { ok: true, frame: { t: 'opened', link: h.link } };
    case 'msg':
      if (noData || !hasKeys(h, ['t', 'link']) || !isId(h.link)) return fail('malformed');
      return { ok: true, frame: { t: 'msg', link: h.link, data } };
    case 'closed':
      if (!noData || !hasKeys(h, ['t', 'link', 'why']) || !isId(h.link)) return fail('malformed');
      if (!oneOf(h.why, ['closed', 'refused', 'limit', 'tls', 'upgrade', 'connect'] as const))
        return fail('malformed');
      return { ok: true, frame: { t: 'closed', link: h.link, why: h.why } };
    case 'checked': {
      if (!hasKeys(h, ['t', 'q', 'outcome']) || !isId(h.q)) return fail('malformed');
      if (!oneOf(h.outcome, ['found', 'missing', 'unchecked'] as const)) return fail('malformed');
      if ((h.outcome === 'found') === noData) return fail('malformed'); // data iff found
      return {
        ok: true,
        frame:
          data === undefined
            ? { t: 'checked', q: h.q, outcome: h.outcome }
            : { t: 'checked', q: h.q, outcome: h.outcome, data },
      };
    }
    default:
      return fail('unknown');
  }
}

const PROOF_LABELS = {
  server: encodeUtf8('agentlink/relay-link/v1/server-proof'),
  client: encodeUtf8('agentlink/relay-link/v1/client-proof'),
} as const;

/**
 * One side's token proof: HMAC-SHA-256 under the token over that side's label, the program's nonce
 * and the link's nonce (each 32 bytes as 64 lowercase hex), as 64 lowercase hex.
 */
export function linkProof(
  token: Uint8Array,
  side: 'server' | 'client',
  clientNonce: string,
  serverNonce: string,
): string {
  const message = concatBytes(
    PROOF_LABELS[side],
    decodeHex(clientNonce, { length: 32 }),
    decodeHex(serverNonce, { length: 32 }),
  );
  return encodeHex(hmacSha256(token, message));
}

/** Checks a proof in constant time (equalBytes). Any malformed input is false. */
export function checkLinkProof(
  token: Uint8Array,
  side: 'server' | 'client',
  clientNonce: string,
  serverNonce: string,
  proof: string,
): boolean {
  try {
    if (typeof proof !== 'string' || !HEX_32.test(proof)) return false;
    const expected = decodeHex(linkProof(token, side, clientNonce, serverNonce));
    return equalBytes(expected, decodeHex(proof));
  } catch {
    return false;
  }
}

/** A frame for a byte stream: 4-byte big-endian length, then the UTF-8 text. */
export function linkFrameBytes(text: string): Uint8Array {
  const body = encodeUtf8(text);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

/**
 * Splits a byte stream into frames (`linkFrameBytes`). A declared length over
 * SHARED_LINK_MAX_FRAME_BYTES or text that is not UTF-8 is an error, and the reader stays failed:
 * the endpoint closes the channel. Nothing over the limit is ever buffered.
 */
export class LinkFrameReader {
  private buffer = new Uint8Array(0);
  private error: 'too_large' | 'malformed' | undefined;

  push(chunk: Uint8Array): { frames: string[]; error?: 'too_large' | 'malformed' } {
    if (this.error !== undefined) return { frames: [], error: this.error };
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    const frames: string[] = [];
    let at = 0;
    while (joined.length - at >= 4) {
      const length = new DataView(joined.buffer, joined.byteOffset + at, 4).getUint32(0);
      if (length > SHARED_LINK_MAX_FRAME_BYTES) return this.failWith('too_large');
      if (joined.length - at - 4 < length) break;
      try {
        frames.push(decodeUtf8(joined.subarray(at + 4, at + 4 + length)));
      } catch {
        return this.failWith('malformed');
      }
      at += 4 + length;
    }
    this.buffer = joined.slice(at);
    return { frames };
  }

  private failWith(error: 'too_large' | 'malformed'): { frames: string[]; error: typeof error } {
    this.error = error;
    this.buffer = new Uint8Array(0);
    return { frames: [], error };
  }
}
