// W4-LIVE-STATUS (D-143; 06 §6 "MCP session heartbeat"): the `agentlink mcp` side of the heartbeat.
//
// - Start: when the server answers `initialize` (the client's `initialized` notification; a tool call
//   that comes first starts it too), the client's `clientInfo.name` is mapped to an AI app id
//   (client-app.ts) and only that id is passed on; the session row is written (core McpSession).
// - Beat: every 15 s on its own one-shot timer, apart from the lease loop; a failed beat is tried
//   again at the next tick and never fails a tool.
// - Tool calls: stamped at their start and end (core writes at most once per second).
// - Stop: on clean shutdown, after the loop released the lease (command.ts), the timer is cleared
//   and the row deleted, before the agent closes.
// Nothing here logs and nothing holds the client's name (I-5, I-7).
import { MCP_SESSION_BEAT_SECONDS } from '@4thtech-io/core';
import { mcpAppIdFor } from './client-app.js';
import type { LoopTimers } from './loop.js';

/** 06 §6: every 15 s. */
export const MCP_BEAT_INTERVAL_MS = MCP_SESSION_BEAT_SECONDS * 1000;

/** The session row as the heartbeat uses it (core `McpSession`). */
export interface HeartbeatSession {
  start(app: string): Promise<boolean>;
  beat(): Promise<boolean>;
  toolCall(): Promise<void>;
  end(): Promise<boolean>;
}

const nodeTimers: LoopTimers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref(); // the heartbeat never keeps the process alive on its own
    return handle;
  },
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** One process's heartbeat. */
export class McpHeartbeat {
  readonly #session: HeartbeatSession;
  readonly #timers: LoopTimers;
  #timer: unknown;
  #started = false;
  #stopped = false;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(session: HeartbeatSession, timers: LoopTimers = nodeTimers) {
    this.#session = session;
    this.#timers = timers;
  }

  /** At `initialize`: maps the client name to an id (the name goes no further) and writes the row. */
  initialized(clientName: unknown): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    const app = mcpAppIdFor(clientName);
    this.#track(() => this.#session.start(app));
    this.#schedule();
  }

  /** At the start and end of every tool call. */
  toolCall(clientName: unknown): void {
    if (this.#stopped) return;
    if (!this.#started) this.initialized(clientName);
    this.#track(() => this.#session.toolCall());
  }

  /** On clean shutdown, after the lease is released: no more beats, the row deleted. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer !== undefined) this.#timers.clear(this.#timer);
    this.#timer = undefined;
    await this.#pending;
    if (this.#started) await this.#session.end().catch(() => false);
  }

  #schedule(): void {
    if (this.#stopped) return;
    this.#timer = this.#timers.set(() => {
      this.#timer = undefined;
      this.#track(() => this.#session.beat());
      this.#schedule();
    }, MCP_BEAT_INTERVAL_MS);
  }

  /** Runs the writes one after another, in order; none can reject. */
  #track(write: () => Promise<unknown>): void {
    this.#pending = this.#pending.then(write).catch(() => undefined);
  }
}
