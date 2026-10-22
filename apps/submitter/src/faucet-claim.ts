// The steps of one faucet claim (05 §9; 03 §4.4; SUB-7; M1-10b, M1-10b-b), over a narrow storage
// interface so they run without the Workers runtime. The faucet Durable Object (faucet.ts) runs
// them one claim at a time over its own storage, so nothing here races.
//
// - Limits: the global cap per chain per UTC day, one claim per agent per window, claims per IP per
//   UTC day. They are checked, then the claim is **charged in storage before the broadcast** (one
//   atomic write): a storage failure at charge time sends nothing, and a storage failure after the
//   broadcast leaves the claim charged, so it can never allow a second claim for that agent.
// - A claim that sent nothing is refunded with one atomic write; a refund that fails leaves it
//   charged (fail safe: the agent waits for the window, nothing is sent twice).
// - Paused (M1-10b-e): after the agent's own earlier claim is checked, the faucet wallet's balance
//   is read; below one grant the claim is `paused`, before any charge, and nothing is sent.
// - A lost broadcast answer is recorded with its transaction hash; a retry by the same agent inside
//   the window returns that transaction, sends nothing and charges nothing.
// - Storage: `a:<agent>` [claim time, state, txHash?], `i:<HMAC of the IP bucket>` [day, count],
//   `g` [day, count]. Never an IP, never an agent next to an IP tag; nothing is logged (07 §7, I-7).
import type { FaucetChain, Hex } from '@4thtech-io/chain';

export type ClaimAnswer =
  | { readonly ok: true; readonly txHash: Hex }
  | {
      readonly ok: false;
      readonly error: 'already_claimed' | 'rate_limited' | 'daily_cap_reached';
      readonly retryAfter: number;
    }
  | { readonly ok: false; readonly error: 'unavailable' }
  /** The faucet cannot cover one grant (M1-10b-e); nothing was sent or charged. */
  | { readonly ok: false; readonly error: 'paused' };

/** The storage calls a claim needs; a Durable Object's storage has them. */
export interface ClaimStore {
  get<T>(key: string): Promise<T | undefined>;
  /** Writes every entry atomically. */
  put(entries: Record<string, unknown>): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface ClaimLimits {
  readonly usdCents: number;
  readonly agentWindowSeconds: number;
  readonly ipClaimsPerDay: number;
  readonly dailyCap: number;
}

export const DAY = 86_400;

/** [UTC day index, count]. */
export type DayCount = [number, number];

/**
 * An agent's claim: [claim time, state] or [claim time, state, txHash].
 * - `p` charged, outcome not recorded (the broadcast may have happened): counts as a claim;
 * - `s` sent: counts as a claim;
 * - `u` sent, answer lost (txHash): counts as a claim, and a retry returns txHash;
 * - `n` not sent, refunded: no claim.
 * The earlier version stored the claim time alone (a number): read as `s`.
 */
export type AgentClaim = number | [number, 'p' | 's' | 'n'] | [number, 'u', Hex];

const TX_HASH = /^0x[0-9a-f]{64}$/;
const UNAVAILABLE: ClaimAnswer = Object.freeze({ ok: false, error: 'unavailable' });
const PAUSED: ClaimAnswer = Object.freeze({ ok: false, error: 'paused' });

/** The claim time of a stored entry that counts as a claim, else null. */
export function claimTime(entry: unknown): number | null {
  if (typeof entry === 'number') return Number.isFinite(entry) ? entry : null;
  if (!Array.isArray(entry) || typeof entry[0] !== 'number') return null;
  return entry[1] === 'n' ? null : entry[0];
}

/** The transaction of a claim whose broadcast answer was lost, else null. */
function lostTx(entry: unknown): Hex | null {
  if (!Array.isArray(entry) || entry[1] !== 'u') return null;
  const hash: unknown = entry[2];
  return typeof hash === 'string' && TX_HASH.test(hash) ? (hash as Hex) : null;
}

/** Checks the limits, charges them, credits the agent, and records the outcome. */
export async function runClaim(
  store: ClaimStore,
  port: FaucetChain,
  limits: ClaimLimits,
  agent: Hex,
  ipTag: string,
  now: number,
): Promise<ClaimAnswer> {
  const day = Math.floor(now / DAY);
  const untilTomorrow = Math.max(1, (day + 1) * DAY - now);
  const agentKey = `a:${agent}`;
  const ipKey = `i:${ipTag}`;

  // The agent's earlier claim first: a retry after a lost answer is not a new claim, so the caps
  // (which it already counted in) do not refuse it.
  const previous = await store.get<AgentClaim>(agentKey);
  const claimedAt = claimTime(previous);
  if (claimedAt !== null && now - claimedAt < limits.agentWindowSeconds) {
    const txHash = lostTx(previous);
    if (txHash !== null) return { ok: true, txHash };
    const retryAfter = Math.max(1, claimedAt + limits.agentWindowSeconds - now);
    return { ok: false, error: 'already_claimed', retryAfter };
  }
  // M1-10b-e: a faucet that cannot cover one grant pauses before its wallet is empty. Checked
  // before the caps, so a paused claim charges nothing; a failed read sends and charges nothing.
  let tokenUsdCents: bigint;
  try {
    tokenUsdCents = (await port.balances()).tokenUsdCents;
  } catch {
    return UNAVAILABLE;
  }
  if (tokenUsdCents < BigInt(limits.usdCents)) return PAUSED;
  const global = await store.get<DayCount>('g');
  const used = global && global[0] === day ? global[1] : 0;
  if (used >= limits.dailyCap) {
    return { ok: false, error: 'daily_cap_reached', retryAfter: untilTomorrow };
  }
  const ip = await store.get<DayCount>(ipKey);
  const ipUsed = ip && ip[0] === day ? ip[1] : 0;
  if (ipUsed >= limits.ipClaimsPerDay) {
    return { ok: false, error: 'rate_limited', retryAfter: untilTomorrow };
  }

  // Charge before the broadcast, in one atomic write. If it fails, nothing is sent.
  try {
    await store.put({
      g: [day, used + 1] satisfies DayCount,
      [agentKey]: [now, 'p'] satisfies AgentClaim,
      [ipKey]: [day, ipUsed + 1] satisfies DayCount,
    });
  } catch {
    // The charge may or may not have been written: either way nothing was sent.
    return UNAVAILABLE;
  }
  try {
    // The daily clean-up (faucet.ts alarm). Without it the entries stay longer; the limits still
    // read their times, so a failure here changes no answer.
    if ((await store.getAlarm()) === null) await store.setAlarm(((day + 1) * DAY + 60) * 1000);
  } catch {
    // Retried by the next claim.
  }

  let result;
  try {
    result = await port.credit(agent, limits.usdCents);
  } catch {
    result = null; // a bad agent or amount, refused before any request: nothing was sent
  }

  if (result === null || result.state === 'not_sent') {
    try {
      await store.put({
        g: [day, used] satisfies DayCount,
        [agentKey]: [now, 'n'] satisfies AgentClaim,
        [ipKey]: [day, ipUsed] satisfies DayCount,
      });
    } catch {
      // The claim stays charged: the agent waits for the window; nothing is sent twice.
    }
    return UNAVAILABLE;
  }

  const record: AgentClaim =
    result.state === 'sent' ? [now, 's'] : [now, 'u', result.txHash.toLowerCase() as Hex];
  try {
    await store.put({ [agentKey]: record });
  } catch {
    // The claim stays charged as `p`: no second claim; a retry is `already_claimed`.
  }
  return result.state === 'sent' ? { ok: true, txHash: result.txHash } : UNAVAILABLE;
}
