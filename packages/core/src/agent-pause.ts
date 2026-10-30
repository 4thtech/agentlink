// W4-PAUSE (S2; D-143 (5); 06 §6 "Paused agents"; 07 §3.2 `agent_pause`; 04 §2.5 "Live status and
// Pause"; proposed, owner confirms at merge): the owner's stop button for one agent.
//
// - Pause writes the one `agent_pause` row (slot `current`, paused_at = now) and signs nothing: it
//   only removes capability (Q-143-1, Decision 50). A second pause keeps the first row.
// - Resume is never here: only a verified `agent.resume` (owner-actions.ts) deletes the row, in the
//   transaction that records its nonce.
// - Every process checks the row at the start of every tool call and command and at every loop step.
//   Fail closed (as for the lease, 07 §3.2): a row that cannot be read (a store error, a busy or
//   damaged file) counts as paused for the sending and fetching paths.
// - Not a security boundary against the same OS user (G-1): a process with shell access can delete
//   the row directly. Pause stops the AI's tools and loops.
//
// Nothing here logs: the row holds only a time (I-7).
import { CoreError } from './errors.js';
import { SINGLETON_SLOT } from './store/schema.js';
import type { Store } from './store/store.js';

/** What the pause row says now. `unreadable` counts as paused (fail closed). */
export type PauseReading =
  | { readonly status: 'running' }
  | { readonly status: 'paused'; readonly pausedAt: number }
  | { readonly status: 'unreadable' };

export interface AgentPauseOptions {
  readonly store: Store;
  /** Unix seconds (the client's clock). */
  readonly now: () => number;
}

/** The fixed refusal of every sending or fetching core path while paused. */
export const agentPaused = (): CoreError =>
  new CoreError('agent_paused', 'This agent is paused.');

const isTime = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export class AgentPause {
  readonly #store: Store;
  readonly #now: () => number;

  constructor(options: AgentPauseOptions) {
    this.#store = options.store;
    this.#now = options.now;
  }

  /** Reads the pause row. Never throws: a failure is `unreadable`. */
  async read(): Promise<PauseReading> {
    try {
      const row = await this.#store.transaction((tx) =>
        tx.get('agent_pause', { slot: SINGLETON_SLOT }),
      );
      if (row === undefined) return { status: 'running' };
      // A row is a pause whatever its time; an odd time is shown as unknown (0).
      return { status: 'paused', pausedAt: isTime(row.paused_at) ? row.paused_at : 0 };
    } catch {
      return { status: 'unreadable' };
    }
  }

  /** True while paused, and when the row cannot be read (fail closed). */
  async paused(): Promise<boolean> {
    return (await this.read()).status !== 'running';
  }

  /** Throws `agent_paused` while paused or unreadable; the check before any effect. */
  async assertRunning(): Promise<void> {
    if (await this.paused()) throw agentPaused();
  }

  /**
   * Pauses the agent: writes the one row with the time now. `already` when a row exists (its time
   * is kept). Signs nothing. Store errors throw (the caller reports `unavailable`).
   */
  async pause(): Promise<'paused' | 'already'> {
    const now = this.#now();
    return this.#store.transaction((tx) => {
      if (tx.get('agent_pause', { slot: SINGLETON_SLOT }) !== undefined) return 'already' as const;
      tx.insert('agent_pause', { slot: SINGLETON_SLOT, paused_at: now });
      return 'paused' as const;
    });
  }
}
