// The MCP session heartbeat (06 §6 "MCP session heartbeat"; 07 §3.2 `mcp_sessions`, `mcp_last_seen`;
// 04 §2.5 "Live status and Pause"; D-143, W4-LIVE-STATUS; proposed, owner confirms at merge).
//
// Every `agentlink mcp` process, lease holder or not, keeps one row so the app can show which AI app
// runs which agent. The publisher lease (publisher-lease.ts) is unchanged and separate: it decides
// who keeps the relay subscriptions, never what the app calls Running.
//
// - Start: when the process answers `initialize`, it inserts its row (a random session ID, the AI app
//   id, the agent's agentId, its pid, started_at, beat_until = now + 45) and deletes rows that are no
//   longer live (TTL, another agent, and, with `pidAlive`, a pid that is gone). Before start: no row.
// - Beat: every 15 s (the caller's timer, apart from the lease loop), beat_until = now + 45 with a
//   compare-and-set on the session ID; a pruned row is inserted again.
// - Tool calls: last_tool_at = now at start and end of each call, at most one write per second.
// - Last seen: start, each beat and the exit write `mcp_last_seen` for the app id.
// - End: on clean shutdown, after the lease is released, the row is deleted (compare-and-set on the
//   session ID). A crash leaves the row; readers drop it (`mcpSessionLive`).
// - Nothing here throws or logs: a failed write is tried again at the next beat and never fails a
//   tool. The app id is an id of the fixed table or `other`; the client's own name never gets here.
//
// Threat note: a same-user process can write, change or delete these rows (G-1) and so fake a
// status; nothing reads them to authorise anything, and no row holds a secret.
import { encodeBase64url, randomBytes } from '@4thtech-io/crypto';
import { AI_APP_IDS } from '@4thtech-io/types';
import {
  MCP_SESSION_BEAT_SECONDS,
  MCP_SESSION_FUTURE_LIMIT_SECONDS,
  MCP_SESSION_TTL_SECONDS,
} from './constants.js';
import type { Row } from './store/schema.js';
import type { Store, StoreTx } from './store/store.js';

export { MCP_SESSION_BEAT_SECONDS, MCP_SESSION_FUTURE_LIMIT_SECONDS, MCP_SESSION_TTL_SECONDS };

/** The app id of a client that is not in the fixed table (06 §6; "Another AI app", Q-143-4). */
export const OTHER_APP = 'other' as const;

/** 07 §3.2: session_id is 16 random bytes, base64url. */
const SESSION_ID_BYTES = 16;
/** 04 §2.5: a pid is accepted only as an integer in 2 .. 2^31 - 1. */
const MAX_PID = 2 ** 31 - 1;

/** An id of the 06 §7 table, else `other`. */
export function mcpAppId(app: unknown): string {
  return typeof app === 'string' && (AI_APP_IDS as readonly string[]).includes(app)
    ? app
    : OTHER_APP;
}

/** 04 §2.5: an integer greater than 1 and at most 2^31 - 1 (0 and -1 would signal a group). */
export function mcpPidValid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 && pid <= MAX_PID;
}

const isTime = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * The reader rule of 06 §6 "Read": live only while now < beat_until <= now + 90, the row names this
 * agent, its pid is valid (checked before `pidAlive` is ever asked) and `pidAlive(pid)` holds.
 * Takes any record shape, so a forged row of the wrong types is not live.
 */
export function mcpSessionLive(
  row: { readonly [column: string]: unknown },
  now: number,
  agentId: string,
  pidAlive: (pid: number) => boolean,
): boolean {
  const until = row['beat_until'];
  if (!isTime(until) || !(now < until && until <= now + MCP_SESSION_FUTURE_LIMIT_SECONDS)) {
    return false;
  }
  if (row['agent_id'] !== agentId || !isTime(row['started_at'])) return false;
  const pid = row['pid'];
  if (!mcpPidValid(pid)) return false;
  try {
    return pidAlive(pid);
  } catch {
    return false;
  }
}

export interface McpSessionOptions {
  readonly store: Store;
  /** Unix seconds. */
  readonly now: () => number;
  /** This agent's agentId (07 §3.2: a reader ignores rows of another agent). */
  readonly agentId: string;
  /** This process's pid. */
  readonly pid: number;
  /** Signal 0 only (node pid-alive.ts). Without it, the writer prunes by TTL and agent only. */
  readonly pidAlive?: (pid: number) => boolean;
}

/** One process's MCP session row. */
export class McpSession {
  /** 16 random bytes, base64url, new per process. Never logged or shown. */
  readonly sessionId: string;
  readonly #store: Store;
  readonly #now: () => number;
  readonly #agentId: string;
  readonly #pid: number;
  readonly #pidAlive: ((pid: number) => boolean) | undefined;
  #app: string | undefined;
  #startedAt = 0;
  #ended = false;
  #lastStamp: number | undefined;

  constructor(options: McpSessionOptions) {
    this.#store = options.store;
    this.#now = options.now;
    this.#agentId = options.agentId;
    this.#pid = options.pid;
    this.#pidAlive = options.pidAlive;
    this.sessionId = encodeBase64url(randomBytes(SESSION_ID_BYTES));
  }

  /** The app id once started. */
  get app(): string | undefined {
    return this.#app;
  }

  /** Writes the row at `initialize` (once). False when it could not be written now. */
  async start(app: unknown): Promise<boolean> {
    if (this.#ended) return false;
    if (this.#app !== undefined) return true;
    const id = mcpAppId(app);
    try {
      const now = this.#clock();
      this.#app = id;
      this.#startedAt = now;
      await this.#store.transaction((tx) => {
        this.#prune(tx, now);
        this.#insert(tx, now, null);
        this.#seen(tx, now);
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Renews beat_until (every 15 s); inserts the row again when it was pruned. */
  async beat(): Promise<boolean> {
    const app = this.#app;
    if (app === undefined || this.#ended) return false;
    try {
      const now = this.#clock();
      await this.#store.transaction((tx) => {
        const changed = tx.update(
          'mcp_sessions',
          { session_id: this.sessionId },
          { beat_until: now + MCP_SESSION_TTL_SECONDS },
        );
        if (changed === 0) {
          this.#prune(tx, now);
          this.#insert(tx, now, this.#lastStamp ?? null);
        }
        this.#seen(tx, now);
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Stamps last_tool_at at the start and end of a tool call; at most one write per second. */
  async toolCall(): Promise<void> {
    if (this.#app === undefined || this.#ended) return;
    try {
      const now = this.#clock();
      if (this.#lastStamp === now) return;
      this.#lastStamp = now;
      await this.#store.transaction((tx) =>
        tx.update('mcp_sessions', { session_id: this.sessionId }, { last_tool_at: now }),
      );
    } catch {
      // A failed stamp never fails a tool.
    }
  }

  /** Deletes this process's row on clean shutdown (after the lease is released). */
  async end(): Promise<boolean> {
    const app = this.#app;
    if (app === undefined || this.#ended) return false;
    this.#ended = true;
    try {
      const now = this.#clock();
      return await this.#store.transaction((tx) => {
        this.#seen(tx, now);
        return tx.delete('mcp_sessions', { session_id: this.sessionId }) === 1;
      });
    } catch {
      return false;
    }
  }

  #insert(tx: StoreTx, now: number, lastToolAt: number | null): void {
    tx.insert('mcp_sessions', {
      session_id: this.sessionId,
      app: this.#app ?? OTHER_APP,
      agent_id: this.#agentId,
      pid: this.#pid,
      started_at: this.#startedAt,
      beat_until: now + MCP_SESSION_TTL_SECONDS,
      last_tool_at: lastToolAt,
    });
  }

  #seen(tx: StoreTx, now: number): void {
    const app = this.#app ?? OTHER_APP;
    if (tx.update('mcp_last_seen', { app }, { last_seen_at: now }) === 0) {
      tx.insert('mcp_last_seen', { app, last_seen_at: now });
    }
  }

  /** Deletes the rows that are no longer live (06 §6: a writer prunes when it inserts its own). */
  #prune(tx: StoreTx, now: number): void {
    const alive = this.#pidAlive ?? (() => true);
    for (const row of tx.select('mcp_sessions')) {
      if (row.session_id === this.sessionId) continue;
      if (!mcpSessionLive(row as Row<'mcp_sessions'>, now, this.#agentId, alive)) {
        tx.delete('mcp_sessions', { session_id: row.session_id });
      }
    }
  }

  #clock(): number {
    const t = this.#now();
    if (!isTime(t) || t > Number.MAX_SAFE_INTEGER - MCP_SESSION_FUTURE_LIMIT_SECONDS) {
      throw new Error('clock');
    }
    return t;
  }
}
