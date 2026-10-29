// W4-SHORT-INVITE (D-139; 07 §5.4, 04 §3.6.2 steps 2-4): the unauthenticated fetch of a short
// invite's `ALI1` object. The URL is built here from the configured drop origin and a strict
// 22-character lookup ID the caller derived itself; nothing from a link or inbound text is ever
// fetched. No redirect is followed (any 3xx, or an opaque redirect, is a failure), no credentials or
// referrer are sent, the answer must be 200 with `application/octet-stream`, and the body is capped
// at 17 441 bytes (Content-Length first, then a running count). The fetch it is given is the drop's
// guarded fetch (exact origin, https). No error carries the URL or the lookup ID (I-7).
import { validateS3Endpoint } from './endpoint.js';
import { StorageError } from './errors.js';
import { discard, type FetchLike } from './http.js';

/** The largest `ALI1` object (04 §3.6.2): header 17 + padded plaintext 17 408 + tag 16. */
export const INVITE_OBJECT_MAX_BYTES = 17_441;
/** The whole fetch is bounded (04 §3.6.2 step 3: at most 10 s). */
export const INVITE_FETCH_TIMEOUT_MS = 10_000;
/** Strict base64url of 16 bytes: 22 characters, the last with zero trailing bits (07 §5.4). */
export const INVITE_LOOKUP_ID_RE = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const MAX_RETRY_AFTER_SECONDS = 3_600;

export interface InviteFetchConfig {
  /** `https://host[:port]`: the configured drop, never a value from a link. */
  readonly endpoint: string;
  readonly fetch: FetchLike;
  /** Default INVITE_FETCH_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

/** True for a strict lookup ID (the drop answers 404 to anything else without a lookup). */
export function isInviteLookupId(value: unknown): value is string {
  return typeof value === 'string' && INVITE_LOOKUP_ID_RE.test(value);
}

function retryAfter(response: Response): { retryAfter: number } | Record<string, never> {
  const raw = response.headers.get('retry-after');
  if (raw === null || !/^\d{1,10}$/.test(raw)) return {};
  return { retryAfter: Math.min(Number(raw), MAX_RETRY_AFTER_SECONDS) };
}

const failed = (status?: number): StorageError =>
  new StorageError('download_failed', 'the invite could not be fetched', status);

const tooLarge = (): StorageError =>
  new StorageError('too_large', 'the invite object is too large');

async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * One GET of `<endpoint>/v1/i/<lookupId>`. Returns the object bytes, or throws a StorageError:
 * `not_found` (404: gone, used up, cancelled, expired or never there), `rate_limited` (429) and
 * `unavailable` (503) (retryable), `too_large`, `invalid_response` (not octet-stream),
 * `download_failed` (any other status, a redirect, or the deadline), `network`.
 */
export async function fetchInviteObject(
  config: InviteFetchConfig,
  lookupId: string,
): Promise<Uint8Array> {
  if (!isInviteLookupId(lookupId)) {
    throw new StorageError('invalid_argument', 'invalid invite lookup ID');
  }
  const origin = validateS3Endpoint(config.endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? INVITE_FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await config.fetch(
        new Request(new URL(`/v1/i/${lookupId}`, origin).href, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
          signal: controller.signal,
        }),
      );
    } catch {
      // The underlying error can carry the URL; it is dropped (I-7).
      if (controller.signal.aborted) throw failed();
      throw new StorageError('network', 'the invite request failed');
    }
    const status = response.status;
    if (status === 200 && response.type !== 'opaqueredirect') {
      const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim();
      if (type?.toLowerCase() !== 'application/octet-stream') {
        await discard(response);
        throw new StorageError('invalid_response', 'the drop returned an invalid response');
      }
      const declared = response.headers.get('content-length');
      if (
        declared !== null &&
        (!/^\d{1,9}$/.test(declared) || Number(declared) > INVITE_OBJECT_MAX_BYTES)
      ) {
        await discard(response);
        throw tooLarge();
      }
      try {
        return await readCapped(response, INVITE_OBJECT_MAX_BYTES);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw failed();
      }
    }
    await discard(response);
    if (status === 404) {
      throw new StorageError('not_found', 'the invite is no longer available', 404);
    }
    if (status === 429) {
      throw new StorageError(
        'rate_limited',
        'the drop is busy; try again later',
        429,
        retryAfter(response),
      );
    }
    if (status === 503) {
      throw new StorageError(
        'unavailable',
        'the drop is unavailable; try again later',
        503,
        retryAfter(response),
      );
    }
    throw failed(status === 0 ? undefined : status);
  } finally {
    clearTimeout(timer);
  }
}
