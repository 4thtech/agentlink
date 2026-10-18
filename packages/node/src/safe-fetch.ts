// M1-15: the SSRF-safe download for `agentlink_fetch_file` (04 §4 "SSRF protection (`fetch_file`)",
// §7; 06 §2.3). The URL comes from another party's envelope, so every step assumes it is hostile:
//   - the raw URL passes core's checkFetchUrl (https only, no numeric host notations, no local
//     names, no user info) before anything else happens;
//   - the host is resolved once, EVERY answer must be globally routable (pickPublicAddress), and
//     the TCP connection goes to that checked address: no second lookup, so DNS rebinding between
//     check and connect cannot redirect it. TLS SNI, certificate checks and `Host` use the name;
//   - at most MAX_FETCH_REDIRECTS redirects, each one re-checked from the raw string and resolved
//     and pinned again; a third redirect fails;
//   - a byte cap (checked against Content-Length first, then counted) and one deadline for the
//     whole download, redirects included; no content decoding, so the cap counts what arrives;
//   - no proxy: the socket is our own (`createConnection`, no Agent), so HTTPS_PROXY and the like
//     cannot bypass the address check.
// Nothing here logs, and no error carries the URL, the host, an address or server text: a download
// URL is a secret (I-7). Callers branch on SafeFetchError.code.
import {
  MAX_FETCH_REDIRECTS,
  checkFetchUrl,
  pickPublicAddress,
  resolveRedirect,
} from '@4thtech-io/core';
import type { CheckedFetchUrl } from '@4thtech-io/core';
import dns from 'node:dns';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from 'node:tls';

/** Default deadline for the whole download, redirects included. */
export const SAFE_FETCH_TIMEOUT_MS = 60_000;
const MAX_HEADER_BYTES = 16 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type SafeFetchErrorCode =
  /** The URL (or a redirect target) failed the raw check of 04 §4. */
  | 'url_refused'
  /** The host did not resolve. */
  | 'resolve_failed'
  /** The host resolved to an address that is not globally routable (or to nothing usable). */
  | 'address_refused'
  /** A redirect had no usable `Location`, or pointed somewhere the raw check refuses. */
  | 'redirect_refused'
  /** More than MAX_FETCH_REDIRECTS redirects. */
  | 'too_many_redirects'
  /** A final status other than 200, or a content encoding other than identity. */
  | 'http_status'
  /** More bytes than `maxBytes` were declared or sent. */
  | 'too_large'
  /** The deadline passed or the caller aborted. */
  | 'timeout'
  /** The connection or TLS failed. */
  | 'network'
  /** `maxBytes` or `timeoutMs` is not a positive safe integer. */
  | 'options_invalid';

const MESSAGES: Record<SafeFetchErrorCode, string> = {
  url_refused: 'The download link is not allowed: it must be a public https link.',
  resolve_failed: 'The download host could not be found.',
  address_refused: 'The download host points to a private or local network address.',
  redirect_refused: 'The download link redirected somewhere that is not allowed.',
  too_many_redirects: 'The download link redirected too many times.',
  http_status: 'The download server did not return the file.',
  too_large: 'The download is larger than the declared size.',
  timeout: 'The download took too long and was stopped.',
  network: 'The download connection failed.',
  options_invalid: 'The download limits are invalid.',
};

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;

  constructor(code: SafeFetchErrorCode) {
    super(MESSAGES[code]); // fixed text: no URL, host, address or server text (I-7)
    this.name = 'SafeFetchError';
    this.code = code;
  }
}

export interface SafeFetchOptions {
  /** Byte cap: the declared size plus overhead (04 §4). Required. */
  readonly maxBytes: number;
  /** Deadline for the whole download, redirects included. Default SAFE_FETCH_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Receives each chunk as it arrives, in order; the body is then not buffered and the result's
   * `body` is empty. A throw or rejection aborts the download and is rethrown unchanged.
   */
  readonly onChunk?: (chunk: Uint8Array) => void | Promise<void>;
}

export interface SafeFetchResult {
  /** Bytes received (≤ maxBytes). */
  readonly size: number;
  /** The body, unless `onChunk` consumed it. */
  readonly body: Uint8Array;
  /** Redirects followed (0..MAX_FETCH_REDIRECTS). */
  readonly redirects: number;
}

export type SafeFetch = (url: string, options: SafeFetchOptions) => Promise<SafeFetchResult>;

/** `dns.lookup` with `all: true`, injectable for tests. */
export type FetchLookup = (host: string) => Promise<readonly string[]>;

/**
 * Test seams, never exported from the package entry (fence.test.ts): `lookup` replaces the system
 * resolver, `ca` the system trust roots, `route` sends the checked address to a local port.
 */
export interface SafeFetchSeams {
  readonly lookup?: FetchLookup;
  readonly ca?: string;
  readonly route?: (address: string, port: number) => { address: string; port: number };
}

function systemLookup(host: string): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true, order: 'verbatim' }, (error, addresses) => {
      if (error !== null || !Array.isArray(addresses)) reject(new Error('lookup failed'));
      else resolve(addresses.map((entry) => entry.address));
    });
  });
}

interface Hop {
  readonly status: number;
  readonly location: string | undefined;
}

/** The safe fetch with test seams. Production: nodeSafeFetch(). */
export function createSafeFetchWith(seams: SafeFetchSeams = {}): SafeFetch {
  const lookup = seams.lookup ?? systemLookup;

  return async function safeFetch(url, options) {
    const timeoutMs = options.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1
    ) {
      throw new SafeFetchError('options_invalid');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onCallerAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (options.signal?.aborted === true) controller.abort();
    const signal = controller.signal;
    let callerError: { readonly error: unknown } | undefined;

    try {
      let current = url;
      for (let redirects = 0; ; redirects += 1) {
        const check = checkFetchUrl(current);
        if (!check.ok)
          throw new SafeFetchError(redirects === 0 ? 'url_refused' : 'redirect_refused');
        const target = check.value;
        const address = await resolvePinned(target, lookup, signal);
        const chunks: Uint8Array[] = [];
        let size = 0;
        const hop = await exchange(
          target,
          address,
          seams,
          signal,
          async (chunk) => {
            size += chunk.length;
            if (size > options.maxBytes) throw new SafeFetchError('too_large');
            if (options.onChunk === undefined) {
              chunks.push(chunk);
              return;
            }
            try {
              await options.onChunk(chunk);
            } catch (error) {
              callerError = { error };
              throw error;
            }
          },
          options.maxBytes,
        );
        if (hop.status === 200) {
          const body = new Uint8Array(options.onChunk === undefined ? size : 0);
          if (options.onChunk === undefined) {
            let offset = 0;
            for (const chunk of chunks) {
              body.set(chunk, offset);
              offset += chunk.length;
            }
          }
          return { size, body, redirects };
        }
        if (!REDIRECT_STATUSES.has(hop.status)) throw new SafeFetchError('http_status');
        if (redirects >= MAX_FETCH_REDIRECTS) throw new SafeFetchError('too_many_redirects');
        const next = resolveRedirect(target, hop.location);
        if (next === undefined) throw new SafeFetchError('redirect_refused');
        current = next;
      }
    } catch (error) {
      if (callerError !== undefined) throw callerError.error;
      if (error instanceof SafeFetchError) throw error;
      throw new SafeFetchError(signal.aborted ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onCallerAbort);
    }
  };
}

/** One lookup per hop; every answer must be globally routable; the first is pinned. */
async function resolvePinned(
  target: CheckedFetchUrl,
  lookup: FetchLookup,
  signal: AbortSignal,
): Promise<string> {
  if (target.literal !== undefined) return target.literal; // already checked as routable
  if (signal.aborted) throw new SafeFetchError('timeout');
  let addresses: readonly string[];
  try {
    addresses = await Promise.race([
      lookup(target.host),
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new SafeFetchError('timeout')), {
          once: true,
        }),
      ),
    ]);
  } catch (error) {
    if (error instanceof SafeFetchError) throw error;
    throw new SafeFetchError('resolve_failed');
  }
  const address = pickPublicAddress(addresses);
  if (address === undefined || isIP(address) === 0) throw new SafeFetchError('address_refused');
  return address;
}

/** A TLS socket to the checked address, with SNI and certificate checks on the host name. */
function pinnedTls(target: CheckedFetchUrl, address: string, seams: SafeFetchSeams): TLSSocket {
  const routed =
    seams.route === undefined ? { address, port: target.port } : seams.route(address, target.port);
  const servername = target.literal === undefined ? target.host : undefined;
  const socket = tlsConnect({
    host: routed.address,
    port: routed.port,
    ...(servername === undefined ? {} : { servername }),
    ALPNProtocols: ['http/1.1'],
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
    checkServerIdentity: (_hostname, cert) => checkServerIdentity(target.host, cert),
    ...(seams.ca === undefined ? {} : { ca: seams.ca }),
  });
  socket.on('error', () => undefined); // the request owns error handling; never an uncaught throw
  return socket;
}

/** One GET to the pinned address. Streams a 200 body into `sink`; returns the status otherwise. */
function exchange(
  target: CheckedFetchUrl,
  address: string,
  seams: SafeFetchSeams,
  signal: AbortSignal,
  sink: (chunk: Uint8Array) => Promise<void>,
  maxBytes: number,
): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, hop?: Hop): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      req.destroy();
      if (error === undefined && hop !== undefined) resolve(hop);
      else reject(error);
    };
    const onAbort = (): void => finish(new SafeFetchError('timeout'));
    const hostHeader =
      (target.host.includes(':') ? `[${target.host}]` : target.host) +
      (target.port === 443 ? '' : `:${target.port}`);
    const req = httpsRequest({
      method: 'GET',
      host: target.host,
      port: target.port,
      path: target.pathAndQuery,
      headers: {
        Host: hostHeader,
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        Connection: 'close',
      },
      // Our own socket and no agent: no proxy, no pooled connection to another address.
      agent: undefined,
      createConnection: () => pinnedTls(target, address, seams),
      maxHeaderSize: MAX_HEADER_BYTES,
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    req.on('error', () => finish(new SafeFetchError(signal.aborted ? 'timeout' : 'network')));
    req.on('response', (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status !== 200) {
        const location = res.headers.location;
        res.resume();
        finish(undefined, {
          status,
          location: typeof location === 'string' ? location : undefined,
        });
        return;
      }
      const encoding = res.headers['content-encoding'];
      if (encoding !== undefined && encoding.toLowerCase() !== 'identity') {
        finish(new SafeFetchError('http_status'));
        return;
      }
      const declared = res.headers['content-length'];
      if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > maxBytes)) {
        finish(new SafeFetchError('too_large'));
        return;
      }
      void (async () => {
        try {
          for await (const chunk of res as AsyncIterable<Buffer>) {
            if (settled) return;
            await sink(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length));
          }
          if (!res.complete) throw new SafeFetchError('network');
          finish(undefined, { status: 200, location: undefined });
        } catch (error) {
          finish(
            error instanceof SafeFetchError
              ? error
              : new SafeFetchError(signal.aborted ? 'timeout' : 'network'),
          );
        }
      })();
    });
    req.end();
  });
}

/** The Node download for `fetch_file`: the SSRF rules of 04 §4 with the system resolver. */
export function nodeSafeFetch(): SafeFetch {
  return createSafeFetchWith();
}
