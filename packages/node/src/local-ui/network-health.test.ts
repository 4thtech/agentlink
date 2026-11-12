// REL051-CF2: the app's network health source (R1-CLASS-02). The status bar and Advanced read
// relay counts from the open agent's own reachability check, never a claim without evidence.
import { describe, expect, it } from 'vitest';
import {
  NETWORK_CHECK_MS,
  NETWORK_FIRST_WAIT_MS,
  networkHealthSource,
  type NetworkHealthClient,
} from './network-health.js';

type Reach = { connected: number; total: number } | undefined;

function manual(start = 1_800_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

/** A client whose check answers what `next` says, or hangs (a black-holed relay) until released. */
function client(): NetworkHealthClient & {
  calls: number;
  next: Reach | 'hang' | 'throw';
  release: (value: Reach) => void;
} {
  let pending: ((value: Reach) => void) | undefined;
  const c = {
    calls: 0,
    next: { connected: 3, total: 3 } as Reach | 'hang' | 'throw',
    release: (value: Reach) => pending?.(value),
    relayReachability: (): Promise<Reach> => {
      c.calls += 1;
      if (c.next === 'throw') return Promise.reject(new Error('wss://relay.example/?token=x'));
      if (c.next === 'hang') return new Promise<Reach>((resolve) => (pending = resolve));
      return Promise.resolve(c.next);
    },
  };
  return c;
}

describe('networkHealthSource (REL051-CF2)', () => {
  it('answers 0 of 3 while no relay can be reached, and the real count once they are back', async () => {
    const c = client();
    const clock = manual();
    const source = networkHealthSource(c, { now: clock.now });
    c.next = { connected: 0, total: 3 };
    expect(await source()).toEqual({ agent: 'running', relays: { connected: 0, total: 3 } });
    c.next = { connected: 3, total: 3 };
    clock.advance(NETWORK_CHECK_MS);
    expect(await source()).toEqual({
      agent: 'running',
      relays: { connected: 3, total: 3 },
      lastSyncAt: Math.floor(clock.now() / 1000),
    });
  });

  it('keeps the last time a relay answered while the network is down again', async () => {
    const c = client();
    const clock = manual();
    const source = networkHealthSource(c, { now: clock.now });
    await source();
    const okAt = Math.floor(clock.now() / 1000);
    c.next = { connected: 0, total: 3 };
    clock.advance(NETWORK_CHECK_MS);
    expect(await source()).toEqual({
      agent: 'running',
      relays: { connected: 0, total: 3 },
      lastSyncAt: okAt,
    });
  });

  it('checks at most once per interval and never twice at once', async () => {
    const c = client();
    const clock = manual();
    const source = networkHealthSource(c, { now: clock.now });
    await Promise.all([source(), source(), source()]);
    await source();
    expect(c.calls).toBe(1);
    clock.advance(NETWORK_CHECK_MS);
    await source();
    expect(c.calls).toBe(2);
  });

  it('never waits on a black-holed check: answers without counts, then with them once it ends', async () => {
    const c = client();
    const clock = manual();
    const source = networkHealthSource(c, { now: clock.now });
    c.next = 'hang';
    const started = Date.now();
    expect(await source()).toEqual({ agent: 'running' });
    expect(Date.now() - started).toBeLessThan(NETWORK_FIRST_WAIT_MS + 500);
    c.release({ connected: 0, total: 3 });
    await new Promise((r) => setTimeout(r, 0));
    expect(await source()).toEqual({ agent: 'running', relays: { connected: 0, total: 3 } });
  });

  it('a failed check or a paused agent (no answer) reports no counts and never the error text', async () => {
    const c = client();
    const clock = manual();
    const source = networkHealthSource(c, { now: clock.now });
    c.next = 'throw';
    const failed = await source();
    expect(failed).toEqual({ agent: 'running' });
    expect(JSON.stringify(failed)).not.toContain('wss:');
    c.next = undefined;
    clock.advance(NETWORK_CHECK_MS);
    expect(await source()).toEqual({ agent: 'running' });
  });
});
