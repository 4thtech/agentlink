// U3-invite-b: the app host's short passes for the open agent while no AI app runs it (06 §6 "One
// active publisher per agent", 07 §3.2 `publisher_lease`; 08 §1, §4; orchestrator Decision 37;
// proposed, owner confirms at merge).
//
// Pairings complete, and messages arrive, only when some process fetches and processes for the
// agent: normally the AI app's `agentlink mcp` server, the publisher-lease holder. On a computer
// where no AI app runs the agent, nothing would, so the app would wait for ever. While the app is
// open, the host runs passes for the OPEN agent only:
//
// - Triggers: (a) the join screen's read while it waits for the inviter's answer (`follow`, at most
//   once per 5 s); (b) while any pairing is pending on either side (a sent invite not used yet, an
//   accept waiting for its ack: core `pairing.waiting()`), at most once per 5 s; (c) otherwise at
//   most once per 15 s while an app page is visible (`tick`, called after the page's reads; the
//   status bar reads every 5 s and stops while the tab is hidden).
// - The lease protocol decides, never a guess from the row: `take()` is core's compare-and-set
//   (insert when there is no row, replace only a lapsed one). It fails while any MCP server holds the
//   lease, and then the host does nothing: no fetch, no processing, no publish. So an MCP server
//   always wins and there are never two publishers at once (beyond core's clock-jump bound, 07 §3.2).
// - With the lease, one short pass: `syncInbox` with a 3 s fetch budget (fetch, store, process:
//   handshakes, acks, messages), then `outbox.processDue` (due rows, each under its per-row claim).
//   No relay subscription, no renewal, no loop of its own: the lease is released right after, so an
//   MCP server that starts takes it at its next 20 s try.
// - REL051-CF1 (R1-CLASS-10): on a slow network (each relay frame seconds late) a 3 s budget can end
//   before the first answer arrives, on every pass, so the accepter never sees the inviter's ack.
//   A pass whose fetch ended partial (`partial`: a relay did not finish) doubles the next pass's
//   budget, up to PAIRING_FOLLOW_MAX_BUDGET_MS (12 s, well inside the 20 s an MCP server waits for
//   the lease); a pass that finished, or failed, goes back to the base budget.
// - Passes never overlap: one at a time per follower (and one follower per open agent).
// - `passing` is true during a pass, so the app shows the agent as its own, not as "Running" in an
//   AI app, while the host briefly holds the lease row.
// - W4-PAUSE (D-143 (5); 06 §6 "Paused agents"; 08 §1 "What stops"): a paused agent gets no pass:
//   the pause row is read first, before the lease is taken, and a row that cannot be read counts as
//   paused (fail closed). The answer is `paused`; nothing is fetched, processed or published.
// - Never throws and logs nothing: a failed pass only means the next one tries again (I-5, I-7: no
//   error text, relay URL or holder ID leaves here).

/** The core calls a pass needs (`AgentLinkClient` fits). */
export interface PairingFollowClient {
  publisherLease(): { take(): Promise<boolean>; release(): Promise<boolean> };
  /** REL051-CF1: `partial` (core's FetchSummary) lengthens the next pass on a slow network. */
  syncInbox(options?: { readonly budgetMs?: number }): Promise<unknown>;
  readonly outbox: {
    processDue(): Promise<unknown>;
    /** OUTBOX-NOW-1: rows waiting out a retry backoff go now, then one delivery pass. */
    retryNow?(): Promise<unknown>;
  };
  readonly pairing: {
    waiting(): Promise<boolean>;
    /** W4-SHORT-INVITE (04 §3.6.2): deletes drop objects of completed, cancelled or expired invites. */
    sweepInviteObjects?(): Promise<void>;
  };
  /** W4-PAUSE: whether the owner paused the agent (core `paused`). Absent: never paused. */
  paused?(): Promise<boolean>;
}

/**
 * `ran`: one pass under the lease; `held`: another process holds it; `busy` / `soon`: skipped;
 * `paused` (W4-PAUSE): the owner paused the agent, so nothing ran.
 */
export type PairingFollowResult = 'ran' | 'held' | 'busy' | 'soon' | 'paused';

export interface PairingFollowOptions {
  /** The clock in milliseconds. */
  readonly nowMs: () => number;
  /** The fetch budget of one pass (default 3 s, the tools' catch-up budget). */
  readonly budgetMs?: number;
}

export interface PairingFollower {
  /** (a) The join screen waits for the inviter's answer: a pass at most once per 5 s. */
  follow(): Promise<PairingFollowResult>;
  /** (b) and (c): after a page read; every 5 s while a pairing is pending, else every 15 s. */
  tick(): Promise<PairingFollowResult>;
  /** UX-LEFT-1: one pass now, at once (the relays are back), without the interval wait. */
  flush(): Promise<PairingFollowResult>;
  /** True while a host pass holds the lease. */
  readonly passing: boolean;
}

/** (a) and (b): a pending pairing is followed at most this often. */
export const PAIRING_FOLLOW_INTERVAL_MS = 5_000;
/** (c): with nothing pending, a visible app runs a pass at most this often. */
export const VISIBLE_PASS_INTERVAL_MS = 15_000;
export const PAIRING_FOLLOW_BUDGET_MS = 3_000;
/** REL051-CF1 (R1-CLASS-10): the longest budget a pass grows to after partial fetches. */
export const PAIRING_FOLLOW_MAX_BUDGET_MS = 12_000;

/** True when a sync answer says a relay did not finish (core `FetchSummary.partial`). */
const partialOf = (result: unknown): boolean =>
  typeof result === 'object' &&
  result !== null &&
  (result as { readonly partial?: unknown }).partial === true;

/** A follower for one open agent (a fresh one per agent the host opens). */
export function pairingFollower(
  client: PairingFollowClient,
  options: PairingFollowOptions,
): PairingFollower {
  const baseBudgetMs = options.budgetMs ?? PAIRING_FOLLOW_BUDGET_MS;
  const maxBudgetMs = Math.max(baseBudgetMs, PAIRING_FOLLOW_MAX_BUDGET_MS);
  let budgetMs = baseBudgetMs;
  let inFlight = false;
  let passing = false;
  let lastAt = Number.NEGATIVE_INFINITY;

  const pending = async (): Promise<boolean> => {
    try {
      return await client.pairing.waiting();
    } catch {
      return false;
    }
  };

  /** One pass, when no other process holds the lease. Callers set `inFlight` and `lastAt`. */
  const pass = async (now = false): Promise<PairingFollowResult> => {
    let lease: ReturnType<PairingFollowClient['publisherLease']>;
    try {
      lease = client.publisherLease();
      // An MCP server (or another host) holds it: it does the work; the host does nothing.
      if (!(await lease.take())) return 'held';
    } catch {
      return 'held';
    }
    passing = true;
    try {
      let partial = false;
      try {
        partial = partialOf(await client.syncInbox({ budgetMs }));
      } finally {
        // R1-CLASS-10: a partial fetch gets a longer next pass; anything else the base budget.
        budgetMs = partial ? Math.min(budgetMs * 2, maxBudgetMs) : baseBudgetMs;
      }
      // OUTBOX-NOW-1: after a reconnect (flush), queued rows skip the rest of their backoff.
      const retryNow = now ? client.outbox.retryNow : undefined;
      await (retryNow === undefined ? client.outbox.processDue() : retryNow.call(client.outbox));
      // W4-SHORT-INVITE (O-L3): the drop-object sweep runs in the background, never holding the
      // pass or the lease (core dedupes a sweep in flight). A failed DELETE is retried with backoff
      // on a later pass; nothing is logged (I-7).
      try {
        client.pairing.sweepInviteObjects?.().catch(() => undefined);
      } catch {
        // A sweep that throws synchronously is the same as one that failed.
      }
    } catch {
      // The next pass tries again.
    } finally {
      await lease.release().catch(() => false);
      passing = false;
    }
    return 'ran';
  };

  /** W4-PAUSE: fail closed; a client without the read is never paused. */
  const paused = async (): Promise<boolean> => {
    if (client.paused === undefined) return false;
    try {
      return await client.paused();
    } catch {
      return true;
    }
  };

  const run = async (due: () => Promise<boolean>, now = false): Promise<PairingFollowResult> => {
    if (inFlight) return 'busy';
    inFlight = true;
    try {
      if (await paused()) return 'paused';
      if (!(await due())) return 'soon';
      lastAt = options.nowMs();
      return await pass(now);
    } finally {
      inFlight = false;
    }
  };

  const since = (): number => options.nowMs() - lastAt;

  return Object.freeze<PairingFollower>({
    follow: () => run(() => Promise.resolve(since() >= PAIRING_FOLLOW_INTERVAL_MS)),
    flush: () => run(() => Promise.resolve(true), true),
    tick: () =>
      run(async () => {
        const elapsed = since();
        if (elapsed < PAIRING_FOLLOW_INTERVAL_MS) return false;
        if (elapsed >= VISIBLE_PASS_INTERVAL_MS) return true;
        return pending();
      }),
    get passing() {
      return passing;
    },
  });
}
