// The invite link codec (04 §3.6, D-69, G-12): the one encode/decode pair for invite data. The CLI,
// the MCP tools and, from M2, the invite landing page use it; no other code inflates invite data.
//
// payload = base64url(deflateRaw(utf8(JSON))), shared as `https://agentlink.4thtech.io/i#<payload>`.
// Compression is the platform's `CompressionStream("deflate-raw")` / `DecompressionStream(...)`
// (browsers, Node, Workers): no dependency, and compression is not a crypto primitive (04 §8.1).
//
// The decoder follows the four steps of 04 §3.6 exactly, and every step fails closed with one fixed
// error (`invite_invalid`): no partial result and no inbound text in the error (I-5).
//  1. The input string is bounded before anything parses it, and must be exactly the canonical
//     prefix plus the payload, or the bare payload. The payload is strict base64url.
//  2. Inflation is fed in slices of at most 1 KiB while the output is read concurrently, with a
//     running count; past 16 384 bytes nothing more is fed, the output due is drained and discarded,
//     the decoder is shut down with nothing left pending, and the invite is refused.
//  3. The stream must end exactly at the end of the input: a successful inflate is repeated without
//     the last input byte, and that must fail (a complete stream always needs its last byte).
//  4. UTF-8 with fatal errors and the BOM kept, I-JSON (duplicate keys refused, integers only) and the
//     strict invite schema (unknown keys refused).
// Nothing hashes, signs or compares the compressed bytes or the payload text (04 §3.6, not canonical).
//
// Link format 2 (W4-SHORT-INVITE, D-139, 04 §3.6.2): `https://agentlink.4thtech.io/i#2.<43>` carries
// only the 32-byte link secret K. `.` is not a base64url character, so the `2.` prefix alone tells
// the formats apart. Resolving one fetches the `ALI1` object under the lookup ID derived from K (the
// caller's fetcher gets that 22-character ID only, never K), opens it, and runs the D-69 steps 2-4 on
// the payload inside, exactly as for a format 1 link. A resolved link is kept in this process's
// memory (bounded, short-lived) so the page's check, the accept and the approval action fetch it once.
//
// This module imports only @4thtech-io/crypto, @4thtech-io/types and the core's errors, so the vector
// harness runs it from source in Node, browsers and workerd (test-vectors/harness/suites/invite-link.ts).
import {
  canonicalize,
  decodeBase64url,
  decodeUtf8,
  encodeBase64url,
  encodeUtf8,
  openShortInvite,
  parseReceivedJson,
  shortInviteLookupId,
  wipe,
} from '@4thtech-io/crypto';
import { inviteSchema, type Invite } from '@4thtech-io/types';
import { CoreError } from './errors.js';

/** The canonical link prefix (04 §3.6, 06 §7.1). The payload follows the `#`. */
export const INVITE_LINK_PREFIX = 'https://agentlink.4thtech.io/i#';
/** The inflated invite JSON is at most this many bytes (04 §3.6). */
export const INVITE_MAX_JSON_BYTES = 16_384;
/** The payload is at most this many characters: unpadded base64url of 16 384 bytes (04 §3.6). */
export const INVITE_MAX_PAYLOAD_CHARS = 21_846;
/** Compressed input is fed to the decoder in slices of at most this many bytes (04 §3.6 note). */
export const INVITE_INFLATE_SLICE_BYTES = 1_024;

const PAYLOAD = /^[A-Za-z0-9_-]+$/;
/** Link format 2: `2.` and 43 characters of strict base64url whose last one has zero trailing bits. */
const SHORT = /^2\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
/** `2.` plus the 43-character secret (04 §3.6.2). */
export const SHORT_INVITE_LINK_CHARS = 45;

const invalid = (): CoreError => new CoreError('invite_invalid', 'The invite link is not valid.');

/** The web-platform stream parts this codec uses (typed locally: the core has no DOM lib). */
interface StreamReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
}
interface StreamWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
interface CodecStream {
  readonly readable: { getReader(): StreamReader };
  readonly writable: { getWriter(): StreamWriter };
}
interface CodecStreamCtor {
  new (format: 'deflate-raw'): CodecStream;
}

interface CodecGlobals {
  readonly CompressionStream?: CodecStreamCtor;
  readonly DecompressionStream?: CodecStreamCtor;
}

function codec(kind: 'CompressionStream' | 'DecompressionStream'): CodecStreamCtor {
  const ctor = (globalThis as CodecGlobals)[kind];
  if (typeof ctor !== 'function') {
    throw new CoreError('invite_invalid', 'This runtime cannot read invite links.');
  }
  return ctor;
}

/**
 * Inflates `input` (raw DEFLATE) under `cap` output bytes. Returns the output, or undefined for a
 * malformed or truncated stream or one that passes the cap. Never throws and never leaves a promise
 * rejected and unhandled: the reader runs concurrently with the slice writes, and after the cap
 * trips the writable side is closed only once no write is pending, while the reader drains and
 * discards whatever output is still due. The readable side is never cancelled.
 */
async function inflateCapped(input: Uint8Array, cap: number): Promise<Uint8Array | undefined> {
  let stream: CodecStream;
  try {
    stream = new (codec('DecompressionStream'))('deflate-raw');
  } catch {
    return undefined;
  }
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  let readFailed = false;
  const reading = (async (): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || value === undefined) return;
        if (over) continue; // past the cap: discard what is still due
        total += value.byteLength;
        if (total > cap) {
          over = true;
          chunks.length = 0;
        } else {
          chunks.push(value);
        }
      }
    } catch {
      readFailed = true;
    }
  })();
  let writeFailed = false;
  for (let offset = 0; offset < input.length && !over; offset += INVITE_INFLATE_SLICE_BYTES) {
    try {
      await writer.write(input.slice(offset, offset + INVITE_INFLATE_SLICE_BYTES));
    } catch {
      writeFailed = true;
      break;
    }
  }
  // No write is pending here. Close (or, after a failed write, abort) and wait for both sides.
  try {
    if (writeFailed) await writer.abort();
    else await writer.close();
  } catch {
    writeFailed = true;
  }
  await reading;
  if (over || writeFailed || readFailed) return undefined;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

async function deflateRaw(input: Uint8Array): Promise<Uint8Array> {
  const stream = new (codec('CompressionStream'))('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  const reading = (async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) return;
      chunks.push(value);
    }
  })();
  await writer.write(input);
  await writer.close();
  await reading;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The D-69 payload bytes P of a schema-valid invite: `deflateRaw(utf8(JCS(invite)))` (04 §3.6). */
export async function encodeInvitePayload(invite: Invite): Promise<Uint8Array> {
  const parsed = inviteSchema.safeParse(invite);
  if (!parsed.success) throw invalid();
  const json = encodeUtf8(canonicalize(parsed.data));
  if (json.length > INVITE_MAX_JSON_BYTES) {
    throw new CoreError('invite_too_large', 'The invite is too large to share as a link.');
  }
  const payload = await deflateRaw(json);
  if (encodeBase64url(payload).length > INVITE_MAX_PAYLOAD_CHARS) {
    throw new CoreError('invite_too_large', 'The invite is too large to share as a link.');
  }
  return payload;
}

/** The format 2 link of the 32-byte link secret K (04 §3.6.2). Never log it (I-7). */
export function encodeShortInviteLink(secret: Uint8Array): string {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) throw invalid();
  return `${INVITE_LINK_PREFIX}2.${encodeBase64url(secret)}`;
}

/**
 * The link secret K of a format 2 link (the full link or the bare `2.<43>`), or undefined when the
 * input is not format 2. A string that starts as format 2 but breaks any rule of 04 §3.6.2 step 1 is
 * refused with `invite_invalid`, as is anything that is neither format (04 §3.6 step 1).
 */
export function shortInviteSecretOf(link: unknown): Uint8Array | undefined {
  if (typeof link !== 'string') throw invalid();
  const code = link.startsWith(INVITE_LINK_PREFIX) ? link.slice(INVITE_LINK_PREFIX.length) : link;
  if (!code.startsWith('2.')) {
    // Format 1 has the same step 1 shape; anything else is neither format (04 §3.6 step 1).
    if (code.length > INVITE_MAX_PAYLOAD_CHARS || !PAYLOAD.test(code)) throw invalid();
    return undefined;
  }
  if (code.length !== SHORT_INVITE_LINK_CHARS || !SHORT.test(code)) throw invalid();
  try {
    return decodeBase64url(code.slice(2), { length: 32 });
  } catch {
    throw invalid();
  }
}

/**
 * Fetches the `ALI1` object stored under `lookupId` (22 characters of base64url) from the configured
 * drop, never from anything in the link. Throws core's `invite_unavailable` (404),
 * `invite_fetch_failed` (retryable) or `invite_invalid` (a response that is not an object).
 */
export type ShortInviteFetch = (lookupId: string) => Promise<Uint8Array>;

const CACHE_MAX = 32;
const CACHE_MS = 15 * 60 * 1000;
/** lookupId → the resolved format 1 link: memory only, for this process (04 §3.6.2 step 3). */
const resolved = new Map<string, { readonly link: string; readonly at: number }>();

/** Forgets every resolved short link (tests, and a host that wants none kept). */
export function clearShortInviteCache(): void {
  resolved.clear();
}

/**
 * The format 1 link of `link`: itself for format 1 (unchecked here: the decoder checks it), or the
 * resolved invite for format 2 (fetched once, opened, then decoded by the D-69 steps). Without a
 * fetcher a format 2 link is refused as damaged, as releases before D-139 do.
 */
export async function resolveInviteLink(
  link: unknown,
  fetchObject?: ShortInviteFetch,
): Promise<string> {
  const secret = shortInviteSecretOf(link);
  if (secret === undefined) return link as string;
  try {
    const lookupId = encodeBase64url(shortInviteLookupId(secret));
    const now = Date.now();
    const hit = resolved.get(lookupId);
    if (hit !== undefined && now - hit.at < CACHE_MS) return hit.link;
    resolved.delete(lookupId);
    if (fetchObject === undefined) throw invalid();
    let object: Uint8Array;
    try {
      object = await fetchObject(lookupId);
    } catch (error) {
      if (
        error instanceof CoreError &&
        (error.code === 'invite_unavailable' ||
          error.code === 'invite_fetch_failed' ||
          error.code === 'invite_invalid')
      ) {
        throw error;
      }
      throw new CoreError('invite_fetch_failed', 'The invite could not be fetched. Try again.');
    }
    if (!(object instanceof Uint8Array)) throw invalid();
    const payload = await openShortInvite(secret, object);
    if (payload === undefined) throw invalid();
    const long = `${INVITE_LINK_PREFIX}${encodeBase64url(payload)}`;
    // Steps 2-4 of the D-69 decoder on P: a payload that is not a valid invite is damaged.
    await decodeFormatOne(long);
    resolved.set(lookupId, { link: long, at: now });
    while (resolved.size > CACHE_MAX) {
      const oldest = resolved.keys().next().value;
      if (oldest === undefined) break;
      resolved.delete(oldest);
    }
    return long;
  } finally {
    wipe(secret);
  }
}

/** Options of decodeInviteLink: how a format 2 link is fetched (absent: refused as damaged). */
export interface DecodeInviteOptions {
  readonly fetchShortInvite?: ShortInviteFetch;
}

/**
 * Encodes a schema-valid invite as its canonical link. The JSON is compact (JCS: no whitespace,
 * non-ASCII unescaped). Refuses an invite whose JSON exceeds 16 384 bytes or whose payload exceeds
 * 21 846 characters, so every link it returns decodes (04 §3.6).
 */
export async function encodeInviteLink(invite: Invite): Promise<string> {
  return `${INVITE_LINK_PREFIX}${encodeBase64url(await encodeInvitePayload(invite))}`;
}

/**
 * Decodes a full canonical link or a bare payload, of either link format, into a strictly valid
 * invite (04 §3.6 steps 1-4; §3.6.2 for format 2). Signatures, hashes and expiry are not checked here
 * (Accept step 1, the pairing service).
 */
export async function decodeInviteLink(
  link: unknown,
  options: DecodeInviteOptions = {},
): Promise<Invite> {
  return decodeFormatOne(await resolveInviteLink(link, options.fetchShortInvite));
}

async function decodeFormatOne(link: unknown): Promise<Invite> {
  // Step 1: bound the input before parsing it; exactly the prefix plus the payload, or the payload.
  if (
    typeof link !== 'string' ||
    link.length > INVITE_LINK_PREFIX.length + INVITE_MAX_PAYLOAD_CHARS
  ) {
    throw invalid();
  }
  const payload = link.startsWith(INVITE_LINK_PREFIX)
    ? link.slice(INVITE_LINK_PREFIX.length)
    : link;
  if (payload.length > INVITE_MAX_PAYLOAD_CHARS || !PAYLOAD.test(payload)) throw invalid();
  let compressed: Uint8Array;
  try {
    compressed = decodeBase64url(payload);
  } catch {
    throw invalid();
  }
  // Step 2: bounded inflation.
  const inflated = await inflateCapped(compressed, INVITE_MAX_JSON_BYTES);
  if (inflated === undefined) throw invalid();
  // Step 3: exact end of stream (the input without its last byte must not inflate).
  if (
    compressed.length === 0 ||
    (await inflateCapped(compressed.subarray(0, -1), INVITE_MAX_JSON_BYTES)) !== undefined
  ) {
    throw invalid();
  }
  // Step 4: strict text, I-JSON and the strict schema.
  let value: unknown;
  try {
    // The invite carries the inviter's card: the received-text parse (04 §2.5.1, D-128).
    value = parseReceivedJson(decodeUtf8(inflated));
  } catch {
    throw invalid();
  }
  const parsed = inviteSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
