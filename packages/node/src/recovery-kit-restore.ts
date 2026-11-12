// UX1113-R1 (D-147; 04 §2.3.3 "Restore", "Restore in the app", "Restore never overwrites", §2.5
// "Restore-only owner session"; 06 §8 `agentlink backup restore`; threats T-1 to T-12): the restore
// engine behind the app's /api/ui/restore/* routes (local-ui/api/restore.ts, run by the approval
// server's restore gate) and `agentlink restore`. Same KeyImportControl as every restore.
//
// - Authority (D-115 E): the kit plus its recovery code typed by a person. Nothing here signs an
//   owner action. With an owner on this computer, owner presence first (the seedless restore-only
//   session, bound to the kit's header hash). With none, nothing is written in the app without a
//   fresh user-verified WebAuthn create bound to the plan (T-1); the terminal path (no gesture) is
//   reachable only through createTerminalRestore, which no route holds.
// - Files (T-6): the page only ever sees opaque 128-bit handles bound to its session, valid 10
//   minutes. A kit is read only from a descriptor opened O_RDONLY | O_NOFOLLOW | O_NONBLOCK and
//   checked by fstat against what was listed (device, inode, size, mtime); never by path again.
// - Limits (T-4, T-5, T-7): three wrong codes per kit header, then a doubling wait (30 s to 15 min)
//   shared by open and check; one KDF at a time; one opened kit and one pending gesture per server;
//   uploads at most one per session and two in all, 4 GiB together, 1 GiB left free.
// - Answers (T-3, T-11): fixed codes only; never the code, a path, a seed or a library message.
//   Nothing is logged here.
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  statfs,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentLinkClient, isRestrictedAlias, type ApprovalChannel } from '@4thtech-io/core';
import {
  CryptoInputError,
  KeyStoreError,
  RECOVERY_KIT_LIMITS,
  canonicalize,
  concatBytes,
  decodeBase64url,
  decodeHex,
  decodeHex0x,
  decodeUtf8,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  equalBytes,
  ownerPrfSalt,
  randomBytes,
  readPasskeyBlobHeader,
  readRecoveryKitHeader,
  sha256,
  verifyWebauthnSignature,
  webauthnPublicKeyFromAuthenticatorData,
  wipe,
  type Argon2idParams,
  type JsonValue,
  type KeyStore,
  type OwnerPresence,
  type RecoveryKitImport,
  type RecoveryKitStoreSink,
} from '@4thtech-io/crypto';
import {
  createKeyImportControl,
  discardImportedAgent,
  importOwnerPasskey,
  importRestoredOwner,
  inOwnersRevokedList,
  unlockForRestore,
  type RestoreOwnerSessionHold,
} from './key-controls.js';
import { keychainAccount, osKeychain, type KeychainBackend } from './keychain.js';
import { markKitRecordChecked } from './kit-record.js';
import { openAgentStoreWith, type AgentStore } from './agent-store.js';
import { KEYCHAIN_CALL_TIMEOUT_MS, guarded, openRecordedKeyStore } from './keychain-keystore.js';
import { ttyOwnerTerminal } from './owner-terminal.js';
import {
  OWNER_ACCOUNT,
  OWNER_NEXT_ACCOUNT,
  readOwnerItem,
  removeOwnerItemIfOurs,
} from './owner-keystore.js';
import {
  readUnsavedMarker,
  removeUnsavedMarker,
  writeUnsavedMarker,
  type UnsavedKind,
} from './master-code-unsaved.js';
import {
  PASSKEY_RP_ID,
  assertPasskeyAssertion,
  parsePasskeyAssertion,
  readOwnerPasskeyHeader,
  readOwnerPasskeyItem,
  removeOwnerPasskeyItemIfOurs,
} from './owner-passkey.js';
import {
  checkSetupRegistration,
  defaultOwnerFiles,
  parseSetupRegistration,
  type SetupRegistration,
} from './owner-setup.js';
import {
  createRestoreQuarantine,
  installRestoredStore,
  peekQuarantinedSnapshot,
  quarantineAuthenticated,
  processAlive,
  removeStaleRestoreFiles,
  restoreFileName,
  trackRestoreFile,
} from './restore-quarantine.js';

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = constants;

/** 04 §2.3.3: a handle, the opened kit and the restore-only session last 10 minutes. */
export const RESTORE_HANDLE_TTL_MS = 600_000;
/** 04 §2.3.3: the gesture challenge of apply/begin (and the PRF get()) lasts 120 s. */
export const RESTORE_GESTURE_TTL_MS = 120_000;
/** 04 §2.3.3: at most 20 kits are listed. */
export const RESTORE_MAX_FOUND = 20;
const HEADER_LENGTH = 74;
const FREE_MARGIN = 1_073_741_824;
/** How often free space is checked again while an upload streams. */
const FREE_RECHECK_BYTES = 64 * 1_048_576;
const MAX_UPLOADS = 2;
const FIRST_WAIT_S = 30;
const MAX_WAIT_S = 900;
const FREE_TRIES = 3;
const GESTURE_TRIES = 3;
const MAX_HANDLES_PER_SESSION = 200;
const KIT_NAME = /^agentlink-recovery-kit[A-Za-z0-9._-]{0,64}\.alkk$/;
const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const AGENT_ID = /^0x[0-9a-f]{40}$/;
const HANDLE = /^[A-Za-z0-9_-]{22}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const PENDING_FILE = 'restore-pending.json';
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const RESTORE_LABEL = encodeUtf8('agentlink-restore-v1');
const RESTORE_PRF_LABEL = encodeUtf8('agentlink-restore-prf-v1');
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

/** A fixed answer: an HTTP status and a JSON body (never an error's text). */
export interface RestoreAnswer {
  readonly status: number;
  readonly body: JsonValue;
}

/** The fixed failure codes of 04 §2.3.3 "Words and errors" (plus `invalid` and `failed`). */
export type RestoreError =
  | 'not_a_kit'
  | 'newer_version'
  | 'other_owner'
  | 'wrong_code'
  | 'damaged'
  | 'wait'
  | 'busy'
  | 'presence_required'
  | 'presence_rejected'
  | 'needs_terminal'
  | 'expired'
  | 'too_large'
  | 'invalid'
  | 'failed';

const STATUS: Readonly<Record<RestoreError, number>> = Object.freeze({
  not_a_kit: 409,
  newer_version: 409,
  other_owner: 409,
  wrong_code: 422,
  damaged: 422,
  wait: 429,
  busy: 409,
  presence_required: 403,
  presence_rejected: 403,
  needs_terminal: 409,
  expired: 410,
  too_large: 413,
  invalid: 400,
  failed: 500,
});

const fail = (error: RestoreError, extra: Record<string, JsonValue> = {}): RestoreAnswer =>
  Object.freeze({ status: STATUS[error], body: Object.freeze({ error, ...extra }) });
const ok = (body: Record<string, JsonValue>): RestoreAnswer =>
  Object.freeze({ status: 200, body: Object.freeze(body) });

export interface RestoreEngineOptions {
  /** The OS user's home folder (`~`). */
  readonly home: string;
  /** This computer's keychain (the app restores to the keychain backend only). */
  readonly keychain: () => KeychainBackend;
  /** `http://localhost:<port>`: the WebAuthn origin the creation must name. */
  readonly origin: string;
  readonly now?: () => number;
  /** Argon2id parameters of the new master code's wrap (tests use the floor). */
  readonly kdf?: Argon2idParams;
  /**
   * The owner key this computer is known to have before any presence (the open ID's card), for the
   * `other_owner` answer before a code is asked. The `owner-passkey` header is read too.
   */
  readonly knownOwnerNostr?: () => Promise<Uint8Array | undefined>;
  /** The 07 §9.1 keychain probe; false: the app answers `needs_terminal`. Default true. */
  readonly keychainUsable?: () => Promise<boolean>;
  /** After a restore wrote IDs (folder names, kit order): the app host opens one. */
  readonly onRestored?: (names: readonly string[]) => Promise<void> | void;
  /**
   * REL051-SF3 (04 §2.5): the server's shared presence backoff. When given, a wrong proof on the
   * restore presence step counts there (and its wait holds this step), not on a counter of its own.
   */
  readonly presenceBackoff?: {
    readonly waitSeconds: () => number;
    readonly failed: () => void;
    readonly succeeded: () => void;
  };
  /** Test seams. */
  readonly maxUploadBytes?: number;
  /** Limit of each native keychain read (default KEYCHAIN_CALL_TIMEOUT_MS). */
  readonly keychainTimeoutMs?: number;
  readonly freeBytes?: (dir: string) => Promise<number | undefined>;
  /**
   * REL051-CF3 (T-7): whether the run that wrote the unsaved-master-code marker still runs (its
   * owner write may be in progress). Default: this process, or a live process with that ID.
   */
  readonly runAlive?: (pid: number) => boolean;
}

/** REL051-CF3: what the page says about a master code that was made here and not saved. */
export type MasterCodeState =
  | { readonly status: 'none' }
  /** Restored IDs wait for their owner: "Finish restoring" with the same kit. */
  | { readonly status: 'finish_restore' }
  /** The code was made and never saved; `touchId`: a passkey can approve making a new one. */
  | { readonly status: 'lost'; readonly kind: UnsavedKind; readonly touchId: boolean };

/** The route-facing restore engine. No member writes an owner without the gesture or a session. */
export interface RestoreEngine {
  found(session: string): Promise<RestoreAnswer>;
  upload(
    session: string,
    chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    declaredLength: number | undefined,
  ): Promise<RestoreAnswer>;
  header(session: string, input: JsonValue | undefined): Promise<RestoreAnswer>;
  presence(
    session: string,
    input: JsonValue | undefined,
    proof: Uint8Array,
    mode: 'passphrase' | 'passkey',
  ): Promise<RestoreAnswer>;
  open(session: string, input: JsonValue | undefined, code: Uint8Array): Promise<RestoreAnswer>;
  check(session: string, input: JsonValue | undefined, code: Uint8Array): Promise<RestoreAnswer>;
  cancel(session: string, input: JsonValue | undefined): Promise<RestoreAnswer>;
  applyBegin(session: string, input: JsonValue | undefined): Promise<RestoreAnswer>;
  applyFinish(
    session: string,
    input: JsonValue | undefined,
    body: Uint8Array,
  ): Promise<RestoreAnswer>;
  /**
   * WP-R2 hook (04 §2.3.3 "Check that my kit opens"): right after the export route sealed a kit,
   * a single-use handle for exactly that file (its device and inode now) and that `kitId`, bound to
   * the page session, for `check` only. Undefined when the file is not a regular file.
   */
  registerExportedKit(
    session: string,
    file: { readonly path: string; readonly kitId: string },
  ): Promise<string | undefined>;
  /** First run's guard: restored IDs wait for their owner (a crash between agents and owner). */
  restorePending(): Promise<boolean>;
  /**
   * First run's hold (fail closed): `finish_restore` while restored IDs wait for their owner,
   * `keychain_unavailable` when the keychain did not answer (never read as "no owner"), else
   * undefined.
   */
  firstRunHold(): Promise<FirstRunHold | undefined>;
  /**
   * REL051-CF3 (R1-CLASS-04; T-7): at start-up, an owner item that a restore which is gone wrote and
   * whose master code never left the server (marker `writing`, exactly that item, no passkey item) is
   * removed again, so first run says "Finish restoring" instead of asking for a code nobody has. A
   * marker with no owner item goes. Anything else is kept. Never throws.
   */
  settle(): Promise<void>;
  /** REL051-CF3: the unsaved master code's state for the page (never the code). */
  masterCodeState(): Promise<MasterCodeState>;
  /** REL051-CF3: "I saved it" (or the code was replaced): the marker goes. */
  masterCodeSaved(): Promise<void>;
  /**
   * REL051-SF3 (T-7): removes the quarantine and upload files of restores that are gone (the engine
   * runs it after every apply and cancel; the server sweeps the folder itself when it starts).
   * Never a live engine's.
   */
  sweep(): Promise<void>;
  close(): Promise<void>;
}

/** Why first run may not create an owner now (04 §2.3.3; fail closed). */
export type FirstRunHold = 'finish_restore' | 'keychain_unavailable';

/** The terminal's restore (`agentlink restore`): the engine plus a path and the no-gesture apply. */
export interface TerminalRestore extends RestoreEngine {
  /** A handle for a kit file the owner named in the command (a regular file, never a link). */
  fileHandle(session: string, path: string): Promise<string | undefined>;
  /**
   * The terminal's apply: no WebAuthn; the TTY and harness-marker guard of the CLI stand where the
   * app's gesture stands (06 §8). Writes the owner under a new master code when none exists.
   */
  applyInTerminal(session: string, input: JsonValue | undefined): Promise<RestoreAnswer>;
}

interface FileRef {
  readonly kind: 'found' | 'upload' | 'export' | 'terminal';
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly kitId?: string;
}

interface UploadEntry {
  handle: string | undefined;
  size: number;
  streaming: boolean;
}

interface HandleEntry {
  readonly session: string;
  readonly file: FileRef;
  readonly expiresAt: number;
}

interface SummaryRow {
  readonly agentId: string;
  readonly name: string;
  readonly people: number;
  readonly lastMessageAt: number | null;
  readonly state: 'new' | 'name_taken' | 'already_here' | 'removed_earlier';
  readonly suggestedName?: string;
  /**
   * UX1113-QA2 N4: for an ID already on this computer, the label this computer shows for it (its
   * config.json `label`, written only after core verified an `agent.label`); never for a new ID
   * (the kit's manifest has no label, so step 3 stays by folder).
   */
  readonly label?: string;
  /** UX1113-QA2: for `name_taken`, the label of the ID already here in that folder, when known. */
  readonly takenLabel?: string;
}

interface HeldKit {
  readonly handle: string;
  readonly session: string;
  readonly kit: RecoveryKitImport;
  readonly headerHash: Uint8Array;
  readonly rows: readonly SummaryRow[];
  readonly restore?: RestoreOwnerSessionHold;
  readonly expiresAt: number;
}

interface Plan {
  readonly selection: readonly string[];
  readonly names: Readonly<Record<string, string>>;
}

interface PendingGesture {
  readonly session: string;
  readonly kit: string;
  readonly plan: Plan;
  nonce: Uint8Array;
  challenge: Uint8Array;
  expiresAt: number;
  stage: 'create' | 'prf';
  created?: SetupRegistration;
  tries: number;
}

interface RestoreSessionEntry {
  readonly hold: RestoreOwnerSessionHold;
  readonly expiresAt: number;
}

const sessionKey = (token: string): string => encodeHex(sha256(encodeUtf8(token)));
const newHandle = (): string => encodeBase64url(randomBytes(16));
const ascii = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

function objectInput(input: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, JsonValue>)
    : undefined;
}

function handleOf(input: JsonValue | undefined, key = 'handle'): string | undefined {
  const value = objectInput(input)?.[key];
  return typeof value === 'string' && HANDLE.test(value) ? value : undefined;
}

/**
 * The text of a small regular file at `path`, or undefined when it is missing, a link, not a regular
 * file, or unreadable. Opened once with O_NOFOLLOW and checked by fstat on that descriptor; read
 * from the descriptor only, never by path again (04 §2.3.3, §4: no check-then-use by path).
 */
async function readRegularText(path: string): Promise<string | undefined> {
  let fh: FileHandle;
  try {
    fh = await open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const info = await fh.stat();
    if (!info.isFile()) return undefined;
    return await fh.readFile('utf8');
  } catch {
    return undefined;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Reads `length` bytes from position 0 of `fh` (fewer at the end of the file). */
async function readHead(fh: FileHandle, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(out, done, length - done, done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return out.subarray(0, done);
}

/** The kit's bytes, from the descriptor only, in 1 MiB pieces, exactly `size` of them. */
async function* chunksOf(fh: FileHandle, size: number): AsyncGenerator<Uint8Array> {
  let at = 0;
  while (at < size) {
    const piece = new Uint8Array(Math.min(1_048_576, size - at));
    const { bytesRead } = await fh.read(piece, 0, piece.length, at);
    if (bytesRead === 0) throw new CryptoInputError('open_failed', 'restore: the kit is short');
    at += bytesRead;
    yield piece.subarray(0, bytesRead);
  }
}

/**
 * REL051-SF3 (T-2, T-4): passes `chunks` through, checking that their first bytes are exactly `head`
 * (the header read, hashed and bound from the same descriptor). On a difference it sets
 * `state.changed` and stops the stream.
 */
async function* sameHead(
  chunks: AsyncIterable<Uint8Array>,
  head: Uint8Array,
  state: { changed: boolean },
): AsyncGenerator<Uint8Array> {
  let seen = 0;
  for await (const chunk of chunks) {
    if (seen < head.length) {
      const n = Math.min(chunk.length, head.length - seen);
      if (!equalBytes(chunk.subarray(0, n), head.subarray(seen, seen + n))) {
        state.changed = true;
        throw new CryptoInputError('open_failed', 'restore: the kit changed while it was read');
      }
      seen += n;
    }
    yield chunk;
  }
  if (seen < head.length) {
    state.changed = true;
    throw new CryptoInputError('open_failed', 'restore: the kit changed while it was read');
  }
}

type HeaderOutcome = 'ok' | 'not_a_kit' | 'newer_version';

function headerOutcome(head: Uint8Array): { outcome: HeaderOutcome; ownerNostr?: Uint8Array } {
  if (head.length < HEADER_LENGTH || ascii(head.subarray(0, 4)) !== 'ALKK') {
    return { outcome: 'not_a_kit' };
  }
  try {
    const header = readRecoveryKitHeader(head);
    return { outcome: 'ok', ownerNostr: header.ownerNostr };
  } catch {
    return { outcome: 'newer_version' };
  }
}

type CoreLogger = NonNullable<Parameters<typeof AgentLinkClient.create>[0]['logger']>;

/**
 * IR-UX1113-R1 round 2: the cores the engine opens (read-back, verified cards for the header step,
 * first run and doctor) write no log line: restore's log surface stays the spec's (none here).
 */
const SILENT_LOGGER: CoreLogger = (() => {
  const silent = {
    level: 'error',
    isEnabled: () => false,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silent,
    withCodes: () => silent,
  };
  return Object.freeze(silent) as unknown as CoreLogger;
})();

const NO_APPROVALS: ApprovalChannel = Object.freeze({
  request: (request: { readonly approvalId: string }) =>
    Promise.resolve({ approvalId: request.approvalId }),
  status: () => Promise.resolve({ state: 'pending' as const }),
}) as unknown as ApprovalChannel;

/**
 * 04 §2.3.3 restore step 7 (IR-UX1113-R1 M2): opens the restored ID with its recorded KeyStore and
 * its store, as every start does: the KeyStore's agent is `agentId`, the stored card re-verifies
 * (both signatures) for that agent and names `ownerNostr`, and the policy loads at the restored
 * `policy-version` mark (not fail closed). Nothing is written; everything is closed again.
 */
async function readBack(
  keychain: KeychainBackend,
  agentId: string,
  ownerNostr: Uint8Array,
  path: string,
): Promise<{ readonly label: LabelReadingLike | undefined } | undefined> {
  const seen = await inspectId(keychain, agentId, path);
  if (seen === undefined || !seen.policyLoads || !equalBytes(seen.ownerNostr, ownerNostr)) {
    return undefined;
  }
  return { label: seen.label };
}

/** Core `loadLabel`'s answer, as the read-back keeps it. */
type LabelReadingLike =
  | { readonly status: 'verified'; readonly label: string }
  | { readonly status: 'none' | 'unverified' };

const LABEL_CHARS = /^[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N} ._'-]*[\p{L}\p{M}\p{N}._'-])?$/u;

/**
 * UX1113-QA2 N4: the agent-folder label rule (apps/cli/src/runtime/agent-name.ts `isAgentLabel`, 06 §6, 11 §5.8):
 * 1 to 32 code points of letters, digits, spaces, `.`, `'` and `-`, NFC, no space at either end and
 * no two in a row. Only such a label is written to a restored ID's config.json, so the folder always
 * parses (a label outside it would make the CLI refuse the folder).
 */
const CONFIG_LABEL_CHARS = /^[\p{L}\p{N} .'-]+$/u;
export function isConfigLabel(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const length = [...value].length;
  if (length < 1 || length > 32) return false;
  if (value.normalize('NFC') !== value) return false;
  if (value.startsWith(' ') || value.endsWith(' ') || value.includes('  ')) return false;
  return CONFIG_LABEL_CHARS.test(value);
}

/**
 * UX1113-R1-LABEL: what the done answer names a restored ID by. Display text only (never decides
 * anything): the label core verified at the read-back (owner-signed `agent.label` in the restored
 * store), only when it is still its own restricted form, at most 32 code points and plain letters,
 * numbers, spaces and `._'-`; anything else (unverified, none, hostile) is the folder name.
 */
export function restoredLabel(reading: LabelReadingLike | undefined, folder: string): string {
  if (reading?.status !== 'verified') return folder;
  const label = reading.label;
  if (typeof label !== 'string' || [...label].length > 32) return folder;
  if (!LABEL_CHARS.test(label) || label.includes('  ') || !isRestrictedAlias(label)) return folder;
  return label;
}

/**
 * Opens an ID as every start does (its recorded keychain KeyStore and its store) and answers the
 * owner its re-verified card names and whether its policy loads at its mark. Undefined when it does
 * not open or its card does not verify. Writes nothing.
 */
async function inspectId(
  keychain: KeychainBackend,
  agentId: string,
  path: string,
): Promise<
  | {
      readonly ownerNostr: Uint8Array;
      readonly policyLoads: boolean;
      readonly label: LabelReadingLike | undefined;
    }
  | undefined
> {
  let opened: AgentStore | undefined;
  let keyStore: KeyStore | undefined;
  try {
    opened = await openAgentStoreWith('keychain', agentId, path, { keychain });
    keyStore = await openRecordedKeyStore('keychain', agentId, { keychain });
    const client = await AgentLinkClient.create({
      keyStore,
      store: opened.store,
      cipher: opened.cipher,
      approvals: NO_APPROVALS,
      logger: SILENT_LOGGER,
      policyMark: opened.policyMark,
      receiptsKept: opened.receiptsKept,
    });
    if (client.agentId !== agentId) return undefined;
    const view = await client.identity.get();
    if (view === undefined || view.agentId !== agentId) return undefined;
    const named = (view.card as { ownerNostr?: unknown }).ownerNostr;
    if (typeof named !== 'string') return undefined;
    const owner = decodeHex0x(named, { length: 32 });
    const policy = await client.ownerActions.loadPolicy();
    // UX1113-R1-LABEL: the verified label (core re-verifies the stored `agent.label`); display only.
    const label = await client.ownerActions.loadLabel().catch(() => undefined);
    return { ownerNostr: owner, policyLoads: policy.mode !== 'fail_closed', label };
  } catch {
    return undefined;
  } finally {
    await keyStore?.close().catch(() => undefined);
    await opened?.close().catch(() => undefined);
  }
}

/** The restore engine of the app's routes (no terminal apply). */
export function createRestoreEngine(options: RestoreEngineOptions): RestoreEngine {
  const full = build(options);
  const {
    found,
    upload,
    header,
    presence,
    open: openKit,
    check,
    cancel,
    applyBegin,
    applyFinish,
    registerExportedKit,
    restorePending,
    firstRunHold,
    settle,
    masterCodeState,
    masterCodeSaved,
    sweep,
    close,
  } = full;
  return Object.freeze({
    found,
    upload,
    header,
    presence,
    open: openKit,
    check,
    cancel,
    applyBegin,
    applyFinish,
    registerExportedKit,
    restorePending,
    firstRunHold,
    settle,
    masterCodeState,
    masterCodeSaved,
    sweep,
    close,
  });
}

/** The terminal's restore engine (`agentlink restore`; never handed to a route). */
export function createTerminalRestore(options: RestoreEngineOptions): TerminalRestore {
  return Object.freeze(build(options));
}

function build(options: RestoreEngineOptions): TerminalRestore {
  const now = options.now ?? Date.now;
  const home = options.home;
  const agentlinkDir = join(home, '.agentlink');
  const restoreDir = join(agentlinkDir, 'restore');
  const agentsDir = join(agentlinkDir, 'agents');
  const revokedDir = join(agentlinkDir, 'revoked');
  const pendingPath = join(agentlinkDir, PENDING_FILE);
  const maxUpload = options.maxUploadBytes ?? RECOVERY_KIT_LIMITS.maxKitBytes;
  const keychainTimeoutMs = options.keychainTimeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  const handles = new Map<string, HandleEntry>();
  const uploads = new Map<string, UploadEntry>();
  const restoreSessions = new Map<string, RestoreSessionEntry>();
  const fails = new Map<string, { count: number; until: number }>();
  let presenceFails = { count: 0, until: 0 };
  let held: HeldKit | undefined;
  let pending: PendingGesture | undefined;
  /**
   * IR-UX1113-R1 M1: one engine-wide lock, taken synchronously (before any await) by open, check,
   * presence, apply/begin and apply/finish. A second request while one runs answers `busy`: one KDF
   * at a time, one opened kit, one apply (T-4, T-7).
   */
  let locked = false;
  /** Bumped by `cancel` per page session; an open that finishes after a cancel wipes its kit. */
  const cancels = new Map<string, number>();
  let ready: Promise<void> | undefined;
  const sweep = setInterval(() => {
    expire();
  }, 30_000);
  sweep.unref();

  /** Stale uploads and quarantine files of a crashed run go at start-up (T-7). */
  function start(): Promise<void> {
    ready ??= removeStaleRestoreFiles(restoreDir, now());
    return ready;
  }

  /** REL051-SF3: a sweep now (start-up and after an operation ended); live files stay. */
  async function sweepNow(): Promise<void> {
    await start();
    await removeStaleRestoreFiles(restoreDir, now()).catch(() => undefined);
  }

  /** REL051-SF3 (04 §2.5): the shared presence backoff when the server gives one, else our own. */
  function presenceWait(): number {
    if (options.presenceBackoff !== undefined) return options.presenceBackoff.waitSeconds();
    const left = presenceFails.until - now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }
  function presenceFailed(): void {
    if (options.presenceBackoff !== undefined) options.presenceBackoff.failed();
    else countFail(presenceFails);
  }
  function presenceSucceeded(): void {
    if (options.presenceBackoff !== undefined) options.presenceBackoff.succeeded();
    else presenceFails = { count: 0, until: 0 };
  }

  function dropHandle(handle: string): void {
    const entry = handles.get(handle);
    handles.delete(handle);
    if (entry?.file.kind === 'upload') {
      for (const [session, up] of uploads) if (up.handle === handle) uploads.delete(session);
      const path = entry.file.path;
      void unlink(path)
        .catch(() => undefined)
        .finally(() => {
          trackRestoreFile(path, false);
        });
    }
  }

  function wipeHeld(): void {
    const current = held;
    held = undefined;
    if (current === undefined) return;
    current.kit.wipe();
    current.restore?.end();
    if (pending?.kit === current.handle) pending = undefined;
  }

  function expire(): void {
    const at = now();
    for (const [handle, entry] of handles) if (at >= entry.expiresAt) dropHandle(handle);
    // Never under a running operation: it holds the kit and the plan until it ends.
    if (!locked && held !== undefined && at >= held.expiresAt) wipeHeld();
    if (!locked && pending !== undefined && at >= pending.expiresAt) pending = undefined;
    for (const [session, entry] of restoreSessions) {
      if (at >= entry.expiresAt) {
        entry.hold.end();
        restoreSessions.delete(session);
      }
    }
  }

  /** Runs `fn` under the engine-wide lock, or answers `busy` (wiping `secret`) when it is taken. */
  async function exclusive(
    fn: () => Promise<RestoreAnswer>,
    secret?: Uint8Array,
  ): Promise<RestoreAnswer> {
    if (locked) {
      if (secret !== undefined) wipe(secret);
      return fail('busy');
    }
    locked = true;
    try {
      return await fn();
    } catch {
      // A failed or timed-out keychain call: a fixed answer, and the lock is released below.
      return fail('failed');
    } finally {
      locked = false;
    }
  }

  function addHandle(session: string, file: FileRef): string {
    const mine = [...handles].filter(([, e]) => e.session === session);
    if (mine.length >= MAX_HANDLES_PER_SESSION) dropHandle((mine[0] as [string, HandleEntry])[0]);
    const handle = newHandle();
    handles.set(handle, { session, file, expiresAt: now() + RESTORE_HANDLE_TTL_MS });
    return handle;
  }

  function entryOf(session: string, handle: string | undefined): HandleEntry | undefined {
    expire();
    if (handle === undefined) return undefined;
    const entry = handles.get(handle);
    return entry?.session === session ? entry : undefined;
  }

  /** Opens the listed file without following a link and checks it is still what was listed (T-6). */
  async function openRef(file: FileRef): Promise<FileHandle | undefined> {
    let fh: FileHandle;
    try {
      fh = await open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch {
      return undefined;
    }
    try {
      const info = await fh.stat();
      if (
        info.isFile() &&
        info.dev === file.dev &&
        info.ino === file.ino &&
        info.size === file.size &&
        info.mtimeMs === file.mtimeMs
      ) {
        return fh;
      }
    } catch {
      // Refused below.
    }
    await fh.close().catch(() => undefined);
    return undefined;
  }

  async function refOf(
    path: string,
    kind: FileRef['kind'],
    kitId?: string,
  ): Promise<FileRef | undefined> {
    let fh: FileHandle;
    try {
      fh = await open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch {
      return undefined;
    }
    try {
      const info = await fh.stat();
      if (!info.isFile()) return undefined;
      return Object.freeze({
        kind,
        path,
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ...(kitId === undefined ? {} : { kitId }),
      });
    } catch {
      return undefined;
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  async function keychainOwnerPresent(): Promise<boolean> {
    const keychain = options.keychain();
    for (const account of [OWNER_ACCOUNT, OWNER_NEXT_ACCOUNT]) {
      // Bounded (round 2): a hung native call rejects, so the operation answers `failed`.
      const blob = await guarded(() => keychain.get(account), keychainTimeoutMs);
      if (blob !== null) {
        wipe(blob);
        return true;
      }
    }
    return false;
  }

  /**
   * REL051-SF3 (R1-SEC-04): the `owner-passkey` item on a computer with no `owner` item. `none`: no
   * item; `foreign`: a well-formed item of another owner (never replaced); else the item's bytes,
   * a leftover of this owner (the kit holds the same seed) or not an owner key at all (a damaged
   * item opens to nothing), which this apply replaces. The caller wipes `blob`.
   */
  async function lonePasskey(
    kitOwner: Uint8Array,
  ): Promise<'none' | 'foreign' | { readonly blob: Uint8Array }> {
    const blob = await readOwnerPasskeyItem(options.keychain(), keychainTimeoutMs);
    if (blob === null) return 'none';
    let owner: Uint8Array | undefined;
    try {
      owner = readPasskeyBlobHeader(blob).ownerNostr;
    } catch {
      owner = undefined;
    }
    if (owner !== undefined && !equalBytes(owner, kitOwner)) {
      wipe(blob);
      return 'foreign';
    }
    return { blob };
  }

  /** The owner a well-formed `owner-passkey` item names, or undefined (none, or damaged). */
  async function passkeyOwner(): Promise<Uint8Array | undefined> {
    // A keychain that does not answer rejects (the operation fails closed).
    const blob = await readOwnerPasskeyItem(options.keychain(), keychainTimeoutMs);
    if (blob === null) return undefined;
    try {
      return readPasskeyBlobHeader(blob).ownerNostr;
    } catch {
      return undefined;
    } finally {
      wipe(blob);
    }
  }

  async function fileOwnerPresent(): Promise<boolean> {
    for (const path of defaultOwnerFiles(home)) {
      try {
        await lstat(path);
        return true;
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'ENOENT') return true;
      }
    }
    return false;
  }

  /**
   * The owners the verified cards of this computer's agent folders name (04 §2.3.3: both card
   * signatures re-verified on open). A folder that does not open counts for nothing.
   */
  async function verifiedCardOwners(): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    for (const [name, agentId] of await existingFolders()) {
      if (agentId === undefined) continue;
      const seen = await inspectId(
        options.keychain(),
        agentId,
        join(agentsDir, name, 'store.sqlite'),
      );
      if (seen !== undefined && !out.some((o) => equalBytes(o, seen.ownerNostr))) {
        out.push(seen.ownerNostr);
      }
    }
    return out;
  }

  /**
   * The owner this computer is known to have, before any presence; undefined when unknown: the
   * `owner-passkey` header, else the open ID's card, else the one owner every verified card here
   * names (IR-UX1113-R1 Low: `other_owner` before the code with no passkey and no ID open). A hint
   * only: presence still opens the owner item to exactly the kit's owner.
   */
  async function knownOwner(): Promise<Uint8Array | undefined> {
    const passkey = await readOwnerPasskeyHeader(options.keychain()).catch(() => null);
    if (passkey !== null) return passkey.ownerNostr;
    const hinted = await options.knownOwnerNostr?.().catch(() => undefined);
    if (hinted !== undefined) return hinted;
    const owners = await verifiedCardOwners();
    return owners.length === 1 ? owners[0] : undefined;
  }

  interface ParsedHeader {
    readonly outcome: HeaderOutcome | 'other_owner';
    readonly ownerPresent: boolean;
    readonly ownerNostr?: Uint8Array;
    readonly headerHash?: Uint8Array;
  }

  async function parseHeaderOf(file: FileRef): Promise<ParsedHeader | undefined> {
    const fh = await openRef(file);
    if (fh === undefined) return undefined;
    let head: Uint8Array;
    try {
      head = await readHead(fh, HEADER_LENGTH);
    } catch {
      return undefined;
    } finally {
      await fh.close().catch(() => undefined);
    }
    return parseHead(head);
  }

  /** The header checks on `head`, the first bytes of one descriptor (never read by path). */
  async function parseHead(head: Uint8Array): Promise<ParsedHeader> {
    const ownerPresent = (await keychainOwnerPresent()) || (await fileOwnerPresent());
    const parsed = headerOutcome(head);
    if (parsed.outcome !== 'ok' || parsed.ownerNostr === undefined) {
      return { outcome: parsed.outcome, ownerPresent };
    }
    const headerHash = sha256(head);
    if (ownerPresent) {
      const known = await knownOwner();
      if (known !== undefined && !equalBytes(known, parsed.ownerNostr)) {
        return { outcome: 'other_owner', ownerPresent, ownerNostr: parsed.ownerNostr, headerHash };
      }
    } else {
      // A crash between the agents and the owner: only the same owner's kit finishes it (T-7):
      // the owner the verified cards here name, or the marker's.
      // REL051-SF3 (R1-SEC-04): a leftover `owner-passkey` item of another owner is never
      // replaced, so that kit is refused before a code is asked and before anything is written.
      const marker = await readPending();
      const owners = await verifiedCardOwners();
      const kitOwner = parsed.ownerNostr;
      const passkey = await passkeyOwner();
      if (
        (marker !== undefined && !equalBytes(marker, kitOwner)) ||
        owners.some((o) => !equalBytes(o, kitOwner)) ||
        (passkey !== undefined && !equalBytes(passkey, kitOwner))
      ) {
        return { outcome: 'other_owner', ownerPresent, ownerNostr: parsed.ownerNostr, headerHash };
      }
    }
    return { outcome: 'ok', ownerPresent, ownerNostr: parsed.ownerNostr, headerHash };
  }

  /** The owner key of an unfinished restore (`restore-pending.json`), or undefined. */
  async function readPending(): Promise<Uint8Array | undefined> {
    try {
      const text = await readRegularText(pendingPath);
      if (text === undefined) return undefined;
      const parsed = JSON.parse(text) as { v?: unknown; ownerNostr?: unknown };
      if (parsed.v !== 1 || typeof parsed.ownerNostr !== 'string') return undefined;
      return decodeHex(parsed.ownerNostr, { length: 32 });
    } catch {
      return undefined;
    }
  }

  async function writePending(ownerNostr: Uint8Array): Promise<void> {
    await mkdir(agentlinkDir, { recursive: true, mode: DIR_MODE });
    const temp = join(agentlinkDir, `.${PENDING_FILE}.${encodeHex(randomBytes(8))}.tmp`);
    const fh = await open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE);
    try {
      await fh.writeFile(`${JSON.stringify({ v: 1, ownerNostr: encodeHex(ownerNostr) })}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await unlink(pendingPath).catch(() => undefined);
    try {
      await link(temp, pendingPath);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  function waitFor(key: string): number {
    const entry = fails.get(key);
    if (entry === undefined) return 0;
    const left = entry.until - now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  function countFail(entry: { count: number; until: number }): void {
    entry.count += 1;
    if (entry.count >= FREE_TRIES) {
      const seconds = Math.min(MAX_WAIT_S, FIRST_WAIT_S * 2 ** (entry.count - FREE_TRIES));
      entry.until = now() + seconds * 1000;
    }
  }

  /**
   * The agent folders here: name → the agentId of its config (undefined when unreadable). UX1113-QA2
   * N4: `labels`, when given (one per request, never shared), receives the label each local agentId's
   * config.json carries (display text only).
   */
  async function existingFolders(
    labels?: Map<string, string>,
  ): Promise<Map<string, string | undefined>> {
    const out = new Map<string, string | undefined>();
    let names: string[];
    try {
      names = await readdir(agentsDir);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!AGENT_NAME.test(name)) continue;
      let agentId: string | undefined;
      try {
        const text = await readRegularText(join(agentsDir, name, 'config.json'));
        if (text !== undefined) {
          const parsed = JSON.parse(text) as {
            agentId?: unknown;
            label?: unknown;
          };
          if (typeof parsed.agentId === 'string' && AGENT_ID.test(parsed.agentId)) {
            agentId = parsed.agentId;
            if (isConfigLabel(parsed.label)) labels?.set(agentId, parsed.label);
          }
        }
      } catch {
        agentId = undefined;
      }
      out.set(name, agentId);
    }
    return out;
  }

  async function summaryOf(kit: RecoveryKitImport): Promise<SummaryRow[]> {
    const localLabels = new Map<string, string>();
    const folders = await existingFolders(localLabels);
    const ids = new Set([...folders.values()].filter((v): v is string => v !== undefined));
    const taken = new Set([...folders.keys()]);
    const kitNames = new Set(kit.agents.map((a) => ascii(a.name)));
    const rows: SummaryRow[] = [];
    const keychain = options.keychain();
    for (const agent of kit.agents) {
      const name = ascii(agent.name);
      const counts = peekQuarantinedSnapshot(kit, agent.agentId) ?? {
        people: 0,
        lastMessageAt: null,
      };
      let state: SummaryRow['state'];
      if (await inOwnersRevokedList(revokedDir, agent.agentId)) state = 'removed_earlier';
      else if (ids.has(agent.agentId)) state = 'already_here';
      else {
        const seed = await guarded(
          () => keychain.get(keychainAccount(agent.agentId, 'seed')),
          keychainTimeoutMs,
        );
        if (seed !== null) {
          wipe(seed);
          state = 'already_here';
        } else state = taken.has(name) ? 'name_taken' : 'new';
      }
      let suggestedName: string | undefined;
      if (state === 'name_taken') {
        for (let n = 2; n < 100; n += 1) {
          const candidate = `${name.slice(0, 32 - String(n).length - 1)}-${String(n)}`;
          if (!taken.has(candidate) && !kitNames.has(candidate)) {
            suggestedName = candidate;
            taken.add(candidate);
            break;
          }
        }
      }
      const label = state === 'already_here' ? localLabels.get(agent.agentId) : undefined;
      // UX1113-QA2 (Fable ruling): a clash names the ID already here by the name people see.
      const takenId = state === 'name_taken' ? folders.get(name) : undefined;
      const takenLabel = takenId === undefined ? undefined : localLabels.get(takenId);
      rows.push(
        Object.freeze({
          agentId: agent.agentId,
          name,
          people: counts.people,
          lastMessageAt: counts.lastMessageAt,
          state,
          ...(suggestedName === undefined ? {} : { suggestedName }),
          ...(label === undefined ? {} : { label }),
          ...(takenLabel === undefined ? {} : { takenLabel }),
        }),
      );
    }
    return rows;
  }

  const rowsJson = (rows: readonly SummaryRow[]): JsonValue =>
    rows.map((r) => ({ ...r }) as unknown as JsonValue);

  function summaryBody(kit: RecoveryKitImport, rows: readonly SummaryRow[]): JsonValue {
    return {
      kitId: encodeBase64url(kit.kitId),
      createdAt: kit.createdAt,
      contents: kit.contents,
      ids: rowsJson(rows),
    };
  }

  /** Opens and checks the handle's kit (open and check). The code is wiped whatever happens. */
  async function openWith(
    session: string,
    input: JsonValue | undefined,
    code: Uint8Array,
    mode: 'open' | 'check',
  ): Promise<RestoreAnswer> {
    // Taken before any await: a cancel from now on wipes what this open holds.
    const cancelAt = cancels.get(session) ?? 0;
    try {
      await start();
      const handle = handleOf(input);
      const entry = entryOf(session, handle);
      if (entry === undefined || handle === undefined) return fail('expired');
      // An export handle is for Check after a save only (04 §2.3.3 "Check that my kit opens").
      if (entry.file.kind === 'export' && mode !== 'check') return fail('expired');
      if (held !== undefined && held.session !== session) return fail('busy');
      if (pending !== undefined && pending.session !== session) return fail('busy');
      // The same page session opening again replaces its kit exactly as `cancel` does (wipe, and
      // its quarantine files deleted); never while another operation runs (the lock).
      if (held !== undefined) wipeHeld();
      // REL051-SF3 (04 §2.3.3 "found", T-2, T-4): one descriptor per request. The header that is
      // hashed, bound and counted is read from it, and the kit is streamed from it; the streamed
      // header must be those very bytes.
      const fh = await openRef(entry.file);
      if (fh === undefined) {
        dropHandle(handle);
        return fail('expired');
      }
      try {
        return await openFrom(session, handle, entry, fh, code, mode, cancelAt);
      } finally {
        await fh.close().catch(() => undefined);
      }
    } finally {
      wipe(code);
    }
  }

  async function openFrom(
    session: string,
    handle: string,
    entry: HandleEntry,
    fh: FileHandle,
    code: Uint8Array,
    mode: 'open' | 'check',
    cancelAt: number,
  ): Promise<RestoreAnswer> {
    let head: Uint8Array;
    try {
      head = await readHead(fh, HEADER_LENGTH);
    } catch {
      dropHandle(handle);
      return fail('expired');
    }
    const parsed = await parseHead(head);
    if (parsed.outcome !== 'ok') return fail(parsed.outcome);
    const headerHash = parsed.headerHash as Uint8Array;
    if (parsed.ownerPresent && (await fileOwnerPresent()) && !(await keychainOwnerPresent())) {
      return fail('needs_terminal');
    }
    if (options.keychainUsable !== undefined && !(await options.keychainUsable())) {
      return fail('needs_terminal');
    }
    let restore: RestoreOwnerSessionHold | undefined;
    if (mode === 'open' && parsed.ownerPresent) {
      const entrySession = restoreSessions.get(session);
      if (entrySession === undefined || !entrySession.hold.boundTo(headerHash)) {
        return fail('presence_required');
      }
      restore = entrySession.hold;
    }
    const key = encodeHex(headerHash);
    const wait = waitFor(key);
    if (wait > 0) return fail('wait', { retryAfter: wait });
    if (entry.file.kind === 'export') dropHandle(handle);
    const sinks: RecoveryKitStoreSink[] = [];
    const stream = { changed: false };
    let kit: RecoveryKitImport;
    try {
      const control = createKeyImportControl({
        backend: 'keychain',
        keychain: options.keychain(),
        ...(restore === undefined ? {} : { ownerStore: restore.store }),
        revokedDir,
      });
      const quarantine = createRestoreQuarantine(restoreDir);
      // Case and spaces do not matter; the code's own form is checked by the KDF's normaliser.
      for (let i = 0; i < code.length; i += 1) {
        const c = code[i] as number;
        if (c >= 0x61 && c <= 0x7a) code[i] = c - 0x20;
      }
      kit = await control.openRecoveryKit(
        sameHead(chunksOf(fh, entry.file.size), head, stream),
        { secret: code.slice(), source: 'prompt' },
        {
          ...(parsed.ownerNostr === undefined ? {} : { expectedOwnerNostr: parsed.ownerNostr }),
          createStoreSink: async () => {
            const sink = await quarantine.createStoreSink();
            sinks.push(sink);
            return sink;
          },
        },
      );
    } catch (error) {
      // REL051-SF3: the bytes changed under the descriptor after the header was read: not the
      // kit presence was given for; nothing is held or counted.
      if (stream.changed) {
        dropHandle(handle);
        return fail('expired');
      }
      // UX1113-QA2 N5: a store sink is only created for plaintext of a chunk that authenticated
      // under this code, so the code was right and the file is damaged (a half-copied kit). Not
      // an oracle: a wrong code never authenticates a chunk, and anyone holding the file can test
      // a code offline the same way; a wrong code still counts toward the wait below. A kit of one
      // chunk cannot tell a cut file from a wrong code (one tag), and says wrong_code.
      if (sinks.length > 0 || sinks.some((s) => quarantineAuthenticated(s))) {
        return fail('damaged');
      }
      if (error instanceof CryptoInputError || error instanceof KeyStoreError) {
        const counter = fails.get(key) ?? { count: 0, until: 0 };
        fails.set(key, counter);
        countFail(counter);
        return fail('wrong_code');
      }
      return fail('damaged');
    }
    if (stream.changed) {
      kit.wipe();
      dropHandle(handle);
      return fail('expired');
    }
    fails.delete(key);
    if (entry.file.kitId !== undefined && encodeBase64url(kit.kitId) !== entry.file.kitId) {
      kit.wipe();
      return fail('damaged');
    }
    let rows: SummaryRow[];
    try {
      rows = await summaryOf(kit);
    } catch {
      kit.wipe();
      return fail('failed');
    }
    const summary = summaryBody(kit, rows);
    if (mode === 'check') {
      // UX1113-QA2 N14: this very kit opened with its code; the kit record of the same kitId (and
      // only it) now counts as backed up. A display aid (G-1): a failure changes nothing here.
      await markKitRecordChecked(agentlinkDir, encodeBase64url(kit.kitId)).catch(() => false);
      kit.wipe();
      return ok({ summary });
    }
    // Cancelled while the kit was opening (the page left): never held.
    if ((cancels.get(session) ?? 0) !== cancelAt) {
      kit.wipe();
      return fail('expired');
    }
    const kitHandle = newHandle();
    held = Object.freeze({
      handle: kitHandle,
      session,
      kit,
      headerHash,
      rows: Object.freeze(rows),
      ...(restore === undefined ? {} : { restore }),
      expiresAt: now() + RESTORE_HANDLE_TTL_MS,
    });
    return ok({ kit: kitHandle, summary });
  }

  /** The plan of apply/begin, checked against the summary before anything else (rename map). */
  async function planOf(input: JsonValue | undefined, current: HeldKit): Promise<Plan | undefined> {
    const record = objectInput(input);
    const selection = record?.['selection'];
    const names = record?.['names'];
    if (!Array.isArray(selection) || selection.length > 16) return undefined;
    if (typeof names !== 'object' || names === null || Array.isArray(names)) return undefined;
    const ids = selection.filter((v): v is string => typeof v === 'string' && AGENT_ID.test(v));
    if (ids.length !== selection.length || new Set(ids).size !== ids.length) return undefined;
    const map: Record<string, string> = {};
    for (const [id, name] of Object.entries(names as Record<string, JsonValue>)) {
      if (!ids.includes(id) || typeof name !== 'string' || !AGENT_NAME.test(name)) return undefined;
      map[id] = name;
    }
    const folders = await existingFolders();
    const finals = new Set<string>();
    for (const id of ids) {
      const row = current.rows.find((r) => r.agentId === id);
      if (row === undefined || (row.state !== 'new' && row.state !== 'name_taken'))
        return undefined;
      const name = map[id] ?? (row.state === 'new' ? row.name : undefined);
      if (name === undefined || folders.has(name) || finals.has(name)) return undefined;
      finals.add(name);
    }
    return Object.freeze({ selection: Object.freeze([...ids]), names: Object.freeze(map) });
  }

  /** Removes a folder this apply just installed (config, store files, folder; never recursive). */
  async function removeInstalledFolder(name: string): Promise<void> {
    const dir = join(agentsDir, name);
    for (const file of ['config.json', 'store.sqlite', 'store.sqlite-wal', 'store.sqlite-shm']) {
      await unlink(join(dir, file)).catch(() => undefined);
    }
    await rmdir(dir).catch(() => undefined);
  }

  /** Restore step 5 for one ID: its folder, its store, then `config.json` last. */
  async function installFolder(
    kit: RecoveryKitImport,
    agentId: string,
    name: string,
  ): Promise<void> {
    await mkdir(agentsDir, { recursive: true, mode: DIR_MODE });
    for (const dir of [agentlinkDir, agentsDir]) {
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('folder');
    }
    const dir = join(agentsDir, name);
    await mkdir(dir, { mode: DIR_MODE });
    let done = false;
    const store = join(dir, 'store.sqlite');
    const config = join(dir, 'config.json');
    const temp = join(dir, `.config.json.${encodeHex(randomBytes(8))}.tmp`);
    try {
      const real = await realpath(dir);
      if (real !== join(await realpath(agentsDir), name)) throw new Error('folder');
      await installRestoredStore(kit, agentId, store);
      const fh = await open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE);
      try {
        await fh.writeFile(
          `${JSON.stringify({ v: 1, name, agentId, keyStore: 'keychain' })}\n`,
          'utf8',
        );
        await fh.sync();
      } finally {
        await fh.close();
      }
      const folder = await open(dir, O_RDONLY).catch(() => undefined);
      await folder?.sync().catch(() => undefined);
      await folder?.close().catch(() => undefined);
      await link(temp, config);
      done = true;
    } finally {
      await unlink(temp).catch(() => undefined);
      if (!done) {
        for (const suffix of ['', '-wal', '-shm'])
          await unlink(`${store}${suffix}`).catch(() => undefined);
        await rmdir(dir).catch(() => undefined);
      }
    }
  }

  /**
   * UX1113-QA2 N4 (04 §2.3.3 rename map; 07 §9.1): after the read-back, the restored ID's config.json
   * also carries the label core verified (as a rename writes it, only after core verified an
   * `agent.label`), so the IDs list names it as before even under a new folder name. Written through
   * a new temporary file and a rename; a label outside the folder label rule, or any failure, leaves
   * the config without a label (the folder name shows, as before). Display only.
   */
  async function writeConfigLabel(agentId: string, name: string, label: string): Promise<void> {
    if (!isConfigLabel(label)) return;
    const dir = join(agentsDir, name);
    const temp = join(dir, `.config.json.${encodeHex(randomBytes(8))}.tmp`);
    let renamed = false;
    try {
      const fh = await open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE);
      try {
        await fh.writeFile(
          `${JSON.stringify({ v: 1, name, agentId, keyStore: 'keychain', label })}\n`,
          'utf8',
        );
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(temp, join(dir, 'config.json'));
      renamed = true;
    } catch {
      // The config without a label stands.
    } finally {
      if (!renamed) await unlink(temp).catch(() => undefined);
    }
  }

  interface Outcome {
    readonly agentId: string;
    readonly name: string;
    /** UX1113-R1-LABEL: the verified label from the read-back, else the folder name. */
    readonly label: string;
    readonly outcome: 'restored' | 'failed';
  }

  /** Per selected ID in kit order: items, store, config.json; all or nothing per ID (T-7). */
  async function writeIds(
    current: HeldKit,
    plan: Plan,
    owner: RestoreOwnerSessionHold | undefined,
  ): Promise<Outcome[]> {
    const keychain = options.keychain();
    const control = createKeyImportControl({
      backend: 'keychain',
      keychain,
      ...(owner === undefined ? {} : { ownerStore: owner.store }),
      revokedDir,
      ...(options.kdf === undefined ? {} : { kdf: options.kdf }),
    });
    const out: Outcome[] = [];
    for (const agent of current.kit.agents) {
      if (!plan.selection.includes(agent.agentId)) continue;
      const name = plan.names[agent.agentId] ?? ascii(agent.name);
      let written = false;
      let installed = false;
      try {
        await control.importAgent(current.kit, agent.agentId, {
          name,
          ...(owner === undefined ? {} : { owner: owner.session }),
        });
        written = true;
        await installFolder(current.kit, agent.agentId, name);
        installed = true;
        // Restore step 7 (IR-UX1113-R1 M2): the ID opens with its KeyStore and store, its card names
        // the kit's owner, and its policy loads at the restored mark; else this ID is rolled back.
        const storePath = join(agentsDir, name, 'store.sqlite');
        const back = await readBack(keychain, agent.agentId, current.kit.ownerNostr, storePath);
        if (back === undefined) throw new Error('read-back');
        const label = restoredLabel(back.label, name);
        // UX1113-QA2 N4: the ID keeps the name people know, also under a new folder name.
        if (back.label?.status === 'verified' && label === back.label.label) {
          await writeConfigLabel(agent.agentId, name, label);
        }
        out.push({ agentId: agent.agentId, name, label, outcome: 'restored' });
      } catch {
        if (installed) await removeInstalledFolder(name);
        if (written) await discardImportedAgent(keychain, agent.agentId);
        out.push({ agentId: agent.agentId, name, label: name, outcome: 'failed' });
      }
    }
    return out;
  }

  const outcomesJson = (outcomes: readonly Outcome[]): JsonValue =>
    outcomes.map((o) => ({ ...o }) as unknown as JsonValue);

  async function restored(outcomes: readonly Outcome[]): Promise<void> {
    const names = outcomes.filter((o) => o.outcome === 'restored').map((o) => o.name);
    if (names.length > 0) await Promise.resolve(options.onRestored?.(names)).catch(() => undefined);
  }

  function heldFor(session: string, kit: unknown): HeldKit | undefined {
    expire();
    const current = held;
    if (current === undefined || current.session !== session || kit !== current.handle) {
      return undefined;
    }
    if (now() >= current.expiresAt) {
      wipeHeld();
      return undefined;
    }
    return current;
  }

  /** No owner here: the agents, then the owner under a new master code (and Touch ID). */
  async function writeWithoutOwner(
    current: HeldKit,
    plan: Plan,
    passkey:
      | { prfOutput: Uint8Array; credentialId: Uint8Array; authenticatorData: Uint8Array }
      | undefined,
  ): Promise<RestoreAnswer> {
    let code: Uint8Array | undefined;
    try {
      if (await keychainOwnerPresent()) return fail('busy');
      // REL051-SF3 (R1-SEC-04): the owner write below refuses while any owner item exists, so its
      // preconditions are settled before anything is written. A leftover `owner-passkey` item of
      // another owner refuses here; one of this owner (or one that is no owner key) is replaced,
      // only while it is still the bytes read.
      const stray = await lonePasskey(current.kit.ownerNostr);
      if (stray === 'foreign') {
        if (passkey !== undefined) wipe(passkey.prfOutput);
        return fail('other_owner');
      }
      if (stray !== 'none') {
        let removed: string;
        try {
          removed = await removeOwnerPasskeyItemIfOurs(
            options.keychain(),
            stray.blob,
            keychainTimeoutMs,
          );
        } finally {
          wipe(stray.blob);
        }
        if (removed !== 'removed' && removed !== 'absent') {
          if (passkey !== undefined) wipe(passkey.prfOutput);
          return fail('failed');
        }
      }
      if (plan.selection.length > 0) await writePending(current.kit.ownerNostr);
      const outcomes = await writeIds(current, plan, undefined);
      // REL051-SF3 (R1-SEC-07): IDs were chosen and none of them was restored (the opened kit's
      // files are gone, say): no owner is created and the answer is never `done`.
      if (plan.selection.length > 0 && !outcomes.some((o) => o.outcome === 'restored')) {
        if (passkey !== undefined) wipe(passkey.prfOutput);
        await unlink(pendingPath).catch(() => undefined);
        return fail('failed', { ids: outcomesJson(outcomes) });
      }
      // REL051-CF3 (T-7): the marker names the item before it is written, so a start after the
      // app closed mid-way can tell its own item apart (settle).
      let item: Uint8Array | undefined;
      const ownerNostr = current.kit.ownerNostr.slice();
      try {
        code = new Uint8Array(
          await importRestoredOwner(current.kit, options.keychain(), {
            ...(options.kdf === undefined ? {} : { kdf: options.kdf }),
            timeoutMs: keychainTimeoutMs,
            beforeWrite: async (blob) => {
              item = sha256(blob);
              wipe(blob);
              await writeUnsavedMarker(home, {
                kind: 'restore',
                stage: 'writing',
                ownerNostr,
                item,
                pid: process.pid,
                at: now(),
              });
            },
          }),
        );
      } catch {
        if (item !== undefined) await removeUnsavedMarker(home);
        if (passkey !== undefined) wipe(passkey.prfOutput);
        // Nothing of this kit was written: no hint is left behind (an ID that was restored keeps
        // it, with its verified card, for owner-only completion).
        if (!outcomes.some((o) => o.outcome === 'restored')) {
          await unlink(pendingPath).catch(() => undefined);
        }
        await restored(outcomes);
        return fail('failed', { ids: outcomesJson(outcomes) });
      }
      const touchId =
        passkey === undefined
          ? false
          : await importOwnerPasskey(current.kit, options.keychain(), passkey);
      // REL051-CF3: the code is in this answer now; the marker stays until "I saved it".
      await writeUnsavedMarker(home, {
        kind: 'restore',
        stage: 'shown',
        ownerNostr,
        ...(item === undefined ? {} : { item }),
        pid: process.pid,
        at: now(),
      }).catch(() => undefined);
      await unlink(pendingPath).catch(() => undefined);
      await restored(outcomes);
      return ok({
        status: 'done',
        ids: outcomesJson(outcomes),
        masterCode: (ascii(code).match(/.{1,4}/g) ?? []).join('-'),
        touchId,
      });
    } finally {
      wipe(code);
      if (held === current) wipeHeld();
      pending = undefined;
      await sweepNow();
    }
  }

  async function writeWithOwner(current: HeldKit, plan: Plan): Promise<RestoreAnswer> {
    const owner = current.restore;
    if (owner === undefined || !owner.boundTo(current.headerHash)) return fail('presence_required');
    try {
      const outcomes = await writeIds(current, plan, owner);
      await restored(outcomes);
      // REL051-SF3 (R1-SEC-07): never `done` when no chosen ID was restored.
      if (!outcomes.some((o) => o.outcome === 'restored')) {
        return fail('failed', { ids: outcomesJson(outcomes) });
      }
      return ok({ status: 'done', ids: outcomesJson(outcomes), touchId: 'unchanged' });
    } finally {
      owner.end();
      for (const [session, entry] of restoreSessions) {
        if (entry.hold === owner) restoreSessions.delete(session);
      }
      if (held === current) wipeHeld();
      await sweepNow();
    }
  }

  /** Owner-only completion is allowed only after a crash, for the same owner (T-7). */
  async function completionAllowed(current: HeldKit): Promise<boolean> {
    if (await keychainOwnerPresent()) return false;
    if (!current.rows.every((r) => r.state === 'already_here' || r.state === 'removed_earlier')) {
      return false;
    }
    // 04 §2.3.3: the restored IDs' verified cards name this kit's owner (the marker is a hint).
    const owners = await verifiedCardOwners();
    const marker = await readPending();
    const kitOwner = current.kit.ownerNostr;
    if (owners.some((o) => !equalBytes(o, kitOwner))) return false;
    if (owners.length > 0 || (marker !== undefined && equalBytes(marker, kitOwner))) return true;
    // REL051-SF3 (R1-SEC-04): a leftover `owner-passkey` item of this kit's owner with no `owner`
    // item: the owner key alone is finished from the kit.
    const passkey = await passkeyOwner();
    return passkey !== undefined && equalBytes(passkey, kitOwner);
  }

  /**
   * 04 §2.3.3: first run never mints an owner while a verified card here names an owner that is not
   * present (no owner item at all); the marker of an unfinished restore is a hint too. Fail closed:
   * a keychain that does not answer (or times out) holds first run as `keychain_unavailable`.
   */
  async function firstRunHold(): Promise<FirstRunHold | undefined> {
    let ownerHere: boolean;
    let passkeyLeft: boolean;
    try {
      ownerHere = await keychainOwnerPresent();
      if (ownerHere) return undefined;
      // REL051-SF3 (R1-SEC-04): an `owner-passkey` item with no `owner` item holds first run (it is
      // never overwritten) and sends the owner to "Finish restoring" with their kit, which replaces
      // a leftover of the same owner; never a dead end.
      const item = await readOwnerPasskeyItem(options.keychain(), keychainTimeoutMs);
      passkeyLeft = item !== null;
      wipe(item ?? undefined);
    } catch {
      return 'keychain_unavailable';
    }
    if (passkeyLeft) return 'finish_restore';
    if ((await readPending()) !== undefined) return 'finish_restore';
    return (await verifiedCardOwners()).length > 0 ? 'finish_restore' : undefined;
  }

  const runAlive = options.runAlive ?? ((pid: number) => pid === process.pid || processAlive(pid));

  async function settle(): Promise<void> {
    try {
      const marker = await readUnsavedMarker(home);
      if (marker === undefined || runAlive(marker.pid)) return;
      const keychain = options.keychain();
      const ownerBlob = await readOwnerItem(keychain, keychainTimeoutMs);
      if (ownerBlob === null) {
        // No owner was written (or it went since): restored IDs, if any, wait for "Finish
        // restoring" through restore-pending.json and their cards; nothing is unsaved.
        await removeUnsavedMarker(home);
        return;
      }
      try {
        if (
          marker.kind !== 'restore' ||
          marker.stage !== 'writing' ||
          marker.item === undefined ||
          !equalBytes(sha256(ownerBlob), marker.item)
        ) {
          return;
        }
        const passkey = await readOwnerPasskeyItem(keychain, keychainTimeoutMs);
        if (passkey !== null) {
          wipe(passkey);
          return;
        }
        // Its code never left this computer's server and no Touch ID wraps it: nobody can use it.
        // The IDs stay; first run says "Finish restoring" (owner-only completion, same kit).
        if ((await readPending()) === undefined) await writePending(marker.ownerNostr);
        const next = await guarded(() => keychain.get(OWNER_NEXT_ACCOUNT), keychainTimeoutMs);
        if (next !== null) {
          if (equalBytes(sha256(next), marker.item)) {
            await guarded(() => keychain.delete(OWNER_NEXT_ACCOUNT), keychainTimeoutMs);
          }
          wipe(next);
        }
        const removed = await removeOwnerItemIfOurs(keychain, ownerBlob, keychainTimeoutMs);
        if (removed === 'removed' || removed === 'absent') await removeUnsavedMarker(home);
      } finally {
        wipe(ownerBlob);
      }
    } catch {
      // Fail safe: nothing is removed when anything here could not be read.
    }
  }

  async function masterCodeState(): Promise<MasterCodeState> {
    if ((await firstRunHold()) === 'finish_restore') return { status: 'finish_restore' };
    const marker = await readUnsavedMarker(home);
    if (marker === undefined) return { status: 'none' };
    const keychain = options.keychain();
    const owner = await readOwnerItem(keychain, keychainTimeoutMs);
    if (owner === null) return { status: 'none' };
    wipe(owner);
    const passkey = await readOwnerPasskeyItem(keychain, keychainTimeoutMs);
    wipe(passkey ?? undefined);
    return { status: 'lost', kind: marker.kind, touchId: passkey !== null };
  }

  async function masterCodeSaved(): Promise<void> {
    await removeUnsavedMarker(home);
  }

  function gestureChallenge(
    label: Uint8Array,
    nonce: Uint8Array,
    kitId: Uint8Array,
    plan: Plan,
  ): Uint8Array {
    const planHash = sha256(
      encodeUtf8(
        canonicalize({ selection: [...plan.selection], names: { ...plan.names } } as JsonValue),
      ),
    );
    return sha256(concatBytes(label, nonce, kitId, planHash));
  }

  async function begin(
    session: string,
    input: JsonValue | undefined,
    terminal: boolean,
  ): Promise<RestoreAnswer> {
    const record = objectInput(input);
    const current = heldFor(session, record?.['kit']);
    if (current === undefined) return fail('expired');
    const plan = await planOf(input, current);
    if (plan === undefined) return fail('invalid');
    const ownerHere = await keychainOwnerPresent();
    if (ownerHere) {
      if (plan.selection.length === 0) return fail('invalid');
      return writeWithOwner(current, plan);
    }
    if (current.restore !== undefined) return fail('invalid');
    if (plan.selection.length === 0 && !(await completionAllowed(current))) return fail('invalid');
    if (options.keychainUsable !== undefined && !(await options.keychainUsable())) {
      return fail('needs_terminal');
    }
    if (terminal) return writeWithoutOwner(current, plan, undefined);
    if (pending !== undefined && pending.session !== session) return fail('busy');
    const nonce = randomBytes(32);
    const challenge = gestureChallenge(RESTORE_LABEL, nonce, current.kit.kitId, plan);
    pending = {
      session,
      kit: current.handle,
      plan,
      nonce,
      challenge,
      expiresAt: now() + RESTORE_GESTURE_TTL_MS,
      stage: 'create',
      tries: 0,
    };
    return ok({
      status: 'gesture',
      nonce: encodeBase64url(nonce),
      expiresInMs: RESTORE_GESTURE_TTL_MS,
      publicKey: {
        rpId: PASSKEY_RP_ID,
        rpName: 'AgentLink',
        userId: encodeBase64url(current.kit.ownerNostr),
        userName: 'AgentLink owner',
        challenge: encodeBase64url(challenge),
        prfSalt: encodeBase64url(ownerPrfSalt()),
      },
    });
  }

  /** The PRF get(): it names the created credential, for the second challenge, with UP, UV and a valid signature. */
  function checkPrfAssertion(
    reg: SetupRegistration,
    created: SetupRegistration,
    challenge: Uint8Array,
  ): 'passkey' | 'code_only' {
    const assertion = reg.assertion;
    if (
      assertion === undefined ||
      reg.prfOutput.length !== 32 ||
      !equalBytes(reg.credentialId, created.credentialId) ||
      !equalBytes(reg.authenticatorData, created.authenticatorData) ||
      !equalBytes(reg.clientDataJSON, created.clientDataJSON) ||
      !equalBytes(assertion.credentialId, created.credentialId)
    ) {
      throw new Error('refused');
    }
    const data = JSON.parse(decodeUtf8(assertion.clientDataJSON)) as Record<string, unknown>;
    if (
      data['type'] !== 'webauthn.get' ||
      data['challenge'] !== encodeBase64url(challenge) ||
      data['origin'] !== options.origin ||
      (data['crossOrigin'] !== undefined && data['crossOrigin'] !== false) ||
      data['topOrigin'] !== undefined
    ) {
      throw new Error('refused');
    }
    const auth = assertion.authenticatorData;
    const flags = auth[32] ?? 0;
    if (
      auth.length < 37 ||
      !equalBytes(auth.subarray(0, 32), sha256(encodeUtf8(PASSKEY_RP_ID))) ||
      (flags & FLAG_UP) === 0 ||
      (flags & FLAG_UV) === 0
    ) {
      throw new Error('refused');
    }
    let coseKey: Uint8Array;
    try {
      coseKey = webauthnPublicKeyFromAuthenticatorData(
        created.authenticatorData,
        created.credentialId,
      );
    } catch {
      return 'code_only';
    }
    if (!verifyWebauthnSignature(coseKey, auth, assertion.clientDataJSON, assertion.signature)) {
      throw new Error('refused');
    }
    return 'passkey';
  }

  async function finish(
    session: string,
    input: JsonValue | undefined,
    body: Uint8Array,
  ): Promise<RestoreAnswer> {
    let reg: SetupRegistration | undefined;
    try {
      expire();
      const nonceText = objectInput(input)?.['nonce'];
      if (pending !== undefined && now() >= pending.expiresAt) pending = undefined;
      const current = pending;
      if (
        current === undefined ||
        current.session !== session ||
        typeof nonceText !== 'string' ||
        !NONCE.test(nonceText) ||
        !equalBytes(decodeBase64url(nonceText), current.nonce)
      ) {
        return fail('expired');
      }
      const kit = heldFor(session, current.kit);
      if (kit === undefined) {
        pending = undefined;
        return fail('expired');
      }
      const rejected = (): RestoreAnswer => {
        current.tries += 1;
        if (current.tries >= GESTURE_TRIES) pending = undefined;
        return fail('presence_rejected');
      };
      try {
        reg = parseSetupRegistration(body);
      } catch {
        return rejected();
      }
      if (current.stage === 'create') {
        if (reg.assertion !== undefined) return rejected();
        try {
          checkSetupRegistration(reg, { challenge: current.challenge, origin: options.origin });
        } catch {
          return rejected();
        }
        if (reg.prfOutput.length !== 32) {
          // PRF only on get() (08 §1): a second gesture bound to a new challenge; nothing written yet.
          const nonce2 = randomBytes(32);
          current.nonce = nonce2;
          current.challenge = gestureChallenge(
            RESTORE_PRF_LABEL,
            nonce2,
            kit.kit.kitId,
            current.plan,
          );
          current.stage = 'prf';
          current.created = reg;
          current.expiresAt = now() + RESTORE_GESTURE_TTL_MS;
          current.tries = 0;
          return ok({
            status: 'prf_needed',
            nonce: encodeBase64url(nonce2),
            expiresInMs: RESTORE_GESTURE_TTL_MS,
            publicKey: {
              rpId: PASSKEY_RP_ID,
              challenge: encodeBase64url(current.challenge),
              credentialId: encodeBase64url(reg.credentialId),
              prfSalt: encodeBase64url(ownerPrfSalt()),
            },
          });
        }
        pending = undefined;
        const proof = reg;
        reg = undefined;
        return await writeWithoutOwner(kit, current.plan, {
          prfOutput: proof.prfOutput,
          credentialId: proof.credentialId,
          authenticatorData: proof.authenticatorData,
        });
      }
      const created = current.created as SetupRegistration;
      let verdict: 'passkey' | 'code_only';
      try {
        verdict = checkPrfAssertion(reg, created, current.challenge);
      } catch {
        return rejected();
      }
      pending = undefined;
      const proof = reg;
      reg = undefined;
      if (verdict === 'code_only') {
        wipe(proof.prfOutput);
        return await writeWithoutOwner(kit, current.plan, undefined);
      }
      return await writeWithoutOwner(kit, current.plan, {
        prfOutput: proof.prfOutput,
        credentialId: created.credentialId,
        authenticatorData: created.authenticatorData,
      });
    } finally {
      if (reg !== undefined) wipe(reg.prfOutput);
      wipe(body);
    }
  }

  async function presenceStep(
    session: string,
    input: JsonValue | undefined,
    proof: Uint8Array,
    mode: 'passphrase' | 'passkey',
  ): Promise<RestoreAnswer> {
    const cancelAt = cancels.get(session) ?? 0;
    try {
      await start();
      const handle = handleOf(input);
      const entry = entryOf(session, handle);
      if (entry === undefined || handle === undefined || entry.file.kind === 'export') {
        return fail('expired');
      }
      const left = presenceWait();
      if (left > 0) return fail('wait', { retryAfter: left });
      if (proof.length === 0) return fail('presence_required');
      const parsed = await parseHeaderOf(entry.file);
      if (parsed === undefined) return fail('expired');
      if (parsed.outcome !== 'ok') return fail(parsed.outcome);
      if (!parsed.ownerPresent || !(await keychainOwnerPresent())) return fail('invalid');
      const ownerNostr = parsed.ownerNostr as Uint8Array;
      let presence: OwnerPresence;
      if (mode === 'passkey') {
        try {
          const assertion = parsePasskeyAssertion(proof);
          const stored = await readOwnerPasskeyHeader(options.keychain());
          if (stored === null) throw new Error('none');
          assertPasskeyAssertion(stored, { ownerNostr }, assertion);
          presence = { kind: 'passkey-prf', prfOutput: assertion.prfOutput };
        } catch {
          presenceFailed();
          return fail('presence_rejected');
        }
      } else {
        presence = { kind: 'passphrase', secret: proof.slice() };
      }
      let hold: RestoreOwnerSessionHold;
      try {
        hold = await unlockForRestore(options.keychain(), ownerNostr, {
          presence,
          headerHash: parsed.headerHash as Uint8Array,
          ttlMs: RESTORE_HANDLE_TTL_MS,
        });
      } catch (error) {
        if (error instanceof KeyStoreError && error.code === 'presence_rejected') {
          presenceFailed();
          return fail('presence_rejected');
        }
        return fail('failed');
      }
      presenceSucceeded();
      // Cancelled while presence ran (the page left): the new session never stays.
      if ((cancels.get(session) ?? 0) !== cancelAt) {
        hold.end();
        return fail('expired');
      }
      restoreSessions.get(session)?.hold.end();
      restoreSessions.set(session, { hold, expiresAt: now() + RESTORE_HANDLE_TTL_MS });
      return ok({ status: 'ok' });
    } finally {
      wipe(proof);
    }
  }

  async function freeSpace(): Promise<number | undefined> {
    return options.freeBytes
      ? options.freeBytes(restoreDir)
      : statfs(restoreDir)
          .then((s) => s.bavail * s.bsize)
          .catch(() => undefined);
  }

  /**
   * 04 §2.3.3 "Upload" (IR-UX1113-R1 Low): one live upload per page session (a new one deletes the
   * old; one still streaming answers `busy`), two in all counting those still streaming, 4 GiB
   * together, and at least 1 GiB left free, checked before and again while the body streams.
   */
  async function uploadStep(
    session: string,
    chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    declared: number | undefined,
  ): Promise<RestoreAnswer> {
    // Reserved synchronously, before any await, so parallel uploads count at once.
    expire();
    const previous = uploads.get(session);
    if (previous?.streaming === true) return fail('busy');
    if (previous?.handle !== undefined) dropHandle(previous.handle);
    uploads.delete(session);
    if (uploads.size >= MAX_UPLOADS) return fail('busy');
    if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0)) {
      return fail('invalid');
    }
    const others = (): number =>
      [...uploads].reduce((n, [key, u]) => (key === session ? n : n + u.size), 0);
    if (declared !== undefined && declared > maxUpload - others()) return fail('too_large');
    const mine: UploadEntry = { handle: undefined, size: 0, streaming: true };
    uploads.set(session, mine);
    let path: string | undefined;
    let kept = false;
    try {
      await start();
      await mkdir(restoreDir, { recursive: true, mode: DIR_MODE });
      const free = await freeSpace();
      if (free !== undefined && free - (declared ?? 0) < FREE_MARGIN) return fail('too_large');
      path = join(restoreDir, restoreFileName('upload'));
      trackRestoreFile(path);
      let fh: FileHandle;
      try {
        fh = await open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE);
      } catch {
        trackRestoreFile(path, false);
        path = undefined;
        return fail('failed');
      }
      let sinceCheck = 0;
      try {
        for await (const chunk of chunks) {
          mine.size += chunk.length;
          sinceCheck += chunk.length;
          if (mine.size > maxUpload - others()) return fail('too_large');
          if (declared !== undefined && mine.size > declared) return fail('invalid');
          if (sinceCheck >= FREE_RECHECK_BYTES) {
            sinceCheck = 0;
            const left = await freeSpace();
            if (left !== undefined && left - chunk.length < FREE_MARGIN) return fail('too_large');
          }
          let done = 0;
          while (done < chunk.length) {
            const { bytesWritten } = await fh.write(chunk, done, chunk.length - done);
            done += bytesWritten;
          }
        }
        await fh.sync();
      } catch {
        return fail('failed');
      } finally {
        await fh.close().catch(() => undefined);
      }
      const ref = await refOf(path, 'upload');
      if (ref === undefined) return fail('failed');
      const handle = addHandle(session, ref);
      mine.handle = handle;
      mine.streaming = false;
      kept = true;
      return ok({ handle, size: mine.size });
    } finally {
      if (!kept) {
        if (uploads.get(session) === mine) uploads.delete(session);
        if (path !== undefined) {
          await unlink(path).catch(() => undefined);
          trackRestoreFile(path, false);
        }
      }
    }
  }

  async function foundStep(session: string): Promise<RestoreAnswer> {
    await start();
    expire();
    const rows: { file: FileRef; name: string; folder: string }[] = [];
    for (const [folder, dir] of [
      ['downloads', join(home, 'Downloads')],
      ['desktop', join(home, 'Desktop')],
      ['home', home],
    ] as const) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!KIT_NAME.test(name)) continue;
        const path = join(dir, name);
        try {
          const info = await lstat(path);
          if (info.isSymbolicLink() || !info.isFile()) continue;
          const real = join(await realpath(dir), name);
          const ref = await refOf(real, 'found');
          if (ref === undefined || ref.ino !== info.ino || ref.dev !== info.dev) continue;
          const fh = await openRef(ref);
          if (fh === undefined) continue;
          let magic: Uint8Array;
          try {
            magic = await readHead(fh, 4);
          } finally {
            await fh.close().catch(() => undefined);
          }
          if (ascii(magic) !== 'ALKK') continue;
          rows.push({ file: ref, name, folder });
        } catch {
          continue;
        }
      }
    }
    rows.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs);
    const kits = rows.slice(0, RESTORE_MAX_FOUND).map((row) => ({
      handle: addHandle(session, row.file),
      name: row.name,
      folder: row.folder,
      modifiedAt: Math.floor(row.file.mtimeMs / 1000),
      size: row.file.size,
    }));
    return ok({ kits: kits as unknown as JsonValue });
  }

  async function headerStep(session: string, input: JsonValue | undefined): Promise<RestoreAnswer> {
    await start();
    const handle = handleOf(input);
    const entry = entryOf(session, handle);
    if (entry === undefined || handle === undefined) return fail('expired');
    const parsed = await parseHeaderOf(entry.file);
    if (parsed === undefined) {
      dropHandle(handle);
      return fail('expired');
    }
    return ok({ header: parsed.outcome, ownerPresent: parsed.ownerPresent });
  }

  async function cancelStep(session: string, input: JsonValue | undefined): Promise<RestoreAnswer> {
    void objectInput(input);
    cancels.set(session, (cancels.get(session) ?? 0) + 1);
    // Under a running operation the kit stays until it ends (an open in flight then wipes it).
    if (!locked) {
      if (held?.session === session) wipeHeld();
      if (pending?.session === session) pending = undefined;
    }
    restoreSessions.get(session)?.hold.end();
    restoreSessions.delete(session);
    if (!locked) await sweepNow();
    return ok({ status: 'cancelled' });
  }

  return {
    found: (session) => foundStep(sessionKey(session)),
    upload: (session, chunks, declared) => uploadStep(sessionKey(session), chunks, declared),
    header: (session, input) => headerStep(sessionKey(session), input).catch(() => fail('failed')),
    presence: (session, input, proof, mode) =>
      exclusive(() => presenceStep(sessionKey(session), input, proof, mode), proof),
    open: (session, input, code) =>
      exclusive(() => openWith(sessionKey(session), input, code, 'open'), code),
    check: (session, input, code) =>
      exclusive(() => openWith(sessionKey(session), input, code, 'check'), code),
    cancel: (session, input) => cancelStep(sessionKey(session), input),
    applyBegin: (session, input) => exclusive(() => begin(sessionKey(session), input, false)),
    applyFinish: (session, input, body) =>
      exclusive(() => finish(sessionKey(session), input, body), body),
    registerExportedKit: async (session, file) => {
      if (typeof file.kitId !== 'string' || !HANDLE.test(file.kitId)) return undefined;
      const info = await lstat(file.path).catch(() => undefined);
      if (info === undefined || info.isSymbolicLink() || !info.isFile()) return undefined;
      const ref = await refOf(file.path, 'export', file.kitId);
      return ref === undefined ? undefined : addHandle(sessionKey(session), ref);
    },
    restorePending: async () => (await firstRunHold()) === 'finish_restore',
    firstRunHold,
    settle,
    masterCodeState,
    masterCodeSaved,
    sweep: sweepNow,
    close: () => {
      clearInterval(sweep);
      wipeHeld();
      pending = undefined;
      for (const [, entry] of restoreSessions) entry.hold.end();
      restoreSessions.clear();
      for (const handle of [...handles.keys()]) dropHandle(handle);
      return Promise.resolve();
    },
    fileHandle: async (session, path) => {
      const info = await lstat(path).catch(() => undefined);
      if (info === undefined || info.isSymbolicLink() || !info.isFile()) return undefined;
      const ref = await refOf(await realpath(path), 'terminal');
      return ref === undefined ? undefined : addHandle(sessionKey(session), ref);
    },
    applyInTerminal: (session, input) => exclusive(() => begin(sessionKey(session), input, true)),
  };
}

// --- The terminal (`agentlink restore`, 06 §8) -------------------------------------------------------

/** The terminal's words (the CLI's own strings file passes them; plain text, no secret). */
export interface RestoreTerminalText {
  readonly noKit: string;
  readonly pickKit: string;
  readonly kitLine: (n: number, name: string) => string;
  readonly errors: Readonly<Record<RestoreError, string>>;
  readonly masterCodePrompt: string;
  readonly recoveryCodePrompt: string;
  readonly checkOpens: string;
  readonly idLine: (name: string, state: string, people: number) => string;
  readonly newName: (name: string, suggested: string) => string;
  readonly confirm: (count: number) => string;
  readonly nothingToRestore: string;
  readonly outcomeLine: (name: string, outcome: string) => string;
  readonly masterCodeShown: string;
  readonly savedIt: string;
  readonly nextSteps: string;
}

/** What one owner terminal offers (owner-terminal.ts OwnerTerminal). */
export interface RestoreTerminal {
  write(text: string): void;
  readSecret(label: string): Promise<Uint8Array>;
  confirm(question: string): Promise<boolean>;
  readText?(label: string): Promise<string>;
  clearScreen(): void;
}

export type TerminalRestoreOutcome = 'restored' | 'checked' | 'refused' | 'cancelled';

const TERMINAL_SESSION = 'terminal';

function bodyOf(answer: RestoreAnswer): Record<string, JsonValue> {
  return (answer.body ?? {}) as Record<string, JsonValue>;
}

/**
 * 06 §8 `agentlink backup restore [file] [--check]` (alias `agentlink restore`): the interactive
 * flow over the restore engine. The recovery code and the master code are read only with the
 * hidden prompt (never an argument, environment variable, file or pipe), three tries each; nothing
 * typed is ever written back. Without a file the kits found in Downloads, Desktop and the home
 * folder are offered (newest first). It asks a new name per clashing ID, confirms (default No), and
 * shows a new master code once when it creates the owner, then clears the screen.
 */
export async function runRestoreInTerminal(
  engine: TerminalRestore,
  terminal: RestoreTerminal,
  request: { readonly file?: string; readonly check: boolean },
  text: RestoreTerminalText,
): Promise<TerminalRestoreOutcome> {
  const s = TERMINAL_SESSION;
  const error = (answer: RestoreAnswer): RestoreError =>
    (bodyOf(answer)['error'] ?? 'failed') as RestoreError;
  const refuse = (code: RestoreError): TerminalRestoreOutcome => {
    terminal.write(text.errors[code] ?? text.errors.failed);
    return 'refused';
  };
  try {
    let handle: string | undefined;
    if (request.file !== undefined) {
      handle = await engine.fileHandle(s, request.file);
      if (handle === undefined) return refuse('not_a_kit');
    } else {
      const kits = (bodyOf(await engine.found(s))['kits'] ?? []) as {
        handle: string;
        name: string;
      }[];
      if (kits.length === 0) {
        terminal.write(text.noKit);
        return 'refused';
      }
      let pick = 0;
      if (kits.length > 1) {
        kits.forEach((k, i) => terminal.write(text.kitLine(i + 1, k.name)));
        const typed = (await terminal.readText?.(text.pickKit))?.trim() ?? '';
        const n = typed === '' ? 1 : Number(typed);
        if (!Number.isInteger(n) || n < 1 || n > kits.length) return refuse('invalid');
        pick = n - 1;
      } else terminal.write(text.kitLine(1, (kits[0] as { name: string }).name));
      handle = (kits[pick] as { handle: string }).handle;
    }
    const head = await engine.header(s, { handle });
    if (head.status !== 200) return refuse(error(head));
    const outcome = bodyOf(head)['header'] as string;
    if (outcome !== 'ok') return refuse(outcome as RestoreError);
    const ownerPresent = bodyOf(head)['ownerPresent'] === true;
    if (ownerPresent && !request.check) {
      let unlocked = false;
      for (let i = 0; i < FREE_TRIES && !unlocked; i += 1) {
        const secret = await terminal.readSecret(text.masterCodePrompt);
        const answer = await engine.presence(s, { handle }, secret, 'passphrase');
        if (answer.status === 200) unlocked = true;
        else if (error(answer) !== 'presence_rejected') return refuse(error(answer));
        else terminal.write(text.errors.presence_rejected);
      }
      if (!unlocked) return 'refused';
    }
    let opened: RestoreAnswer | undefined;
    for (let i = 0; i < FREE_TRIES; i += 1) {
      const code = await terminal.readSecret(text.recoveryCodePrompt);
      const answer = request.check
        ? await engine.check(s, { handle }, code)
        : await engine.open(s, { handle }, code);
      if (answer.status === 200) {
        opened = answer;
        break;
      }
      if (error(answer) !== 'wrong_code') return refuse(error(answer));
      terminal.write(text.errors.wrong_code);
    }
    if (opened === undefined) return 'refused';
    const summary = bodyOf(opened)['summary'] as unknown as { ids: SummaryRow[] };
    for (const row of summary.ids) terminal.write(text.idLine(row.name, row.state, row.people));
    if (request.check) {
      terminal.write(text.checkOpens);
      return 'checked';
    }
    const kit = bodyOf(opened)['kit'] as string;
    const selection: string[] = [];
    const names: Record<string, string> = {};
    for (const row of summary.ids) {
      if (row.state === 'new') selection.push(row.agentId);
      if (row.state === 'name_taken') {
        const suggested = row.suggestedName ?? `${row.name}-2`;
        const typed = (await terminal.readText?.(text.newName(row.name, suggested)))?.trim() ?? '';
        selection.push(row.agentId);
        names[row.agentId] = typed === '' ? suggested : typed;
      }
    }
    if (selection.length === 0 && ownerPresent) {
      terminal.write(text.nothingToRestore);
      await engine.cancel(s, { kit });
      return 'refused';
    }
    if (!(await terminal.confirm(text.confirm(selection.length)))) {
      await engine.cancel(s, { kit });
      return 'cancelled';
    }
    const done = await engine.applyInTerminal(s, { kit, selection, names });
    for (const row of (bodyOf(done)['ids'] ?? []) as { name: string; outcome: string }[]) {
      terminal.write(text.outcomeLine(row.name, row.outcome));
    }
    if (done.status !== 200) return refuse(error(done));
    const master = bodyOf(done)['masterCode'];
    if (typeof master === 'string') {
      terminal.write(text.masterCodeShown);
      terminal.write(master);
      await terminal.confirm(text.savedIt);
      terminal.clearScreen();
      // REL051-CF3: shown in the terminal and confirmed there; the app has nothing to add.
      await engine.masterCodeSaved();
    }
    terminal.write(text.nextSteps);
    return 'restored';
  } finally {
    await engine.close();
  }
}

/**
 * The package entry's restore (`agentlink restore`): this OS user's keychain and home, the process's
 * own TTY prompt (refused unless stdin and stdout are TTYs). No seam.
 */
export function restoreInTerminal(
  request: { readonly file?: string; readonly check: boolean },
  text: RestoreTerminalText,
): Promise<TerminalRestoreOutcome> {
  const terminal = ttyOwnerTerminal();
  const engine = createTerminalRestore({
    home: homedir(),
    keychain: osKeychainOnce(),
    origin: 'terminal',
  });
  return runRestoreInTerminal(engine, terminal, request, text);
}

/**
 * `doctor` (UX1113-R1, 04 §2.3.3): why first run is held here: restored IDs wait for their owner
 * (`finish_restore`), or the keychain did not answer (`keychain_unavailable`). Reads this user's keychain owner items, the marker and the agent folders'
 * verified cards; unlocks nothing and writes nothing. No seam.
 */
export async function restoreHoldHere(): Promise<FirstRunHold | undefined> {
  const engine = createRestoreEngine({
    home: homedir(),
    keychain: osKeychainOnce(),
    origin: 'terminal',
  });
  try {
    return await engine.firstRunHold();
  } finally {
    await engine.close();
  }
}

function osKeychainOnce(): () => KeychainBackend {
  let made: KeychainBackend | undefined;
  return () => (made ??= osKeychain());
}
