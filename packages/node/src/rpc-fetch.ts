// M1-4a (IR-M1-4a-1 M-1): the address-checked fetch for chain RPC requests in Node. It is the
// `fetchFn` the CLI hands `@4thtech-io/chain`'s createReadClient, so the 04 §4 resolve-time rule
// applies to shipped and user-added RPC URLs alike. It reuses the safe-fetch machinery (M1-15):
//   - the raw URL passes core's checkFetchUrl first (https only, no local names, no user info);
//   - every request resolves the host again, EVERY answer must be globally routable (loopback,
//     private, link-local and unique-local answers are refused), and the TLS connection goes to the
//     checked address itself, with SNI, certificate checks and `Host` on the name. One lookup per
//     request and `Connection: close`, so DNS rebinding between check and connect cannot redirect it;
//   - no redirects (a 3xx is an error), no proxy (our own socket), no cookies, a response size cap
//     and the caller's abort signal (viem's per-request timeout).
// An RPC URL may carry the owner's provider key in its path, so the URL is a secret: no error, log
// or result here carries the URL, the host, an address or server text (I-7).
import { checkFetchUrl } from '@4thtech-io/core';
import type { CheckedFetchUrl } from '@4thtech-io/core';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  SafeFetchError,
  pinnedTls,
  resolvePinned,
  systemLookup,
  type SafeFetchSeams,
} from './safe-fetch.js';

/** Largest RPC response accepted (eth_getLogs pages stay far below it). */
export const RPC_FETCH_MAX_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;

export type RpcFetchErrorCode =
  /** The URL failed the raw check of 04 §4, or the request is not a plain POST/GET with a body. */
  | 'url_refused'
  /** The host did not resolve. */
  | 'resolve_failed'
  /** The host resolved to an address that is not globally routable. */
  | 'address_refused'
  /** The server answered with a redirect; RPC requests never follow one. */
  | 'redirect_refused'
  /** The response was larger than RPC_FETCH_MAX_BYTES. */
  | 'too_large'
  /** The caller aborted (timeout). */
  | 'timeout'
  /** The connection or TLS failed. */
  | 'network';

const MESSAGES: Record<RpcFetchErrorCode, string> = {
  url_refused: 'The RPC endpoint is not allowed: it must be a public https link.',
  resolve_failed: 'The RPC endpoint could not be found.',
  address_refused: 'The RPC endpoint points to a private or local network address.',
  redirect_refused: 'The RPC endpoint redirected, which is not allowed.',
  too_large: 'The RPC endpoint sent too much data.',
  timeout: 'The RPC endpoint took too long.',
  network: 'The connection to the RPC endpoint failed.',
};

export class RpcFetchError extends Error {
  readonly code: RpcFetchErrorCode;

  constructor(code: RpcFetchErrorCode) {
    super(MESSAGES[code]); // fixed text: never the URL, host, address or server text (I-7)
    this.name = 'RpcFetchError';
    this.code = code;
  }
}

/** The `fetch` shape viem's HTTP transport calls. */
export type RpcFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function fromSafeFetch(error: unknown, signal: AbortSignal | undefined): RpcFetchError {
  if (error instanceof RpcFetchError) return error;
  if (error instanceof SafeFetchError) {
    if (error.code === 'resolve_failed' || error.code === 'address_refused') {
      return new RpcFetchError(error.code);
    }
    if (error.code === 'timeout') return new RpcFetchError('timeout');
  }
  return new RpcFetchError(signal?.aborted === true ? 'timeout' : 'network');
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => {
    // Hop-by-hop and identity headers are ours to set.
    if (!['host', 'connection', 'content-length', 'cookie', 'authorization'].includes(name)) {
      out[name] = value;
    }
  });
  return out;
}

function send(
  target: CheckedFetchUrl,
  address: string,
  seams: SafeFetchSeams,
  method: 'POST' | 'GET',
  body: Buffer,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, response?: Response): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      req.destroy();
      if (response !== undefined) resolve(response);
      else reject(error);
    };
    const onAbort = (): void => finish(new RpcFetchError('timeout'));
    const hostHeader =
      (target.host.includes(':') ? `[${target.host}]` : target.host) +
      (target.port === 443 ? '' : `:${String(target.port)}`);
    const req = httpsRequest({
      method,
      host: target.host,
      port: target.port,
      path: target.pathAndQuery,
      headers: {
        ...headers,
        Host: hostHeader,
        'Accept-Encoding': 'identity',
        Connection: 'close',
        'Content-Length': String(body.length),
      },
      agent: undefined, // our own socket: no proxy, no pooled connection to another address
      createConnection: () => pinnedTls(target, address, seams),
      maxHeaderSize: MAX_HEADER_BYTES,
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    req.on('error', () => finish(new RpcFetchError(signal.aborted ? 'timeout' : 'network')));
    req.on('response', (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        finish(new RpcFetchError('redirect_refused'));
        return;
      }
      const encoding = res.headers['content-encoding'];
      if (encoding !== undefined && encoding.toLowerCase() !== 'identity') {
        res.resume();
        finish(new RpcFetchError('network'));
        return;
      }
      void (async () => {
        try {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of res as AsyncIterable<Buffer>) {
            if (settled) return;
            size += chunk.length;
            if (size > RPC_FETCH_MAX_BYTES) throw new RpcFetchError('too_large');
            chunks.push(chunk);
          }
          if (!res.complete) throw new RpcFetchError('network');
          const type = res.headers['content-type'];
          finish(
            undefined,
            new Response(status === 204 ? null : Buffer.concat(chunks), {
              status,
              headers: typeof type === 'string' ? { 'content-type': type } : {},
            }),
          );
        } catch (error) {
          finish(
            error instanceof RpcFetchError
              ? error
              : new RpcFetchError(signal.aborted ? 'timeout' : 'network'),
          );
        }
      })();
    });
    req.end(body);
  });
}

/** The RPC fetch with test seams. Production: nodeRpcFetch(). Not exported from the package. */
export function createRpcFetchWith(seams: SafeFetchSeams = {}): RpcFetch {
  const lookup = seams.lookup ?? systemLookup;
  return async function rpcFetch(input, init) {
    const signal = init?.signal ?? new AbortController().signal;
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'POST' && method !== 'GET') throw new RpcFetchError('url_refused');
      const raw = init?.body ?? null;
      if (raw !== null && typeof raw !== 'string') throw new RpcFetchError('url_refused');
      const body = Buffer.from(raw ?? '', 'utf8');
      if (body.length > MAX_REQUEST_BYTES) throw new RpcFetchError('url_refused');
      const check = checkFetchUrl(url);
      if (!check.ok) throw new RpcFetchError('url_refused');
      // A fresh lookup per request; every answer must be public; the first is pinned.
      const address = await resolvePinned(check.value, lookup, signal);
      return await send(check.value, address, seams, method, body, headerRecord(init), signal);
    } catch (error) {
      throw fromSafeFetch(error, signal);
    }
  };
}

/**
 * The address-checked fetch for chain RPC requests in Node, with the system resolver. Pass it as
 * `fetchFn` to `@4thtech-io/chain` createReadClient.
 */
export function nodeRpcFetch(): RpcFetch {
  return createRpcFetchWith();
}
