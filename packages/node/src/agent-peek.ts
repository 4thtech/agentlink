// U3-c: a read-only look at an agent's store for the Agents list (08 §1 `GET /api/ui/agents`; 06 §6;
// D-138). The app host has one agent open at a time; for every listed agent it shows the number of
// contacts and whether an AI app is running it (the publisher lease row, 06 §6: the host only reads
// the row and never takes the lease).
//
// Only columns the store keeps in clear are read (07 §3): `contacts.status` and
// `publisher_lease.lease_until`. No KeyStore, store key or cipher is opened, nothing encrypted is
// read, nothing is written. The database is opened read-only (SQLITE_OPEN_READONLY) with
// `fileMustExist`; any failure (no store yet, an older schema, a busy or damaged file) answers
// undefined and the page shows the agent without the numbers. The caller passes the store path from
// the checked agent folder (agent-dir.ts readAgentConfig: realpath, no links, regular files).
import Database from 'better-sqlite3';

/** What the Agents list shows of one agent's store. */
export interface AgentStorePeek {
  /** Contacts with status `active`. */
  readonly contacts: number;
  /** True while a publisher lease row is live (an AI app is running this agent). */
  readonly running: boolean;
}

/** A lease_until further ahead than two lease periods is from a clock that went back: lapsed. */
const FUTURE_LIMIT_SECONDS = 120;

/** Reads the counts of the store at `storePath`; undefined when it cannot be read just now. */
export function peekAgentStore(storePath: string, nowSeconds: number): AgentStorePeek | undefined {
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
    const lease = db
      .prepare("SELECT lease_until AS until FROM publisher_lease WHERE name = 'subscriptions'")
      .get() as { until?: unknown } | undefined;
    const contacts =
      typeof counted?.n === 'number' && Number.isSafeInteger(counted.n) ? counted.n : 0;
    const until = typeof lease?.until === 'number' ? lease.until : undefined;
    const running =
      until !== undefined && nowSeconds < until && until <= nowSeconds + FUTURE_LIMIT_SECONDS;
    return Object.freeze({ contacts, running });
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}
