// The submitter client (07 §6.2, §7; M1-10a): the HTTP side of "submit via submitter(s) with
// failover". It sends items the agent already signed through KeyStore.sign712 and parses answers
// strictly. It trusts no answer: M1-4c confirms every status by reading the chain (04 §5, §7: a
// malicious submitter can only censor), and falls back to another submitter or direct mode.
//
// - Submitter URLs pass the 04 §4 raw-string rule (https, a public host name, no user info, query
//   or fragment), and requests go only through the platform's address-checked fetch, as for RPC
//   URLs (IR-M1-4a-2 R-3; Node: nodeRpcFetch). No redirect, credentials or referrer.
// - Failover: the next URL on a network error, a timeout, a 5xx or 429, a chain that submitter does
//   not serve, or an answer that does not parse. A refusal of the request itself (other 4xx) stops,
//   because every submitter would refuse it too.
// - Errors carry fixed codes and text: never a URL, a signature or server text.
import { ChainConfigError } from '../config/index.js';
import { isAddressCheckedFetch } from '../clients/checked-fetch.js';
import { DEFAULT_RPC_TIMEOUT_MS } from '../clients/read-client.js';
import { timeoutSignal, type AnyFetch, type FetchFn, type FetchResponse } from './rpc.js';
import { checkRpcUrl } from '../clients/rpc-url.js';
import type { OccReceipt, OccRecord } from '@4thtech-io/crypto';
import {
  isTxHash,
  parseHealthResponse,
  parseStatusResponse,
  parseSubmitResponse,
  submitRequestBody,
  type HealthResponse,
  type StatusResponse,
  type SubmitKind,
  type SubmitResponse,
} from './wire.js';

/** At most this many submitter URLs (07 §7: clients accept a list). */
export const MAX_SUBMITTER_URLS = 5;
/** Largest submitter answer read. */
const MAX_ANSWER_BYTES = 256 * 1024;

export type SubmitterErrorCode =
  /** Every submitter failed or answered in a way that does not parse. */
  | 'unavailable'
  /** A submitter refused the request itself (400 and similar). */
  | 'refused'
  /** The input is not valid (a malformed transaction hash, mismatched lists). */
  | 'invalid_input';

const MESSAGES: Record<SubmitterErrorCode, string> = {
  unavailable: 'No submitter could take the request.',
  refused: 'The submitter refused the request.',
  invalid_input: 'The submitter request is not valid.',
};

/** A submitter client failure. Fixed text; `reason` is the submitter's fixed error code, if any. */
export class SubmitterError extends Error {
  readonly code: SubmitterErrorCode;
  readonly reason: string | undefined;

  constructor(code: SubmitterErrorCode, reason?: string) {
    super(MESSAGES[code]);
    this.name = 'SubmitterError';
    this.code = code;
    this.reason = reason;
  }
}

export interface SubmitterClientOptions {
  /** Submitter base URLs, tried in order. */
  readonly urls: readonly string[];
  /** The platform's address-checked fetch (Node: nodeRpcFetch). */
  readonly fetchFn: AnyFetch;
  /** Per-request timeout, 1 to 30 000 ms. */
  readonly timeoutMs?: number;
}

export interface SubmitterClient {
  notarize(
    chainId: number,
    items: readonly { readonly record: OccRecord; readonly signature: string }[],
  ): Promise<SubmitResponse>;
  acknowledge(
    chainId: number,
    items: readonly { readonly receipt: OccReceipt; readonly signature: string }[],
  ): Promise<SubmitResponse>;
  status(txHash: string): Promise<StatusResponse>;
  health(): Promise<HealthResponse>;
}

const ERROR_CODE = /^[a-z_]{1,32}$/;

export function createSubmitterClient(options: SubmitterClientOptions): SubmitterClient {
  if (!isAddressCheckedFetch(options.fetchFn)) {
    throw new ChainConfigError(
      'unchecked_fetch',
      'fetchFn: must be the platform address-checked fetch (Node: nodeRpcFetch)',
    );
  }
  const fetchFn = options.fetchFn as unknown as FetchFn;
  if (options.urls.length < 1 || options.urls.length > MAX_SUBMITTER_URLS) {
    throw new ChainConfigError(
      'bad_submitter_url',
      `1 to ${String(MAX_SUBMITTER_URLS)} submitter URLs`,
    );
  }
  const bases = options.urls.map((url) => {
    if (!checkRpcUrl(url).ok) {
      throw new ChainConfigError(
        'bad_submitter_url',
        'a submitter URL breaks the rule (https, a public host name)',
      );
    }
    return url.replace(/\/+$/, '');
  });
  const timeout = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) {
    throw new ChainConfigError('bad_client_option', 'timeoutMs: 1 to 30000');
  }

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    parse: (value: unknown) => T,
  ): Promise<T> {
    for (const base of bases) {
      let res: FetchResponse;
      let value: unknown;
      try {
        res = await fetchFn(`${base}${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
          redirect: 'error',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: timeoutSignal(timeout),
        });
        const text = await res.text();
        if (text.length > MAX_ANSWER_BYTES) continue;
        value = JSON.parse(text);
      } catch {
        continue;
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const reason = (value as { error?: unknown } | null)?.error;
        const code = typeof reason === 'string' && ERROR_CODE.test(reason) ? reason : undefined;
        if (code === 'unsupported_chain' || res.status === 404) continue;
        throw new SubmitterError('refused', code);
      }
      if (res.status !== 200) continue;
      try {
        return parse(value);
      } catch {
        continue;
      }
    }
    throw new SubmitterError('unavailable');
  }

  const submit = (
    kind: SubmitKind,
    chainId: number,
    items: readonly (
      { record: OccRecord; signature: string } | { receipt: OccReceipt; signature: string }
    )[],
  ) => {
    let body: Record<string, unknown>;
    try {
      body = submitRequestBody(
        kind,
        chainId,
        items.map((i) => ('record' in i ? { record: i.record } : { receipt: i.receipt })),
        items.map((i) => i.signature),
      );
    } catch {
      return Promise.reject(new SubmitterError('invalid_input'));
    }
    const path = kind === 'notarize' ? '/v1/notarize' : '/v1/receipt';
    return request('POST', path, body, (value) => {
      const parsed = parseSubmitResponse(value);
      if (parsed.chainId !== chainId) throw new SubmitterError('unavailable');
      return parsed;
    });
  };

  return Object.freeze({
    notarize: (chainId, items) => submit('notarize', chainId, items),
    acknowledge: (chainId, items) => submit('receipt', chainId, items),
    status: (txHash: string) => {
      if (!isTxHash(txHash)) return Promise.reject(new SubmitterError('invalid_input'));
      return request('GET', `/v1/status/${txHash}`, undefined, (value) => {
        const parsed = parseStatusResponse(value);
        if (parsed.txHash !== txHash) throw new SubmitterError('unavailable');
        return parsed;
      });
    },
    health: () => request('GET', '/v1/health', undefined, parseHealthResponse),
  } satisfies SubmitterClient);
}
