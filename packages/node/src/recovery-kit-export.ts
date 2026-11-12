// WP-11 (F-1 full; D-117 A; 04 §2.3.3 "Export: who sees the seeds", "Snapshot", §2.5.1
// `backup.export`; 07 §9.4) and WP-R2 (D-147 (2), (6), (7); 04 §2.3.3 "In the local app", "Kit
// record", "Check that my kit opens"): saving one recovery kit of every ID of this owner from the
// local app.
//
// I-4: called only from the app host's presence gate (approval-server.ts `exportRecoveryKit`), with
// the owner session that gate unlocked for an export (KeychainOwnerKeyStore.unlockForExport) from the
// presence this request carried. In order, inside that one owner operation:
//   1. the server draws one kitId (16 CSPRNG bytes); core prepares `backup.export` {kitId, "full"} for
//      the open ID and for each other ID the host passes (`others`, each with its own core), all with
//      that kitId; the gate's `sign` signs each body, one checked request per call, with this one
//      gesture's session (one entry of the owner secret covers them, 04 §2.5 "One entry");
//   2. each ID's core applies its own (its nonce row is the audit record, 07 §3.4); if any is
//      refused, nothing is sealed;
//   3. the KeyExportControl seals the owner seed, each ID's KeyStore items and its store snapshot as
//      `ALKK` v1 into one new file (O_CREAT | O_EXCL | O_NOFOLLOW, 0600, never under ~/.agentlink) in
//      the Downloads folder, else the home folder, and returns one new recovery code for display once;
//   4. the kit record `~/.agentlink/kit-record.json` is written (kit-record.ts; a display aid, its
//      failure keeps the save) and an in-memory export handle is issued for Check (the device and
//      inode of the file just created; the page never sees the path).
// Each snapshot is `VACUUM INTO` a private temporary file under that ID's own lock hold (the control
// holds it, one ID at a time), read back after the hold, and deleted at the end whatever happened.
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
import {
  MAX_KIT_IDS,
  kitExportHandles,
  writeKitRecord,
  type KitExportHandles,
} from './kit-record.js';
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
 * not included). Its own core prepares and applies its `backup.export`.
 */
export interface RecoveryKitPeer {
  readonly source: RecoveryKitPeerSource;
  readonly prepareBackupExport: PrepareBackupExport;
  apply(signed: { readonly body: JsonObject; readonly sig: string }): Promise<OwnerActionOutcome>;
}

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
  /** WP-R2: this owner's other IDs, in kit order after the open one (at most 15). */
  readonly others?: readonly RecoveryKitPeer[];
  /** WP-R2: the export handle registry; default the server process's (kit-record.ts). */
  readonly handles?: KitExportHandles;
}

/** The saved outcome with what WP-R2 adds: the IDs it covers and the export handle for Check. */
export type RecoveryKitSaved = Extract<LocalUiRecoveryKitOutcome, { status: 'saved' }> & {
  /** The covered IDs in kit order (public facts only). */
  readonly covers: readonly { readonly agentId: string; readonly name: string }[];
  /** The export handle (kit-record.ts), when the file just created could be identified. */
  readonly check?: string;
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

/** The parts in kit order (the open ID first), or undefined when any is not valid or listed twice. */
function partsOf(args: RecoveryKitExportArgs): readonly KitPart[] | undefined {
  const { source, client } = args;
  if (source.agentId !== client.agentId) return undefined;
  const parts: KitPart[] = [
    {
      source: { agentId: source.agentId, name: source.name, storePath: source.storePath },
      prepare: (kitId) => client.ownerActions.prepareBackupExport(kitId, 'full'),
      apply: (signed) => args.apply(signed),
    },
  ];
  for (const peer of args.others ?? []) {
    parts.push({
      source: peer.source,
      prepare: (kitId) => peer.prepareBackupExport(kitId, 'full'),
      apply: (signed) => peer.apply(signed),
    });
  }
  if (parts.length > MAX_KIT_IDS) return undefined;
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const { source: s } of parts) {
    if (
      !isObject(s) ||
      typeof s.agentId !== 'string' ||
      !AGENT_ID.test(s.agentId) ||
      typeof s.name !== 'string' ||
      !AGENT_NAME.test(s.name) ||
      typeof s.storePath !== 'string' ||
      ids.has(s.agentId) ||
      names.has(s.name)
    ) {
      return undefined;
    }
    ids.add(s.agentId);
    names.add(s.name);
  }
  return parts;
}

/** The one owner operation of saving a recovery kit (see the file comment). */
export async function exportRecoveryKit(
  args: RecoveryKitExportArgs,
): Promise<RecoveryKitExportOutcome> {
  const { source } = args;
  const parts = partsOf(args);
  if (parts === undefined) return { status: 'failed' };
  const kitId = encodeBase64url(randomBytes(16));

  // 1. Core prepares one backup.export per ID, all with this kitId.
  const bodies: JsonObject[] = [];
  for (const part of parts) {
    const prepared = await part.prepare(kitId);
    if (
      prepared.status !== 'prepared' ||
      !isExportBody(prepared.body, part.source.agentId, kitId)
    ) {
      return { status: 'not_applied' };
    }
    bodies.push(prepared.body);
  }
  // 1b. This gesture's session signs each, one checked request per call.
  const signed: { readonly body: JsonObject; readonly sig: string }[] = [];
  for (const body of bodies) {
    const signatures = await args.sign(args.review, [{ kind: 'owner-action', action: body }]);
    const only = signatures[0];
    if (signatures.length !== 1 || only === undefined || only.kind !== 'owner-action') {
      return { status: 'not_applied' };
    }
    signed.push(only.signed);
  }
  // 2. Each ID's core applies its own (the audit rows); if any is refused, nothing is sealed.
  for (const [i, part] of parts.entries()) {
    const one = signed[i];
    if (one === undefined) return { status: 'not_applied' };
    let applied: OwnerActionOutcome;
    try {
      applied = await part.apply(one);
    } catch {
      return { status: 'not_applied' };
    }
    if (applied.status !== 'applied') return { status: 'not_applied' };
  }

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
      exports: Object.fromEntries(
        parts.map((p, i) => [p.source.agentId, String(bodies[i]?.['nonce'])]),
      ),
      contents: 'full',
      file: path,
    }).catch(() => undefined);
    const check =
      created === undefined
        ? undefined
        : (args.handles ?? kitExportHandles).issue({ kitId, path, ...created });
    return {
      status: 'saved',
      file: name,
      folder: folder.shown,
      code: shown,
      covers: Object.freeze(
        parts.map((p) => Object.freeze({ agentId: p.source.agentId, name: p.source.name })),
      ),
      ...(check === undefined ? {} : { check }),
    };
  } catch {
    // The control deletes a kit it did not finish; the error's text is never passed on (I-7).
    return { status: 'failed' };
  } finally {
    wipe(code);
    if (temp !== undefined) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}
