// The page's one request (D-139, 04 §3.6.2 steps 2-4, 08 §4): a GET of a short-link invite object
// from the drop. The URL is the page's own build constant plus the lookupId core derived, never
// anything from the fragment or inbound text; the link secret, the link and the decrypted invite are
// never sent. No credentials, no referrer, no redirect, no cache; the answer must be 200 with
// `application/octet-stream` and at most 17 441 bytes (a running count), within 10 s. Errors are
// core's three invite codes and carry nothing from the answer (I-5).
import { CoreError, type ShortInviteFetch } from '@4thtech-io/core';
import { SHORT_INVITE_LOOKUP_ID_RE } from '@4thtech-io/crypto';

/** The drop host (07 §5.4, `DROP_DEFAULT_ENDPOINT`): the only origin the CSP lets the page reach. */
export const DROP_HOST = 'https://drop.agentlink.4thtech.io';

/** The largest invite object (04 §3.6.2: 17 + 17 408 + 16 bytes). */
export const INVITE_OBJECT_MAX_BYTES = 17_441;

/** The whole fetch, body included, is given up after this (04 §3.6.2 step 3). */
export const INVITE_FETCH_TIMEOUT_MS = 10_000;

/** Strict base64url of 16 bytes, shared with storage and the drop Worker (F-L2). */
const LOOKUP_ID = SHORT_INVITE_LOOKUP_ID_RE;

const unavailable = (): CoreError =>
  new CoreError('invite_unavailable', 'This invite is no longer available.');
const failed = (): CoreError =>
  new CoreError('invite_fetch_failed', 'The invite could not be fetched. Try again.');
const invalid = (): CoreError =>
  new CoreError('invite_invalid', 'This invite is damaged or not supported.');

/** The page's fetcher for core's `resolveInviteLink`. `fetchImpl` is the browser's `fetch`. */
export function inviteFetcher(
  fetchImpl: typeof fetch,
  timeoutMs: number = INVITE_FETCH_TIMEOUT_MS,
): ShortInviteFetch {
  return async (lookupId: string): Promise<Uint8Array> => {
    if (typeof lookupId !== 'string' || !LOOKUP_ID.test(lookupId)) throw invalid();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(`${DROP_HOST}/v1/i/${lookupId}`, {
          method: 'GET',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
        });
      } catch {
        // A network failure, the timeout, or a redirect the browser refused (`redirect: 'error'`).
        throw failed();
      }
      if (response.status === 404) throw unavailable();
      if (response.status === 429 || response.status === 503) throw failed();
      if (response.status !== 200) throw invalid();
      const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
      if (type !== 'application/octet-stream') throw invalid();
      const length = response.headers.get('content-length');
      if (length !== null && !(Number(length) <= INVITE_OBJECT_MAX_BYTES)) throw invalid();
      return await readBounded(response);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}

/** The body, read with a running count that stops above the cap. */
async function readBounded(response: Response): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const out = new Uint8Array(INVITE_OBJECT_MAX_BYTES);
  let size = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw failed();
      }
      if (chunk.done) break;
      if (size + chunk.value.length > INVITE_OBJECT_MAX_BYTES) throw invalid();
      out.set(chunk.value, size);
      size += chunk.value.length;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return out.slice(0, size);
}
