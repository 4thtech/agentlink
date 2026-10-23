// Rate counters and aggregate metrics of the submitter (07 §7; 04 §7 gas griefing; M1-10a). One
// class, several kinds of instance, each named by the Worker:
//   `i:<HMAC of the IP bucket>`        items per IP (IPv6 /64) per hour, every item counted (FA-3);
//                                      `r:`, `f:` and `g:<HMAC>` count reads, faucet and top-up
//                                      requests per IP the same way;
//   `s:<chainId>:<signer address>`     new items per signer per hour (items already on-chain are not
//                                      counted: anyone can replay a signer's public items);
//   `d:<chainId>:<agent address>`      gasless top-ups sent per agent per hour (M3-4b-t-3; only
//                                      authorizations that passed the relay checks count);
//   `metrics`                          the aggregate counters, a fixed set of names.
// No raw IP, signature or record is stored, and an IP is never stored next to a signer or agent. Counter
// instances delete their own storage after their window (alarm).
import { DurableObject } from 'cloudflare:workers';

/** The aggregate counters: a fixed set of names, never an ID, address, signature or IP (07 §7). */
export const METRICS = [
  'request_notarize',
  'request_receipt',
  'request_status',
  'request_health',
  'request_faucet',
  'faucet_credited',
  'faucet_paused',
  'request_deposit_auth',
  'deposit_auth_submitted',
  'deposit_auth_refused',
  'item_submitted',
  'item_held',
  'item_skipped',
  'item_failed',
  'rate_limited',
  'bad_request',
  'unavailable',
  'internal_error',
] as const;
export type Metric = (typeof METRICS)[number];

export interface TakeResult {
  readonly ok: boolean;
  /** Seconds until the window resets (when refused). */
  readonly retryAfter: number;
}

/** [window index, count] of a fixed-window counter. */
type Window = [number, number];

export class SubmitterLimits extends DurableObject {
  /**
   * Adds `count` to this instance's window of `windowSeconds` if the total stays within `limit`;
   * otherwise refuses and adds nothing.
   */
  async take(
    count: number,
    limit: number,
    windowSeconds: number,
    now: number,
  ): Promise<TakeResult> {
    const index = Math.floor(now / windowSeconds);
    const stored = await this.ctx.storage.get<Window>('w');
    const used = stored && stored[0] === index ? stored[1] : 0;
    const retryAfter = (index + 1) * windowSeconds - now;
    if (used + count > limit) return { ok: false, retryAfter: Math.max(1, retryAfter) };
    await this.ctx.storage.put('w', [index, used + count] satisfies Window);
    // Forget the counter once its window is over.
    await this.ctx.storage.setAlarm(((index + 1) * windowSeconds + 60) * 1000);
    return { ok: true, retryAfter: 0 };
  }

  /** Adds to the aggregate counters (the `metrics` instance only). */
  async bump(counts: Partial<Record<Metric, number>>): Promise<void> {
    const current = (await this.ctx.storage.get<Record<string, number>>('m')) ?? {};
    for (const name of METRICS) {
      const n = counts[name];
      if (typeof n === 'number' && Number.isSafeInteger(n) && n > 0) {
        current[name] = (current[name] ?? 0) + n;
      }
    }
    await this.ctx.storage.put('m', current);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
