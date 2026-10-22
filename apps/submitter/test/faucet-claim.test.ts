// M1-10b-b: the faucet's claim steps (src/faucet-claim.ts) over an in-memory store that can fail
// on demand, in Node. The Durable Object (src/faucet.ts) runs these steps one claim at a time over
// its own storage; test/faucet.test.ts drives that under Miniflare.
//
// - The claim is charged in storage before the broadcast: a storage failure at charge time sends
//   nothing, and a storage failure after the broadcast still leaves the claim charged.
// - A claim that sent nothing is refunded; a refund that fails leaves it charged (fail safe).
// - A lost broadcast answer is followed by a retry that returns that transaction.
import { describe, expect, it } from 'vitest';
import type { Hex } from '@4thtech-io/chain';
import { runClaim, type ClaimLimits, type ClaimStore } from '../src/faucet-claim.js';
import { FakeFaucet } from './fake-faucet.js';

const CHAIN_ID = 84532;
const DAY = 86_400;
const NOW = 20_000 * DAY + 3_600;
const LIMITS: ClaimLimits = {
  usdCents: 100,
  agentWindowSeconds: DAY,
  ipClaimsPerDay: 2,
  dailyCap: 10,
};
const AGENT = `0x${'ab'.repeat(20)}` as Hex;
const OTHER = `0x${'cd'.repeat(20)}` as Hex;
const IP_A = 'a'.repeat(64);
const IP_B = 'b'.repeat(64);

class MemoryStore implements ClaimStore {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;
  /** Fail the put calls whose number (1-based) is listed; every later put succeeds. */
  failPuts = new Set<number>();
  private puts = 0;

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(structuredClone(this.data.get(key)) as T | undefined);
  }

  put(entries: Record<string, unknown>): Promise<void> {
    this.puts += 1;
    if (this.failPuts.has(this.puts)) return Promise.reject(new Error('storage down'));
    for (const [key, value] of Object.entries(entries)) this.data.set(key, structuredClone(value));
    return Promise.resolve();
  }

  delete(keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) if (this.data.delete(key)) n += 1;
    return Promise.resolve(n);
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm);
  }

  setAlarm(at: number): Promise<void> {
    this.alarm = at;
    return Promise.resolve();
  }
}

function claim(store: ClaimStore, faucet: FakeFaucet, agent = AGENT, ip = IP_A, now = NOW) {
  return runClaim(store, faucet, LIMITS, agent, ip, now);
}

describe('runClaim: charge before the broadcast (M1-10b-b)', () => {
  it('the claim is charged in storage when the credit starts', async () => {
    const store = new MemoryStore();
    const faucet = new FakeFaucet(CHAIN_ID);
    let seen: unknown[] = [];
    faucet.onCredit = () => {
      seen = [store.data.get(`a:${AGENT}`), store.data.get('g'), store.data.get(`i:${IP_A}`)];
    };
    const answer = await claim(store, faucet);
    expect(answer.ok).toBe(true);
    const day = Math.floor(NOW / DAY);
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toEqual([day, 1]);
    expect(seen[2]).toEqual([day, 1]);
    expect(store.alarm).not.toBeNull();
  });

  it('a storage failure at charge time sends nothing and is unavailable', async () => {
    const store = new MemoryStore();
    store.failPuts.add(1);
    const faucet = new FakeFaucet(CHAIN_ID);
    expect(await claim(store, faucet)).toEqual({ ok: false, error: 'unavailable' });
    expect(faucet.calls).toHaveLength(0);
    expect(store.data.size).toBe(0);
    // Nothing was sent, so the agent's one claim is still there, and it is sent only once.
    expect((await claim(store, faucet)).ok).toBe(true);
    expect(await claim(store, faucet, AGENT, IP_B)).toMatchObject({ error: 'already_claimed' });
    expect(faucet.calls).toHaveLength(1);
  });

  it('a storage failure after the broadcast still answers the transaction and allows no second claim', async () => {
    const store = new MemoryStore();
    store.failPuts.add(2); // the charge succeeds; recording the result fails
    const faucet = new FakeFaucet(CHAIN_ID);
    const first = await claim(store, faucet);
    expect(first.ok).toBe(true);
    const again = await claim(store, faucet, AGENT, IP_B);
    expect(again).toMatchObject({ ok: false, error: 'already_claimed' });
    expect(faucet.calls).toHaveLength(1);
  });

  it('a claim that sent nothing is refunded: every limit is as before', async () => {
    const store = new MemoryStore();
    const faucet = new FakeFaucet(CHAIN_ID);
    expect((await claim(store, faucet, OTHER)).ok).toBe(true);
    const before = { g: store.data.get('g'), ip: store.data.get(`i:${IP_A}`) };
    faucet.mode = 'not_sent';
    expect(await claim(store, faucet)).toEqual({ ok: false, error: 'unavailable' });
    // One atomic write puts back the counts and marks the agent's claim as not charged.
    expect({ g: store.data.get('g'), ip: store.data.get(`i:${IP_A}`) }).toEqual(before);
    faucet.mode = 'sent';
    expect((await claim(store, faucet)).ok).toBe(true);
  });

  it('a faucet busy with a stuck approve: unavailable (retryable), refunded, the agent may retry at once (M1-10b-c)', async () => {
    const store = new MemoryStore();
    const faucet = new FakeFaucet(CHAIN_ID);
    faucet.mode = 'not_sent';
    faucet.notSentReason = 'busy';
    // The answer on the wire is unchanged for deployed clients: the retryable `unavailable`.
    expect(await claim(store, faucet)).toEqual({ ok: false, error: 'unavailable' });
    expect(store.data.get('g')).toEqual([Math.floor(NOW / DAY), 0]);
    expect(store.data.get(`i:${IP_A}`)).toEqual([Math.floor(NOW / DAY), 0]);
    faucet.mode = 'sent';
    expect((await claim(store, faucet)).ok).toBe(true);
    expect(faucet.charged()).toBe(1);
  });

  it('a credit that throws before any request is refunded', async () => {
    const store = new MemoryStore();
    const faucet = new FakeFaucet(CHAIN_ID);
    faucet.onCredit = () => {
      throw new Error('bad input');
    };
    expect(await claim(store, faucet)).toEqual({ ok: false, error: 'unavailable' });
    expect(store.data.get('g')).toEqual([Math.floor(NOW / DAY), 0]);
    faucet.onCredit = null;
    expect((await claim(store, faucet)).ok).toBe(true);
  });

  it('a refund that fails leaves the claim charged: no second send', async () => {
    const store = new MemoryStore();
    store.failPuts.add(2); // the refund
    const faucet = new FakeFaucet(CHAIN_ID);
    faucet.mode = 'not_sent';
    expect(await claim(store, faucet)).toEqual({ ok: false, error: 'unavailable' });
    faucet.mode = 'sent';
    expect(await claim(store, faucet, AGENT, IP_B)).toMatchObject({ error: 'already_claimed' });
    expect(faucet.calls).toHaveLength(1);
  });

  it('a claim charged but never answered (the instance stopped) is already_claimed', async () => {
    const store = new MemoryStore();
    store.data.set(`a:${AGENT}`, [NOW - 10, 'p']);
    const faucet = new FakeFaucet(CHAIN_ID);
    const answer = await claim(store, faucet, AGENT, IP_B);
    expect(answer).toMatchObject({ ok: false, error: 'already_claimed' });
    expect(faucet.calls).toHaveLength(0);
  });

  it('reads a claim time stored by the earlier version (a number) as a claim', async () => {
    const store = new MemoryStore();
    store.data.set(`a:${AGENT}`, NOW - 10);
    const faucet = new FakeFaucet(CHAIN_ID);
    const answer = await claim(store, faucet);
    expect(answer).toMatchObject({ ok: false, error: 'already_claimed' });
    if (!answer.ok && answer.error === 'already_claimed') {
      expect(answer.retryAfter).toBe(DAY - 10);
    }
    expect(faucet.calls).toHaveLength(0);
  });
});

describe('runClaim: a lost broadcast answer (M1-10b-b)', () => {
  it('the retry returns the earlier transaction, sends nothing and charges nothing', async () => {
    const store = new MemoryStore();
    const faucet = new FakeFaucet(CHAIN_ID);
    faucet.mode = 'unknown';
    expect(await claim(store, faucet)).toEqual({ ok: false, error: 'unavailable' });
    expect(faucet.calls).toHaveLength(1);
    const before = new Map(store.data);
    faucet.mode = 'sent';
    const retry = await claim(store, faucet, AGENT, IP_B);
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.txHash).toBe(`0x${'1'.padStart(64, 'e')}`);
    expect(faucet.calls).toHaveLength(1);
    expect(store.data).toEqual(before);
    // Every later retry inside the window answers the same.
    expect(await claim(store, faucet, AGENT, IP_B)).toEqual(retry);
  });

  it('after the window the agent may claim again', async () => {
    const store = new MemoryStore();
    const faucet = new FakeFaucet(CHAIN_ID);
    faucet.mode = 'unknown';
    await claim(store, faucet);
    faucet.mode = 'sent';
    const later = await claim(store, faucet, AGENT, IP_B, NOW + DAY);
    expect(later.ok).toBe(true);
    expect(faucet.calls).toHaveLength(2);
  });

  it('a sent claim stays already_claimed on a repeat', async () => {
    const store = new MemoryStore();
    const faucet = new FakeFaucet(CHAIN_ID);
    expect((await claim(store, faucet)).ok).toBe(true);
    expect(await claim(store, faucet, AGENT, IP_B)).toMatchObject({ error: 'already_claimed' });
  });
});

describe('runClaim: the limits are unchanged', () => {
  it('the global cap, then the agent, then the IP limit refuse before any send', async () => {
    const store = new MemoryStore();
    const faucet = new FakeFaucet(CHAIN_ID);
    const day = Math.floor(NOW / DAY);
    store.data.set('g', [day, LIMITS.dailyCap]);
    expect(await claim(store, faucet)).toMatchObject({ error: 'daily_cap_reached' });
    store.data.set('g', [day, 0]);
    store.data.set(`i:${IP_A}`, [day, LIMITS.ipClaimsPerDay]);
    expect(await claim(store, faucet)).toMatchObject({ error: 'rate_limited' });
    expect(faucet.calls).toHaveLength(0);
  });
});
