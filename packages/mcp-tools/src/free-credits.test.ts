// M1-36i: free test credits, claimed once per agent per testnet (05 §9, 12 §2, 07 §2 reads; M1-10b).
// The claimer against a fake core `requestFaucet` and an in-memory marker:
// - once only: after a claim that added credits (or the service saying it already did), no request
//   is ever sent again for that chain, also from a new claimer over the same marker (a restart);
// - a chain the runtime does not call a free-credits testnet (a mainnet) never reaches the core;
// - paused: the service's daily cap, its rate limit and "unavailable" (the pool is empty) map to
//   `paused`, with a backoff before the next request; anything else is `none`.
import type { AgentLinkClient, FreeCreditsResult } from '@4thtech-io/core';
import { describe, expect, it } from 'vitest';
import { coreToolClient, type ProofPlatformTools } from './context.js';
import {
  FREE_CREDITS_BACKOFF,
  createFreeCreditsClaimer,
  memoryFreeCreditsMarker,
  type FreeCreditsMarker,
} from './free-credits.js';

const BASE_SEPOLIA = 84532;
const BASE_MAINNET = 8453;

function setup(
  answers: FreeCreditsResult[],
  options: { marker?: FreeCreditsMarker; now?: () => number } = {},
) {
  const requests: number[] = [];
  const marker = options.marker ?? memoryFreeCreditsMarker();
  const claim = createFreeCreditsClaimer({
    request: (chainId) => {
      requests.push(chainId);
      const next = answers.shift();
      return next === undefined ? Promise.reject(new Error('no answer')) : Promise.resolve(next);
    },
    isFreeCreditsChain: (chainId) => chainId === BASE_SEPOLIA,
    marker,
    now: options.now ?? (() => 1_760_000_000),
  });
  return { claim, requests, marker };
}

describe('free test credits claimer (M1-36i)', () => {
  it('claims once: added the first time, never asked again afterwards', async () => {
    const { claim, requests } = setup([{ status: 'sent' }, { status: 'sent' }]);
    expect(await claim(BASE_SEPOLIA)).toBe('added');
    expect(await claim(BASE_SEPOLIA)).toBe('none');
    expect(await claim(BASE_SEPOLIA)).toBe('none');
    expect(requests).toEqual([BASE_SEPOLIA]);
  });

  it('the marker persists: a new claimer over the same marker (a restart) never claims again', async () => {
    const first = setup([{ status: 'sent' }]);
    expect(await first.claim(BASE_SEPOLIA)).toBe('added');
    const second = setup([{ status: 'sent' }], { marker: first.marker });
    expect(await second.claim(BASE_SEPOLIA)).toBe('none');
    expect(second.requests).toEqual([]);
    expect(await first.marker.read(BASE_SEPOLIA)).toEqual({ state: 'claimed' });
  });

  it('already claimed (by the service) counts as claimed: no sentence, never asked again', async () => {
    const { claim, requests } = setup([{ status: 'already_claimed', retryAfter: 600 }]);
    expect(await claim(BASE_SEPOLIA)).toBe('none');
    expect(await claim(BASE_SEPOLIA)).toBe('none');
    expect(requests).toEqual([BASE_SEPOLIA]);
  });

  it('two calls at the same time send one request', async () => {
    const { claim, requests } = setup([{ status: 'sent' }, { status: 'sent' }]);
    const [a, b] = await Promise.all([claim(BASE_SEPOLIA), claim(BASE_SEPOLIA)]);
    expect([a, b].sort()).toEqual(['added', 'none']);
    expect(requests).toEqual([BASE_SEPOLIA]);
  });

  it('a mainnet (or any chain not called a free-credits testnet) is refused before the core', async () => {
    const { claim, requests, marker } = setup([{ status: 'sent' }]);
    expect(await claim(BASE_MAINNET)).toBe('none');
    expect(await claim(1)).toBe('none');
    expect(await claim(Number.NaN)).toBe('none');
    expect(requests).toEqual([]);
    expect(await marker.read(BASE_MAINNET)).toBeUndefined();
  });

  it('the core refusing the chain (not_testnet) is none, and writes nothing', async () => {
    const { claim, marker } = setup([{ status: 'refused', reason: 'not_testnet' }]);
    expect(await claim(BASE_SEPOLIA)).toBe('none');
    expect(await marker.read(BASE_SEPOLIA)).toBeUndefined();
  });

  it.each<[string, FreeCreditsResult]>([
    ['daily cap reached (pool alert)', { status: 'daily_cap_reached', retryAfter: 3600 }],
    ['rate limited', { status: 'rate_limited', retryAfter: 3600 }],
    ['unavailable (the pool is empty or the service is down)', { status: 'unavailable' }],
  ])('%s maps to paused', async (_name, answer) => {
    const { claim } = setup([answer]);
    expect(await claim(BASE_SEPOLIA)).toBe('paused');
  });

  it('a paused claim retries only after its backoff, which grows, then can succeed', async () => {
    let now = 1_760_000_000;
    const { claim, requests } = setup(
      [{ status: 'unavailable' }, { status: 'unavailable' }, { status: 'sent' }],
      { now: () => now },
    );
    expect(await claim(BASE_SEPOLIA)).toBe('paused');
    // Inside the backoff: still paused, nothing sent.
    now += FREE_CREDITS_BACKOFF.firstSeconds - 1;
    expect(await claim(BASE_SEPOLIA)).toBe('paused');
    expect(requests).toHaveLength(1);
    now += 1;
    expect(await claim(BASE_SEPOLIA)).toBe('paused');
    expect(requests).toHaveLength(2);
    // The second backoff is longer than the first.
    now += FREE_CREDITS_BACKOFF.firstSeconds;
    expect(await claim(BASE_SEPOLIA)).toBe('paused');
    expect(requests).toHaveLength(2);
    now += FREE_CREDITS_BACKOFF.firstSeconds;
    expect(await claim(BASE_SEPOLIA)).toBe('added');
    expect(requests).toHaveLength(3);
    expect(await claim(BASE_SEPOLIA)).toBe('none');
  });

  it('the backoff honours a longer retryAfter, bounded by a day', async () => {
    let now = 1_760_000_000;
    const { claim, requests } = setup(
      [{ status: 'daily_cap_reached', retryAfter: 10 * 86_400 }, { status: 'sent' }],
      { now: () => now },
    );
    expect(await claim(BASE_SEPOLIA)).toBe('paused');
    now += FREE_CREDITS_BACKOFF.maxSeconds - 1;
    expect(await claim(BASE_SEPOLIA)).toBe('paused');
    expect(requests).toHaveLength(1);
    now += 1;
    expect(await claim(BASE_SEPOLIA)).toBe('added');
  });

  it('a request that throws is paused, and a marker that cannot be read sends nothing', async () => {
    const { claim } = setup([]);
    expect(await claim(BASE_SEPOLIA)).toBe('paused');
    const requests: number[] = [];
    const broken = createFreeCreditsClaimer({
      request: (chainId) => {
        requests.push(chainId);
        return Promise.resolve({ status: 'sent' });
      },
      isFreeCreditsChain: () => true,
      marker: {
        read: () => Promise.reject(new Error('disk')),
        write: () => Promise.resolve(),
      },
    });
    expect(await broken(BASE_SEPOLIA)).toBe('none');
    expect(requests).toEqual([]);
  });
});

describe('coreToolClient wiring (M1-36i)', () => {
  function wired(options: { marker?: boolean; isFreeCreditsChain?: boolean }) {
    const asked: number[] = [];
    const client = {
      proofs: {
        requestFaucet: (chainId: number): Promise<FreeCreditsResult> => {
          asked.push(chainId);
          return Promise.resolve({ status: 'sent' });
        },
      },
    } as unknown as AgentLinkClient;
    const platform = {
      chainIdOf: () => undefined,
      ...(options.isFreeCreditsChain === false
        ? {}
        : { isFreeCreditsChain: (chainId: number) => chainId === BASE_SEPOLIA }),
    } as unknown as ProofPlatformTools;
    const tools = coreToolClient(client, {
      proofs: platform,
      ...(options.marker === false ? {} : { freeCredits: memoryFreeCreditsMarker() }),
    });
    return { proofs: tools.proofs!, asked };
  }

  it('claims through the core requestFaucet, once', async () => {
    const { proofs, asked } = wired({});
    expect(await proofs.freeCredits?.(BASE_SEPOLIA)).toBe('added');
    expect(await proofs.freeCredits?.(BASE_SEPOLIA)).toBe('none');
    expect(asked).toEqual([BASE_SEPOLIA]);
  });

  it('a mainnet never reaches the core', async () => {
    const { proofs, asked } = wired({});
    expect(await proofs.freeCredits?.(BASE_MAINNET)).toBe('none');
    expect(asked).toEqual([]);
  });

  it('no marker or no testnet check: no claim at all', () => {
    expect(wired({ marker: false }).proofs.freeCredits).toBeUndefined();
    expect(wired({ isFreeCreditsChain: false }).proofs.freeCredits).toBeUndefined();
  });
});
