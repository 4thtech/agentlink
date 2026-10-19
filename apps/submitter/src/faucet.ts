// The testnet credits faucet (05 §9; 03 §4.4; 12 §4.1; audit-rules SUB-7; 04 §7; M1-10b): it tops
// up a testnet agent's credits with `depositFor`, so testers never need gas or a token.
//
//   POST /v1/faucet   {chainId, agent}   ->   200 {chainId, txHash}
//
// - Testnets only: a chain ID off the hard-coded allowlist of @4thtech-io/chain (`isFaucetChain`)
//   is `unsupported_chain` before anything else; the settings refuse such a chain too (config.ts).
// - Limits (new identities are free, so per-agent limits alone are not enough): one claim per agent
//   per window, claims per IP (IPv6 /64) per UTC day, and a global cap per chain per UTC day. A
//   per-IP hourly request limit in front (SubmitterLimits) bounds the work any one IP causes.
// - One Durable Object per chain (`faucet:<chainId>`) checks the limits, sends and charges them, one
//   claim at a time, so the caps hold under concurrent claims and the faucet wallet's nonces never
//   race. A claim is charged when its `depositFor` was broadcast (sent, or its answer was lost); a
//   claim that sent nothing is not charged.
// - Privacy (07 §7, I-7): nothing is logged. Storage keeps `a:<agent>` (the claim time; the agent
//   is public on-chain once credited), `i:<HMAC of the IP bucket>` (a day and a count) and `g` (a
//   day and a count), never an IP and never an agent next to an IP tag. Entries are deleted once
//   their window is over (alarm).
import { DurableObject } from 'cloudflare:workers';
import { isEvmAddress, isFaucetChain, type FaucetChain, type Hex } from '@4thtech-io/chain';
import { parseJson } from '@4thtech-io/crypto';
import { readFaucetConfig } from './config.js';

export interface FaucetDeps {
  /** The faucet wallet of an allowlisted chain, or null when its faucet key is not configured. */
  faucetFor(env: unknown, chainId: number): FaucetChain | null;
}

export type ClaimAnswer =
  | { readonly ok: true; readonly txHash: Hex }
  | {
      readonly ok: false;
      readonly error: 'already_claimed' | 'rate_limited' | 'daily_cap_reached';
      readonly retryAfter: number;
    }
  | { readonly ok: false; readonly error: 'unavailable' };

/** The faucet's RPC surface, as the Worker calls it. */
export interface SubmitterFaucetApi {
  claim(chainId: number, agent: Hex, ipTag: string): Promise<ClaimAnswer>;
}

/** Largest faucet request body: `{chainId, agent}` is under 100 bytes. */
export const MAX_FAUCET_BODY_BYTES = 1024;

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

export type FaucetRequest =
  | { readonly ok: true; readonly chainId: number; readonly agent: Hex }
  | { readonly ok: false; readonly error: 'bad_request' | 'unsupported_chain' };

/** Parses `{chainId, agent}` strictly; the chain must be on the hard-coded testnet allowlist. */
export function parseFaucetRequest(text: string): FaucetRequest {
  let value: unknown;
  try {
    value = parseJson(text);
  } catch {
    return { ok: false, error: 'bad_request' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'bad_request' };
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== 'agent' || keys[1] !== 'chainId') {
    return { ok: false, error: 'bad_request' };
  }
  const { chainId, agent } = body;
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId < 1) {
    return { ok: false, error: 'bad_request' };
  }
  if (!isFaucetChain(chainId)) return { ok: false, error: 'unsupported_chain' };
  if (!isEvmAddress(agent) || agent.toLowerCase() === ZERO_ADDRESS) {
    return { ok: false, error: 'bad_request' };
  }
  return { ok: true, chainId, agent: agent.toLowerCase() as Hex };
}

const DAY = 86_400;
const IP_TAG = /^[0-9a-f]{64}$/;
const AGENT = /^0x[0-9a-f]{40}$/;
/** The longest agent window the settings allow (config.ts), for pruning without settings. */
const MAX_AGENT_WINDOW = 30 * DAY;

/** [UTC day index, count]. */
type DayCount = [number, number];

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const UNAVAILABLE: ClaimAnswer = Object.freeze({ ok: false, error: 'unavailable' });

/**
 * The faucet class as other modules see it. Declared, because a declaration file cannot name an
 * anonymous class with private members (TS4094); at run time it is a Durable Object class.
 */
export type SubmitterFaucetClass = new (
  ctx: DurableObjectState,
  env: Record<string, unknown>,
) => SubmitterFaucetApi & { alarm(): Promise<void> };

export function createFaucetClass(deps: FaucetDeps): SubmitterFaucetClass {
  return class SubmitterFaucet
    extends DurableObject<Record<string, unknown>>
    implements SubmitterFaucetApi
  {
    /** Claims run one at a time: the limits are checked, the credit sent and the limits charged. */
    private tail: Promise<unknown> = Promise.resolve();

    claim(chainId: number, agent: Hex, ipTag: string): Promise<ClaimAnswer> {
      const run = this.tail.then(() => this.claimNow(chainId, agent, ipTag));
      this.tail = run.catch(() => undefined);
      return run.catch(() => UNAVAILABLE);
    }

    private async claimNow(chainId: number, agent: Hex, ipTag: string): Promise<ClaimAnswer> {
      const config = readFaucetConfig(this.env);
      if (!config || !isFaucetChain(chainId) || !config.chains.includes(chainId)) {
        return UNAVAILABLE;
      }
      if (typeof agent !== 'string' || !AGENT.test(agent) || agent === ZERO_ADDRESS) {
        return UNAVAILABLE;
      }
      if (typeof ipTag !== 'string' || !IP_TAG.test(ipTag)) return UNAVAILABLE;
      const port = deps.faucetFor(this.env, chainId);
      if (!port || port.chainId !== chainId) return UNAVAILABLE;

      const now = nowSeconds();
      const day = Math.floor(now / DAY);
      const untilTomorrow = Math.max(1, (day + 1) * DAY - now);
      const storage = this.ctx.storage;
      const agentKey = `a:${agent}`;
      const ipKey = `i:${ipTag}`;
      const global = await storage.get<DayCount>('g');
      const used = global && global[0] === day ? global[1] : 0;
      if (used >= config.dailyCap) {
        return { ok: false, error: 'daily_cap_reached', retryAfter: untilTomorrow };
      }
      const claimedAt = await storage.get<number>(agentKey);
      if (typeof claimedAt === 'number' && now - claimedAt < config.agentWindowSeconds) {
        const retryAfter = Math.max(1, claimedAt + config.agentWindowSeconds - now);
        return { ok: false, error: 'already_claimed', retryAfter };
      }
      const ip = await storage.get<DayCount>(ipKey);
      const ipUsed = ip && ip[0] === day ? ip[1] : 0;
      if (ipUsed >= config.ipClaimsPerDay) {
        return { ok: false, error: 'rate_limited', retryAfter: untilTomorrow };
      }

      let result;
      try {
        result = await port.credit(agent, config.usdCents);
      } catch {
        return UNAVAILABLE;
      }
      if (result.state === 'not_sent') return UNAVAILABLE;
      // Broadcast (sent, or its answer lost): charge every limit.
      await storage.put({
        g: [day, used + 1] satisfies DayCount,
        [agentKey]: now,
        [ipKey]: [day, ipUsed + 1] satisfies DayCount,
      });
      if ((await storage.getAlarm()) === null) {
        await storage.setAlarm(((day + 1) * DAY + 60) * 1000);
      }
      return result.state === 'sent' ? { ok: true, txHash: result.txHash } : UNAVAILABLE;
    }

    /** Daily: deletes the entries whose window is over; runs again while any remain. */
    async alarm(): Promise<void> {
      const now = nowSeconds();
      const day = Math.floor(now / DAY);
      const window = readFaucetConfig(this.env)?.agentWindowSeconds ?? MAX_AGENT_WINDOW;
      const storage = this.ctx.storage;
      const stale: string[] = [];
      for (const [key, at] of await storage.list<number>({ prefix: 'a:' })) {
        if (typeof at !== 'number' || now - at >= window) stale.push(key);
      }
      for (const [key, count] of await storage.list<DayCount>({ prefix: 'i:' })) {
        if (!Array.isArray(count) || count[0] !== day) stale.push(key);
      }
      const global = await storage.get<DayCount>('g');
      if (global !== undefined && global[0] !== day) stale.push('g');
      for (let i = 0; i < stale.length; i += 128) {
        await storage.delete(stale.slice(i, i + 128));
      }
      const left = await storage.list({ limit: 1 });
      if (left.size > 0) await storage.setAlarm(((day + 1) * DAY + 60) * 1000);
    }
  };
}
