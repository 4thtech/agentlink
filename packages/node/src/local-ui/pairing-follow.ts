// U3-invite-b: the app host follows a pairing it started to "Connected" when no AI app runs the
// agent (06 §6 "One active publisher per agent", 07 §3.2 `publisher_lease`; 08 §4 "One step from
// an invite link"; proposed, owner confirms at merge).
//
// After an accept in the app, the pairing completes only when someone fetches and processes the
// inviter's `handshake-ack` (06 §6). That is normally the AI app's `agentlink mcp` server, the
// publisher-lease holder. On a computer where no AI app runs this agent yet, nothing would, so the
// join screen would wait for ever. While that screen waits, its read calls `follow()`:
//
// - The lease protocol decides, never a guess from the row: `take()` is core's compare-and-set
//   (insert when there is no row, replace only a lapsed one). It fails while any MCP server holds
//   the lease, and then the host does nothing: no fetch, no processing, no publish. So there are
//   never two publishers at once (beyond the core's clock-jump bound, 07 §3.2).
// - With the lease, one short pass: `syncInbox` with a small fetch budget (fetch, store, process:
//   the handshake-ack), then `outbox.processDue` (due rows, each under its per-row claim). No relay
//   subscription, no renewal, no loop of its own: the lease is released right after, so an MCP server
//   that starts takes it at its next 20 s try.
// - At most one pass at a time and one per `minIntervalMs` (5 s), only while the screen polls.
// - Never throws and logs nothing: a failed pass only means the screen keeps waiting (I-5, I-7: no
//   error text, relay URL or holder ID leaves here).

/** The core calls one pass needs (`AgentLinkClient` fits). */
export interface PairingFollowClient {
  publisherLease(): { take(): Promise<boolean>; release(): Promise<boolean> };
  syncInbox(options?: { readonly budgetMs?: number }): Promise<unknown>;
  readonly outbox: { processDue(): Promise<unknown> };
}

/** `ran`: one pass under the lease; `held`: another process holds it; `busy` / `soon`: skipped. */
export type PairingFollowResult = 'ran' | 'held' | 'busy' | 'soon';

export interface PairingFollowOptions {
  /** The clock in milliseconds. */
  readonly nowMs: () => number;
  /** The shortest time between two passes (default 5 s). */
  readonly minIntervalMs?: number;
  /** The fetch budget of one pass (default 3 s, the tools' catch-up budget). */
  readonly budgetMs?: number;
}

export interface PairingFollower {
  follow(): Promise<PairingFollowResult>;
}

export const PAIRING_FOLLOW_INTERVAL_MS = 5_000;
export const PAIRING_FOLLOW_BUDGET_MS = 3_000;

/** A follower for one open agent (a fresh one per agent the host opens). */
export function pairingFollower(
  client: PairingFollowClient,
  options: PairingFollowOptions,
): PairingFollower {
  const minInterval = options.minIntervalMs ?? PAIRING_FOLLOW_INTERVAL_MS;
  const budgetMs = options.budgetMs ?? PAIRING_FOLLOW_BUDGET_MS;
  let inFlight = false;
  let lastAt = Number.NEGATIVE_INFINITY;
  return Object.freeze<PairingFollower>({
    async follow() {
      if (inFlight) return 'busy';
      const now = options.nowMs();
      if (now - lastAt < minInterval) return 'soon';
      inFlight = true;
      lastAt = now;
      try {
        let lease: ReturnType<PairingFollowClient['publisherLease']>;
        try {
          lease = client.publisherLease();
          // An MCP server (or another host) holds it: it runs the pass; the host does nothing.
          if (!(await lease.take())) return 'held';
        } catch {
          return 'held';
        }
        try {
          await client.syncInbox({ budgetMs });
          await client.outbox.processDue();
        } catch {
          // The screen keeps waiting; the next poll tries again.
        } finally {
          await lease.release().catch(() => false);
        }
        return 'ran';
      } finally {
        inFlight = false;
      }
    },
  });
}
