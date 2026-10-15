// The MCP server's background loop (06 §6; 07 §3.2 `publisher_lease`, §4.2; D-71 (3), D-73; M1-9r).
//
// While `agentlink mcp` runs, one server process per agent keeps receiving and delivering without a
// tool call, so a pairing completes, acks and card updates are applied, and queued wraps are retried
// while the harness is open.
//
// - Publisher lease (M1-7k-b, reused from core). Every 20 s the server takes the agent's lease, or
//   renews it while it holds it. Only the holder runs the passes below. A server that does not hold
//   it stays idle and tries again 20 s later; its tools still answer, and `agentlink_inbox` and
//   `agentlink_status` still run their own short catch-up (06 §2.0). A renewal that changes no row
//   means the lease was lost: no further pass starts (one in flight finishes; every effect is
//   idempotent and claimed per row, so a doubled holder costs relay connections, never a second
//   effect). CLI commands never create a loop, so they never take the lease.
// - Pass (holder only): `syncInbox` (fetch with the 48 h look-back from the relay cursor, which on
//   the first pass is the start-up look-back; dedup by gift-wrap ID, then by envelopeHash; store;
//   then process the stored envelopes: handshake completion and `handshake-ack`, card updates, held
//   rows, acks), then `outbox.processDue` (staged pairing messages get their rows; due rows are
//   published, each under its per-row claim, M1-7k). Then the next pass after `syncIntervalMs`, or
//   sooner when the fetch did not finish (budget, a relay down): 1 s after the first partial pass,
//   doubling with each consecutive partial one up to `syncIntervalMs`, reset by a full pass. So an
//   offline machine or a dead relay set costs at most one pass per `syncIntervalMs` once backed off.
// - Relay "subscriptions". The core's Transport has no live `subscribe` yet (packages/core
//   transport.ts: "`subscribe` joins later"; S2), so the holder reads its relays with a repeated
//   catch-up pass. Swapping in a live subscription changes only `#pass`.
// - Notifications (optional, 06 §6). `attachInboxResource` serves `agentlink://inbox` (counts only)
//   and sends `notifications/resources/updated` after a pass that stored or processed something,
//   only to a client that subscribed. Nothing depends on it: the tools work without it.
// - Shutdown. `stop()` clears the timers, waits for a lease step or pass in flight, then releases the
//   lease, so another server takes over at its next try. Call it before the agent's store closes.
//
// I-5, I-7: nothing from an inbound envelope reaches a log line or an error here. A failed pass logs
// a fixed message and, at most, a fixed lower-case error code; never an error message, a relay URL,
// the holder ID or any content. No timer callback can reject: every step catches.
import { PUBLISHER_LEASE_RENEW_SECONDS } from '@agentlink/core';
import type { Logger } from '@agentlink/log';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';

/** The resource a harness can subscribe to for inbox changes (06 §6). */
export const INBOX_RESOURCE_URI = 'agentlink://inbox';

/** Lease take or renew interval: 20 s (07 §3.2). */
export const LEASE_INTERVAL_MS = PUBLISHER_LEASE_RENEW_SECONDS * 1000;
/** Time between two passes while this process holds the lease. */
export const SYNC_INTERVAL_MS = 30_000;
/** Fetch budget of one loop pass (the tools' catch-up uses 3 s; the loop may take longer). */
export const PASS_BUDGET_MS = 10_000;
/**
 * The first pass after a partial one (budget, a relay down) follows this soon; the delay doubles
 * with each further consecutive partial pass, capped at the sync interval.
 */
export const PARTIAL_RETRY_MS = 1_000;

/** The publisher lease as the loop uses it (core `PublisherLease`). */
export interface LoopLease {
  readonly held: boolean;
  take(): Promise<boolean>;
  renew(): Promise<boolean>;
  release(): Promise<boolean>;
}

/** The part of the core client the loop drives (`AgentLinkClient` fits). */
export interface LoopClient {
  publisherLease(): LoopLease;
  syncInbox(options?: { readonly budgetMs?: number }): Promise<{
    readonly partial: boolean;
    readonly stored: number;
    readonly reports: readonly unknown[];
  }>;
  readonly outbox: { processDue(): Promise<unknown> };
}

/** One-shot timers. Tests pass a manual scheduler; production uses unref'd `setTimeout`. */
export interface LoopTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface BackgroundLoopOptions {
  readonly client: LoopClient;
  readonly logger: Logger;
  /** Called after a pass that stored or processed envelopes (the inbox resource's notification). */
  readonly onInboxChanged?: () => void;
  readonly timers?: LoopTimers;
  readonly leaseIntervalMs?: number;
  readonly syncIntervalMs?: number;
  readonly passBudgetMs?: number;
}

const nodeTimers: LoopTimers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref(); // the loop never keeps the process alive on its own
    return handle;
  },
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** A fixed code from a core or transport error, or nothing (never the message: I-5, I-7). */
function errorCode(error: unknown): { reason?: string } {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && CODE.test(code)) return { reason: code };
  }
  return {};
}

type State = 'new' | 'running' | 'stopped';

export class BackgroundLoop {
  readonly #client: LoopClient;
  readonly #log: Logger;
  readonly #timers: LoopTimers;
  readonly #lease: LoopLease;
  readonly #onInboxChanged: (() => void) | undefined;
  readonly #leaseMs: number;
  readonly #syncMs: number;
  readonly #budgetMs: number;
  #state: State = 'new';
  /** True from a successful take until a renewal fails or the loop stops. */
  #holding = false;
  #leaseTimer: unknown;
  #passTimer: unknown;
  #leaseStep: Promise<void> | undefined;
  #passRun: Promise<void> | undefined;
  /** Consecutive partial passes, for the retry backoff. */
  #partials = 0;

  constructor(options: BackgroundLoopOptions) {
    this.#client = options.client;
    this.#log = options.logger;
    this.#timers = options.timers ?? nodeTimers;
    this.#onInboxChanged = options.onInboxChanged;
    this.#leaseMs = options.leaseIntervalMs ?? LEASE_INTERVAL_MS;
    this.#syncMs = options.syncIntervalMs ?? SYNC_INTERVAL_MS;
    this.#budgetMs = options.passBudgetMs ?? PASS_BUDGET_MS;
    // A handle with its own random holder ID; creating it writes nothing.
    this.#lease = this.#client.publisherLease();
  }

  /** True while this process holds the publisher lease and runs the passes. */
  get holding(): boolean {
    return this.#state === 'running' && this.#holding && this.#lease.held;
  }

  /** True while a pass runs (tests wait on it). */
  get busy(): boolean {
    return this.#passRun !== undefined || this.#leaseStep !== undefined;
  }

  /** Starts the lease timer: the first take is now. Idempotent. */
  start(): void {
    if (this.#state !== 'new') return;
    this.#state = 'running';
    this.#scheduleLease(0);
  }

  /**
   * One lease step: take the lease, or renew it while held. Runs on the lease timer; tests may call
   * it directly. Never rejects.
   */
  async leaseStep(): Promise<void> {
    if (this.#state !== 'running') return;
    if (this.#leaseStep !== undefined) return this.#leaseStep;
    const step = this.#runLeaseStep();
    this.#leaseStep = step;
    try {
      await step;
    } finally {
      this.#leaseStep = undefined;
    }
  }

  async #runLeaseStep(): Promise<void> {
    let ok: boolean;
    try {
      ok = this.#holding ? await this.#lease.renew() : await this.#lease.take();
    } catch {
      ok = false; // a lease that cannot be read or written counts as not held (07 §3.2)
    }
    if (this.#state !== 'running') return; // stop() releases it
    if (ok && !this.#holding) {
      this.#holding = true;
      this.#log.info('background loop active');
      this.#schedulePass(0); // the start-up pass: the 48 h look-back
    } else if (!ok && this.#holding) {
      // Lost: stop the passes before anything else (07 §3.2 "Renew").
      this.#holding = false;
      this.#clearPassTimer();
      this.#log.info('background loop idle');
    }
  }

  /**
   * One pass, only while holding: fetch, store and process, then deliver due outbox rows. Runs on
   * the pass timer; tests may call it directly. Never rejects. Returns whether the fetch was partial.
   */
  async pass(): Promise<boolean> {
    if (!this.holding) return false;
    if (this.#passRun !== undefined) {
      await this.#passRun;
      return false;
    }
    let partial = false;
    const run = (async () => {
      partial = await this.#pass();
    })();
    this.#passRun = run;
    try {
      await run;
    } finally {
      this.#passRun = undefined;
    }
    return partial;
  }

  async #pass(): Promise<boolean> {
    let partial = false;
    try {
      const result = await this.#client.syncInbox({ budgetMs: this.#budgetMs });
      partial = result.partial;
      if (result.stored > 0 || result.reports.length > 0) this.#notify();
    } catch (error) {
      this.#log.warn('background sync failed', errorCode(error));
    }
    if (!this.holding) return false; // lost during the fetch: deliver nothing more
    try {
      await this.#client.outbox.processDue();
    } catch (error) {
      this.#log.warn('background delivery failed', errorCode(error));
    }
    return partial;
  }

  #notify(): void {
    if (this.#onInboxChanged === undefined) return;
    try {
      this.#onInboxChanged();
    } catch {
      // optional (06 §6): a notification failure changes nothing
    }
  }

  /**
   * Stops the loop: no new step or pass, waits for one in flight, then releases the lease (07 §3.2
   * "Release"). Never rejects. Call it before the store closes.
   */
  async stop(): Promise<void> {
    if (this.#state === 'stopped') return;
    const wasRunning = this.#state === 'running';
    this.#state = 'stopped';
    this.#holding = false;
    if (this.#leaseTimer !== undefined) this.#timers.clear(this.#leaseTimer);
    this.#leaseTimer = undefined;
    this.#clearPassTimer();
    await Promise.allSettled([this.#leaseStep, this.#passRun]);
    if (!wasRunning) return;
    // Compare-and-set on this process's holder ID: a no-op when it does not hold the lease.
    try {
      await this.#lease.release();
    } catch {
      // release() does not throw; a lease left behind lapses within 60 s
    }
  }

  #scheduleLease(ms: number): void {
    if (this.#state !== 'running') return;
    this.#leaseTimer = this.#timers.set(() => {
      this.#leaseTimer = undefined;
      void this.leaseStep().finally(() => {
        this.#scheduleLease(this.#leaseMs);
      });
    }, ms);
  }

  #schedulePass(ms: number): void {
    // One chain only: a pass in flight schedules the next one itself when it ends.
    if (!this.holding || this.#passTimer !== undefined || this.#passRun !== undefined) return;
    this.#passTimer = this.#timers.set(() => {
      this.#passTimer = undefined;
      void this.pass().then((partial) => {
        this.#partials = partial ? this.#partials + 1 : 0;
        this.#schedulePass(this.#nextDelay());
      });
    }, ms);
  }

  /** The delay before the next pass: the sync interval, or the partial-pass backoff. */
  #nextDelay(): number {
    if (this.#partials === 0) return this.#syncMs;
    const exponent = Math.min(this.#partials - 1, 30);
    return Math.min(PARTIAL_RETRY_MS * 2 ** exponent, this.#syncMs);
  }

  #clearPassTimer(): void {
    if (this.#passTimer !== undefined) this.#timers.clear(this.#passTimer);
    this.#passTimer = undefined;
  }
}

/** What `agentlink://inbox` reads: counts only, never content or names (06 §2.1). */
export interface InboxCountsSource {
  counts(): Promise<{
    readonly inbox: readonly { readonly unread: number }[];
    readonly requests: number;
  }>;
}

/**
 * Serves `agentlink://inbox` on `server` (before it connects) and returns the notifier the loop
 * calls: `notifications/resources/updated` goes out only after the client subscribed (06 §6,
 * optional). Reading it returns `{ unread, requests }` counts; the messages come from
 * `agentlink_inbox`, wrapped (06 §4).
 */
export function attachInboxResource(server: Server, source: InboxCountsSource): () => void {
  let subscribed = false;
  server.registerCapabilities({ resources: { subscribe: true, listChanged: false } });
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      {
        uri: INBOX_RESOURCE_URI,
        name: 'inbox',
        title: 'AgentLink inbox',
        description: 'Unread message and request counts. Read messages with agentlink_inbox.',
        mimeType: 'application/json',
      },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== INBOX_RESOURCE_URI) throw new Error('Unknown resource.');
    const counts = await source.counts();
    const unread = counts.inbox.reduce((n, c) => n + c.unread, 0);
    const result: ReadResourceResult = {
      contents: [
        {
          uri: INBOX_RESOURCE_URI,
          mimeType: 'application/json',
          text: JSON.stringify({ unread, requests: counts.requests }),
        },
      ],
    };
    return result;
  });
  server.setRequestHandler(SubscribeRequestSchema, (request) => {
    if (request.params.uri === INBOX_RESOURCE_URI) subscribed = true;
    return {};
  });
  server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
    if (request.params.uri === INBOX_RESOURCE_URI) subscribed = false;
    return {};
  });
  return () => {
    if (!subscribed) return;
    server.sendResourceUpdated({ uri: INBOX_RESOURCE_URI }).catch(() => undefined);
  };
}
