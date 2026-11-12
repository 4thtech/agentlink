// WP-11 (F-1 full; D-117 A; 04 §2.3.3 "Export: who sees the seeds", "Snapshot", §2.5.1
// `backup.export`; 07 §9.4) and WP-R2 (D-147 (2), (6), (7); 04 §2.3.3 "In the local app", "Kit
// record", "Check that my kit opens"): saving one recovery kit of every ID of this owner from the
// local app.
//
// I-4: called only from the app host's presence gate (approval-server.ts `exportRecoveryKit`), with
// the owner session that gate unlocked for an export (KeychainOwnerKeyStore.unlockForExport) from the
// presence this request carried. In order, inside that one owner operation:
//   1. the server draws one kitId (16 CSPRNG bytes); one ID at a time, that ID's core prepares
//      `backup.export` {kitId, "full"}, the gate's `sign` signs it (one checked request per call,
//      with this one gesture's session: one entry of the owner secret covers them all, 04 §2.5 "One
//      entry") and that same core applies it (its nonce row is the audit record, 07 §3.4). The open
//      ID goes first, with its own core; then the host walks this owner's other IDs (`others`, WP-R2b):
//      its slot closes the open ID's core and opens each other ID's core alone, closing it before the
//      next, so at most one agent's KeyStore and store are open in the host at any time (04 §2.5
//      "KeyStore isolation"); the open ID's core is never opened twice;
//   2. if any is refused, an ID is not valid or listed twice, the walk cannot finish or the time
//      budget (EXPORT_BUDGET_MS) has passed, nothing is sealed;
//   3. the KeyExportControl seals the owner seed, each ID's KeyStore items and its store snapshot as
//      `ALKK` v1 into one new file (O_CREAT | O_EXCL | O_NOFOLLOW, 0600, never under ~/.agentlink) in
//      the Downloads folder, else the home folder, and returns one new recovery code for display once;
//   4. the kit record `~/.agentlink/kit-record.json` is written (kit-record.ts; a display aid, its
//      failure keeps the save) and the restore engine registers an export handle for Check
//      (`registerCheck`, WP-R2b: recovery-kit-restore.ts registerExportedKit, the device and inode of
//      the file just created, bound to the page session; the page never sees the path).
// Each snapshot is `VACUUM INTO` a private temporary file under that ID's own lock hold (the control
// holds it, one ID at a time, after every other ID's core was closed again), read back after the
// hold, and deleted at the end whatever happened.
// The people count of the record is read from that same snapshot (the same cut).
//
// Zero access: nothing here talks to any network. Nothing is logged; failures are fixed outcomes
// that never carry a path, a code or an error's text (I-7). The code leaves as display text only.
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { OwnerActionOutcome } from '@4thtech-io/core';
import {
  encodeBase64url,
  randomBytes,
  wipe,
  type JsonObject,
  type OwnerSession,
  type RecoveryKitStoreSource,
} from '@4thtech-io/crypto';
import { createKeyExportControl } from './key-controls.js';
import type { KeychainBackend } from './keychain.js';
import { MAX_KIT_IDS, writeKitRecord } from './kit-record.js';
import type { LocalUiRecoveryKitSource } from './local-ui/context.js';
import type { LocalUiRecoveryKitOutcome } from './local-ui/route-types.js';
import type { KeychainOwnerKeyStore } from './owner-keystore.js';
import type { OwnerReview, OwnerSignRequest, OwnerSignature } from './owner-operation.js';

type PrepareBackupExport = (
  kitId: string,
  contents: 'full' | 'identity',
) => Promise<
  { readonly status: 'prepared'; readonly body: unknown } | { readonly status: 'refused' }
>;

/** What the open agent's core offers this export (AgentLinkClient, read through these only). */
export interface RecoveryKitClient {
  readonly agentId: string;
  readonly ownerActions: {
    prepareBackupExport: PrepareBackupExport;
  };
}

/** One ID's public facts in a kit (never a secret). */
export interface RecoveryKitPeerSource {
  /** `0x` + 40 lowercase hex. */
  readonly agentId: string;
  /** The agent folder name (06 §6), the kit manifest's `name`. */
  readonly name: string;
  /** The ID's `store.sqlite`; its inter-process lock is `<path>.lock` (06 §6). */
  readonly storePath: string;
}

/**
 * WP-R2: another keychain ID of this owner to include (the host builds these; a file-KeyStore ID is
 * not included). Its own core prepares and applies its `backup.export`; it is valid only during the
 * `step` it is handed to (its core is closed right after).
 */
export interface RecoveryKitPeer {
  readonly source: RecoveryKitPeerSource;
  readonly prepareBackupExport: PrepareBackupExport;
  apply(signed: { readonly body: JsonObject; readonly sig: string }): Promise<OwnerActionOutcome>;
}

/**
 * WP-R2b (IR L-1): why an ID of this owner is not in the kit. Only `file_keystore` is one the owner
 * can back up in the terminal (`agentlink backup export --agent <name>`); `could_not_open` (its
 * folder or keychain items could not be read here just now) and `over_limit` (more than 16 IDs)
 * are not.
 */
export type RecoveryKitNotIncludedReason = 'file_keystore' | 'could_not_open' | 'over_limit';

/** WP-R2b: one ID of this owner the kit does not include, by folder name (never sealed). */
export interface RecoveryKitNotIncluded {
  readonly name: string;
  readonly reason: RecoveryKitNotIncludedReason;
}

const NOT_INCLUDED_REASONS: readonly string[] = ['file_keystore', 'could_not_open', 'over_limit'];

/**
 * WP-R2b: the host's walk over this owner's other IDs (approval-server.ts, AppHostSlot.visitOthers).
 * `each` hands `step` one ID at a time, with that ID's core the only one open in the host, and
 * closes it before the next; `step` resolving false stops the walk. The walk must end by
 * `deadlineAt` (the engine's clock, `now()`): the host bounds each open and each step by it and by
 * its own per-ID limit, and on a timeout closes that ID, opens the first ID again and reports
 * `ok: false`. `ok` is false when the walk stopped or could not finish. `notIncluded` names the
 * IDs of this owner it could not include, with the reason: never sealed, named on the page.
 */
export interface RecoveryKitOthers {
  each(
    step: (peer: RecoveryKitPeer) => Promise<boolean>,
    bounds: { readonly deadlineAt: number },
  ): Promise<{ readonly ok: boolean; readonly notIncluded: readonly RecoveryKitNotIncluded[] }>;
}

/**
 * WP-R2b (IR M-1): the time from the gesture to the last apply (milliseconds). The export session
 * lives OWNER_SESSION_DEFAULT_TTL_MS (60 s) from the gesture and the seal needs it too, so the walk
 * ends well inside it: EXPORT_BUDGET_MS + EXPORT_SEAL_MARGIN_MS <= the session's TTL.
 */
export const EXPORT_BUDGET_MS = 40_000;
/** WP-R2b: the part of the export session kept for sealing after the last apply. */
export const EXPORT_SEAL_MARGIN_MS = 20_000;

export interface RecoveryKitExportArgs {
  /** A session the paired store issued with unlockForExport (the gate's). */
  readonly session: OwnerSession;
  readonly ownerStore: KeychainOwnerKeyStore;
  /** The OS keychain holding the agents' items (keychain agents only). */
  readonly keychain: KeychainBackend;
  readonly source: LocalUiRecoveryKitSource;
  readonly client: RecoveryKitClient;
  readonly review: OwnerReview;
  /** Signs exactly `requests` with this gesture's session (checkGesture + signGesture). */
  sign(
    review: OwnerReview,
    requests: readonly OwnerSignRequest[],
  ): Promise<readonly OwnerSignature[]>;
  /** The open ID's core `ownerActions.apply`: verifies the owner signature, records the nonce row. */
  apply(signed: { readonly body: JsonObject; readonly sig: string }): Promise<OwnerActionOutcome>;
  /** Milliseconds. */
  now(): number;
  /** WP-R2b: this owner's other IDs, walked one at a time after the open one (at most 15). */
  readonly others?: RecoveryKitOthers;
  /**
   * WP-R2b: registers the file just sealed for Check (the restore engine's registerExportedKit,
   * bound to the page session); resolves the export handle, or undefined. Absent: no handle.
   */
  registerCheck?(file: {
    readonly path: string;
    readonly kitId: string;
  }): Promise<string | undefined>;
}

/** The saved outcome with what WP-R2 adds: the IDs it covers and the export handle for Check. */
export type RecoveryKitSaved = Extract<LocalUiRecoveryKitOutcome, { status: 'saved' }> & {
  /** The covered IDs in kit order (public facts only). */
  readonly covers: readonly { readonly agentId: string; readonly name: string }[];
  /** The export handle (the restore engine's), when the file just created could be registered. */
  readonly check?: string;
  /** WP-R2b: this owner's IDs the kit does not include, with the reason, when any. */
  readonly notIncluded?: readonly RecoveryKitNotIncluded[];
};

export type RecoveryKitExportOutcome =
  RecoveryKitSaved | Exclude<LocalUiRecoveryKitOutcome, { status: 'saved' }>;

const KIT_PREFIX = 'agentlink-recovery-kit-';
const KIT_EXT = '.alkk';
const MAX_SUFFIX = 99;
const READ_CHUNK = 1_048_576;
const AGENT_ID = /^0x[0-9a-f]{40}$/;
const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Exactly `backup.export` {kitId, "full"} for `agent` (what is signed; core checks it all again). */
function isExportBody(body: unknown, agent: string, kitId: string): body is JsonObject {
  if (!isObject(body) || !isObject(body['params'])) return false;
  const p = body['params'];
  return (
    body['op'] === 'backup.export' &&
    body['agent'] === agent &&
    typeof body['nonce'] === 'string' &&
    NONCE.test(body['nonce']) &&
    Object.keys(p).length === 2 &&
    p['kitId'] === kitId &&
    p['contents'] === 'full'
  );
}

const two = (n: number): string => String(n).padStart(2, '0');

/** The local date as `YYYY-MM-DD`. */
function dateOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** The Downloads folder when it is a folder, else the home folder. */
async function kitFolder(home: string): Promise<{ path: string; shown: 'Downloads' | 'Home' }> {
  const downloads = join(home, 'Downloads');
  try {
    if ((await stat(downloads)).isDirectory()) return { path: downloads, shown: 'Downloads' };
  } catch {
    // No Downloads folder: the home folder.
  }
  return { path: home, shown: 'Home' };
}

/** A free kit file name for today; the control's O_EXCL still refuses a race. */
async function freeName(folder: string, date: string): Promise<string | undefined> {
  for (let n = 1; n <= MAX_SUFFIX; n += 1) {
    const name = `${KIT_PREFIX}${date}${n === 1 ? '' : `-${n}`}${KIT_EXT}`;
    if (!(await exists(join(folder, name)))) return name;
  }
  return undefined;
}

/** The snapshot file's bytes in order, read after the lock hold ended. */
async function* fileChunks(path: string): AsyncIterable<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for (;;) {
      const buffer = new Uint8Array(READ_CHUNK);
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, null);
      if (bytesRead === 0) return;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

/** 04 §2.3.3 "Snapshot": `VACUUM INTO` a private file (run under the agent's lock by the control). */
async function snapshotOf(storePath: string, into: string): Promise<RecoveryKitStoreSource> {
  const db = new Database(storePath, { readonly: true, fileMustExist: true });
  try {
    db.prepare('VACUUM INTO ?').run(into);
  } finally {
    db.close();
  }
  await chmod(into, 0o600);
  const { size } = await lstat(into);
  return { length: size, chunks: fileChunks(into) };
}

/** Active contacts in a finished snapshot (the people of this ID at the save); 0 when unreadable. */
function peopleIn(snapshotPath: string): number {
  try {
    const db = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT count(*) AS n FROM contacts WHERE status = 'active'").get() as
        { n?: unknown } | undefined;
      const n = row?.n;
      return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/** One ID of the kit: its public facts, and its core's prepare and apply. */
interface KitPart {
  readonly source: RecoveryKitPeerSource;
  prepare(kitId: string): ReturnType<PrepareBackupExport>;
  apply(signed: { readonly body: JsonObject; readonly sig: string }): Promise<OwnerActionOutcome>;
}

/** True when `s` is a valid ID's public facts not yet in the kit, and the kit has room for it. */
function admissible(s: unknown, inKit: readonly KitPart[]): s is RecoveryKitPeerSource {
  if (inKit.length >= MAX_KIT_IDS) return false;
  if (
    !isObject(s) ||
    typeof s['agentId'] !== 'string' ||
    !AGENT_ID.test(s['agentId']) ||
    typeof s['name'] !== 'string' ||
    !AGENT_NAME.test(s['name']) ||
    typeof s['storePath'] !== 'string'
  ) {
    return false;
  }
  return !inKit.some((p) => p.source.agentId === s['agentId'] || p.source.name === s['name']);
}

/** The open ID's part, or undefined when its source does not name the open client. */
function openPart(args: RecoveryKitExportArgs): KitPart | undefined {
  const { source, client } = args;
  if (source.agentId !== client.agentId) return undefined;
  const facts = { agentId: source.agentId, name: source.name, storePath: source.storePath };
  if (!admissible(facts, [])) return undefined;
  return {
    source: facts,
    prepare: (kitId) => client.ownerActions.prepareBackupExport(kitId, 'full'),
    apply: (signed) => args.apply(signed),
  };
}

/** The one owner operation of saving a recovery kit (see the file comment). */
export async function exportRecoveryKit(
  args: RecoveryKitExportArgs,
): Promise<RecoveryKitExportOutcome> {
  const { source } = args;
  const first = openPart(args);
  if (first === undefined) return { status: 'failed' };
  const kitId = encodeBase64url(randomBytes(16));
  const deadline = args.now() + EXPORT_BUDGET_MS;

  // 1 and 2. One ID at a time, with its own core open: prepare, sign, apply.
  const parts: KitPart[] = [];
  const proofs: { readonly body: JsonObject; readonly sig: string }[] = [];
  // Set once the walk ended (also by a host timeout): a step still running signs and applies no more.
  let ended = false;
  const one = async (part: KitPart): Promise<boolean> => {
    if (ended || args.now() > deadline) return false;
    const prepared = await part.prepare(kitId);
    if (
      prepared.status !== 'prepared' ||
      !isExportBody(prepared.body, part.source.agentId, kitId)
    ) {
      return false;
    }
    const body = prepared.body;
    if (ended || args.now() > deadline) return false;
    const signatures = await args.sign(args.review, [{ kind: 'owner-action', action: body }]);
    const only = signatures[0];
    if (signatures.length !== 1 || only === undefined || only.kind !== 'owner-action') return false;
    if (ended) return false;
    const applied = await part.apply(only.signed);
    if (applied.status !== 'applied' || ended) return false;
    parts.push(part);
    proofs.push(only.signed);
    return true;
  };
  try {
    if (!(await one(first))) return { status: 'not_applied' };
  } catch {
    return { status: 'not_applied' };
  }
  let notIncluded: readonly RecoveryKitNotIncluded[] = [];
  if (args.others !== undefined) {
    let invalid = false;
    let walk: { readonly ok: boolean; readonly notIncluded: readonly RecoveryKitNotIncluded[] };
    try {
      // Deviation 1 (WP-R2b, IR L-2, put to the owner): with one core open at a time, a peer is
      // checked only when its turn comes, so the open ID (and any valid earlier peer) may already
      // be signed and applied when an invalid peer is found; that peer is never signed and nothing
      // is sealed (recovery-kit-export.test.ts "before that peer is signed").
      walk = await args.others.each(
        async (peer) => {
          const facts = isObject(peer) ? peer.source : undefined;
          if (!admissible(facts, parts)) {
            invalid = true;
            return false;
          }
          return one({
            source: { agentId: facts.agentId, name: facts.name, storePath: facts.storePath },
            prepare: (k) => peer.prepareBackupExport(k, 'full'),
            apply: (signed) => peer.apply(signed),
          });
        },
        Object.freeze({ deadlineAt: deadline }),
      );
    } catch {
      return { status: invalid ? 'failed' : 'not_applied' };
    } finally {
      ended = true;
    }
    if (invalid) return { status: 'failed' };
    if (!walk.ok) return { status: 'not_applied' };
    notIncluded = walk.notIncluded
      .filter(
        (one) =>
          isObject(one) &&
          typeof one.name === 'string' &&
          AGENT_NAME.test(one.name) &&
          NOT_INCLUDED_REASONS.includes(one.reason),
      )
      .map((one) => Object.freeze({ name: one.name, reason: one.reason }));
  }
  ended = true;
  if (args.now() > deadline) return { status: 'not_applied' };

  // 3. Only now, after every audit record, is anything sealed.
  const createdMs = args.now();
  const createdAt = Math.floor(createdMs / 1000);
  const folder = await kitFolder(source.home);
  const name = await freeName(folder.path, dateOf(createdMs));
  if (name === undefined) return { status: 'failed' };
  const path = join(folder.path, name);
  const agentlinkDir = join(source.home, '.agentlink');
  const storePaths = new Map(parts.map((p) => [p.source.agentId, p.source.storePath]));
  const people = new Map<string, number>();
  let temp: string | undefined;
  let code: Uint8Array | undefined;
  try {
    temp = await mkdtemp(join(tmpdir(), 'agentlink-kit-'));
    await chmod(temp, 0o700);
    const snapshotDir = temp;
    const storePathOf = (agentId: string): string => {
      const found = storePaths.get(agentId);
      if (found === undefined) throw new Error('not in this kit');
      return found;
    };
    const control = createKeyExportControl({
      owner: args.ownerStore,
      itemsOf: () => args.keychain,
      storePathOf,
      agentlinkDir,
      ...(source.kdf === undefined ? {} : { kdf: source.kdf }),
    });
    code = await control.sealRecoveryKit(args.session, {
      kitId,
      createdAt,
      contents: 'full',
      agents: parts.map((p) => ({ agentId: p.source.agentId, name: p.source.name })),
      // Called by the control under each ID's own lock hold: that ID's consistent cut.
      snapshots: async (agentId: string) => {
        const into = join(snapshotDir, `store-${people.size}.sqlite`);
        const snapshot = await snapshotOf(storePathOf(agentId), into);
        people.set(agentId, peopleIn(into));
        return snapshot;
      },
      path,
    });
    const shown = new TextDecoder().decode(code);

    // 4. The kit is sealed and closed: the export handle (the file just created) and the record.
    let created: { dev: number; ino: number } | undefined;
    try {
      const info = await lstat(path);
      if (info.isFile()) created = { dev: info.dev, ino: info.ino };
    } catch {
      created = undefined;
    }
    // A display aid (G-1): if it cannot be written the save still stands; nothing is logged.
    await writeKitRecord(agentlinkDir, {
      v: 1,
      kitId,
      at: createdAt,
      covers: parts.map((p) => p.source.agentId),
      names: Object.fromEntries(parts.map((p) => [p.source.agentId, p.source.name])),
      peopleAtSave: Object.fromEntries(
        parts.map((p) => [p.source.agentId, people.get(p.source.agentId) ?? 0]),
      ),
      // WP-R2b (IR L-3): each ID's signed backup.export, so core can match this very save.
      exports: Object.fromEntries(
        parts.map((p, i) => [p.source.agentId, proofs[i] as { body: JsonObject; sig: string }]),
      ),
      contents: 'full',
      file: path,
    }).catch(() => undefined);
    let check: string | undefined;
    if (created !== undefined && args.registerCheck !== undefined) {
      try {
        check = await args.registerCheck({ path, kitId });
      } catch {
        check = undefined;
      }
    }
    return {
      status: 'saved',
      file: name,
      folder: folder.shown,
      code: shown,
      covers: Object.freeze(
        parts.map((p) => Object.freeze({ agentId: p.source.agentId, name: p.source.name })),
      ),
      ...(check === undefined ? {} : { check }),
      ...(notIncluded.length === 0 ? {} : { notIncluded: Object.freeze([...notIncluded]) }),
    };
  } catch {
    // The control deletes a kit it did not finish; the error's text is never passed on (I-7).
    return { status: 'failed' };
  } finally {
    wipe(code);
    if (temp !== undefined) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}
