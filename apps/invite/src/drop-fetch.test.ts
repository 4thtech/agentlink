// W4-SHORT-INVITE (S2; D-139, 04 §3.6.2 steps 2-4, 08 §4): the page's one GET of a short-link
// invite object. The URL is the page's own drop host plus the 22-character lookupId and nothing else;
// the request carries no credentials, no referrer, follows no redirect and is never cached; the
// answer is bounded (status, type, 17 441 bytes, 10 s) and mapped to core's three invite errors.
import { CoreError } from '@4thtech-io/core';
import { describe, expect, it, vi } from 'vitest';
import headersFile from '../site/_headers?raw';
import {
  DROP_HOST,
  INVITE_FETCH_TIMEOUT_MS,
  INVITE_OBJECT_MAX_BYTES,
  inviteFetcher,
} from './drop-fetch.js';
import { dropResponse } from './testing/fixtures.js';

const LOOKUP = 'AbCdEfGhIjKlMnOpQr_-12';

type FetchArgs = [RequestInfo | URL, RequestInit | undefined];

function fakeFetch(answer: () => Response | Promise<Response>) {
  return vi.fn<(...args: FetchArgs) => Promise<Response>>(async () => answer());
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CoreError);
    return (error as CoreError).code;
  }
  throw new Error('expected a refusal');
}

/** A body streamed in `chunks` pieces of `size` bytes, with no Content-Length. */
function streamed(chunks: number, size: number): Response {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(size));
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
}

describe('the drop host and the CSP (08 §4, D-139)', () => {
  it('is the build constant, the default drop endpoint', () => {
    expect(DROP_HOST).toBe('https://drop.agentlink.4thtech.io');
    expect(INVITE_OBJECT_MAX_BYTES).toBe(17_441);
    expect(INVITE_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it('the CSP allows a connection to the drop host only, and changes nothing else', () => {
    const csp = /^\s*Content-Security-Policy:\s*(.+)$/m.exec(headersFile)?.[1]?.trim();
    expect(csp).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src https://drop.agentlink.4thtech.io; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'",
    );
    expect(headersFile).toMatch(/^\s*Referrer-Policy: no-referrer$/m);
  });
});

describe('inviteFetcher: the request', () => {
  it('sends exactly one GET to the drop host with the exact options', async () => {
    const fetch = fakeFetch(() => dropResponse(new Uint8Array([1, 2, 3])));
    const bytes = await inviteFetcher(fetch)(LOOKUP);
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`https://drop.agentlink.4thtech.io/v1/i/${LOOKUP}`);
    expect(init).toBeDefined();
    const { signal, ...rest } = init ?? {};
    expect(rest).toEqual({
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      cache: 'no-store',
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses anything but a 22-character base64url lookupId, without a request', async () => {
    const fetch = fakeFetch(() => dropResponse(new Uint8Array([1])));
    const get = inviteFetcher(fetch);
    for (const bad of [
      '',
      LOOKUP.slice(1),
      `${LOOKUP}A`,
      'AbCdEfGhIjKlMnOpQr+/12',
      '../../v1/upload/xxxxxx',
      'AbCdEfGhIjKlMnOpQr%2F1',
    ]) {
      expect(await codeOf(get(bad)), bad).toBe('invite_invalid');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('inviteFetcher: the answer (04 §3.6.2 step 4)', () => {
  it('maps 404 to invite_unavailable', async () => {
    const get = inviteFetcher(fakeFetch(() => dropResponse(null, 404, {})));
    expect(await codeOf(get(LOOKUP))).toBe('invite_unavailable');
  });

  it('maps 429 and 503 to the retryable invite_fetch_failed', async () => {
    for (const status of [429, 503]) {
      const get = inviteFetcher(fakeFetch(() => dropResponse(null, status, {})));
      expect(await codeOf(get(LOOKUP)), String(status)).toBe('invite_fetch_failed');
    }
  });

  it('maps a network failure, and a redirect refused by the browser, to invite_fetch_failed', async () => {
    // With `redirect: 'error'` the browser rejects the fetch on any 3xx with a TypeError.
    const get = inviteFetcher(
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    expect(await codeOf(get(LOOKUP))).toBe('invite_fetch_failed');
  });

  it('treats every other status as damaged (invite_invalid)', async () => {
    for (const status of [201, 204, 301, 302, 400, 401, 403, 410, 500, 502]) {
      const get = inviteFetcher(fakeFetch(() => dropResponse(null, status, {})));
      expect(await codeOf(get(LOOKUP)), String(status)).toBe('invite_invalid');
    }
  });

  it('accepts only Content-Type application/octet-stream', async () => {
    for (const type of ['text/html', 'application/json', 'application/octet-streamx', '']) {
      const get = inviteFetcher(
        fakeFetch(() => dropResponse(new Uint8Array([1]), 200, { 'content-type': type })),
      );
      expect(await codeOf(get(LOOKUP)), type).toBe('invite_invalid');
    }
  });

  it('refuses a Content-Length above 17 441 bytes before reading the body', async () => {
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const answer = new Response(body, {
      headers: { 'content-type': 'application/octet-stream', 'content-length': '17442' },
    });
    const get = inviteFetcher(fakeFetch(() => answer));
    expect(await codeOf(get(LOOKUP))).toBe('invite_invalid');
    expect(pull).not.toHaveBeenCalled();
  });

  it('aborts a body above 17 441 bytes with a running count (no Content-Length)', async () => {
    const get = inviteFetcher(fakeFetch(() => streamed(18, 1_000)));
    expect(await codeOf(get(LOOKUP))).toBe('invite_invalid');
  });

  it('accepts a body of exactly 17 441 bytes', async () => {
    const get = inviteFetcher(
      fakeFetch(() => dropResponse(new Uint8Array(INVITE_OBJECT_MAX_BYTES).fill(9))),
    );
    expect((await get(LOOKUP)).length).toBe(INVITE_OBJECT_MAX_BYTES);
  });

  it('gives up after the timeout as invite_fetch_failed', async () => {
    const fetch = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    expect(await codeOf(inviteFetcher(fetch, 20)(LOOKUP))).toBe('invite_fetch_failed');
  });
});
