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
