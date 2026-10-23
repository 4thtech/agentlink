// `POST /v1/deposit-authorization` (07 §7; 05 §2.5; M3-4b-t-2): the wire format both sides parse
// and the client with failover. The request is `{chainId, token, auth}`, `auth` being the EIP-3009
// `ReceiveWithAuthorization` fields in the 04 §2.4.1 JSON form plus the split signature `v`, `r`,
// `s` (the vault's `depositWithAuthorization` takes them so). The answer is
// `{status: "submitted", txHash}` or `{status: "failed", error, txHash?}` with a fixed error code.
//
// - Everything is parsed strictly: unknown fields, other spellings and out-of-range values are
//   refused, never normalised. `v` is 27 or 28 and the signature is canonical (low `s`; 04 §2.4.1).
// - The authorization is public once redeemed and moves funds only to the vault, as credits of
//   `from` (05 §2.5): a submitter can censor it, never redirect it. Still, nothing here logs it, and
//   errors carry fixed codes and text: never a signature, an address or a URL (I-7).
// - Failover (as the submitter client, client.ts): the next URL on a network error, a timeout, a
//   5xx (501 `not_available` included: that submitter has not enabled the route yet), a 429, a 404,
//   an unserved chain or an answer that does not parse. Sending the same authorization to a second
//   submitter is safe: its nonce is single use on the token, so at most one redemption lands.
//   Another 4xx stops, because every submitter would refuse it too.
// - The answer is untrusted: the caller confirms the credit by reading `creditsOf` on chain (T4).
import {
  decodeEcdsaSignature,
  parseReceiveWithAuthorization,
  type ReceiveWithAuthorization,
} from '@4thtech-io/crypto';
import { ChainConfigError } from '../config/index.js';
import { isAddressCheckedFetch } from '../clients/checked-fetch.js';
import { DEFAULT_RPC_TIMEOUT_MS } from '../clients/read-client.js';
import { checkRpcUrl } from '../clients/rpc-url.js';
import { ChainInputError, checkChainId, type Hex } from '../ids/index.js';
import { MAX_SUBMITTER_URLS, SubmitterError, type SubmitterClientOptions } from './client.js';
import { timeoutSignal, type FetchFn, type FetchResponse } from './rpc.js';

/** The `auth` of a deposit authorization: the EIP-3009 fields and the split signature. */
export interface DepositAuthorizationAuth extends ReceiveWithAuthorization {
  readonly from: Hex;
  readonly to: Hex;
  readonly nonce: Hex;
  readonly v: 27 | 28;
  readonly r: Hex;
  readonly s: Hex;
}

/** A `POST /v1/deposit-authorization` body. `token` is the token contract, lowercase. */
export interface DepositAuthorizationRequest {
  readonly chainId: number;
  readonly token: Hex;
  readonly auth: DepositAuthorizationAuth;
}

/**
 * The fixed codes of a deposit-authorization refusal or failure (the relay checks, deposit-relay.ts,
 * plus the Worker's own `rate_limited` and `unavailable`).
 */
export const DEPOSIT_AUTH_ERROR_CODES = Object.freeze([
  'unsupported_chain',
  'gasless_unavailable',
  'not_vault',
  'below_min_deposit',
  'above_max_top_up',
  'expired',
  'invalid_window',
  'invalid_signature',
  'already_used',
  'simulation_failed',
  'gas_too_high',
  'rate_limited',
  'unavailable',
] as const);

export type DepositAuthErrorCode = (typeof DEPOSIT_AUTH_ERROR_CODES)[number];

/** A submitter's answer. Untrusted: the credit is confirmed on chain. */
export type DepositAuthorizationResponse =
  /** The `depositWithAuthorization` transaction was sent (`txHash`, computed by the submitter). */
  | { readonly status: 'submitted'; readonly txHash: Hex; readonly error?: undefined }
  /** Nothing was credited; `txHash` when a sent transaction reverted. */
  | { readonly status: 'failed'; readonly error: DepositAuthErrorCode; readonly txHash?: Hex };

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const AUTH_FIELDS = ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce', 'v', 'r', 's'];
/** Largest answer read. */
const MAX_ANSWER_BYTES = 16 * 1024;
const ERROR_CODE = /^[a-z_]{1,32}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  code: string,
  what: string,
): Record<string, unknown> {
  if (!isObject(value)) throw new ChainInputError(code, `${what}: must be an object`);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) {
      throw new ChainInputError(code, `${what}: unknown field`);
    }
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d === undefined || !('value' in d))
      throw new ChainInputError(code, `${what}: not plain data`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new ChainInputError(code, `${what}: missing field`);
  }
  return value;
}

const badBody = (what: string): never => {
  throw new ChainInputError('invalid_deposit_auth_body', what);
};

/**
 * Parses a `POST /v1/deposit-authorization` body strictly (see the module comment). Checks the
 * form only: the chain, the token, the payee, the amount, the window and whose signature it is are
 * the relay's checks (deposit-relay.ts). Refusals are ChainInputError `invalid_deposit_auth_body`,
 * fixed text.
 */
export function parseDepositAuthorizationRequest(body: unknown): DepositAuthorizationRequest {
  const code = 'invalid_deposit_auth_body';
  const o = exact(body, ['chainId', 'token', 'auth'], [], code, 'request');
  let chainId: number;
  try {
    chainId = checkChainId(o.chainId);
  } catch {
    return badBody('chainId: must be a positive integer');
  }
  if (typeof o.token !== 'string' || !ADDRESS.test(o.token)) {
    badBody('token: must be 0x + 40 lowercase hex');
  }
  const a = exact(o.auth, AUTH_FIELDS, [], code, 'auth');
  let fields: ReceiveWithAuthorization;
  try {
    fields = parseReceiveWithAuthorization({
      from: a.from,
      to: a.to,
      value: a.value,
      validAfter: a.validAfter,
      validBefore: a.validBefore,
      nonce: a.nonce,
    });
  } catch {
    // The crypto parser's message may describe the input; ours never does.
    return badBody('auth: not in the 04 §2.4.1 JSON form');
  }
  if (a.v !== 27 && a.v !== 28) badBody('auth.v: must be 27 or 28');
  if (typeof a.r !== 'string' || !BYTES32.test(a.r))
    badBody('auth.r: must be 0x + 64 lowercase hex');
  if (typeof a.s !== 'string' || !BYTES32.test(a.s))
    badBody('auth.s: must be 0x + 64 lowercase hex');
  const v = a.v as 27 | 28;
  const r = a.r as Hex;
  const s = a.s as Hex;
  try {
    decodeEcdsaSignature(`0x${r.slice(2)}${s.slice(2)}${v.toString(16)}`);
  } catch {
    badBody('auth: the signature is not in canonical form');
  }
  const auth: DepositAuthorizationAuth = Object.freeze({
    from: fields.from as Hex,
    to: fields.to as Hex,
    value: fields.value,
    validAfter: fields.validAfter,
    validBefore: fields.validBefore,
    nonce: fields.nonce as Hex,
    v,
    r,
    s,
  });
  return Object.freeze({ chainId, token: o.token as Hex, auth });
}

/** The JSON body for a request (parsed first, so only a well-formed request is ever sent). */
export function depositAuthorizationRequestBody(
  request: DepositAuthorizationRequest,
): Record<string, unknown> {
  const r = parseDepositAuthorizationRequest({
    chainId: request.chainId,
    token: request.token,
    auth:
      request.auth === null || typeof request.auth !== 'object'
        ? request.auth
        : { ...request.auth },
  });
  return { chainId: r.chainId, token: r.token, auth: { ...r.auth } };
}

const badAnswer = (what: string): never => {
  throw new ChainInputError('invalid_submitter_answer', what);
};

/** Parses a submitter's answer strictly. Untrusted: the caller confirms the credit on chain. */
export function parseDepositAuthorizationResponse(value: unknown): DepositAuthorizationResponse {
  const o = exact(value, ['status'], ['txHash', 'error'], 'invalid_submitter_answer', 'answer');
  if (o.txHash !== undefined && (typeof o.txHash !== 'string' || !BYTES32.test(o.txHash))) {
    badAnswer('txHash');
  }
  if (o.status === 'submitted') {
    if (o.txHash === undefined || Object.hasOwn(o, 'error')) badAnswer('submitted');
    return Object.freeze({ status: 'submitted', txHash: o.txHash as Hex });
  }
  if (o.status === 'failed') {
    if (!(DEPOSIT_AUTH_ERROR_CODES as readonly unknown[]).includes(o.error)) badAnswer('error');
    return Object.freeze({
      status: 'failed',
      error: o.error as DepositAuthErrorCode,
      ...(o.txHash === undefined ? {} : { txHash: o.txHash as Hex }),
    });
  }
  return badAnswer('status');
}

/** Sends a signed deposit authorization to the configured submitters, with failover. */
export interface DepositAuthClient {
  submit(request: DepositAuthorizationRequest): Promise<DepositAuthorizationResponse>;
}

/**
 * The deposit-authorization client over the same options as createSubmitterClient: 1 to 5
 * submitter URLs that pass the 04 §4 rule, and the platform's address-checked fetch.
 */
export function createDepositAuthClient(options: SubmitterClientOptions): DepositAuthClient {
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

  return Object.freeze({
    async submit(request: DepositAuthorizationRequest): Promise<DepositAuthorizationResponse> {
      let body: string;
      try {
        body = JSON.stringify(depositAuthorizationRequestBody(request));
      } catch {
        throw new SubmitterError('invalid_input');
      }
      for (const base of bases) {
        let res: FetchResponse;
        let value: unknown;
        try {
          res = await fetchFn(`${base}/v1/deposit-authorization`, {
            method: 'POST',
            body,
            headers: { 'content-type': 'application/json' },
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
          return parseDepositAuthorizationResponse(value);
        } catch {
          continue;
        }
      }
      throw new SubmitterError('unavailable');
    },
  } satisfies DepositAuthClient);
}
