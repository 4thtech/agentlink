// The 4thTech submitter Worker (07 §7; 05 §3.3; 04 §7; M1-10a): it relays Records and Receipts
// that agents signed, so an agent without native gas can notarize. It never sees a key, plaintext
// or a storage link, and it cannot alter what it sends: the Notary checks every signature (I-3).
//
//   POST /v1/notarize                 {chainId, records: [{record, signature}]}
//   POST /v1/receipt                  {chainId, receipts: [{receipt, signature}]}
//   GET  /v1/status/:txHash           a sent transaction and the current status of its items
//   GET  /v1/health                   per chain: available, gas balance (wei), queue depth, and
//                                     the pool states gas: ok|low and faucet: ok|low|paused
//                                     (pool.ts; M1-10b-e)
//   POST /v1/deposit-authorization    {chainId, token, auth}: a gasless top-up (deposit-auth.ts;
//                                     M3-4b-t-3); 501 `not_available` unless
//                                     SUBMITTER_DEPOSIT_AUTH_CHAINS enables it
//   POST /v1/faucet                   {chainId, agent}: testnet credits (faucet.ts; M1-10b);
//                                     503 `paused` while the faucet cannot cover one grant
//
// Logging (07 §7, I-7): this Worker writes nothing to the console and logs no request, IP, signer,
// signature or record. It keeps only the aggregate counters of limits.ts (METRICS). Errors are fixed
// codes; no response echoes request input.
import {
  getChainConfig,
  isTxHash,
  parseDepositAuthorizationRequest,
  parseSubmitRequest,
  type DepositAuthErrorCode,
  type DepositAuthorizationRequest,
  type ChainInputError,
  type FaucetBalances,
  type FaucetChain,
  type FaucetPoolState,
  type Hex,
  type SubmitKind,
  type SubmitterChain,
} from '@4thtech-io/chain';
import { encodeHex, encodeUtf8, hmacSha256, parseJson } from '@4thtech-io/crypto';
import {
  pinnedFaucet,
  poolThresholds,
  readConfig,
  readDepositAuthConfig,
  readFaucetConfig,
  type SubmitterConfig,
} from './config.js';
import {
  MAX_DEPOSIT_AUTH_BODY_BYTES,
  createDepositRelayClass,
  precheckDepositAuthorization,
  type SubmitterDepositRelayApi,
} from './deposit-auth.js';
import { faucetPoolState, gasPoolState } from './pool.js';
import {
  MAX_FAUCET_BODY_BYTES,
  createFaucetClass,
  parseFaucetRequest,
  type FaucetDeps,
  type SubmitterFaucetApi,
} from './faucet.js';
import { ipBucket } from './ip.js';
import { SubmitterLimits, type Metric } from './limits.js';
import { createQueueClass, type QueueDeps, type SubmitterQueueApi } from './queue.js';

export { SubmitterLimits, createDepositRelayClass, createFaucetClass, createQueueClass };
export { METRICS, type Metric } from './limits.js';
export {
  DEFAULTS,
  DEPOSIT_AUTH_DEFAULTS,
  FAUCET_DEFAULTS,
  pinnedFaucet,
  readConfig,
  readDepositAuthConfig,
  readFaucetAddress,
  readFaucetConfig,
  type DepositAuthConfig,
  type FaucetConfig,
  type Limits,
  type SubmitterConfig,
} from './config.js';
export {
  parseFaucetRequest,
  type ClaimAnswer,
  type FaucetDeps,
  type SubmitterFaucetApi,
} from './faucet.js';
export {
  MAX_DEPOSIT_AUTH_BODY_BYTES,
  precheckDepositAuthorization,
  type DepositRelayDeps,
  type RelayAnswer,
  type SubmitterDepositRelayApi,
} from './deposit-auth.js';

export interface SubmitterEnv {
  readonly SUBMITTER_QUEUE: DurableObjectNamespace<SubmitterQueueApi>;
  readonly SUBMITTER_LIMITS: DurableObjectNamespace<SubmitterLimits>;
  /** The faucet (M1-10b); without the binding the faucet is unavailable. */
  readonly SUBMITTER_FAUCET?: DurableObjectNamespace<SubmitterFaucetApi>;
  /** The gasless top-up relay (M3-4b-t-3); without the binding the route is unavailable. */
  readonly SUBMITTER_DEPOSIT_RELAY?: DurableObjectNamespace<SubmitterDepositRelayApi>;
  readonly [name: string]: unknown;
}

export type WorkerDeps = QueueDeps &
  FaucetDeps & {
    /** How long one isolate reuses a balance read for `/v1/health`; default BALANCE_CACHE_MS. */
    readonly balanceCacheMs?: number;
  };

/**
 * Largest request body (IR-M1-10a-1 L-4): 20 items, each with a signature of the full 2 048 bytes
 * (4 098 hex characters) and a Record in JSON form (under 1 KiB), stay below it.
 */
export const MAX_BODY_BYTES = 128 * 1024;

/** A paused faucet's `retry-after`: the owner tops it up within hours, not seconds. */
const PAUSED_RETRY_AFTER_SECONDS = 3_600;

/**
 * How long one isolate reuses a chain's gas balance and faucet balances for `/v1/health` (an RPC
 * read each).
 */
const BALANCE_CACHE_MS = 10_000;
const balances = new Map<number, { readonly at: number; readonly wei: string | null }>();
const faucetBalances = new Map<
  number,
  { readonly at: number; readonly value: FaucetBalances | null }
>();

async function gasBalanceOf(port: SubmitterChain, cacheMs: number): Promise<string | null> {
  const cached = balances.get(port.chainId);
  if (cached && Date.now() - cached.at < cacheMs) return cached.wei;
  const wei = await port.gasBalance().then(
    (value) => value.toString(10),
    () => null,
  );
  balances.set(port.chainId, { at: Date.now(), wei });
  return wei;
}

async function faucetBalancesOf(
  faucet: FaucetChain,
  cacheMs: number,
): Promise<FaucetBalances | null> {
  const cached = faucetBalances.get(faucet.chainId);
  if (cached && Date.now() - cached.at < cacheMs) return cached.value;
  const value = await faucet.balances().then(
    (b) => b,
    () => null,
  );
  faucetBalances.set(faucet.chainId, { at: Date.now(), value });
  return value;
}

const HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'referrer-policy': 'no-referrer',
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

const refuse = (status: number, error: string, extra?: Record<string, string>): Response =>
  json(status, { error }, extra);

interface Ctx {
  readonly env: SubmitterEnv;
  readonly ctx: ExecutionContext;
  readonly deps: WorkerDeps;
  readonly metrics: Partial<Record<Metric, number>>;
}

function count(c: Ctx, metric: Metric, n = 1): void {
  c.metrics[metric] = (c.metrics[metric] ?? 0) + n;
}

const queueOf = (env: SubmitterEnv, chainId: number) =>
  env.SUBMITTER_QUEUE.get(env.SUBMITTER_QUEUE.idFromName(`chain:${String(chainId)}`));

async function readBody(request: Request, max = MAX_BODY_BYTES): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(all);
}

/** The HMAC of the caller's IP bucket, hex, under a purpose label (never the IP itself). */
function ipTag(config: SubmitterConfig, request: Request, label: string): string {
  const bucket = ipBucket(request.headers.get('cf-connecting-ip'));
  return encodeHex(hmacSha256(config.ipKey, encodeUtf8(`${label}${bucket}`)));
}

/**
 * Charges the caller's IP bucket (`prefix` `i`: items; `r`: status and health reads; `f`: faucet
 * requests; `g`: gasless top-up requests); returns a 429 when it is over its hourly limit, else
 * null.
 */
async function takeIp(
  c: Ctx,
  config: SubmitterConfig,
  request: Request,
  prefix: 'i' | 'r' | 'f' | 'g',
  n: number,
  limit: number,
): Promise<Response | null> {
  const now = Math.floor(Date.now() / 1000);
  const ipKey = ipTag(config, request, '');
  const stub = c.env.SUBMITTER_LIMITS.get(c.env.SUBMITTER_LIMITS.idFromName(`${prefix}:${ipKey}`));
  const taken = await stub.take(n, limit, 3600, now);
  if (taken.ok) return null;
  count(c, 'rate_limited');
  return refuse(429, 'rate_limited', { 'retry-after': String(taken.retryAfter) });
}

async function submit(c: Ctx, config: SubmitterConfig, kind: SubmitKind, request: Request) {
  count(c, kind === 'notarize' ? 'request_notarize' : 'request_receipt');
  let text: string | null;
  try {
    text = await readBody(request);
  } catch {
    count(c, 'bad_request');
    return refuse(400, 'bad_request');
  }
  if (text === null) {
    count(c, 'bad_request');
    return refuse(413, 'too_large');
  }
  let parsed;
  try {
    parsed = parseSubmitRequest(kind, parseJson(text), (chainId) =>
      config.chains.includes(chainId) ? getChainConfig(chainId)?.contracts.notary : undefined,
    );
  } catch (error) {
    count(c, 'bad_request');
    const code = (error as ChainInputError | null)?.code;
    return refuse(400, code === 'unsupported_chain' ? 'unsupported_chain' : 'bad_request');
  }
  if (c.deps.portFor(c.env, parsed.chainId) === null) {
    count(c, 'unavailable');
    return refuse(503, 'unavailable');
  }

  // Per-IP limit (07 §7, FA-3): every item counts, including replays of items already on-chain.
  const limited = await takeIp(
    c,
    config,
    request,
    'i',
    parsed.items.length,
    config.limits.ipItemsPerHour,
  );
  if (limited) return limited;

  const answer = await queueOf(c.env, parsed.chainId).submit(parsed.chainId, parsed.items);
  if (!answer.ok) {
    count(c, 'unavailable');
    return refuse(503, 'unavailable');
  }
  for (const item of answer.items) {
    if (item.status === 'submitted') count(c, 'item_submitted');
    else if (item.status === 'held') count(c, 'item_held');
    else if (item.status === 'skipped') count(c, 'item_skipped');
    else if (item.status === 'failed') {
      count(c, item.error === 'rate_limited' ? 'rate_limited' : 'item_failed');
    }
  }
  return json(200, { chainId: parsed.chainId, items: answer.items });
}

async function status(
  c: Ctx,
  config: SubmitterConfig,
  request: Request,
  txHash: string,
): Promise<Response> {
  count(c, 'request_status');
  const limited = await takeIp(c, config, request, 'r', 1, config.limits.ipReadsPerHour);
  if (limited) return limited;
  if (!isTxHash(txHash)) return refuse(400, 'bad_request');
  for (const chainId of config.chains) {
    const found = await queueOf(c.env, chainId).status(txHash as Hex);
    if (found) return json(200, found);
  }
  return refuse(404, 'not_found');
}

async function health(c: Ctx, config: SubmitterConfig | null, request: Request): Promise<Response> {
  count(c, 'request_health');
  if (!config) return json(200, { ok: false, chains: [] });
  const limited = await takeIp(c, config, request, 'r', 1, config.limits.ipReadsPerHour);
  if (limited) return limited;
  const cacheMs = c.deps.balanceCacheMs ?? BALANCE_CACHE_MS;
  const faucetConfig = readFaucetConfig(c.env);
  const chains = await Promise.all(
    config.chains.map(async (chainId) => {
      const port: SubmitterChain | null = c.deps.portFor(c.env, chainId);
      const gasBalance = port ? await gasBalanceOf(port, cacheMs) : null;
      const queueDepth = await queueOf(c.env, chainId).depth();
      const thresholds = poolThresholds(chainId);
      // M1-10b-e: states only, never the faucet's balances or address. A chain the faucet does not
      // serve has `faucet: null`; one it serves whose wallet is missing or unreadable is paused.
      let faucet: FaucetPoolState | null = null;
      if (faucetConfig?.chains.includes(chainId) === true) {
        const wallet = pinnedFaucet(c.env, chainId, c.deps.faucetFor(c.env, chainId));
        const walletBalances = wallet ? await faucetBalancesOf(wallet, cacheMs) : null;
        faucet = faucetPoolState(walletBalances, faucetConfig.usdCents, thresholds);
      }
      return {
        chainId,
        available: port !== null && gasBalance !== null,
        gasBalance,
        queueDepth,
        gas: gasPoolState(gasBalance, thresholds),
        faucet,
      };
    }),
  );
  return json(200, { ok: chains.every((x) => x.available), chains });
}

/** POST /v1/faucet (faucet.ts; 05 §9; SUB-7). */
async function faucetClaim(
  c: Ctx,
  config: SubmitterConfig | null,
  request: Request,
): Promise<Response> {
  count(c, 'request_faucet');
  const faucetConfig = readFaucetConfig(c.env);
  const namespace = c.env.SUBMITTER_FAUCET;
  if (!config || !faucetConfig || !namespace) {
    count(c, 'unavailable');
    return refuse(503, 'unavailable');
  }
  // Every faucet request counts against its IP's hourly limit, whatever its outcome.
  const limited = await takeIp(c, config, request, 'f', 1, faucetConfig.ipRequestsPerHour);
  if (limited) return limited;
  let text: string | null;
  try {
    text = await readBody(request, MAX_FAUCET_BODY_BYTES);
  } catch {
    count(c, 'bad_request');
    return refuse(400, 'bad_request');
  }
  if (text === null) {
    count(c, 'bad_request');
    return refuse(413, 'too_large');
  }
  const parsed = parseFaucetRequest(text);
  if (!parsed.ok) {
    count(c, 'bad_request');
    return refuse(400, parsed.error);
  }
  if (
    !faucetConfig.chains.includes(parsed.chainId) ||
    pinnedFaucet(c.env, parsed.chainId, c.deps.faucetFor(c.env, parsed.chainId)) === null
  ) {
    count(c, 'unavailable');
    return refuse(503, 'unavailable');
  }
  const stub = namespace.get(namespace.idFromName(`faucet:${String(parsed.chainId)}`));
  const answer = await stub.claim(parsed.chainId, parsed.agent, ipTag(config, request, 'faucet:'));
  if (answer.ok) {
    count(c, 'faucet_credited');
    return json(200, { chainId: parsed.chainId, txHash: answer.txHash });
  }
  if (answer.error === 'unavailable') {
    count(c, 'unavailable');
    return refuse(503, 'unavailable');
  }
  if (answer.error === 'paused') {
    // M1-10b-e: a stable code clients map to plain words; the owner tops the wallet up.
    count(c, 'faucet_paused');
    return refuse(503, 'paused', { 'retry-after': String(PAUSED_RETRY_AFTER_SECONDS) });
  }
  count(c, 'rate_limited');
  return refuse(429, answer.error, { 'retry-after': String(answer.retryAfter) });
}

/** A deposit-authorization refusal: `{status: "failed", error}` with a fixed code. */
const failed = (
  status: number,
  error: DepositAuthErrorCode,
  extra?: Record<string, string>,
): Response => json(status, { status: 'failed', error }, extra);

/** The HTTP status of a relay refusal: the request's fault is 4xx; the submitter's is 503. */
function refusalStatus(error: DepositAuthErrorCode): number {
  if (error === 'unavailable') return 503;
  if (error === 'rate_limited') return 429;
  if (error === 'already_used') return 409;
  return 400;
}

/** POST /v1/deposit-authorization (deposit-auth.ts; 07 §7; 05 §2.5; M3-4b-t-3). */
async function depositAuthorization(
  c: Ctx,
  config: SubmitterConfig | null,
  request: Request,
): Promise<Response> {
  const depositConfig = readDepositAuthConfig(c.env);
  // Off (the default): the route stays as it was before M3-4b, uncounted.
  if (!depositConfig) return refuse(501, 'not_available');
  count(c, 'request_deposit_auth');
  const namespace = c.env.SUBMITTER_DEPOSIT_RELAY;
  if (!config || !namespace) {
    count(c, 'unavailable');
    return failed(503, 'unavailable');
  }
  // Every request counts against its IP's hourly limit, whatever its outcome.
  const limited = await takeIp(c, config, request, 'g', 1, depositConfig.ipRequestsPerHour);
  if (limited) {
    return failed(429, 'rate_limited', {
      'retry-after': limited.headers.get('retry-after') ?? '1',
    });
  }
  let text: string | null;
  try {
    text = await readBody(request, MAX_DEPOSIT_AUTH_BODY_BYTES);
  } catch {
    count(c, 'bad_request');
    return refuse(400, 'bad_request');
  }
  if (text === null) {
    count(c, 'bad_request');
    return refuse(413, 'too_large');
  }
  let parsed: DepositAuthorizationRequest;
  try {
    parsed = parseDepositAuthorizationRequest(parseJson(text));
  } catch {
    count(c, 'bad_request');
    return refuse(400, 'bad_request');
  }
  const chain = getChainConfig(parsed.chainId);
  if (!depositConfig.chains.includes(parsed.chainId) || !chain) {
    count(c, 'deposit_auth_refused');
    return failed(400, 'unsupported_chain');
  }
  const early = precheckDepositAuthorization(
    parsed,
    chain.contracts.vault.toLowerCase() as Hex,
    Math.floor(Date.now() / 1000),
  );
  if (early !== null) {
    count(c, 'deposit_auth_refused');
    return failed(refusalStatus(early), early);
  }
  const stub = namespace.get(namespace.idFromName(`deposit:${String(parsed.chainId)}`));
  const answer = await stub.relay(parsed.chainId, parsed);
  if (answer.ok) {
    count(c, 'deposit_auth_submitted');
    return json(200, { status: 'submitted', txHash: answer.txHash });
  }
  if (answer.txHash !== undefined) {
    // A repeat of a sent authorization whose transaction reverted.
    count(c, 'deposit_auth_refused');
    return json(200, { status: 'failed', error: answer.error, txHash: answer.txHash });
  }
  if (answer.error === 'unavailable') count(c, 'unavailable');
  else if (answer.error === 'rate_limited') count(c, 'rate_limited');
  else count(c, 'deposit_auth_refused');
  return failed(
    refusalStatus(answer.error),
    answer.error,
    answer.error === 'rate_limited'
      ? { 'retry-after': String(Math.max(1, answer.retryAfter ?? 1)) }
      : undefined,
  );
}

async function route(c: Ctx, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const config = readConfig(c.env);

  if (path === '/v1/health') {
    return method === 'GET' ? health(c, config, request) : refuse(405, 'method_not_allowed');
  }
  if (path === '/v1/deposit-authorization') {
    // 07 §7: gasless top-ups, off unless SUBMITTER_DEPOSIT_AUTH_CHAINS enables them (M3-4b-t-3).
    return method === 'POST'
      ? depositAuthorization(c, config, request)
      : refuse(405, 'method_not_allowed');
  }
  if (path === '/v1/faucet') {
    return method === 'POST' ? faucetClaim(c, config, request) : refuse(405, 'method_not_allowed');
  }
  const statusMatch = /^\/v1\/status\/([^/]+)$/.exec(path);
  const known = path === '/v1/notarize' || path === '/v1/receipt' || statusMatch !== null;
  if (!known) return refuse(404, 'not_found');
  if (!config) {
    count(c, 'unavailable');
    return refuse(503, 'unavailable');
  }
  if (statusMatch) {
    return method === 'GET'
      ? status(c, config, request, statusMatch[1] ?? '')
      : refuse(405, 'method_not_allowed');
  }
  if (method !== 'POST') return refuse(405, 'method_not_allowed');
  return submit(c, config, path === '/v1/notarize' ? 'notarize' : 'receipt', request);
}

/** The Worker's fetch handler, over the given chain ports. */
export function createSubmitterWorker(deps: WorkerDeps) {
  return {
    async fetch(request: Request, env: SubmitterEnv, ctx: ExecutionContext): Promise<Response> {
      const c: Ctx = { env, ctx, deps, metrics: {} };
      let response: Response;
      try {
        response = await route(c, request);
      } catch {
        count(c, 'internal_error');
        response = refuse(500, 'internal_error');
      }
      if (Object.keys(c.metrics).length > 0) {
        const metrics = env.SUBMITTER_LIMITS.get(env.SUBMITTER_LIMITS.idFromName('metrics'));
        ctx.waitUntil(metrics.bump(c.metrics).catch(() => undefined));
      }
      return response;
    },
  };
}
