// U3-c: a read-only look at an agent's store for the Agents list (08 §1 `GET /api/ui/agents`; 06 §6;
// D-138). The app host has one agent open at a time; for every listed agent it shows the number of
// contacts and which AI apps run it.
//
// W4-LIVE-STATUS (D-143; 06 §6 "MCP session heartbeat" "Read"; 04 §2.5 "Live status and Pause"):
// Running and the live sessions come from the `mcp_sessions` rows that are live (now < beat_until <=
// now + 90, the row names this store's agent, the pid passes pid-alive.ts: an integer in 2..2^31-1
// that answers signal 0). The publisher lease no longer decides Running (the host never reads or
// takes it here). `mcp_last_seen` gives "last seen" per AI app. Only the app id (an id of the 06 §7
// table, else `other`) and times leave this file: never a pid, a session ID or a holder ID (I-7).
//
// W4-PAUSE (D-143 (5); 07 §3.2 `agent_pause`; 08 §1 "Per agent state"): `paused` when the agent's
// pause row exists (display only: the agent's own processes enforce the pause, fail closed). A store
// from before version 11 (no pause table) is not paused.
//
// Only columns the store keeps in clear are read (07 §3): `contacts.status`, `identity.agent_id`,
// `agent_pause` and the heartbeat tables. No KeyStore, store key or cipher is opened, nothing encrypted is read,
// nothing is written. The database is opened read-only (SQLITE_OPEN_READONLY) with `fileMustExist`;
// any failure (no store yet, a busy or damaged file) answers undefined and the page shows the agent
// without the numbers; a store from before version 10 (no heartbeat tables) reads as no sessions.
// The caller passes the store path from the checked agent folder (agent-dir.ts readAgentConfig:
// realpath, no links, regular files).
import Database from 'better-sqlite3';
import { mcpAppId, mcpSessionLive } from '@4thtech-io/core';
import { pidAlive as defaultPidAlive } from './pid-alive.js';

/** One live MCP session as the app may know it: the app id and times only. */
export interface AgentLiveSession {
  /** An id of the 06 §7 table, or `other`. */
  readonly app: string;
  /** Unix seconds. */
  readonly startedAt: number;
  /** Unix seconds of the last tool call start or end; null before the first. */
  readonly lastToolAt: number | null;
}

/** When an AI app id last ran this agent (`mcp_last_seen`). */
export interface AgentLastSeen {
  readonly app: string;
  /** Unix seconds. */
  readonly at: number;
}

/** What the Agents list shows of one agent's store. */
export interface AgentStorePeek {
  /** Contacts with status `active`. */
  readonly contacts: number;
  /** True while at least one MCP session row is live (D-143; never the lease). */
  readonly running: boolean;
  /** The live sessions (at most MAX_SESSIONS), in row order of their app ids. */
  readonly sessions: readonly AgentLiveSession[];
  /** One entry per app id, sorted by app id. */
  readonly lastSeen: readonly AgentLastSeen[];
  /** W4-PAUSE: present (true) only while the agent's pause row exists. */
  readonly paused?: true;
}

export interface PeekOptions {
  /** Signal 0 only (pid-alive.ts); tests pass a fake. */
  readonly pidAlive?: (pid: number) => boolean;
}

/** At most this many session rows are read per agent (a forged table cannot make a read unbounded). */
const MAX_SESSIONS = 64;

const isTime = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Reads the counts of the store at `storePath`; undefined when it cannot be read just now. */
export function peekAgentStore(
  storePath: string,
  nowSeconds: number,
  options: PeekOptions = {},
): AgentStorePeek | undefined {
  let db: Database.Database;
  try {
    db = new Database(storePath, { readonly: true, fileMustExist: true });
  } catch {
    return undefined;
  }
  try {
    db.pragma('busy_timeout = 200');
    const counted = db
      .prepare("SELECT count(*) AS n FROM contacts WHERE status = 'active'")
      .get() as { n?: unknown } | undefined;
    const contacts =
      typeof counted?.n === 'number' && Number.isSafeInteger(counted.n) ? counted.n : 0;
    const live = readLive(db, nowSeconds, options.pidAlive ?? defaultPidAlive);
    return Object.freeze({
      contacts,
      running: live.sessions.length > 0,
      sessions: live.sessions,
      lastSeen: live.lastSeen,
      ...(readPaused(db) ? { paused: true as const } : {}),
    });
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/** W4-PAUSE: whether the pause row exists; false for a store from before version 11. */
function readPaused(db: Database.Database): boolean {
  const has = db
    .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'agent_pause'")
    .get() as { n?: unknown } | undefined;
  if (has?.n !== 1) return false;
  const rows = db.prepare('SELECT count(*) AS n FROM agent_pause').get() as
    | { n?: unknown }
    | undefined;
  return typeof rows?.n === 'number' && rows.n > 0;
}

/** The heartbeat tables, or none when they do not exist (a store from before version 10). */
function readLive(
  db: Database.Database,
  now: number,
  alive: (pid: number) => boolean,
): Pick<AgentStorePeek, 'sessions' | 'lastSeen'> {
  const none = { sessions: Object.freeze([]), lastSeen: Object.freeze([]) };
  const has = db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name IN " +
        "('mcp_sessions', 'mcp_last_seen', 'identity')",
    )
    .get() as { n?: unknown } | undefined;
  if (has?.n !== 3) return none;
  const identity = db.prepare('SELECT agent_id AS id FROM identity LIMIT 1').get() as
    { id?: unknown } | undefined;
  const agentId = typeof identity?.id === 'string' && identity.id !== '' ? identity.id : undefined;
  const sessions: AgentLiveSession[] = [];
  if (agentId !== undefined) {
    const rows = db
      .prepare(
        'SELECT app, agent_id, pid, started_at, beat_until, last_tool_at FROM mcp_sessions ' +
          `ORDER BY rowid LIMIT ${String(MAX_SESSIONS)}`,
      )
      .all() as Record<string, unknown>[];
    for (const row of rows) {
      if (!mcpSessionLive(row, now, agentId, alive)) continue;
      const tool = row['last_tool_at'];
      sessions.push(
        Object.freeze({
          app: mcpAppId(row['app']),
          startedAt: row['started_at'] as number,
          lastToolAt: isTime(tool) ? tool : null,
        }),
      );
    }
  }
  const newest = new Map<string, number>();
  const seenRows = db
    .prepare(`SELECT app, last_seen_at FROM mcp_last_seen LIMIT ${String(MAX_SESSIONS)}`)
    .all() as Record<string, unknown>[];
  for (const row of seenRows) {
    const at = row['last_seen_at'];
    if (!isTime(at)) continue;
    const app = mcpAppId(row['app']);
    if ((newest.get(app) ?? -1) < at) newest.set(app, at);
  }
  const lastSeen = [...newest.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([app, at]) => Object.freeze({ app, at }));
  return { sessions: Object.freeze(sessions), lastSeen: Object.freeze(lastSeen) };
}
