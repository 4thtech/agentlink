// Free test credits, claimed once per agent per testnet (M1-36i; 05 §9, 12 §2 "Testnets: free",
// 07 §2 `proofs.requestFaucet`; M1-10b). Owner decision 2026-10-22: claim automatically, once per
// agent, a small amount (the service's own grant), testnets only, and say plainly when the service
// is paused.
//
// - Trigger: the first proof attempt that comes back `needs_credits` with a route to a testnet
//   (notarize.ts, send.ts). Not at setup: setup stays offline, an agent that never asks for proof
//   never takes from the shared pool, and the route names the exact chain the proof would pay on.
// - Once: a claim that added credits, or the service answering that this agent already claimed, is
//   stored as `claimed` in the marker (a file in the agent's folder, runtime/free-credits.ts) and
//   never sent again, across restarts. A marker that cannot be read sends nothing (fail safe).
// - Paused (the pool is empty, the daily cap, the per-IP limit, the service down): `paused`, and
//   the next request waits out a growing backoff (FREE_CREDITS_BACKOFF), at least the service's
//   retryAfter, at most a day.
// - Testnets only, twice over: `isFreeCreditsChain` (the runtime: the chain package's hard-coded
//   allowlist AND the shipped config's `testnet` flag) is checked here before the core is called,
//   and the core's `requestFaucet` checks its own allowlist again before anything is sent.
// - Nothing from the service reaches a result: the outcome is one of three fixed values (I-5).
import type { FreeCreditsResult } from '@4thtech-io/core';

/** `added`: credits were added just now. `paused`: the service can't add any now. `none`: nothing to say. */
export type FreeCreditsOutcome = 'added' | 'paused' | 'none';

/** The stored state of one chain's claim. */
export type FreeCreditsChainState =
  | { readonly state: 'claimed' }
  | {
      readonly state: 'retry';
      /** Paused answers so far. */
      readonly attempts: number;
      /** Unix seconds before which no request is sent. */
      readonly next: number;
    };

/** Where the claim is remembered (Node: a 0600 file in the agent's folder). */
export interface FreeCreditsMarker {
  read(chainId: number): Promise<FreeCreditsChainState | undefined>;
  write(chainId: number, state: FreeCreditsChainState): Promise<void>;
}

export const FREE_CREDITS_BACKOFF = Object.freeze({
  /** The wait after the first paused answer, in seconds; it doubles with each further one. */
  firstSeconds: 300,
  /** The longest wait, in seconds. */
  maxSeconds: 86_400,
});

export interface FreeCreditsClaimerDeps {
  /** Core `proofs.requestFaucet(chainId)`. */
  request(chainId: number): Promise<FreeCreditsResult>;
  /** The runtime's testnet check: the chain package's allowlist and the shipped `testnet` flag. */
  isFreeCreditsChain(chainId: number): boolean;
  readonly marker: FreeCreditsMarker;
  /** Unix seconds. Default: the system clock. */
  readonly now?: () => number;
}

const systemNow = (): number => Math.floor(Date.now() / 1000);

/** The wait after `attempts` paused answers, never shorter than a sane `retryAfter`. */
function backoff(attempts: number, retryAfter: unknown): number {
  const grown = FREE_CREDITS_BACKOFF.firstSeconds * 2 ** Math.min(Math.max(attempts - 1, 0), 16);
  const asked =
    typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter > 0
      ? retryAfter
      : 0;
  return Math.min(Math.max(grown, asked), FREE_CREDITS_BACKOFF.maxSeconds);
}

/** One claim function per agent; concurrent calls for one chain share one request. */
export function createFreeCreditsClaimer(
  deps: FreeCreditsClaimerDeps,
): (chainId: number) => Promise<FreeCreditsOutcome> {
  const now = deps.now ?? systemNow;
  const inFlight = new Map<number, Promise<FreeCreditsOutcome>>();

  async function claimNow(chainId: number): Promise<FreeCreditsOutcome> {
    let stored: FreeCreditsChainState | undefined;
    try {
      stored = await deps.marker.read(chainId);
    } catch {
      return 'none'; // cannot tell whether it was claimed: never risk a second claim
    }
    if (stored?.state === 'claimed') return 'none';
    const attempts = stored?.state === 'retry' ? stored.attempts : 0;
    if (stored?.state === 'retry' && now() < stored.next) return 'paused';

    let answer: FreeCreditsResult;
    try {
      answer = await deps.request(chainId);
    } catch {
      answer = { status: 'unavailable' };
    }
    const save = async (state: FreeCreditsChainState): Promise<void> => {
      try {
        await deps.marker.write(chainId, state);
      } catch {
        // Not remembered: the next attempt asks again and the service answers `already_claimed`.
      }
    };
    switch (answer.status) {
      case 'sent':
        await save({ state: 'claimed' });
        return 'added';
      case 'already_claimed':
        await save({ state: 'claimed' });
        return 'none';
      case 'rate_limited':
      case 'daily_cap_reached':
      case 'unavailable': {
        const next = attempts + 1;
        const retryAfter = 'retryAfter' in answer ? answer.retryAfter : undefined;
        await save({ state: 'retry', attempts: next, next: now() + backoff(next, retryAfter) });
        return 'paused';
      }
      default:
        return 'none'; // refused (not a testnet here, no identity): nothing to tell
    }
  }

  return (chainId: number): Promise<FreeCreditsOutcome> => {
    if (!Number.isSafeInteger(chainId) || !deps.isFreeCreditsChain(chainId)) {
      return Promise.resolve('none');
    }
    const running = inFlight.get(chainId);
    if (running !== undefined)
      return running.then((outcome) => (outcome === 'added' ? 'none' : outcome));
    const run = claimNow(chainId).finally(() => inFlight.delete(chainId));
    inFlight.set(chainId, run);
    return run;
  };
}

/** An in-memory marker (tests; a runtime without an agent folder keeps the claim per process). */
export function memoryFreeCreditsMarker(): FreeCreditsMarker {
  const states = new Map<number, FreeCreditsChainState>();
  return Object.freeze<FreeCreditsMarker>({
    read: (chainId) => Promise.resolve(states.get(chainId)),
    write: (chainId, state) => {
      states.set(chainId, state);
      return Promise.resolve();
    },
  });
}
