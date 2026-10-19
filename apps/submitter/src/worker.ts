// The 4thTech submitter Worker (07 §7; 05 §3.3; 04 §7; M1-10a): it relays Records and Receipts
// that agents signed, so an agent without native gas can notarize. It never sees a key, plaintext
// or a storage link, and it cannot alter what it sends: the Notary checks every signature (I-3).
//
//   POST /v1/notarize                 {chainId, records: [{record, signature}]}
//   POST /v1/receipt                  {chainId, receipts: [{receipt, signature}]}
//   GET  /v1/status/:txHash           a sent transaction and the current status of its items
//   GET  /v1/health                   per chain: available, gas balance (wei), queue depth
//   POST /v1/deposit-authorization    present, disabled until M3-4b (501)
//
// Logging (07 §7, I-7): this Worker writes nothing to the console and logs no request, IP, signer,
// signature or record. It keeps only the aggregate counters of limits.ts (METRICS). Errors are fixed
// codes; no response echoes request input.
import {
  getChainConfig,
  isTxHash,
  parseSubmitRequest,
  type ChainInputError,
  type Hex,
  type SubmitKind,
  type SubmitterChain,
} from '@4thtech-io/chain';
import { encodeHex, encodeUtf8, hmacSha256, parseJson } from '@4thtech-io/crypto';
import { readConfig, type SubmitterConfig } from './config.js';
import { ipBucket } from './ip.js';
import { SubmitterLimits, type Metric } from './limits.js';
import { createQueueClass, type QueueDeps, type SubmitterQueueApi } from './queue.js';

export { SubmitterLimits, createQueueClass };
export { METRICS, type Metric } from './limits.js';
export { DEFAULTS, readConfig, type Limits, type SubmitterConfig } from './config.js';

export interface SubmitterEnv {
  readonly SUBMITTER_QUEUE: DurableObjectNamespace<SubmitterQueueApi>;
  readonly SUBMITTER_LIMITS: DurableObjectNamespace<SubmitterLimits>;
  readonly [name: string]: unknown;
}

export type WorkerDeps = QueueDeps;

/** Largest request body; 20 items with long ERC-1271 signatures stay below it. */
export const MAX_BODY_BYTES = 64 * 1024;

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

async function readBody(request: Request): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
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
  const now = Math.floor(Date.now() / 1000);
  const bucket = ipBucket(request.headers.get('cf-connecting-ip'));
  const ipKey = encodeHex(hmacSha256(config.ipKey, encodeUtf8(bucket)));
  const ipLimit = c.env.SUBMITTER_LIMITS.get(c.env.SUBMITTER_LIMITS.idFromName(`i:${ipKey}`));
  const taken = await ipLimit.take(parsed.items.length, config.limits.ipItemsPerHour, 3600, now);
  if (!taken.ok) {
    count(c, 'rate_limited');
    return refuse(429, 'rate_limited', { 'retry-after': String(taken.retryAfter) });
  }

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

async function status(c: Ctx, config: SubmitterConfig, txHash: string): Promise<Response> {
  count(c, 'request_status');
  if (!isTxHash(txHash)) return refuse(400, 'bad_request');
  for (const chainId of config.chains) {
    const found = await queueOf(c.env, chainId).status(txHash as Hex);
    if (found) return json(200, found);
  }
  return refuse(404, 'not_found');
}

async function health(c: Ctx, config: SubmitterConfig | null): Promise<Response> {
  count(c, 'request_health');
  if (!config) return json(200, { ok: false, chains: [] });
  const chains = await Promise.all(
    config.chains.map(async (chainId) => {
      const port: SubmitterChain | null = c.deps.portFor(c.env, chainId);
      const gasBalance = port
        ? await port.gasBalance().then(
            (wei) => wei.toString(10),
            () => null,
          )
        : null;
      const queueDepth = await queueOf(c.env, chainId).depth();
      return { chainId, available: port !== null && gasBalance !== null, gasBalance, queueDepth };
    }),
  );
  return json(200, { ok: chains.every((x) => x.available), chains });
}

async function route(c: Ctx, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const config = readConfig(c.env);

  if (path === '/v1/health') {
    return method === 'GET' ? health(c, config) : refuse(405, 'method_not_allowed');
  }
  if (path === '/v1/deposit-authorization') {
    // 07 §7: present but disabled until M3-4b (gasless top-ups need M1-3c first).
    return method === 'POST' ? refuse(501, 'not_available') : refuse(405, 'method_not_allowed');
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
      ? status(c, config, statusMatch[1] ?? '')
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
