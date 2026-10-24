// The Node half of free test credits (M1-36i; 05 §9, M1-10b `POST /v1/faucet`; 07 §2
// `proofs.requestFaucet`; 04 §4; I-5, I-7):
//
// - nodeFreeCreditsPort: the core's FreeCreditsPort. It posts exactly `{chainId, agent}` (both
//   public: the agent ID is the credits account on-chain) to the 4thTech submitter's free-credits
//   path, on the fixed submitter URLs only (never a URL from a message, a tool argument or the
//   service's answer), through the address-checked fetch (nodeRpcFetch: https only, public
//   addresses only, no redirects). No key, signature or other value leaves. A chain off the chain
//   package's hard-coded testnet allowlist, or not a testnet in the shipped config, sends nothing.
//   The answer maps by HTTP status and the service's fixed codes only: no server text, transaction
//   hash or header text is kept (a 429's Retry-After is kept as a bounded number of seconds; its
//   body is read up to 512 bytes; a refusing 4xx waits a day, never claimed).
// - fileFreeCreditsMarker: the claim, remembered in the agent's folder (`free-credits.json`, 0600,
//   written to a new file and renamed into place). It holds the agent ID and per chain `claimed` or
//   a retry time: public values only. A file that cannot be parsed counts as claimed for every chain
//   (fail safe: never a second claim).
//
// Nothing here logs, and nothing returned carries a URL, a path or server text.
import { open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import * as chain from '@4thtech-io/chain';
import type { FreeCreditsAnswer, FreeCreditsPort } from '@4thtech-io/core';
import { encodeHex, parseJson, randomBytes } from '@4thtech-io/crypto';
import type { FreeCreditsChainState, FreeCreditsMarker } from '../tools/free-credits.js';

/** The submitter's free test credits path (apps/submitter/src/worker.ts, M1-10b). */
export const FREE_CREDITS_PATH = '/v1/faucet';
/** The marker file in the agent's folder. */
export const FREE_CREDITS_FILE = 'free-credits.json';
/** How long one request may take. */
export const FREE_CREDITS_TIMEOUT_MS = 15_000;
/** The wait the service's 429 implies when it gives none we can read. */
const DEFAULT_RETRY_AFTER = 3_600;
/** A Retry-After is honoured, but never shorter than 5 minutes nor longer than a day. */
const MIN_RETRY_AFTER = 300;
const MAX_RETRY_AFTER = 86_400;
/** A 429 body longer than this many bytes is not read further or parsed. */
const MAX_ANSWER_CHARS = 512;

const AGENT = /^0x[0-9a-fA-F]{40}$/;
const UNAVAILABLE: FreeCreditsAnswer = Object.freeze({ status: 'unavailable' });
const LIMIT_CODES: ReadonlySet<string> = new Set([
  'already_claimed',
  'rate_limited',
  'daily_cap_reached',
]);

/**
 * True only for a chain on the chain package's hard-coded testnet allowlist whose shipped config
 * (in `configs`, default every shipped chain) says testnet. A mainnet is never one.
 */
export function isFreeCreditsChain(
  chainId: unknown,
  configs: readonly chain.ChainConfig[] = chain.chainRegistry(),
): boolean {
  return (
    typeof chainId === 'number' &&
    Number.isSafeInteger(chainId) &&
    chain.isFaucetChain(chainId) &&
    configs.some((c) => c.chainId === chainId && c.testnet === true)
  );
}

export interface FreeCreditsPortOptions {
  /** The address-checked fetch (nodeRpcFetch). */
  readonly fetchFn: chain.RpcFetchFn;
  /** The submitter base URLs, from the shipped config (SUBMITTER_DEFAULT_URLS). */
  readonly urls: readonly string[];
  /** The shipped chains (the `testnet` flag). Default: every shipped chain. */
  readonly configs?: readonly chain.ChainConfig[];
}

/** Reads at most MAX_ANSWER_CHARS bytes of the body, then cancels the rest. Undefined if cut off. */
async function readCapped(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_ANSWER_CHARS) return undefined; // too long: not parsed
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(all);
}

/** The 429 code, read from a short JSON body (bounded read); `rate_limited` for anything else. */
async function limitCode(response: Response): Promise<FreeCreditsAnswer['status']> {
  try {
    const text = await readCapped(response);
    if (text === undefined) return 'rate_limited';
    const body = parseJson(text) as unknown;
    const error =
      typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
    return typeof error === 'string' && LIMIT_CODES.has(error)
      ? (error as FreeCreditsAnswer['status'])
      : 'rate_limited';
  } catch {
    return 'rate_limited';
  }
}

/**
 * The wait a 429 implies, in seconds: its Retry-After (whole seconds or an HTTP date), never under
 * MIN_RETRY_AFTER and never over MAX_RETRY_AFTER; DEFAULT_RETRY_AFTER when absent or unreadable.
 * Only the number is kept.
 */
function retryAfterOf(response: Response): number {
  const raw = response.headers.get('retry-after')?.trim() ?? '';
  let seconds: number | undefined;
  if (/^[0-9]{1,9}$/.test(raw)) {
    seconds = Number(raw);
  } else if (raw !== '' && /[A-Za-z]/.test(raw)) {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) seconds = Math.ceil((at - Date.now()) / 1000);
  }
  if (seconds === undefined) return DEFAULT_RETRY_AFTER;
  return Math.min(Math.max(seconds, MIN_RETRY_AFTER), MAX_RETRY_AFTER);
}

/** A 4xx that asking again cannot fix (a bad request, no such route, refused): never retried. */
function isPermanentClientError(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
}

export function nodeFreeCreditsPort(options: FreeCreditsPortOptions): FreeCreditsPort {
  const urls = [...options.urls];
  return Object.freeze<FreeCreditsPort>({
    async request({ chainId, agent }): Promise<FreeCreditsAnswer> {
      if (!isFreeCreditsChain(chainId, options.configs)) return UNAVAILABLE;
      if (typeof agent !== 'string' || !AGENT.test(agent)) return UNAVAILABLE;
      const body = JSON.stringify({ chainId, agent: agent.toLowerCase() });
      for (const base of urls) {
        let response: Response;
        try {
          response = await options.fetchFn(`${base.replace(/\/+$/, '')}${FREE_CREDITS_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: AbortSignal.timeout(FREE_CREDITS_TIMEOUT_MS),
          });
        } catch {
          continue; // this URL did not answer: the next one, else unavailable
        }
        if (response.status === 200) {
          await response.body?.cancel().catch(() => undefined);
          return Object.freeze({ status: 'sent' });
        }
        if (response.status === 429) {
          const retryAfter = retryAfterOf(response);
          const status = await limitCode(response);
          return status === 'already_claimed' ||
            status === 'rate_limited' ||
            status === 'daily_cap_reached'
            ? Object.freeze({ status, retryAfter })
            : UNAVAILABLE;
        }
        await response.body?.cancel().catch(() => undefined);
        // A refusal (4xx other than 408/425/429) is not retried for a day: a paused answer with the
        // longest wait, never `claimed`, so a WAF or deploy 404 does not disable claims for good.
        // Fixed value, no server text.
        if (isPermanentClientError(response.status)) {
          return Object.freeze({ status: 'rate_limited', retryAfter: MAX_RETRY_AFTER });
        }
        return UNAVAILABLE;
      }
      return UNAVAILABLE;
    },
  });
}

// ---- The marker file -----------------------------------------------------------------------------

interface MarkerFile {
  readonly v: 1;
  readonly agentId: string;
  readonly chains: Record<string, FreeCreditsChainState>;
}

const CLAIMED: FreeCreditsChainState = Object.freeze({ state: 'claimed' });
const CHAIN_KEY = /^[1-9][0-9]{0,15}$/;

/** A stored chain state, or `claimed` for anything malformed (fail safe). */
function chainState(value: unknown): FreeCreditsChainState {
  if (typeof value !== 'object' || value === null) return CLAIMED;
  const v = value as Record<string, unknown>;
  if (v.state === 'claimed') return CLAIMED;
  if (
    v.state === 'retry' &&
    typeof v.attempts === 'number' &&
    Number.isSafeInteger(v.attempts) &&
    v.attempts >= 1 &&
    typeof v.next === 'number' &&
    Number.isSafeInteger(v.next) &&
    v.next >= 0
  ) {
    return Object.freeze({ state: 'retry', attempts: v.attempts, next: v.next });
  }
  return CLAIMED;
}

type Loaded =
  | { readonly kind: 'missing' }
  | { readonly kind: 'broken' }
  | { readonly kind: 'ok'; readonly file: MarkerFile };

export function fileFreeCreditsMarker(dir: string, agentId: string): FreeCreditsMarker {
  const file = path.join(dir, FREE_CREDITS_FILE);
  const owner = agentId.toLowerCase();
  let writing: Promise<unknown> = Promise.resolve();

  async function load(): Promise<Loaded> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
      throw error; // unreadable: the claimer sends nothing
    }
    try {
      const value = parseJson(text) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { kind: 'broken' };
      }
      const v = value as Record<string, unknown>;
      if (v.v !== 1 || typeof v.agentId !== 'string') return { kind: 'broken' };
      if (v.agentId.toLowerCase() !== owner) return { kind: 'missing' }; // another agent's file
      const chains: Record<string, FreeCreditsChainState> = {};
      if (typeof v.chains !== 'object' || v.chains === null || Array.isArray(v.chains)) {
        return { kind: 'broken' };
      }
      for (const [key, state] of Object.entries(v.chains as Record<string, unknown>)) {
        if (CHAIN_KEY.test(key)) chains[key] = chainState(state);
      }
      return { kind: 'ok', file: { v: 1, agentId: owner, chains } };
    } catch {
      return { kind: 'broken' };
    }
  }

  async function save(contents: MarkerFile): Promise<void> {
    const tmp = `${file}.${encodeHex(randomBytes(6))}.tmp`;
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(contents)}\n`, 'utf8');
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close().catch(() => undefined);
    }
    try {
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  return Object.freeze<FreeCreditsMarker>({
    async read(chainId) {
      const loaded = await load();
      if (loaded.kind === 'broken') return CLAIMED;
      if (loaded.kind === 'missing') return undefined;
      return loaded.file.chains[String(chainId)];
    },
    write(chainId, state) {
      const run = writing.then(async () => {
        const loaded = await load();
        if (loaded.kind === 'broken') return; // keep the fail-safe file as it is
        const chains = loaded.kind === 'ok' ? { ...loaded.file.chains } : {};
        chains[String(chainId)] =
          state.state === 'claimed'
            ? CLAIMED
            : { state: 'retry', attempts: state.attempts, next: state.next };
        await save({ v: 1, agentId: owner, chains });
      });
      writing = run.catch(() => undefined);
      return run;
    },
  });
}
