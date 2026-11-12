// REL051-CF2 (R1-CLASS-02): the local app's network health source (08 §1; 07 §4.2, §4.3; I-7).
//
// The status bar and Advanced › Relays & network used to say "Connected" / "Working" with no relay
// evidence at all: nothing supplied the health read's relay counts. Relay passes for an agent run in
// whichever process holds its publisher lease (usually the AI app's `agentlink mcp`), so the app
// process cannot read another process's connections. Instead it checks for itself, from this
// computer: the open agent's core client connects (or reuses a pooled connection) to each of the
// agent's own relays and counts the ones that are open (core `relayReachability`). This is exactly
// the question the owner needs answered ("can this computer reach the message network?"), e.g. on a
// school network that blocks WebSockets.
//
// - Lazy and bounded: a check starts only when the health read asks (an app page is open and
//   visible), at most once per NETWORK_CHECK_MS, never two at once. A check against a relay that
//   never answers takes up to the pool's 10 s connect bound, so the source never waits for it
//   beyond NETWORK_FIRST_WAIT_MS: it answers the last result (or no counts) and the next read gets
//   the new one. Recovery is automatic: the next check reconnects.
// - `lastSyncAt` is the last time a check found at least one relay connected (unix seconds): what
//   "Last checked" shows, frozen while the network cannot be reached. It is not a message sync.
// - Until the first check has finished the answer says `checking` (the app shows "Checking the
//   connection…"), never a bare running that would read as Connected.
// - Counts only: the client answers numbers, and a failed check (or a paused agent, or no own list)
//   answers no counts. No relay address, reason or error text ever leaves here.
// - `agent` stays `running` (the agent is open in the process that answers), as before.
import type { LocalUiHealthSnapshot } from './api/health.js';

/** A check starts at most this often (the app's health read runs every 5 s while visible). */
export const NETWORK_CHECK_MS = 5_000;
/** How long one health read waits for a check it started before answering the last result. */
export const NETWORK_FIRST_WAIT_MS = 400;

/** The core call the source needs (`AgentLinkClient` fits). */
export interface NetworkHealthClient {
  relayReachability(): Promise<{ readonly connected: number; readonly total: number } | undefined>;
}

export interface NetworkHealthOptions {
  /** The clock in milliseconds. */
  readonly now: () => number;
}

type Counts = { readonly connected: number; readonly total: number };

const isCounts = (value: unknown): value is Counts => {
  if (typeof value !== 'object' || value === null) return false;
  const { connected, total } = value as { connected?: unknown; total?: unknown };
  return (
    Number.isInteger(connected) &&
    Number.isInteger(total) &&
    (connected as number) >= 0 &&
    (connected as number) <= (total as number)
  );
};

/** A health source for the open agent's local app (LocalUiOptions.health). Never rejects. */
export function networkHealthSource(
  client: NetworkHealthClient,
  options: NetworkHealthOptions,
): () => Promise<LocalUiHealthSnapshot> {
  let counts: Counts | undefined;
  let lastOkAt: number | undefined;
  let startedAt: number | undefined;
  let inFlight: Promise<void> | undefined;
  let checked = false;

  const check = (): Promise<void> => {
    startedAt = options.now();
    const run = (async () => {
      let answer: unknown;
      try {
        answer = await client.relayReachability();
      } catch {
        answer = undefined; // fixed: the error (and its text) is never kept or passed on
      }
      counts = isCounts(answer) ? { connected: answer.connected, total: answer.total } : undefined;
      if (counts !== undefined && counts.connected > 0) {
        lastOkAt = Math.floor(options.now() / 1000);
      }
      checked = true;
    })().finally(() => {
      inFlight = undefined;
    });
    inFlight = run;
    return run;
  };

  const snapshot = (): LocalUiHealthSnapshot => ({
    agent: 'running',
    ...(checked ? {} : { checking: true }),
    ...(counts === undefined ? {} : { relays: counts }),
    ...(lastOkAt === undefined ? {} : { lastSyncAt: lastOkAt }),
  });

  return async () => {
    const now = options.now();
    const due = startedAt === undefined || now - startedAt >= NETWORK_CHECK_MS || now < startedAt;
    if (inFlight === undefined && due) {
      const started = check();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        started,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, NETWORK_FIRST_WAIT_MS);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    }
    return snapshot();
  };
}
