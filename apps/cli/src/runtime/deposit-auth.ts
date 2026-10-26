// The Node half of the gasless top-up (M3-4b-t-T4-b; 07 §7 `POST /v1/deposit-authorization`,
// 05 §2.5; 04 §4; I-4, I-7). The core builds and signs the agent's deposit authorization only
// after a verified owner action (M3-4b-t-T4-a); this port carries it to the 4thTech submitter and
// maps the answer to a fixed outcome. It is a runtime port, never an MCP tool: nothing in
// packages/mcp-tools or src/mcp/ reaches it (I-4), and the core does not export the function that calls it.
//
// - Where it goes: the submitter URLs of the shipped config only (SUBMITTER_DEFAULT_URLS), never a
//   URL from a message, a tool argument or an answer. The port is built through
//   `chain.createDepositAuthClient`'s own checks (the platform's address-checked fetch, 1 to 5 URLs
//   that pass the 04 §4 rule), and each request has no redirect, credentials or referrer.
// - What it sends: the strict body (`chain.depositAuthorizationRequestBody`, the same parser the
//   submitter runs). Nothing is sent for a chain that is not a shipped gasless testnet, while the
//   client-side kill switch is off (`gaslessToken` refuses while GASLESS_TOPUP_ENABLED is false), or
//   for an authorization that does not pay the shipped vault.
// - How answers map (the submitter's worker.ts statuses):
//     200 submitted                 -> submitted (the txHash is dropped: the core confirms the
//                                      credit by reading creditsOf, never from this answer)
//     429 rate_limited              -> rate_limited, retryAfter from Retry-After (1 s to 24 h, else
//                                      1 h); no other submitter is asked, so the limit is honoured
//     409 / 200 failed already_used -> already_used
//     501 (route off), 503 (stuck or not configured), other 5xx, 404, unsupported_chain,
//     gasless_unavailable (that submitter's route is off), a network error, a timeout or an answer
//     that does not parse -> the next URL; none left -> unavailable
//     another 4xx or 200 failed     -> refused with the fixed code, or `bad_request` for any other
// - Nothing logs. No result or error carries the authorization, the signature, a URL, a header or
//   server text (I-7).
//
// The port and answer types are the core's (`DepositAuthPort` on `ProofsPlatform.depositAuth`,
// M3-4b-t-T4-a).
import * as chain from '@4thtech-io/chain';
import type { DepositAuthAnswer, DepositAuthPort } from '@4thtech-io/core';

export type { DepositAuthAnswer, DepositAuthPort };

/** The submitter's gasless top-up path (apps/submitter/src/worker.ts, M3-4b-t-3). */
export const DEPOSIT_AUTH_PATH = '/v1/deposit-authorization';
/** How long one request may take: the relay simulates and sends before it answers. */
export const DEPOSIT_AUTH_TIMEOUT_MS = 20_000;
/** The wait a 429 implies when its Retry-After cannot be read. */
const DEFAULT_RETRY_AFTER = 3_600;
/** The longest wait a Retry-After may set. */
const MAX_RETRY_AFTER = 86_400;
/** Largest answer read. */
const MAX_ANSWER_CHARS = 16 * 1024;

/** The refusal codes that pass through; anything else is `bad_request`. */
export const DEPOSIT_AUTH_REFUSALS = Object.freeze([
  'unsupported_chain',
  'gasless_unavailable',
  'not_vault',
  'below_min_deposit',
  'above_max_top_up',
  'expired',
  'invalid_window',
  'invalid_signature',
  'simulation_failed',
  'gas_too_high',
  'bad_request',
] as const satisfies readonly Extract<DepositAuthAnswer, { status: 'refused' }>['code'][]);

export type DepositAuthRefusal = (typeof DEPOSIT_AUTH_REFUSALS)[number];

export interface DepositAuthPortOptions {
  /** The address-checked fetch (nodeRpcFetch). */
  readonly fetchFn: chain.RpcFetchFn;
  /** The submitter base URLs, from the shipped config (SUBMITTER_DEFAULT_URLS). */
  readonly urls: readonly string[];
  /** The shipped chains. Default: every shipped chain. */
  readonly configs?: readonly chain.ChainConfig[];
  /** Test seam: the chain kit's gasless gate. Default: `@4thtech-io/chain` (the shipped switch). */
  readonly kit?: Pick<typeof chain, 'gaslessToken'>;
}

const UNAVAILABLE: DepositAuthAnswer = Object.freeze({ status: 'unavailable' });
const SUBMITTED: DepositAuthAnswer = Object.freeze({ status: 'submitted' });
const ALREADY_USED: DepositAuthAnswer = Object.freeze({ status: 'already_used' });
const refused = (code: DepositAuthRefusal): DepositAuthAnswer =>
  Object.freeze({ status: 'refused', code });
const limited = (retryAfter: number): DepositAuthAnswer =>
  Object.freeze({ status: 'rate_limited', retryAfter });

const refusal = (code: unknown): DepositAuthRefusal =>
  typeof code === 'string' && (DEPOSIT_AUTH_REFUSALS as readonly string[]).includes(code)
    ? (code as DepositAuthRefusal)
    : 'bad_request';

/** Retry-After as whole seconds (1 to 24 h); the default for anything else (an HTTP date too). */
function retryAfterOf(response: Response): number {
  const raw = response.headers.get('retry-after');
  if (raw === null || !/^[0-9]{1,10}$/.test(raw.trim())) return DEFAULT_RETRY_AFTER;
  const seconds = Number(raw.trim());
  if (seconds < 1) return DEFAULT_RETRY_AFTER;
  return Math.min(seconds, MAX_RETRY_AFTER);
}

/** The JSON body of an answer, or undefined when it is too long or does not parse. */
async function bodyOf(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (text.length > MAX_ANSWER_CHARS) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const errorOf = (body: unknown): unknown =>
  typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;

export function nodeDepositAuthPort(options: DepositAuthPortOptions): DepositAuthPort {
  // The chain client's checks, once: the address-checked fetch, 1 to 5 URLs, the 04 §4 rule. Its
  // errors carry fixed text (never the URL). The port sends itself, so a 429 keeps its Retry-After.
  chain.createDepositAuthClient({
    urls: options.urls,
    fetchFn: options.fetchFn,
    timeoutMs: DEPOSIT_AUTH_TIMEOUT_MS,
  });
  const bases = options.urls.map((url) => url.replace(/\/+$/, ''));
  const fetchFn = options.fetchFn as unknown as typeof fetch;
  const kit = options.kit ?? chain;
  const configs = options.configs ?? chain.chainRegistry();

  return Object.freeze<DepositAuthPort>({
    async submit(request): Promise<DepositAuthAnswer> {
      if (typeof request !== 'object' || request === null) return refused('bad_request');
      // 1. A shipped gasless testnet (never a mainnet: GASLESS_CHAIN_IDS and the shipped flag).
      const chainId: unknown = request.chainId;
      const config = configs.find((c) => c.chainId === chainId);
      if (
        typeof chainId !== 'number' ||
        config?.testnet !== true ||
        !chain.GASLESS_CHAIN_IDS.includes(chainId) ||
        chain.getChainConfig(chainId)?.testnet !== true
      ) {
        return refused('unsupported_chain');
      }
      // 2. Form: only a well-formed request is ever sent (the submitter's own parser).
      let body: string;
      try {
        body = JSON.stringify(chain.depositAuthorizationRequestBody(request));
      } catch {
        return refused('bad_request');
      }
      // 3. The kill switch, the token and the vault payee.
      let deployment: chain.GaslessToken;
      try {
        deployment = kit.gaslessToken(config, request.token);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        return refused(code === 'not_vault' ? 'not_vault' : 'gasless_unavailable');
      }
      if (deployment.chainId !== chainId || deployment.token !== request.token.toLowerCase()) {
        return refused('gasless_unavailable');
      }
      if (request.auth.to.toLowerCase() !== deployment.vault) return refused('not_vault');

      // 4. Send, with failover on what another submitter might take.
      for (const base of bases) {
        let response: Response;
        try {
          response = await fetchFn(`${base}${DEPOSIT_AUTH_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            redirect: 'error',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal: AbortSignal.timeout(DEPOSIT_AUTH_TIMEOUT_MS),
          });
        } catch {
          continue;
        }
        const status = response.status;
        if (status === 429) {
          const wait = retryAfterOf(response);
          await response.body?.cancel().catch(() => undefined);
          return limited(wait);
        }
        if (status === 409) {
          await response.body?.cancel().catch(() => undefined);
          return ALREADY_USED;
        }
        if (status === 404 || status >= 500 || (status !== 200 && status < 400)) {
          await response.body?.cancel().catch(() => undefined);
          continue;
        }
        const value = await bodyOf(response);
        if (status >= 400) {
          const code = errorOf(value);
          if (code === 'unsupported_chain' || code === 'gasless_unavailable') continue;
          if (code === 'already_used') return ALREADY_USED;
          if (code === 'rate_limited') return limited(retryAfterOf(response));
          if (code === 'unavailable') continue;
          return refused(refusal(code));
        }
        let answer: chain.DepositAuthorizationResponse;
        try {
          answer = chain.parseDepositAuthorizationResponse(value);
        } catch {
          continue;
        }
        if (answer.status === 'submitted') return SUBMITTED;
        if (answer.error === 'already_used') return ALREADY_USED;
        if (answer.error === 'rate_limited') return limited(DEFAULT_RETRY_AFTER);
        if (
          answer.error === 'unavailable' ||
          answer.error === 'unsupported_chain' ||
          answer.error === 'gasless_unavailable'
        ) {
          continue;
        }
        return refused(refusal(answer.error));
      }
      return UNAVAILABLE;
    },
  });
}
