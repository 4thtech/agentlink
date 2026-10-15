// M1-7k-b: the per-agent publisher lease (07 §3.2 `publisher_lease`; 06 §6 "One active publisher per
// agent"; D-73). A store row with compare-and-set: a 60 s lease renewed every 20 s, taken over once it
// lapses, released on clean shutdown. Several harness MCP processes share one agent store; exactly
// one of them keeps the relay subscriptions. The node test (packages/node) runs the same cases over
// one real SQLite file with two connections and a killed child process.
import { MemoryKeyStore } from '@agentlink/crypto/testing';
import { describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import {
  PUBLISHER_LEASE_RENEW_SECONDS,
  PUBLISHER_LEASE_SECONDS,
  PublisherLease,
} from './publisher-lease.js';
import { MemoryStore } from './store/memory-store.js';
import type { Store } from './store/store.js';
import { FakeClock, RecordingApprovalChannel, TestStoreCipher, seed } from './testing/fixtures.js';

const pair = (store: Store, clock: FakeClock) => ({
  a: new PublisherLease({ store, now: clock.now }),
  b: new PublisherLease({ store, now: clock.now }),
});

/** How many of `leases` believe they hold the lease right now. */
const holders = (...leases: PublisherLease[]): number => leases.filter((l) => l.held).length;

const leaseRow = (store: Store) =>
  store.transaction((tx) => tx.get('publisher_lease', { name: 'subscriptions' }));

describe('publisher lease: take, renew, release (07 §3.2)', () => {
  it('uses the spec values: a 60 s lease renewed every 20 s', () => {
    expect(PUBLISHER_LEASE_SECONDS).toBe(60);
    expect(PUBLISHER_LEASE_RENEW_SECONDS).toBe(20);
  });

  it('gives each process a random 16-byte base64url holder ID', () => {
    const store = new MemoryStore();
    const { a, b } = pair(store, new FakeClock());
    expect(a.holder).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(b.holder).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.holder).not.toBe(b.holder);
  });

  it('lets exactly one of two processes take the lease, also when both try at once', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const { a, b } = pair(store, clock);
    const results = await Promise.all([a.take(), b.take()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(holders(a, b)).toBe(1);
    const winner = results[0] === true ? a : b;
    expect(await leaseRow(store)).toEqual({
      name: 'subscriptions',
      holder: winner.holder,
      lease_until: clock.t + PUBLISHER_LEASE_SECONDS,
    });
  });

  it('keeps the lease while the holder renews every 20 s, and hands it over once renewals stop', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const { a, b } = pair(store, clock);
    expect(await a.take()).toBe(true);
    for (let i = 0; i < 6; i += 1) {
      clock.t += PUBLISHER_LEASE_RENEW_SECONDS;
      expect(await a.renew()).toBe(true);
      expect(await b.take()).toBe(false); // retries every 20 s, never wins while A renews
      expect(holders(a, b)).toBe(1);
      expect(a.held).toBe(true);
    }
    // A dies (no release, no renewal). B takes over within one lease period of A's last renewal.
    const lastRenewal = clock.t;
    clock.t = lastRenewal + PUBLISHER_LEASE_SECONDS - 1;
    expect(await b.take()).toBe(false);
    clock.t = lastRenewal + PUBLISHER_LEASE_SECONDS;
    expect(await b.take()).toBe(true);
    expect(b.held).toBe(true);
    expect(a.held).toBe(false);
    // A comes back: its renewal changes no row, so it knows it lost the lease.
    expect(await a.renew()).toBe(false);
    expect(a.held).toBe(false);
    expect(holders(a, b)).toBe(1);
  });

  it('a take by the holder renews its own lease', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const { a } = pair(store, clock);
    expect(await a.take()).toBe(true);
    clock.t += 30;
    expect(await a.take()).toBe(true);
    expect((await leaseRow(store))?.lease_until).toBe(clock.t + PUBLISHER_LEASE_SECONDS);
  });

  it('releases on clean shutdown so another process takes over at once; a non-holder releases nothing', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const { a, b } = pair(store, clock);
    expect(await a.take()).toBe(true);
    expect(await b.release()).toBe(false);
    expect((await leaseRow(store))?.holder).toBe(a.holder);
    expect(await a.release()).toBe(true);
    expect(a.held).toBe(false);
    expect(await leaseRow(store)).toBeUndefined();
    expect(await b.take()).toBe(true);
  });

  it('never holds forever after a crash: a lapsed lease is always taken over', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const dead = new PublisherLease({ store, now: clock.now });
    expect(await dead.take()).toBe(true);
    const next = new PublisherLease({ store, now: clock.now });
    clock.t += PUBLISHER_LEASE_SECONDS;
    expect(await next.take()).toBe(true);
  });
});

describe('publisher lease: clock jumps (one machine clock shared by every process)', () => {
  it('forward jump: the other process takes over and the old holder knows at once that it lost', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const { a, b } = pair(store, clock);
    expect(await a.take()).toBe(true);
    clock.t += 3_600;
    expect(a.held).toBe(false); // its own lease_until has passed on this clock
    expect(await b.take()).toBe(true);
    expect(holders(a, b)).toBe(1);
    expect(await a.renew()).toBe(false);
    expect(await a.take()).toBe(false);
    expect(holders(a, b)).toBe(1);
  });

  it('a forward jump shorter than the lease changes nothing', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const { a, b } = pair(store, clock);
    expect(await a.take()).toBe(true);
    clock.t += PUBLISHER_LEASE_SECONDS - 1;
    expect(await b.take()).toBe(false);
    expect(a.held).toBe(true);
    expect(await a.renew()).toBe(true);
  });

  it('backward jump: a lease dated beyond now + 120 s is lapsed, so a crashed holder cannot keep it for the size of the jump, and never two holders', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const { a, b } = pair(store, clock);
    expect(await a.take()).toBe(true);
    clock.t -= 3_600;
    // No live holder could have written lease_until > now + 120 on this clock.
    expect(a.held).toBe(false);
    expect(await b.take()).toBe(true);
    expect(holders(a, b)).toBe(1);
    expect(await a.renew()).toBe(false);
    expect(holders(a, b)).toBe(1);
  });

  it('backward jump with no other process: the holder renews and keeps the lease', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const { a } = pair(store, clock);
    expect(await a.take()).toBe(true);
    clock.t -= 3_600;
    expect(await a.renew()).toBe(true);
    expect(a.held).toBe(true);
    expect((await leaseRow(store))?.lease_until).toBe(clock.t + PUBLISHER_LEASE_SECONDS);
  });

  it('a small backward jump (within the lease) does not lapse the lease', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const { a, b } = pair(store, clock);
    expect(await a.take()).toBe(true);
    clock.t += 10;
    expect(await a.renew()).toBe(true);
    clock.t -= 10;
    expect(a.held).toBe(true);
    expect(await b.take()).toBe(false);
  });

  it("documents the bound: after a jump back and forth, two processes may both believe they hold it until the old holder's next renewal (at most 20 s)", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const { a, b } = pair(store, clock);
    expect(await a.take()).toBe(true); // lease_until = t0 + 60
    clock.t -= 70;
    expect(await b.take()).toBe(true); // A's lease is dated beyond now + 120: lapsed
    clock.t += 20;
    // A has not looked at the store since: on its own view its lease is valid again.
    expect(holders(a, b)).toBe(2);
    // Its next renewal (every 20 s) changes no row, and it stops (06 §6).
    expect(await a.renew()).toBe(false);
    expect(holders(a, b)).toBe(1);
    expect(b.held).toBe(true);
  });

  it('without clock jumps, a process that believes it holds the lease is always the row holder', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const leases = [0, 1, 2].map(() => new PublisherLease({ store, now: clock.now }));
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let step = 0; step < 400; step += 1) {
      clock.t += rand(40);
      const lease = leases[rand(leases.length)] as PublisherLease;
      const r = rand(3);
      if (r === 0) await lease.take();
      else if (r === 1) await lease.renew();
      else if (rand(10) === 0) await lease.release();
      const row = await leaseRow(store);
      for (const l of leases) if (l.held) expect(l.holder).toBe(row?.holder);
      expect(holders(...leases)).toBeLessThanOrEqual(1);
    }
  });

  it('with random clock jumps, one round of renewals always leaves at most one holder, the row holder', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const leases = [0, 1, 2].map(() => new PublisherLease({ store, now: clock.now }));
    let seed = 11;
    const rand = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let step = 0; step < 300; step += 1) {
      const r = rand(6);
      if (r === 0) clock.t += 30 + rand(3_600);
      else if (r === 1) clock.t -= 1 + rand(3_600);
      else clock.t += rand(PUBLISHER_LEASE_RENEW_SECONDS);
      await (leases[rand(leases.length)] as PublisherLease).take();
      for (const l of leases) await l.renew(); // the 20 s renewal of every process
      const row = await leaseRow(store);
      expect(holders(...leases)).toBeLessThanOrEqual(1);
      for (const l of leases) if (l.held) expect(l.holder).toBe(row?.holder);
    }
  });
});

describe('publisher lease: failures count as not held (07 §3.2 "On failure")', () => {
  it('a store that cannot be read or written gives no lease and throws nothing', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const { a } = pair(store, clock);
    expect(await a.take()).toBe(true);
    const broken: Store = {
      schemaVersion: store.schemaVersion,
      transaction: () => Promise.reject(new Error('disk')),
      close: () => store.close(),
    };
    const lease = new PublisherLease({ store: broken, now: clock.now });
    expect(await lease.take()).toBe(false);
    expect(await lease.renew()).toBe(false);
    expect(await lease.release()).toBe(false);
    expect(lease.held).toBe(false);
  });

  it('a renewal that fails drops the lease in this process', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    let fail = false;
    const flaky: Store = {
      schemaVersion: store.schemaVersion,
      transaction: (body) => (fail ? Promise.reject(new Error('busy')) : store.transaction(body)),
      close: () => store.close(),
    };
    const lease = new PublisherLease({ store: flaky, now: clock.now });
    expect(await lease.take()).toBe(true);
    fail = true;
    expect(await lease.renew()).toBe(false);
    expect(lease.held).toBe(false);
  });

  it('an invalid clock gives no lease', async () => {
    const store = new MemoryStore();
    const lease = new PublisherLease({ store, now: () => Number.NaN });
    expect(await lease.take()).toBe(false);
    expect(lease.held).toBe(false);
    expect(await leaseRow(store)).toBeUndefined();
  });
});

describe('publisher lease: client wiring', () => {
  it('two clients over one store: each gets its own holder; only one holds; opening a client takes nothing', async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const open = () =>
      AgentLinkClient.create({
        keyStore: new MemoryKeyStore(seed(1)),
        store,
        cipher: new TestStoreCipher(),
        approvals: new RecordingApprovalChannel(),
        clock: clock.now,
      });
    const one = await open();
    const two = await open();
    // CLI commands open a client and never take the lease (06 §6): opening writes no lease row.
    expect(await leaseRow(store)).toBeUndefined();
    const a = one.publisherLease();
    const b = two.publisherLease();
    expect(a.holder).not.toBe(b.holder);
    expect(await a.take()).toBe(true);
    expect(await b.take()).toBe(false);
    clock.t += PUBLISHER_LEASE_SECONDS;
    expect(await b.take()).toBe(true);
    expect(await a.renew()).toBe(false);
  });
});
