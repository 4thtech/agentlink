// M1-8b: the agent's inter-process lock (06 §6; 07 §3.4, §3.7): one holder at a time across every
// process on the machine, for critical sections that span awaits, such as raising the KeyStore's
// policy-version mark (07 §3.4) or the file KeyStore's writes (M1-8f).
//
// The lock is an exclusive SQLite transaction on its own small file next to the store. SQLite takes
// an OS file lock (POSIX advisory locks, LockFileEx on Windows) that the OS releases when the holder
// exits or crashes, so a dead holder never leaves a stale lock, and SQLite also keeps two connections
// in one process apart. Nothing is ever written to the lock file. The wait is asynchronous (a short
// poll with backoff), so a waiting process keeps serving its event loop.
import { closeSync, openSync } from 'node:fs';
import Database from 'better-sqlite3';
import { NodeStoreError } from './store-errors.js';

/** How long acquiring the lock waits before `store_busy`. */
export const INTER_PROCESS_LOCK_TIMEOUT_MS = 10_000;

export interface InterProcessLockOptions {
  /** How long to wait for the lock. Default INTER_PROCESS_LOCK_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isBusy = (error: unknown): boolean =>
  error instanceof Database.SqliteError && error.code.startsWith('SQLITE_BUSY');

/** Runs `fn` while holding the lock at `lockPath`; the lock is released when `fn` settles. */
export async function withInterProcessLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  options: InterProcessLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? INTER_PROCESS_LOCK_TIMEOUT_MS;
  let db: Database.Database;
  try {
    try {
      closeSync(openSync(lockPath, 'wx', 0o600));
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
    }
    db = new Database(lockPath, { fileMustExist: true });
    db.pragma('busy_timeout = 0');
  } catch {
    throw new NodeStoreError('store_failed');
  }
  try {
    const deadline = Date.now() + timeoutMs;
    let delay = 2;
    for (;;) {
      try {
        db.prepare('BEGIN EXCLUSIVE').run();
        break;
      } catch (error) {
        if (!isBusy(error)) throw new NodeStoreError('store_failed');
        if (Date.now() >= deadline) throw new NodeStoreError('store_busy');
        await sleep(delay);
        delay = Math.min(delay * 2, 50);
      }
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
