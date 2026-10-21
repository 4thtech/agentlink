// A minimal JSON-RPC caller for the submitter Worker's chain port (07 §7; M1-10a).
//
// - Every URL passes the 04 §4 raw-string rule (`checkRpcUrl`) before the caller exists, and is a
//   secret (it may carry the operator's provider key in its path): it never appears in an error.
// - Only the read methods of the read client plus `eth_sendRawTransaction` are sent. No account,
//   signing or filter method exists here; the gas key signs locally (port.ts).
// - No redirect, no credentials, no referrer; a per-request timeout. A transport failure (network,
//   timeout, HTTP status, a body that is not JSON-RPC) moves to the next URL; a JSON-RPC error is an
//   answer and is returned as such, so a contract revert is never retried elsewhere.
// - Redirects use `redirect: "manual"`: the Workers runtime throws a TypeError for "error" (it
//   supports only "follow" and "manual"). A 3xx answer is not ok, so it is never followed and the
//   caller moves to the next URL, the same outcome as "error".
//
// Why the Worker does not go through `createReadClient` (IR-M1-4a-2 R-3): that client needs the
// platform's address-checked fetch, which exists only in Node (`nodeRpcFetch`). This caller runs in
// the Cloudflare Workers runtime, whose fetch has no route into private networks, and its URLs come
// from the operator's Worker configuration or the shipped chain config, never from inbound content.
import { ChainConfigError } from '../config/index.js';
import { ChainError } from '../clients/errors.js';
import { RPC_READ_METHODS } from '../clients/read-client.js';
import { checkRpcUrl } from '../clients/rpc-url.js';

/** The JSON-RPC methods the submitter's chain port sends. */
export const SUBMITTER_RPC_METHODS: readonly string[] = Object.freeze([
  ...RPC_READ_METHODS,
  'eth_sendRawTransaction',
]);

/** Largest JSON-RPC answer read (receipts with a 20-item batch's logs stay far below it). */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

/** A JSON-RPC error answer: `data` is the revert data when the node returned it. */
export class RpcAnswerError extends Error {
  readonly rpcCode: number | undefined;
  readonly data: `0x${string}` | undefined;

  constructor(rpcCode: number | undefined, data: `0x${string}` | undefined) {
    super('The chain returned an error.'); // fixed text: never server text (I-7)
    this.name = 'RpcAnswerError';
    this.rpcCode = rpcCode;
    this.data = data;
  }
}

/** The part of a fetch Response the caller reads (this package has no DOM types). */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/** The request options the caller sends. */
export interface FetchInit {
  readonly method: 'GET' | 'POST';
  readonly headers?: Record<string, string>;
  readonly body?: string;
  /** `manual` in the Worker (workerd refuses `error`); a 3xx is then not ok and never followed. */
  readonly redirect: 'error' | 'manual';
  readonly credentials: 'omit';
  readonly referrerPolicy: 'no-referrer';
  readonly signal: unknown;
}

/** The runtime's fetch, as this package calls it. */
export type FetchFn = (input: string, init: FetchInit) => Promise<FetchResponse>;

/** Any fetch-shaped function (the platform's `fetch`, a test double). */
export type AnyFetch = (input: string, init: never) => Promise<unknown>;

/** `AbortSignal.timeout(ms)` of the runtime (Workers, Node 22, browsers). */
export function timeoutSignal(ms: number): unknown {
  return (
    globalThis as unknown as { AbortSignal: { timeout(ms: number): unknown } }
  ).AbortSignal.timeout(ms);
}

const HEX = /^0x[0-9a-fA-F]*$/;

function revertDataOf(error: Record<string, unknown>): `0x${string}` | undefined {
  const data = error.data;
  if (typeof data === 'string' && HEX.test(data)) return data as `0x${string}`;
  if (typeof data === 'object' && data !== null) {
    const nested = (data as Record<string, unknown>).data;
    if (typeof nested === 'string' && HEX.test(nested)) return nested as `0x${string}`;
  }
  return undefined;
}

/** A JSON-RPC caller over the checked URLs, in order. */
export function createRpcCaller(
  urls: readonly string[],
  fetchFn: FetchFn,
  timeoutMs: number,
): (method: string, params: readonly unknown[]) => Promise<unknown> {
  if (urls.length === 0) throw new ChainConfigError('bad_rpc_url', 'at least one RPC URL');
  for (const url of urls) {
    if (!checkRpcUrl(url).ok) {
      // Never echo the URL: it is a secret.
      throw new ChainConfigError(
        'bad_rpc_url',
        'an RPC URL breaks the rule (https, a public host name)',
      );
    }
  }
  const list = [...new Set(urls)];
  let id = 0;
  return async (method, params) => {
    if (!SUBMITTER_RPC_METHODS.includes(method)) throw new ChainError('method_refused');
    id += 1;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    let timedOut = false;
    for (const url of list) {
      let answer: unknown;
      try {
        const res = await fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: timeoutSignal(timeoutMs),
        });
        if (!res.ok) continue;
        const text = await res.text();
        if (text.length > MAX_ANSWER_BYTES) continue;
        answer = JSON.parse(text);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === 'TimeoutError' || error.name === 'AbortError')
        ) {
          timedOut = true;
        }
        continue;
      }
      if (typeof answer !== 'object' || answer === null) continue;
      const a = answer as Record<string, unknown>;
      if (a.id !== id) continue;
      if (typeof a.error === 'object' && a.error !== null) {
        const e = a.error as Record<string, unknown>;
        throw new RpcAnswerError(typeof e.code === 'number' ? e.code : undefined, revertDataOf(e));
      }
      if (!('result' in a)) continue;
      return a.result;
    }
    throw new ChainError(timedOut ? 'rpc_timeout' : 'rpc_unavailable');
  };
}
