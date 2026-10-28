// U3-c: the agent folder lock (06 §6 "Open agents and removal"; 04 §2.5 "Removing an agent" step 1;
// D-138). Every process that has an agent open (each `agentlink mcp` server, publisher or not, the
// app host and the CLI commands that open it) holds a SHARED lock on that agent's folder for as long
// as the agent is open. Removing an agent (card U3-e) needs the lock EXCLUSIVE: while any process
// holds it shared, the exclusive take fails at once (`in_use`). The publisher lease alone never
// decides `in_use`.
//
// The lock is a SQLite read transaction on its own empty file in the agent folder, `open.lock`, as
// the store's inter-process lock is (inter-process-lock.ts): SQLite takes an OS file lock (POSIX
// advisory locks, LockFileEx on Windows) that the OS drops when the holder exits or crashes, so a dead
// process never leaves the agent "in use". Shared holders never block each other; an exclusive take
// is refused while any shared holder is alive, in this process or another. Nothing is ever written to
// the file.
//
// Folder rules (04 §4, 06 §6): the caller passes the agent folder's checked realpath
// (agent-dir.ts readAgentConfig). The lock file is created with mode 0600 and must be a regular file
// with one name (never a link, FIFO or folder); anything else fails closed with `lock_failed`.
// Residual (G-1): a same-user process can delete or replace the file; this keeps mistakes out, it is
// not a boundary against the agent.
import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/** The lock file's name inside the agent folder. */
export const AGENT_OPEN_LOCK_FILE = 'open.lock';

export type AgentFolderLockErrorCode = 'in_use' | 'lock_failed';

const MESSAGES: Readonly<Record<AgentFolderLockErrorCode, string>> = Object.freeze({
  in_use: 'This agent is open in another AgentLink process.',
  lock_failed: "AgentLink couldn't lock this agent's folder.",
});

/** Fixed text only: never a path (I-7). */
export class AgentFolderLockError extends Error {
  readonly code: AgentFolderLockErrorCode;
  constructor(code: AgentFolderLockErrorCode) {
    super(MESSAGES[code]);
    this.name = 'AgentFolderLockError';
    this.code = code;
  }
}

/** A held shared lock. `release` is idempotent. */
export interface AgentFolderLock {
  release(): void;
}

const isBusy = (error: unknown): boolean =>
  error instanceof Database.SqliteError && error.code.startsWith('SQLITE_BUSY');

/** Opens the lock file's connection after the file rules above. */
function openLockDb(dir: string): Database.Database {
  const path = join(dir, AGENT_OPEN_LOCK_FILE);
  try {
    try {
      closeSync(
        openSync(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        ),
      );
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
    }
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new AgentFolderLockError('lock_failed');
    }
    const db = new Database(path, { fileMustExist: true });
    db.pragma('busy_timeout = 0');
    return db;
  } catch {
    throw new AgentFolderLockError('lock_failed');
  }
}

/**
 * Takes the shared lock on the agent folder `dir` (its checked realpath) and holds it until
 * `release`. Refused at once with `in_use` while an exclusive holder (a removal) is in its step.
 */
export function holdAgentFolderShared(dir: string): AgentFolderLock {
  const db = openLockDb(dir);
  try {
    db.prepare('BEGIN').run();
    // The first read takes SQLite's SHARED lock and keeps it until the transaction ends.
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (error) {
    db.close();
    // An exclusive holder means the agent is being removed: it is not opened.
    throw new AgentFolderLockError(isBusy(error) ? 'in_use' : 'lock_failed');
  }
  let held = true;
  return Object.freeze<AgentFolderLock>({
    release: () => {
      if (!held) return;
      held = false;
      try {
        if (db.inTransaction) db.prepare('ROLLBACK').run();
      } finally {
        db.close();
      }
    },
  });
}

/**
 * Runs `fn` while holding the agent folder lock exclusive (card U3-e: removal). Refused at once with
 * `in_use` while any process, this one included, holds it shared: no wait, no retry.
 */
export async function withAgentFolderExclusive<T>(
  dir: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const db = openLockDb(dir);
  try {
    try {
      db.prepare('BEGIN EXCLUSIVE').run();
    } catch (error) {
      throw new AgentFolderLockError(isBusy(error) ? 'in_use' : 'lock_failed');
    }
    try {
      return await fn();
    } finally {
      if (db.inTransaction) db.prepare('ROLLBACK').run();
    }
  } finally {
    db.close();
  }
}
