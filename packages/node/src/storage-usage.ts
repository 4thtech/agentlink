// REL051-RET1 (S1; retention plan RET-1; 08 §1 Storage; 07 §3; I-5, I-7): a read-only look at how
// much room an ID's store and the Inbox folder take. Sizes only: nothing is changed or deleted.
//
// `peekStorageUsage` opens the store like agent-peek.ts does (SQLITE_OPEN_READONLY, no KeyStore, no
// cipher, nothing decrypted). It reads only clear columns: the byte length of the stored (sealed or
// signed) text per `contact_id`, and the size column of the received files that were saved to the
// Inbox. A sealed value is measured by its stored length, never opened. Per-person names are sealed
// in the store, so a caller that may open the ID names people itself; the rows here carry the
// contact's ID only for that join and it never leaves the server.
//
// `scanInbox` measures the Inbox folder: one directory level, regular files only (a link, a folder or
// anything else is not counted and never followed), at most MAX_INBOX_ENTRIES entries. It reads no
// file content and keeps no name.
//
// Every failure answers undefined; nothing here logs, and no path or name is ever part of an error
// (I-7).
import Database from 'better-sqlite3';
import { lstat, opendir, stat } from 'node:fs/promises';
import path from 'node:path';

/** The store tables are read for at most this many people. */
const MAX_GROUPS = 1000;
/** The Inbox scan stops counting after this many entries (the answer says `truncated`). */
export const MAX_INBOX_ENTRIES = 20_000;

export interface StoragePerContact {
  /** The contact's agentId, or null for rows that name no contact. Never sent to the page. */
  readonly contactId: string | null;
  /** Stored bytes of this person's messages (signed text plus the sealed body). */
  readonly messageBytes: number;
  /** Received files of this person still indexed as saved in the Inbox. */
  readonly fileCount: number;
  readonly fileBytes: number;
}

export interface StorageUsage {
  /** `store.sqlite` on disk, and its `-wal` file. */
  readonly storeBytes: number;
  readonly walBytes: number;
  readonly messageBytes: number;
  readonly fileCount: number;
  readonly fileBytes: number;
  readonly perContact: readonly StoragePerContact[];
}

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;

async function sizeOf(file: string): Promise<number> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

interface Totals {
  messageBytes: number;
  fileCount: number;
  fileBytes: number;
}

/** A store's answer is reused while its files are unchanged, for at most this long. */
export const STORAGE_CACHE_TTL_MS = 60_000;
const MAX_CACHED_STORES = 64;
const cache = new Map<
  string,
  { readonly key: string; readonly at: number; readonly value: StorageUsage }
>();

async function fileKey(file: string): Promise<string> {
  try {
    const info = await stat(file);
    return `${String(info.mtimeMs)}:${String(info.size)}`;
  } catch {
    return 'none';
  }
}

/**
 * The sizes of the store at `storePath`; undefined when it cannot be read just now. The read is
 * synchronous SQLite, so an answer is kept per store while the store and its `-wal` file keep the
 * same modified time and size (and for STORAGE_CACHE_TTL_MS at most): reopening the page does not
 * scan a large store again.
 */
export async function peekStorageUsage(
  storePath: string,
  now: () => number = Date.now,
): Promise<StorageUsage | undefined> {
  const key = `${await fileKey(storePath)}|${await fileKey(`${storePath}-wal`)}`;
  const hit = cache.get(storePath);
  if (hit !== undefined && hit.key === key && now() - hit.at < STORAGE_CACHE_TTL_MS) {
    return hit.value;
  }
  const value = await readStorageUsage(storePath);
  if (value === undefined) {
    cache.delete(storePath);
    return undefined;
  }
  if (cache.size >= MAX_CACHED_STORES) cache.clear();
  cache.set(storePath, { key, at: now(), value });
  return value;
}

async function readStorageUsage(storePath: string): Promise<StorageUsage | undefined> {
  const [storeBytes, walBytes] = await Promise.all([sizeOf(storePath), sizeOf(`${storePath}-wal`)]);
  let db: Database.Database;
  try {
    db = new Database(storePath, { readonly: true, fileMustExist: true });
  } catch {
    return undefined;
  }
  try {
    db.pragma('busy_timeout = 200');
    const messages = db
      .prepare(
        'SELECT contact_id AS c, ' +
          'sum(coalesce(length(CAST(envelope_json AS BLOB)), 0) + ' +
          'coalesce(length(CAST(payload_json AS BLOB)), 0)) AS bytes ' +
          `FROM envelopes GROUP BY contact_id LIMIT ${String(MAX_GROUPS)}`,
      )
      .all() as { c?: unknown; bytes?: unknown }[];
    // A store from before schema version 6 has no `saved_name` column: no saved files.
    const hasSaved =
      (
        db
          .prepare("SELECT count(*) AS n FROM pragma_table_info('files') WHERE name = 'saved_name'")
          .get() as { n?: unknown } | undefined
      )?.n === 1;
    const files = hasSaved
      ? (db
          .prepare(
            'SELECT e.contact_id AS c, count(*) AS n, sum(f.size) AS bytes ' +
              'FROM files f JOIN envelopes e ON e.envelope_id = f.envelope_id ' +
              'WHERE f.saved_name IS NOT NULL ' +
              `GROUP BY e.contact_id LIMIT ${String(MAX_GROUPS)}`,
          )
          .all() as { c?: unknown; n?: unknown; bytes?: unknown }[])
      : [];
    const byContact = new Map<string | null, Totals>();
    const slot = (c: unknown): Totals => {
      const key = typeof c === 'string' && c !== '' ? c : null;
      let found = byContact.get(key);
      if (found === undefined) {
        found = { messageBytes: 0, fileCount: 0, fileBytes: 0 };
        byContact.set(key, found);
      }
      return found;
    };
    for (const row of messages) slot(row.c).messageBytes += num(row.bytes);
    for (const row of files) {
      const s = slot(row.c);
      s.fileCount += num(row.n);
      s.fileBytes += num(row.bytes);
    }
    const perContact = [...byContact.entries()].map(([contactId, v]) =>
      Object.freeze({ contactId, ...v }),
    );
    return Object.freeze({
      storeBytes,
      walBytes,
      messageBytes: perContact.reduce((a, p) => a + p.messageBytes, 0),
      fileCount: perContact.reduce((a, p) => a + p.fileCount, 0),
      fileBytes: perContact.reduce((a, p) => a + p.fileBytes, 0),
      perContact: Object.freeze(perContact),
    });
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

export interface InboxScan {
  readonly files: number;
  readonly bytes: number;
  /** More than MAX_INBOX_ENTRIES entries: the numbers are a floor. */
  readonly truncated: boolean;
}

/** The size of the regular files directly in `folder` (already a resolved real folder). */
export async function scanInbox(folder: string): Promise<InboxScan | undefined> {
  try {
    const dir = await opendir(folder);
    let entries = 0;
    let files = 0;
    let bytes = 0;
    let truncated = false;
    try {
      for await (const entry of dir) {
        // The cap is on entries looked at (links and folders included), not only on files.
        if (entries >= MAX_INBOX_ENTRIES) {
          truncated = true;
          break;
        }
        entries += 1;
        try {
          const info = await lstat(path.join(folder, entry.name));
          if (!info.isFile()) continue;
          files += 1;
          bytes += info.size;
        } catch {
          // A file that vanished while counting is not counted.
        }
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
    return Object.freeze({ files, bytes, truncated });
  } catch {
    return undefined;
  }
}
