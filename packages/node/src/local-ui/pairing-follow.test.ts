// W4-SHORT-INVITE fix round (O-L3; 04 §3.6.2, 06 §6): the drop-object sweep never holds up a
// follow pass. A sweep that hangs (a drop that never answers) leaves the pass done, the lease
// released and the next pass free to run; a sweep that fails is swallowed.
import { describe, expect, it } from 'vitest';
import { pairingFollower, type PairingFollowClient } from './pairing-follow.js';

function client(sweep: () => Promise<void>) {
  const calls = { take: 0, release: 0, sync: 0, sweep: 0 };
  const c: PairingFollowClient = {
    publisherLease: () => ({
      take: () => {
        calls.take += 1;
        return Promise.resolve(true);
      },
      release: () => {
        calls.release += 1;
        return Promise.resolve(true);
      },
    }),
    syncInbox: () => {
      calls.sync += 1;
      return Promise.resolve();
    },
    outbox: { processDue: () => Promise.resolve() },
    pairing: {
      waiting: () => Promise.resolve(true),
      sweepInviteObjects: () => {
        calls.sweep += 1;
        return sweep();
      },
    },
  };
  return { c, calls };
}

/** Settles `p` within a few macrotasks, or reports that it is still pending. */
async function within<T>(p: Promise<T>): Promise<T | 'pending'> {
  const late = new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50));
  return Promise.race([p, late]);
}

describe('the invite sweep never blocks a pass (O-L3)', () => {
  it('a hung sweep: the pass ends, the lease is released, the next pass runs', async () => {
    const { c, calls } = client(() => new Promise<void>(() => {}));
    let t = 0;
    const follower = pairingFollower(c, { nowMs: () => t });
    expect(await within(follower.follow())).toBe('ran');
    expect(calls.sweep).toBe(1);
    expect(calls.release).toBe(1);
    expect(follower.passing).toBe(false);
    t += 5_000;
    expect(await within(follower.follow())).toBe('ran');
    expect(calls.sync).toBe(2);
  });

  it('a failing sweep is swallowed', async () => {
    const { c, calls } = client(() => Promise.reject(new Error('drop down')));
    const follower = pairingFollower(c, { nowMs: () => 0 });
    expect(await within(follower.follow())).toBe('ran');
    expect(calls.release).toBe(1);
  });
});

// W4-PAUSE (D-143 (5); 06 §6 "Paused agents"; 08 §1 "What stops"): the host's pairing passes skip a
// paused agent before the lease is even taken; a pause state that cannot be read counts as paused.
describe('a paused agent gets no host pass (W4-PAUSE)', () => {
  const cases: readonly [string, () => Promise<boolean>][] = [
    ['paused', () => Promise.resolve(true)],
    ['unreadable pause state (fail closed)', () => Promise.reject(new Error('SQLITE_BUSY'))],
  ];
  for (const [label, paused] of cases) {
    it(`${label}: no lease, no fetch, no publish, no sweep`, async () => {
      const { c, calls } = client(() => Promise.resolve());
      const follower = pairingFollower({ ...c, paused }, { nowMs: () => 0 });
      expect(await follower.follow()).toBe('paused');
      expect(await follower.tick()).toBe('paused');
      expect(calls).toEqual({ take: 0, release: 0, sync: 0, sweep: 0 });
      expect(follower.passing).toBe(false);
    });
  }

  it('not paused: the pass runs as before', async () => {
    const { c, calls } = client(() => Promise.resolve());
    const follower = pairingFollower(
      { ...c, paused: () => Promise.resolve(false) },
      { nowMs: () => 0 },
    );
    expect(await follower.follow()).toBe('ran');
    expect(calls.sync).toBe(1);
  });
});

// REL051-CF1 (R1-CLASS-10): on a slow network one pass's 3 s fetch budget can end before the first
// answer arrives, every time. A pass that ended partial (the relay did not finish) doubles the next
// pass's budget, up to 12 s; a pass that finished resets it.
describe('a slow network gets a longer pass (R1-CLASS-10)', () => {
  function slow(partial: () => boolean) {
    const budgets: number[] = [];
    const c: PairingFollowClient = {
      publisherLease: () => ({
        take: () => Promise.resolve(true),
        release: () => Promise.resolve(true),
      }),
      syncInbox: (options) => {
        budgets.push(options?.budgetMs ?? -1);
        return Promise.resolve({ partial: partial() });
      },
      outbox: { processDue: () => Promise.resolve() },
      pairing: { waiting: () => Promise.resolve(true) },
    };
    return { c, budgets };
  }

  it('doubles the budget after a partial pass, up to the cap, and resets after a full one', async () => {
    let partial = true;
    const { c, budgets } = slow(() => partial);
    let t = 0;
    const follower = pairingFollower(c, { nowMs: () => t });
    for (let i = 0; i < 5; i += 1) {
      expect(await follower.follow()).toBe('ran');
      t += 5_000;
    }
    expect(budgets).toEqual([3_000, 6_000, 12_000, 12_000, 12_000]);
    partial = false;
    await follower.follow();
    t += 5_000;
    await follower.follow();
    expect(budgets.slice(5)).toEqual([12_000, 3_000]);
  });

  it('a sync that throws or answers nothing keeps the base budget', async () => {
    const budgets: number[] = [];
    let t = 0;
    const follower = pairingFollower(
      {
        publisherLease: () => ({
          take: () => Promise.resolve(true),
          release: () => Promise.resolve(true),
        }),
        syncInbox: (options) => {
          budgets.push(options?.budgetMs ?? -1);
          return budgets.length === 1 ? Promise.reject(new Error('x')) : Promise.resolve();
        },
        outbox: { processDue: () => Promise.resolve() },
        pairing: { waiting: () => Promise.resolve(true) },
      },
      { nowMs: () => t },
    );
    await follower.follow();
    t += 5_000;
    await follower.follow();
    t += 5_000;
    await follower.follow();
    expect(budgets).toEqual([3_000, 3_000, 3_000]);
  });
});

describe('UX-LEFT-1: flush runs a pass at once, past the interval', () => {
  it('a pass just ran, flush still runs one; follow waits', async () => {
    const { c, calls } = client(() => Promise.resolve());
    const follower = pairingFollower(c, { nowMs: () => 0 });
    expect(await within(follower.follow())).toBe('ran');
    expect(await within(follower.follow())).toBe('soon');
    expect(await within(follower.flush())).toBe('ran');
    expect(calls.sync).toBe(2);
  });
});

describe('OUTBOX-NOW-1: flush (relays back) retries the queued rows now', () => {
  it('a flush calls outbox.retryNow instead of processDue; other passes do not', async () => {
    const outbox = { due: 0, now: 0 };
    const { c } = client(() => Promise.resolve());
    const withRetry: PairingFollowClient = {
      ...c,
      outbox: {
        processDue: () => {
          outbox.due += 1;
          return Promise.resolve();
        },
        retryNow: () => {
          outbox.now += 1;
          return Promise.resolve();
        },
      },
    };
    let t = 0;
    const follower = pairingFollower(withRetry, { nowMs: () => t });
    expect(await within(follower.follow())).toBe('ran');
    expect(outbox).toEqual({ due: 1, now: 0 });
    expect(await within(follower.flush())).toBe('ran');
    expect(outbox).toEqual({ due: 1, now: 1 });
    t += 15_000;
    expect(await within(follower.tick())).toBe('ran');
    expect(outbox).toEqual({ due: 2, now: 1 });
  });

  it('a client without retryNow still gets a processDue pass on flush', async () => {
    let due = 0;
    const { c } = client(() => Promise.resolve());
    const plain: PairingFollowClient = {
      ...c,
      outbox: {
        processDue: () => {
          due += 1;
          return Promise.resolve();
        },
      },
    };
    expect(await within(pairingFollower(plain, { nowMs: () => 0 }).flush())).toBe('ran');
    expect(due).toBe(1);
  });
});
