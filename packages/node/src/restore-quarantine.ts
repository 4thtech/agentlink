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
//
// Errors are fixed sentences that never contain a path or a value (I-7).
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  CryptoInputError,
  decodeHex,
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
/** The quarantine file names: `.restore-<16 hex>.sqlite`. */
const RESTORE_FILE = /^\.restore-[0-9a-f]{16}\.sqlite(?:-wal|-shm)?$/;

type SinkState = 'open' | 'committed' | 'checked' | 'installed' | 'discarded';

interface QuarantinedFile {
  readonly path: string;
  state: SinkState;
  handle: FileHandle | undefined;
}

/** Every quarantine sink this module made, by identity (a look-alike sink is never one). */
const SINKS = new WeakMap<RecoveryKitStoreSink, QuarantinedFile>();

const restoreFailed = (): CryptoInputError =>
  new CryptoInputError('invalid_argument', 'restore: the restored store cannot be used');

function removeFiles(path: string): void {
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
      const path = join(dir, `.restore-${encodeHex(randomBytes(8))}.sqlite`);
      const handle = await open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE);
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
    const rows = db.prepare('SELECT agent_id, agent_card_json FROM identity').all() as {
      agent_id: unknown;
      agent_card_json: unknown;
    }[];
    if (rows.length !== 1) return false;
    const row = rows[0] as { agent_id: unknown; agent_card_json: unknown };
    if (row.agent_id !== agentId || typeof row.agent_card_json !== 'string') return false;
    cipher = await createAgentStoreCipher(storeKey);
    const text = await cipher.open(
      { table: 'identity', column: 'agent_card_json', rowKey: rowKeyOf([agentId]) },
      row.agent_card_json as Sealed,
    );
    const stored = parseJson(text) as { card?: { ownerNostr?: unknown } } | null;
    const named = stored?.card?.ownerNostr;
    // A real card spells its owner keys `0x` + lowercase hex (04 §2.4.1); before W4-RENAME-REACHES-
    // CONTACTS only the bare form was accepted, so a kit of a real agent was refused here.
    if (typeof named !== 'string' || !/^(?:0x)?[0-9a-f]{64}$/.test(named)) return false;
    const hex = named.startsWith('0x') ? named.slice(2) : named;
    if (!equalBytes(decodeHex(hex, { length: 32 }), ownerNostr)) return false;
    file.state = 'checked';
    return true;
  } catch {
    return false;
  } finally {
    cipher?.close();
    db?.close();
  }
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
  await unlink(file.path).catch(() => undefined);
}

/** 04 §4 (D-84): removes quarantine files a crashed restore left in `dir`. */
export async function removeStaleRestoreFiles(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (RESTORE_FILE.test(name)) await unlink(join(dir, name)).catch(() => undefined);
  }
}
