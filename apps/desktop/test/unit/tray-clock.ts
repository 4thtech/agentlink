// A manual clock for the tray engine tests (TRAY-ENGINE): timers fire only on advance().
import type { TrayTimers } from '../../src/main/tray-engine.js';

interface Pending {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

export class ManualClock implements TrayTimers {
  now = 0;
  #next = 1;
  #pending: Pending[] = [];

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#next;
    this.#next += 1;
    this.#pending.push({ id, at: this.now + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#pending = this.#pending.filter((p) => p.id !== handle);
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  /** Moves time forward, firing every timer due on the way (in order). */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = this.#pending
        .filter((p) => p.at <= end)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.#pending = this.#pending.filter((p) => p.id !== due.id);
      this.now = due.at;
      due.fn();
    }
    this.now = end;
  }
}
