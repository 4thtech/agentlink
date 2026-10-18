// The per-agent publisher lease (07 §3.2 `publisher_lease`; 06 §6 "One active publisher per agent";
// D-73; M1-7k-b). Several harness MCP processes share one agent store; the holder of this lease is
// the one that keeps the relay subscriptions, runs the start-up look-back and the background loop
// (M1-9r). CLI commands never take it: opening a client takes nothing.
//
// - Take: in one store transaction, insert the row (holder, lease_until = now + 60), renew it when
//   this process already holds it, or replace a lapsed row with a compare-and-set on the old holder
//   and the old lease_until. A take that changes no row means another process holds the lease; try
//   again 20 s later.
// - Renew: every 20 s, lease_until = now + 60 with a compare-and-set on holder = this process. A
//   renewal that changes no row means the lease was lost: stop the subscriptions and the loop first.
// - Release: on clean shutdown, delete the row with a compare-and-set on holder = this process.
// - On failure (07 §3.2): a lease that cannot be read or written counts as not held. Nothing here
//   throws; a store or clock error returns false and drops this process's view of the lease.
//
// Lapsed: lease_until ≤ now, or lease_until > now + 120 (two lease periods). No holder writes more
// than now + 60, so the second can only come from a clock that has since gone back by more than 60 s;
// treating it as lapsed means a holder that crashed just before a backward jump cannot keep the lease
// for the length of the jump: after a crash the lease lapses within 120 s whatever the jump (a lease
// never holds forever after a crash). A smaller step back (an NTP correction) changes nothing.
//
// Clock jumps. Every process of one agent runs on one machine and reads the same clock (the store is
// a local file, 06 §6). `held` checks this process's own lease_until against that clock both ways
// (now < lease_until ≤ now + 120), so right after a jump that lets another process take the lease the
// old holder no longer counts itself as holder. The bound: after a jump back by more than 60 s and
// then forward again, the old holder can believe it holds the lease while another process took it in
// between, until its next renewal, which changes no row: at most one renewal interval (20 s). Without clock jumps a process that believes it holds the lease is the row's
// holder. The lease is not authority (07 §3.2): every effect is idempotent and claimed per row, so
// two holders at once cost relay connections, never a second effect.
//
// The holder ID is random, not a secret; it is still never logged (I-7: nothing here logs).
import { encodeBase64url, randomBytes } from '@4thtech-io/crypto';
import { PUBLISHER_LEASE_RENEW_SECONDS, PUBLISHER_LEASE_SECONDS } from './constants.js';
import type { Store } from './store/store.js';

export { PUBLISHER_LEASE_RENEW_SECONDS, PUBLISHER_LEASE_SECONDS };

/** The only lease name in M1 (07 §3.2). */
export const SUBSCRIPTIONS_LEASE = 'subscriptions' as const;

/** 07 §3.2: holder is 16 random bytes, base64url. */
const HOLDER_BYTES = 16;
/** A lease_until further ahead than this is from a clock that went back: lapsed (see above). */
const FUTURE_LIMIT_SECONDS = 2 * PUBLISHER_LEASE_SECONDS;

export interface PublisherLeaseOptions {
  readonly store: Store;
  /** Unix seconds (the client's clock). */
  readonly now: () => number;
}

/** One process's handle on the agent's publisher lease, with its own random holder ID. */
export class PublisherLease {
  /** This process's holder ID: 16 random bytes, base64url, chosen once per handle. */
  readonly holder: string;
  readonly #store: Store;
  readonly #now: () => number;
  /** The lease_until this process last wrote and committed, or undefined when it does not hold. */
  #until: number | undefined;

  constructor(options: PublisherLeaseOptions) {
    this.#store = options.store;
    this.#now = options.now;
    this.holder = encodeBase64url(randomBytes(HOLDER_BYTES));
  }

  /**
   * True while this process's last committed lease is valid on the current clock (now < lease_until
   * ≤ now + 120). Use it before acting as the holder; see the clock-jump bound above.
   */
  get held(): boolean {
    const until = this.#until;
    if (until === undefined) return false;
    let now: number;
    try {
      now = this.#clock();
    } catch {
      return false;
    }
    return now < until && until <= now + FUTURE_LIMIT_SECONDS;
  }

  /** Takes the lease, or renews it when this process holds it. False: another process holds it. */
  async take(): Promise<boolean> {
    return this.#write((now, until) =>
      this.#store.transaction((tx) => {
        const row = tx.get('publisher_lease', { name: SUBSCRIPTIONS_LEASE });
        if (row === undefined) {
          tx.insert('publisher_lease', {
            name: SUBSCRIPTIONS_LEASE,
            holder: this.holder,
            lease_until: until,
          });
          return true;
        }
        if (row.holder === this.holder) {
          return (
            tx.update(
              'publisher_lease',
              { name: SUBSCRIPTIONS_LEASE, holder: this.holder },
              { lease_until: until },
            ) === 1
          );
        }
        const lapsed = row.lease_until <= now || row.lease_until > now + FUTURE_LIMIT_SECONDS;
        if (!lapsed) return false;
        return (
          tx.update(
            'publisher_lease',
            { name: SUBSCRIPTIONS_LEASE, holder: row.holder, lease_until: row.lease_until },
            { holder: this.holder, lease_until: until },
          ) === 1
        );
      }),
    );
  }

  /** Renews the lease (every 20 s). False: this process does not hold it (any more). */
  async renew(): Promise<boolean> {
    return this.#write((_now, until) =>
      this.#store.transaction(
        (tx) =>
          tx.update(
            'publisher_lease',
            { name: SUBSCRIPTIONS_LEASE, holder: this.holder },
            { lease_until: until },
          ) === 1,
      ),
    );
  }

  /** Releases the lease on clean shutdown. False: this process did not hold it, or the store failed. */
  async release(): Promise<boolean> {
    this.#until = undefined;
    try {
      return await this.#store.transaction(
        (tx) =>
          tx.delete('publisher_lease', { name: SUBSCRIPTIONS_LEASE, holder: this.holder }) === 1,
      );
    } catch {
      return false;
    }
  }

  /** Runs one compare-and-set write; records the new lease_until only when it changed a row. */
  async #write(body: (now: number, until: number) => Promise<boolean>): Promise<boolean> {
    try {
      const now = this.#clock();
      const until = now + PUBLISHER_LEASE_SECONDS;
      const ok = await body(now, until);
      this.#until = ok ? until : undefined;
      return ok;
    } catch {
      this.#until = undefined; // on failure the lease counts as not held (07 §3.2)
      return false;
    }
  }

  #clock(): number {
    const t = this.#now();
    if (!Number.isSafeInteger(t) || t < 0 || t > Number.MAX_SAFE_INTEGER - FUTURE_LIMIT_SECONDS) {
      throw new Error('clock');
    }
    return t;
  }
}
