// WP-11 (F-1 full; D-117 A; 04 §2.3.3 "Export: who sees the seeds", "Snapshot", §2.5.1
// `backup.export`; 07 §9.4): saving the open agent's recovery kit from the local app.
//
// I-4: called only from the app host's presence gate (approval-server.ts `exportRecoveryKit`), with
// the owner session that gate unlocked for an export (KeychainOwnerKeyStore.unlockForExport) from the
// presence this request carried. In order, inside that one owner operation:
//   1. the server draws the kitId (16 CSPRNG bytes); core prepares `backup.export` {kitId, "full"}
//      for the open agent; the gate signs exactly that body;
//   2. core applies it (its nonce row is the audit record, 07 §3.4); without `applied` nothing is
//      sealed;
//   3. the KeyExportControl seals the owner seed, the agent's KeyStore items and its store snapshot as
//      `ALKK` v1 into a new file (O_CREAT | O_EXCL | O_NOFOLLOW, 0600, never under ~/.agentlink) in
//      the Downloads folder, else the home folder, and returns a new recovery code for display once.
// The snapshot is `VACUUM INTO` a private temporary file under the agent's lock hold (the control
// holds it), read back after the hold, and deleted at the end whatever happened.
//
// Zero access: nothing here talks to any network. Nothing is logged; failures are fixed outcomes
// that never carry a path, a code or an error's text (I-7). The code leaves as display text only.
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, rm, stat } from 'node:fs/promises';
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
import type { LocalUiRecoveryKitSource } from './local-ui/context.js';
import type { LocalUiRecoveryKitOutcome } from './local-ui/route-types.js';
import type { KeychainOwnerKeyStore } from './owner-keystore.js';
import type { OwnerReview, OwnerSignRequest, OwnerSignature } from './owner-operation.js';

/** What the open agent's core offers this export (AgentLinkClient, read through these only). */
export interface RecoveryKitClient {
  readonly agentId: string;
  readonly ownerActions: {
    prepareBackupExport(
      kitId: string,
      contents: 'full' | 'identity',
    ): Promise<
      { readonly status: 'prepared'; readonly body: unknown } | { readonly status: 'refused' }
    >;
  };
}

export interface RecoveryKitExportArgs {
  /** A session the paired store issued with unlockForExport (the gate's). */
  readonly session: OwnerSession;
  readonly ownerStore: KeychainOwnerKeyStore;
  /** The OS keychain holding the agent's items (keychain agents only). */
  readonly keychain: KeychainBackend;
  readonly source: LocalUiRecoveryKitSource;
  readonly client: RecoveryKitClient;
  readonly review: OwnerReview;
  /** Signs exactly `requests` with this gesture's session (checkGesture + signGesture). */
  sign(
    review: OwnerReview,
    requests: readonly OwnerSignRequest[],
  ): Promise<readonly OwnerSignature[]>;
  /** core `ownerActions.apply`: verifies the owner signature, then records the nonce row. */
  apply(signed: { readonly body: JsonObject; readonly sig: string }): Promise<OwnerActionOutcome>;
  /** Milliseconds. */
  now(): number;
}

const KIT_PREFIX = 'agentlink-recovery-kit-';
const KIT_EXT = '.alkk';
const MAX_SUFFIX = 99;
const READ_CHUNK = 1_048_576;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Exactly `backup.export` {kitId, "full"} for `agent` (what is signed; core checks it all again). */
function isExportBody(body: unknown, agent: string, kitId: string): body is JsonObject {
  if (!isObject(body) || !isObject(body['params'])) return false;
  const p = body['params'];
  return (
    body['op'] === 'backup.export' &&
    body['agent'] === agent &&
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
    await stat(path);
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
  const { size } = await stat(into);
  return { length: size, chunks: fileChunks(into) };
}

/** The one owner operation of saving a recovery kit (see the file comment). */
export async function exportRecoveryKit(
  args: RecoveryKitExportArgs,
): Promise<LocalUiRecoveryKitOutcome> {
  const { source, client } = args;
  if (source.agentId !== client.agentId) return { status: 'failed' };
  const kitId = encodeBase64url(randomBytes(16));
  const prepared = await client.ownerActions.prepareBackupExport(kitId, 'full');
  if (prepared.status !== 'prepared' || !isExportBody(prepared.body, client.agentId, kitId)) {
    return { status: 'not_applied' };
  }
  const signatures = await args.sign(args.review, [
    { kind: 'owner-action', action: prepared.body },
  ]);
  const first = signatures[0];
  if (signatures.length !== 1 || first === undefined || first.kind !== 'owner-action') {
    return { status: 'not_applied' };
  }
  let applied: OwnerActionOutcome;
  try {
    applied = await args.apply(first.signed);
  } catch {
    return { status: 'not_applied' };
  }
  if (applied.status !== 'applied') return { status: 'not_applied' };

  // Only now, after the audit record, is anything sealed.
  const createdMs = args.now();
  const folder = await kitFolder(source.home);
  const name = await freeName(folder.path, dateOf(createdMs));
  if (name === undefined) return { status: 'failed' };
  let temp: string | undefined;
  let code: Uint8Array | undefined;
  try {
    temp = await mkdtemp(join(tmpdir(), 'agentlink-kit-'));
    await chmod(temp, 0o700);
    const snapshotPath = join(temp, 'store.sqlite');
    const control = createKeyExportControl({
      owner: args.ownerStore,
      itemsOf: () => args.keychain,
      storePathOf: () => source.storePath,
      agentlinkDir: join(source.home, '.agentlink'),
      ...(source.kdf === undefined ? {} : { kdf: source.kdf }),
    });
    code = await control.sealRecoveryKit(args.session, {
      kitId,
      createdAt: Math.floor(createdMs / 1000),
      contents: 'full',
      agents: [{ agentId: source.agentId, name: source.name }],
      snapshots: () => snapshotOf(source.storePath, snapshotPath),
      path: join(folder.path, name),
    });
    return {
      status: 'saved',
      file: name,
      folder: folder.shown,
      code: new TextDecoder().decode(code),
    };
  } catch {
    // The control deletes a kit it did not finish; the error's text is never passed on (I-7).
    return { status: 'failed' };
  } finally {
    wipe(code);
    if (temp !== undefined) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}
