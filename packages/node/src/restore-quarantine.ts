// M1-9i-c (04 §2.3.3 "Secret entries never touch disk", "Checks after decryption", restore step 5;
// 04 §4 quarantine rules, D-84): where a recovery kit's store snapshots wait while the kit opens.
//
// - Each store entry goes to its own private temporary file in the restore's quarantine folder
//   (created O_CREAT | O_EXCL | O_NOFOLLOW, mode 0600). Only store snapshots go here: the seeds and
//   items stay in memory buffers inside the import control (key-controls.ts).
// - commit() only marks the bytes authenticated (the whole kit's final chunk verified). The import
//   control then runs the snapshot checks on the quarantined file: its `identity.agent_id` is the
//   agent's ID and its stored card names the kit's owner. Only a sink that passed them can be
//   installed into an agent folder (installRestoredStore), so nothing reaches an agent's folder
//   before the checks pass.
// - discard() deletes the file (and the `-wal` and `-shm` files the check may leave); a failure
//   anywhere discards every sink of the kit. Stale files from a crash are removed at start-up
//   (removeStaleRestoreFiles).
// - REL051-SF3 (T-7): every quarantine and upload file is named with the process that made it, and
//   this process tracks the ones still in use, so a sweep (a second engine, the terminal's
//   `agentlink restore`) removes only files of runs that are gone, never a live engine's kit.
//
// Errors are fixed sentences that never contain a path or a value (I-7).
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  CryptoInputError,
  decodeHex0x,
  encodeHex,
  equalBytes,
  parseJson,
  randomBytes,
  type RecoveryKitImport,
  type RecoveryKitStoreSink,
} from '@4thtech-io/crypto';
import { rowKeyOf, type Sealed } from '@4thtech-io/core';
import { STORE_APPLICATION_ID } from './sqlite-schema.js';
import { createAgentStoreCipher } from './store-cipher.js';

const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
/**
 * The quarantine file names: `.restore-<pid>-<16 hex>.sqlite` (REL051-SF3; the name of earlier
 * builds, without the pid, is matched too and always counts as stale).
 */
const RESTORE_FILE = /^(\.restore-(?:(\d{1,10})-)?[0-9a-f]{16}\.sqlite)(?:-wal|-shm)?$/;
/** UX1113-R1 (04 §2.3.3 "Upload"): a kit uploaded from the page, `.upload-<pid>-<16 hex>.alkk`. */
export const UPLOAD_FILE = /^(\.upload-(?:(\d{1,10})-)?[0-9a-f]{16}\.alkk)$/;
/**
 * A file of another live process older than this is stale all the same (a reused pid): an opened
 * kit lives 10 minutes, an apply far less than a day.
 */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** The quarantine and upload files this process made and still uses, by path. */
const LIVE = new Set<string>();

/** A new restore file name of this process: `.restore-<pid>-<hex>.sqlite` or `.upload-…`. */
export function restoreFileName(kind: 'restore' | 'upload'): string {
  const id = `${String(process.pid)}-${encodeHex(randomBytes(8))}`;
  return kind === 'restore' ? `.restore-${id}.sqlite` : `.upload-${id}.alkk`;
}

/** Marks `path` as in use by this process (a sweep keeps it) or, with `false`, no longer. */
export function trackRestoreFile(path: string, live = true): void {
  if (live) LIVE.add(path);
  else LIVE.delete(path);
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM';
  }
}

type SinkState = 'open' | 'committed' | 'checked' | 'installed' | 'discarded';

interface QuarantinedFile {
  readonly path: string;
  state: SinkState;
  handle: FileHandle | undefined;
  /** W4-RENAME-REACHES-CONTACTS: the checked snapshot's `identity.key_epoch` (its card's epoch). */
  keyEpoch?: number;
  /** UX1113-R1: commit() ran, so the whole kit authenticated (the code was right). */
  authenticated?: true;
}

/** Every quarantine sink this module made, by identity (a look-alike sink is never one). */
const SINKS = new WeakMap<RecoveryKitStoreSink, QuarantinedFile>();

const restoreFailed = (): CryptoInputError =>
  new CryptoInputError('invalid_argument', 'restore: the restored store cannot be used');

function removeFiles(path: string): void {
  LIVE.delete(path);
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // Already gone.
    }
  }
}

/**
 * The restore's quarantine in `dir` (created 0700 if missing). `createStoreSink` is what the CLI
 * passes as OpenRecoveryKitOptions.createStoreSink; the import control refuses any other sink.
 */
export function createRestoreQuarantine(dir: string): {
  readonly createStoreSink: () => Promise<RecoveryKitStoreSink>;
} {
  return Object.freeze({
    createStoreSink: async (): Promise<RecoveryKitStoreSink> => {
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
      const info = await lstat(dir);
      if (!info.isDirectory()) throw restoreFailed();
      const path = join(dir, restoreFileName('restore'));
      LIVE.add(path);
      let handle: FileHandle;
      try {
        handle = await open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE);
      } catch (error) {
        LIVE.delete(path);
        throw error;
      }
      const file: QuarantinedFile = { path, state: 'open', handle };
      let offset = 0;
      const sink: RecoveryKitStoreSink = Object.freeze({
        write: async (bytes: Uint8Array): Promise<void> => {
          if (file.state !== 'open' || file.handle === undefined) throw restoreFailed();
          let done = 0;
          while (done < bytes.length) {
            const { bytesWritten } = await file.handle.write(
              bytes,
              done,
              bytes.length - done,
              offset,
            );
            done += bytesWritten;
            offset += bytesWritten;
          }
        },
        commit: async (): Promise<void> => {
          if (file.state !== 'open' || file.handle === undefined) throw restoreFailed();
          await file.handle.sync();
          await file.handle.close();
          file.handle = undefined;
          // Authenticated, not yet checked: still quarantined.
          file.state = 'committed';
          file.authenticated = true;
        },
        discard: async (): Promise<void> => {
          await discardFile(file);
        },
      });
      SINKS.set(sink, file);
      return sink;
    },
  });
}

async function discardFile(file: QuarantinedFile): Promise<void> {
  if (file.state === 'discarded' || file.state === 'installed') return;
  file.state = 'discarded';
  const handle = file.handle;
  file.handle = undefined;
  await handle?.close().catch(() => undefined);
  removeFiles(file.path);
}

/** True when `sink` is a quarantine sink of this module. */
export function isQuarantineSink(sink: unknown): sink is RecoveryKitStoreSink {
  return typeof sink === 'object' && sink !== null && SINKS.has(sink as RecoveryKitStoreSink);
}

/** Discards a quarantine sink (synchronously, for RecoveryKitImport.wipe). */
export function discardQuarantineSync(sink: RecoveryKitStoreSink): void {
  const file = SINKS.get(sink);
  if (file === undefined || file.state === 'discarded' || file.state === 'installed') return;
  file.state = 'discarded';
  const handle = file.handle;
  file.handle = undefined;
  void handle?.close().catch(() => undefined);
  removeFiles(file.path);
}

/**
 * 04 §2.3.3 "Checks after decryption", the store half (IR-M1-9i-b-1): on the committed quarantined
 * snapshot, the AgentLink store has exactly one `identity` row, its `agent_id` is `agentId`, and its
 * stored card (sealed under the kit's store key) names `ownerNostr`. Marks the sink checked and
 * returns true only then; any failure is false and the sink stays unchecked.
 */
export async function checkQuarantinedSnapshot(
  sink: RecoveryKitStoreSink,
  agentId: string,
  storeKey: Uint8Array,
  ownerNostr: Uint8Array,
): Promise<boolean> {
  const file = SINKS.get(sink);
  if (file?.state !== 'committed') return false;
  let db: Database.Database | undefined;
  let cipher: Awaited<ReturnType<typeof createAgentStoreCipher>> | undefined;
  try {
    db = new Database(file.path, { fileMustExist: true });
    db.pragma('query_only = ON');
    db.pragma('trusted_schema = OFF');
    if (db.pragma('application_id', { simple: true }) !== STORE_APPLICATION_ID) return false;
    const rows = db.prepare('SELECT agent_id, agent_card_json, key_epoch FROM identity').all() as {
      agent_id: unknown;
      agent_card_json: unknown;
      key_epoch: unknown;
    }[];
    if (rows.length !== 1) return false;
    const row = rows[0] as { agent_id: unknown; agent_card_json: unknown; key_epoch: unknown };
    if (row.agent_id !== agentId || typeof row.agent_card_json !== 'string') return false;
    cipher = await createAgentStoreCipher(storeKey);
    const text = await cipher.open(
      { table: 'identity', column: 'agent_card_json', rowKey: rowKeyOf([agentId]) },
      row.agent_card_json as Sealed,
    );
    const stored = parseJson(text) as {
      card?: { ownerNostr?: unknown; keyEpoch?: unknown };
    } | null;
    const named = stored?.card?.ownerNostr;
    // The card spelling of ownerNostr: `0x` + 64 lowercase hex (04 §2.4.1); anything else throws.
    if (typeof named !== 'string') return false;
    if (!equalBytes(decodeHex0x(named, { length: 32 }), ownerNostr)) return false;
    // W4-RENAME-REACHES-CONTACTS (D-141): the epoch the store's card is at, for a kit without the
    // `key-epoch` item (kits made before it): the row and its card must agree.
    const epoch = row.key_epoch;
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) return false;
    if (stored?.card?.keyEpoch !== epoch) return false;
    file.keyEpoch = epoch;
    file.state = 'checked';
    return true;
  } catch {
    return false;
  } finally {
    cipher?.close();
    db?.close();
  }
}

/**
 * W4-RENAME-REACHES-CONTACTS (D-141; 04 §2.3.3): the key epoch of a checked quarantined snapshot
 * (its identity row, equal to its card's), or undefined for a sink this module did not check.
 */
export function checkedSnapshotKeyEpoch(
  sink: RecoveryKitStoreSink | undefined,
): number | undefined {
  if (sink === undefined) return undefined;
  const file = SINKS.get(sink);
  if (file === undefined || (file.state !== 'checked' && file.state !== 'installed'))
    return undefined;
  return file.keyEpoch;
}

/** The handle's store sink of `agentId`, if any (public facts only). */
function sinkOf(kit: RecoveryKitImport, agentId: string): RecoveryKitStoreSink | undefined {
  if (typeof kit !== 'object' || kit === null || !Array.isArray(kit.agents)) return undefined;
  return kit.agents.find((a) => a.agentId === agentId)?.store;
}

/**
 * Restore step 5, the store: moves the checked snapshot of `agentId` to `destination` (the agent's
 * `store.sqlite`, which the CLI's agent-folder rules chose). Never overwrites: a hard link fails when
 * the destination exists, then the quarantine name is removed. Only a sink of this module that passed
 * the snapshot checks moves; anything else is refused and nothing is written. The caller fsyncs the
 * folder and writes `config.json` last.
 */
export async function installRestoredStore(
  kit: RecoveryKitImport,
  agentId: string,
  destination: string,
): Promise<void> {
  const sink = sinkOf(kit, agentId);
  const file = sink === undefined ? undefined : SINKS.get(sink);
  if (file?.state !== 'checked') throw restoreFailed();
  for (const suffix of ['-wal', '-shm'])
    await unlink(`${file.path}${suffix}`).catch(() => undefined);
  try {
    await link(file.path, destination);
  } catch {
    throw restoreFailed();
  }
  file.state = 'installed';
  LIVE.delete(file.path);
  await unlink(file.path).catch(() => undefined);
}

/**
 * UX1113-R1 (04 §2.3.3 "Restore in the app"): true when `sink` was committed, so the kit it came
 * from authenticated with the code given (a later snapshot check may still have refused it). The
 * restore engine answers `damaged` then, not `wrong_code`, and does not count a wrong code.
 */
export function quarantineAuthenticated(sink: RecoveryKitStoreSink): boolean {
  return SINKS.get(sink)?.authenticated === true;
}

/**
 * UX1113-R1 (T-10): counts and dates only from a checked quarantined snapshot of `agentId`: the
 * active contacts and the newest message time (Unix seconds, or null). Only clear columns are read
 * (07 §3): `contacts.status` and `envelopes.created_at`; never a name, a card or a message. Undefined
 * when the sink is not a checked sink of this module or cannot be read.
 */
export function peekQuarantinedSnapshot(
  kit: RecoveryKitImport,
  agentId: string,
): { readonly people: number; readonly lastMessageAt: number | null } | undefined {
  const sink = sinkOf(kit, agentId);
  const file = sink === undefined ? undefined : SINKS.get(sink);
  if (file?.state !== 'checked') return undefined;
  let db: Database.Database | undefined;
  try {
    db = new Database(file.path, { fileMustExist: true, readonly: true });
    db.pragma('query_only = ON');
    db.pragma('trusted_schema = OFF');
    const people = db
      .prepare("SELECT count(*) AS n FROM contacts WHERE status = 'active'")
      .get() as { n: unknown };
    const last = db.prepare('SELECT max(created_at) AS t FROM envelopes').get() as { t: unknown };
    const n = typeof people.n === 'number' && Number.isSafeInteger(people.n) ? people.n : 0;
    const t = typeof last.t === 'number' && Number.isSafeInteger(last.t) ? last.t : null;
    return Object.freeze({ people: n, lastMessageAt: t });
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

/**
 * 04 §4 (D-84), T-7: removes the quarantine and upload files of restores that are gone from `dir`:
 * files of an earlier build (no pid in the name), of a process that has ended, of this process that
 * it no longer uses, and any older than a day. A file another live process (or this one) still uses
 * is kept. Never follows a link (unlink removes the name only).
 */
export async function removeStaleRestoreFiles(
  dir: string,
  now: number = Date.now(),
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = RESTORE_FILE.exec(name) ?? UPLOAD_FILE.exec(name);
    if (match === null) continue;
    const path = join(dir, name);
    const base = join(dir, match[1] as string);
    const pidText = match[2];
    let stale: boolean;
    if (pidText === undefined) stale = true;
    else {
      const pid = Number(pidText);
      if (pid === process.pid) stale = !LIVE.has(base);
      else if (!processAlive(pid)) stale = true;
      else {
        const info = await lstat(path).catch(() => undefined);
        stale = info === undefined || now - info.mtimeMs > STALE_AFTER_MS;
      }
    }
    if (stale) await unlink(path).catch(() => undefined);
  }
}
