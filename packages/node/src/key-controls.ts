// M1-9i-c: the Node backends of the owner-flow controls of M1-9i-b2 (04 §2.3.3 "Export: who sees the
// seeds" and "Restore", §2.2 `s3:<id>` and `storage-mark`, §2.8 `owner-next`; 07 §9.1; D-115; I-4,
// I-7, I-10), over the keychain and file backends:
//
// - KeyExportControl seals the owner seed and each agent's items with its store snapshot as an
//   `ALKK` v1 kit. The owner seed comes only from a session that this control's paired
//   KeychainOwnerKeyStore issued with unlockForExport (checked by identity). For each agent, the
//   items are read and the `snapshots` callback runs under ONE hold of the agent's inter-process lock
//   (06 §6), so the marks and the store are one consistent cut; a callback that takes that lock
//   itself with the LockHold it is given is refused at once (inter-process-lock.ts). Never an `s3:*` item (D-115 D).
// - KeyImportControl opens and checks a kit (the crypto checks, then the store snapshot checks on
//   the quarantined store, restore-quarantine.ts) and writes one agent's items at once, never over
//   an existing item or `.alks` (D-115 C), with `storage-mark` as `{"v":1,"active":null}`. On a
//   machine with an owner item it needs a session of the paired OwnerKeyStore whose owner is the
//   kit's. importOwner writes the owner seed under a new generated owner code with the `owner-next`
//   protocol (keychain machines; a file-machine owner fails closed, as `owner init` does there).
// - StorageCredentialControl writes and deletes `s3:<id>` under the agent's inter-process lock.
// - ownStorageKeysOver is core's OwnStorageKeys (M1-9i-a) over the same items.
//
// None of these is reachable from the package entry, a KeyStore, an OwnerKeyStore or a session; the
// CLI owner flows (M1-9i) construct them (I-4; apps/cli/test/owner-controls-fence.test.ts). Every
// seed, item value and code is wiped after use and on every failure (04 §8 rule 3). Errors are fixed
// sentences that never contain an input (I-7).
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  CryptoInputError,
  KeyStoreError,
  credentialDigestOfItem,
  equalBytes,
  randomBytes,
  wipe,
  type Argon2idParams,
  type DisplayCode,
  type ImportAgentOptions,
  type ImportedAgentKeys,
  type AgentKeyEraseRequest,
  type KeyEraseControl,
  type KeyExportControl,
  type KeyImportControl,
  type KeystoreEntry,
  type OpenRecoveryKitOptions,
  type OwnerSession,
  type RecoveryCodeSecret,
  type RecoveryKitExportRequest,
  type RecoveryKitImport,
  type RecoveryKitSource,
  type StorageCredential,
  type StorageCredentialControl,
} from '@4thtech-io/crypto';
import {
  encodeStorageCredentialItem,
  generateSecretCode,
  newKeystoreKek,
  openRecoveryKit,
  sealRecoveryKit,
  type OpenedRecoveryKit,
  type RecoveryKitAgentInput,
  type RecoveryKitItem,
  type RecoveryKitStoreSink,
  type RecoveryKitStoreSource,
} from '@4thtech-io/crypto/keystore';
import {
  STORAGE_MARK_ITEM,
  encodeStorageMark,
  verifyRevokedEntry,
  type OwnStorageKeys,
} from '@4thtech-io/core';
import { CLI_COMMAND } from './cli-command.js';
import { NodeKeyStoreError } from './errors.js';
import {
  OWNER_FILE,
  defaultKeystoreDir,
  eraseFileAgent,
  importAgentFile,
} from './file-keystore.js';
import { readKeystoreFile, type KeystoreFsOptions } from './file-keystore-fs.js';
import { withInterProcessLock, type LockHold } from './inter-process-lock.js';
import { KEYCHAIN_CALL_TIMEOUT_MS, eraseKeychainAgent, guarded } from './keychain-keystore.js';
import {
  assertAgentId,
  keychainAccount,
  type KeychainBackend,
  type KeychainItem,
} from './keychain.js';
import {
  OWNER_ACCOUNT,
  OWNER_NEXT_ACCOUNT,
  exportSeedOf,
  issuedBy,
  storeRestoredOwnerSeed,
  type KeychainOwnerKeyStore,
} from './owner-keystore.js';
import {
  checkQuarantinedSnapshot,
  discardQuarantineSync,
  isQuarantineSink,
} from './restore-quarantine.js';

const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants;
const KIT_MODE = 0o600;
/** 06 §6: the local agent name. */
const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** 04 §2.2: a `storage.set` id, 8 CSPRNG bytes as 16 lowercase hex. */
const STORAGE_ID = /^[0-9a-f]{16}$/;
/**
 * The agent items a kit carries (04 §2.3.3), in kit order; `seed` and `store-key` are required.
 * W4-RENAME-REACHES-CONTACTS (D-141): `key-epoch` is optional (absent: epoch 0), so a restored
 * renamed agent opens its KeyStore at the epoch its store holds.
 */
const KIT_ITEMS = [
  'seed',
  'store-key',
  'policy-version',
  'receipts-kept',
  'storage-mark',
  'key-epoch',
] as const;
const REQUIRED_ITEMS: readonly string[] = ['seed', 'store-key'];

// --- Fixed errors (I-7) ---------------------------------------------------------------------------

const presenceRequired = (): KeyStoreError =>
  new KeyStoreError(
    'presence_required',
    'owner control: an owner session of this owner is required',
  );
const ownerLocked = (): KeyStoreError =>
  new KeyStoreError('owner_locked', 'owner control: the owner session has ended');
const notExportSession = (): KeyStoreError =>
  new KeyStoreError(
    'operation_not_allowed',
    'owner control: this owner session was not unlocked for a backup export',
  );
const itemExists = (): KeyStoreError =>
  new KeyStoreError('item_exists', 'owner control: the item already exists and is never replaced');
const kitClosed = (): KeyStoreError =>
  new KeyStoreError('keystore_closed', 'restore: this kit was wiped');
const ownerRejected = (): KeyStoreError =>
  new KeyStoreError(
    'presence_rejected',
    "restore: the owner on this computer is not the kit's owner",
  );
const fileOwnerUnsupported = (): KeyStoreError =>
  new KeyStoreError(
    'unsupported_operation',
    'restore: an owner on a passphrase-locked key file machine is not supported yet',
  );
const agentRetired = (): KeyStoreError =>
  new KeyStoreError(
    'operation_not_allowed',
    'restore: this agent was removed and is retired for good; it comes back only as a new agent',
  );
const argument = (message: string): CryptoInputError =>
  new CryptoInputError('invalid_argument', message);
const kitOpenFailed = (): CryptoInputError =>
  new CryptoInputError(
    'open_failed',
    'recovery kit: cannot open (wrong code, another owner, or a damaged, truncated or foreign kit)',
  );
const keychainFailed = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keychain_failed',
    `The system keychain refused the request. Unlock it and try again; \`${CLI_COMMAND} doctor\` shows what is wrong.`,
  );

/** A genuine, live session of `store` (by identity, never by shape). */
function assertOwnerSession(session: unknown, store: KeychainOwnerKeyStore): void {
  if (!issuedBy(session, store)) throw presenceRequired();
  if (!(session as OwnerSession).isActive()) throw ownerLocked();
}

function assertStorageId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !STORAGE_ID.test(id)) {
    throw argument('storage credential: the id must be 16 lowercase hex characters');
  }
}

const asDisplayCode = (code: Uint8Array): DisplayCode => code as DisplayCode;

/** The concatenated kit bytes of a write stream go straight to `handle`, in order. */
function fileWriter(handle: FileHandle): (bytes: Uint8Array) => Promise<void> {
  let offset = 0;
  return async (bytes) => {
    let done = 0;
    while (done < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, done, bytes.length - done, offset);
      done += bytesWritten;
      offset += bytesWritten;
    }
  };
}

// --- KeyExportControl -----------------------------------------------------------------------------

export interface KeyExportControlOptions {
  /** The paired owner store: only sessions it issued with unlockForExport are accepted. */
  readonly owner: KeychainOwnerKeyStore;
  /** The recorded item backend of each agent (07 §9.1): the OS keychain or its unlocked `ALKS`. */
  readonly itemsOf: (agentId: string) => KeychainBackend;
  /** The agent's `store.sqlite`; its inter-process lock is `<path>.lock` (06 §6). */
  readonly storePathOf: (agentId: string) => string;
  /** `~/.agentlink`: a kit is never written inside it (04 §2.3.3). */
  readonly agentlinkDir: string;
  /** Argon2id parameters; default the kit defaults (tests use the floor). */
  readonly kdf?: Argon2idParams;
  readonly timeoutMs?: number;
}

interface ExportAgent {
  readonly agentId: string;
  readonly name: string;
}

/** The request, read once: what is checked is what is sealed. */
function exportSnapshot(request: unknown): {
  readonly kitId: unknown;
  readonly createdAt: unknown;
  readonly contents: unknown;
  readonly agents: readonly ExportAgent[];
  /** Runs under the agent's lock; any lock it takes passes `hold` as `within` (inter-process-lock.ts). */
  readonly snapshots: (agentId: string, hold: LockHold) => Promise<RecoveryKitStoreSource>;
  readonly path: string;
} {
  if (typeof request !== 'object' || request === null)
    throw argument('backup export: malformed request');
  const { kitId, createdAt, contents, agents, snapshots, path } = request as Record<
    string,
    unknown
  >;
  if (typeof snapshots !== 'function')
    throw argument('backup export: snapshots must be a function');
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw argument('backup export: the kit path must be absolute');
  }
  if (!Array.isArray(agents) || agents.length === 0 || agents.length > 16) {
    throw argument('backup export: one to 16 agents');
  }
  const seen = new Set<string>();
  const list = agents.map((agent: unknown): ExportAgent => {
    const { agentId, name } = (agent ?? {}) as Record<string, unknown>;
    assertAgentId(agentId);
    if (typeof name !== 'string' || !AGENT_NAME.test(name)) {
      throw argument('backup export: an agent name is not valid');
    }
    if (seen.has(agentId)) throw argument('backup export: an agent is listed twice');
    seen.add(agentId);
    return Object.freeze({ agentId, name });
  });
  return {
    kitId,
    createdAt,
    contents,
    agents: Object.freeze(list),
    snapshots: snapshots as (agentId: string, hold: LockHold) => Promise<RecoveryKitStoreSource>,
    path,
  };
}

/** True when `path`'s real folder is `agentlinkDir` or inside it. */
async function insideAgentlinkDir(path: string, agentlinkDir: string): Promise<boolean> {
  const folder = await realpath(dirname(path)).catch(() => {
    throw argument('backup export: the kit folder does not exist');
  });
  const home = await realpath(agentlinkDir).catch(() => resolve(agentlinkDir));
  return folder === home || folder.startsWith(`${home}${sep}`);
}

async function readItem(
  items: KeychainBackend,
  agentId: string,
  name: KeychainItem,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  return guarded(() => items.get(keychainAccount(agentId, name)), timeoutMs);
}

/** 04 §2.3.3 "Export": the KeyExportControl of this machine's keychain and file backends. */
export function createKeyExportControl(options: KeyExportControlOptions): KeyExportControl {
  const { owner, itemsOf, storePathOf, agentlinkDir, kdf } = options;
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  return Object.freeze({
    async sealRecoveryKit(
      session: OwnerSession,
      request: RecoveryKitExportRequest,
    ): Promise<DisplayCode> {
      const first = exportSeedOf(session, owner);
      if (first.status === 'foreign') throw presenceRequired();
      if (first.status === 'ended') throw ownerLocked();
      if (first.status !== 'ok') throw notExportSession();
      wipe(first.seed);
      const req = exportSnapshot(request);
      if (await insideAgentlinkDir(req.path, agentlinkDir)) {
        throw argument('backup export: a kit is never written inside ~/.agentlink');
      }
      let handle: FileHandle;
      try {
        handle = await open(req.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, KIT_MODE);
      } catch {
        throw argument(
          'backup export: the kit file cannot be created there (it may already exist)',
        );
      }
      const held: Uint8Array[] = [];
      let ownerSeed: Uint8Array | undefined;
      let done = false;
      try {
        const agents: RecoveryKitAgentInput[] = [];
        for (const agent of req.agents) {
          const items = itemsOf(agent.agentId);
          // One lock hold: the marks, the other items and the snapshot are one cut (04 §2.3.3).
          const read = await withInterProcessLock(
            `${storePathOf(agent.agentId)}.lock`,
            async (hold) => {
              const kitItems: RecoveryKitItem[] = [];
              for (const name of KIT_ITEMS) {
                const value = await readItem(items, agent.agentId, name, timeoutMs);
                if (value === null) {
                  if (REQUIRED_ITEMS.includes(name)) {
                    throw new NodeKeyStoreError(
                      'identity_missing',
                      "This agent's identity is not in its key store. Restore it from a backup or check the agent name; AgentLink never creates a new identity in its place.",
                    );
                  }
                  continue;
                }
                held.push(value);
                kitItems.push({ name, value });
              }
              const store = await req.snapshots(agent.agentId, hold);
              return { kitItems, store };
            },
          );
          agents.push({
            agentId: agent.agentId,
            name: agent.name,
            items: read.kitItems,
            store: read.store,
          });
        }
        // The seed is read only now, after every lock is released, and wiped right after sealing.
        const second = exportSeedOf(session, owner);
        if (second.status === 'ended') throw ownerLocked();
        if (second.status !== 'ok') throw presenceRequired();
        ownerSeed = second.seed;
        const code = await sealRecoveryKit(
          {
            ownerSeed,
            kitId: req.kitId as string,
            createdAt: req.createdAt as number,
            contents: req.contents as RecoveryKitExportRequest['contents'],
            agents,
          },
          fileWriter(handle),
          kdf,
        );
        try {
          await handle.sync();
          await handle.close();
        } catch (error) {
          wipe(code);
          throw error;
        }
        done = true;
        return asDisplayCode(code);
      } finally {
        wipe(ownerSeed, ...held);
        if (!done) {
          await handle.close().catch(() => undefined);
          await unlink(req.path).catch(() => undefined);
        }
      }
    },
  });
}

// --- KeyImportControl -----------------------------------------------------------------------------

export interface KeyImportControlOptions {
  /** The backend the restored agents are written to (07 §9.1, chosen by the restore, step 4). */
  readonly backend: 'keychain' | 'file';
  /** The OS keychain (backend `keychain`): the agent items. */
  readonly keychain?: KeychainBackend;
  /** The keystore folder (backend `file`); default `~/.agentlink/keystore`. */
  readonly keystoreDir?: string;
  /** Where this machine's owner item lives; default `keychain` for the keychain backend. */
  readonly ownerKeychain?: KeychainBackend;
  /**
   * The paired owner store, when an owner item exists: the kit must be this owner's, and
   * importAgent needs a live session it issued.
   */
  readonly ownerStore?: KeychainOwnerKeyStore;
  /**
   * U3-e: the owner's revoked list (04 §2.3.3, §2.5.1); default `~/.agentlink/revoked`. Any entry
   * for an agent's ID refuses that agent before anything of it is written.
   */
  readonly revokedDir?: string;
  /** Test seams. */
  readonly fs?: KeystoreFsOptions;
  readonly kdf?: Argon2idParams;
  readonly timeoutMs?: number;
}

/**
 * U3-e (04 §2.3.3 restore table, D-138): true unless the owner's revoked list certainly has no entry
 * for `agentId`. Any entry refuses, whether it verifies (under the kit's owner or any other) or is
 * damaged, and so does a list that cannot be checked (fail closed). Residual (G-1): a same-user
 * process that deletes the entry lets the restore proceed; contacts that applied the revoke still
 * drop the agent.
 */
export async function inOwnersRevokedList(revokedDir: string, agentId: string): Promise<boolean> {
  assertAgentId(agentId);
  try {
    await lstat(join(revokedDir, `${agentId}.json`));
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code !== 'ENOENT';
  }
}

interface KitState {
  opened: OpenedRecoveryKit | null;
  readonly sinks: readonly RecoveryKitStoreSink[];
}

/**
 * Every kit handle a Node import control opened, by identity. Shared by both backends, so the CLI may
 * open the kit before it picks the backend (04 §2.3.3 steps 3 and 4).
 */
const KITS = new WeakMap<RecoveryKitImport, KitState>();

function stateOf(kit: unknown): OpenedRecoveryKit {
  const state =
    typeof kit === 'object' && kit !== null ? KITS.get(kit as RecoveryKitImport) : undefined;
  if (state === undefined) throw argument('restore: not a kit this restore opened');
  if (state.opened === null) throw kitClosed();
  return state.opened;
}

function asciiName(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/** 04 §2.3.3 "Restore": the KeyImportControl of one backend. */
export function createKeyImportControl(options: KeyImportControlOptions): KeyImportControl {
  const { backend, keychain, ownerStore, fs = {}, kdf } = options;
  const revokedDir = options.revokedDir ?? join(homedir(), '.agentlink', 'revoked');
  // On a keychain machine the owner item is in the same OS keychain unless the caller says otherwise,
  // so the owner check below can never be skipped by leaving the option out.
  const ownerKeychain = options.ownerKeychain ?? (backend === 'keychain' ? keychain : undefined);
  const keystoreDir = options.keystoreDir ?? defaultKeystoreDir();
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  if (backend !== 'keychain' && backend !== 'file') throw argument('restore: unknown backend');
  if (backend === 'keychain' && keychain === undefined) throw argument('restore: no keychain');

  /** An owner item on this machine: `owner` or `owner-next`, or a file-machine `owner.alko`. */
  async function ownerPresent(): Promise<boolean> {
    if (ownerKeychain !== undefined) {
      for (const account of [OWNER_ACCOUNT, OWNER_NEXT_ACCOUNT]) {
        const blob = await guarded(() => ownerKeychain.get(account), timeoutMs);
        if (blob !== null) {
          wipe(blob);
          return true;
        }
      }
    }
    if (backend === 'file') {
      const file = await readKeystoreFile(keystoreDir, OWNER_FILE, fs).catch(() => null);
      if (file !== null) {
        wipe(file);
        return true;
      }
    }
    return false;
  }

  async function writeKeychainItems(
    target: KeychainBackend,
    agentId: string,
    entries: readonly KeystoreEntry[],
  ): Promise<void> {
    const accounts = entries.map((e) => keychainAccount(agentId, e.name as KeychainItem));
    // Any existing item of this agent refuses the import, not only those the kit carries (D-115 C).
    for (const account of KIT_ITEMS.map((name) => keychainAccount(agentId, name))) {
      const existing = await guarded(() => target.get(account), timeoutMs);
      if (existing !== null) {
        wipe(existing);
        throw itemExists();
      }
    }
    const written: string[] = [];
    try {
      for (const [i, account] of accounts.entries()) {
        const value = (entries[i] as KeystoreEntry).value;
        written.push(account);
        await guarded(() => target.set(account, value), timeoutMs);
        const back = await guarded(() => target.get(account), timeoutMs);
        const same = back !== null && equalBytes(back, value);
        if (back !== null) wipe(back);
        if (!same) throw keychainFailed();
      }
    } catch (error) {
      // All at once: every item this run wrote is removed again (it checked they were absent).
      for (const account of written) {
        await guarded(() => target.delete(account), timeoutMs).catch(() => false);
      }
      throw error;
    }
  }

  return Object.freeze({
    async openRecoveryKit(
      kit: RecoveryKitSource,
      code: RecoveryCodeSecret,
      openOptions: OpenRecoveryKitOptions,
    ): Promise<RecoveryKitImport> {
      if (typeof openOptions !== 'object' || openOptions === null) {
        throw argument('restore: options must be an object');
      }
      const createSink = openOptions.createStoreSink;
      if (typeof createSink !== 'function') throw argument('restore: createStoreSink is required');
      const expectedOwnerNostr =
        ownerStore === undefined
          ? openOptions.expectedOwnerNostr
          : (await ownerStore.getPublicKeys()).ownerNostr;
      const sinks: RecoveryKitStoreSink[] = [];
      const opened = await openRecoveryKit(kit, code, {
        ...(expectedOwnerNostr === undefined ? {} : { expectedOwnerNostr }),
        createStoreSink: async () => {
          const sink = await createSink();
          // Only the restore quarantine (D-84): its files are checked before they can be installed.
          if (!isQuarantineSink(sink)) {
            const other = sink as Partial<RecoveryKitStoreSink> | null;
            await Promise.resolve(other?.discard?.()).catch(() => undefined);
            throw argument('restore: the store must go to the restore quarantine');
          }
          sinks.push(sink);
          return sink;
        },
      });
      try {
        // 04 §2.3.3 "Checks after decryption", the store half, on the quarantined snapshots.
        for (const agent of opened.agents) {
          const storeKey = agent.items.find((i) => i.name === 'store-key')?.value;
          const ok =
            storeKey !== undefined &&
            (await checkQuarantinedSnapshot(
              agent.store,
              agent.agentId,
              storeKey,
              opened.ownerNostr,
            ));
          if (!ok) throw kitOpenFailed();
        }
      } catch (error) {
        opened.wipe();
        for (const sink of sinks) await Promise.resolve(sink.discard()).catch(() => undefined);
        throw error instanceof CryptoInputError ? error : kitOpenFailed();
      }
      const state: KitState = { opened, sinks: Object.freeze(sinks) };
      const handle = Object.freeze({
        ownerNostr: opened.ownerNostr.slice(),
        kitId: opened.kitId.slice(),
        createdAt: opened.createdAt,
        contents: opened.contents,
        agents: Object.freeze(
          opened.agents.map((agent) =>
            Object.freeze({
              agentId: agent.agentId,
              name: agent.name.slice(),
              store: agent.store,
              storeLength: agent.storeLength,
            }),
          ),
        ),
        wipe(): void {
          const current = state.opened;
          state.opened = null;
          current?.wipe();
          for (const sink of state.sinks) discardQuarantineSync(sink);
        },
      }) as unknown as RecoveryKitImport;
      KITS.set(handle, state);
      return handle;
    },

    async importAgent(
      kit: RecoveryKitImport,
      agentId: string,
      importOptions: ImportAgentOptions = {},
    ): Promise<ImportedAgentKeys> {
      const opened = stateOf(kit);
      const agent = opened.agents.find((a) => a.agentId === agentId);
      if (agent === undefined) throw argument('restore: that agent is not in the kit');
      // U3-e: a removed agent is retired for good (04 §2.3.3): refused before anything is written.
      if (await inOwnersRevokedList(revokedDir, agentId)) throw agentRetired();
      const name = importOptions.name ?? asciiName(agent.name);
      if (typeof name !== 'string' || !AGENT_NAME.test(name)) {
        throw argument('restore: the agent name is not valid');
      }
      // 04 §2.3.3 restore table: an existing owner is kept only after its own code opened it to the
      // kit's owner. A card naming that owner is never enough.
      if (await ownerPresent()) {
        const session = importOptions.owner;
        if (ownerStore === undefined || !issuedBy(session, ownerStore)) throw presenceRequired();
        if (!(session as OwnerSession).isActive()) throw ownerLocked();
        const keys = await ownerStore.getPublicKeys();
        if (!equalBytes(keys.ownerNostr, opened.ownerNostr)) throw ownerRejected();
      }
      // Every item of the kit except its storage-mark, which is written as active null (D-115 D).
      const entries: KeystoreEntry[] = [];
      for (const item of agent.items) {
        if (item.name !== STORAGE_MARK_ITEM) entries.push({ name: item.name, value: item.value });
      }
      const mark = encodeStorageMark(null);
      entries.push({ name: STORAGE_MARK_ITEM, value: mark });
      if (backend === 'keychain') {
        await writeKeychainItems(keychain as KeychainBackend, agentId, entries);
        return Object.freeze({ unlockCode: undefined });
      }
      const unlockCode = generateSecretCode();
      let kek: Awaited<ReturnType<typeof newKeystoreKek>> | undefined;
      try {
        kek = await newKeystoreKek(
          'ALKS',
          { secret: unlockCode, secretKind: 1, source: 'prompt' },
          kdf,
        );
        await importAgentFile(keystoreDir, agentId, kek, entries, fs);
        return Object.freeze({ unlockCode: asDisplayCode(unlockCode) });
      } catch (error) {
        wipe(unlockCode);
        throw error;
      } finally {
        if (kek !== undefined) wipe(kek.kek);
      }
    },

    async importOwner(kit: RecoveryKitImport): Promise<DisplayCode> {
      const opened = stateOf(kit);
      if (backend === 'file' || ownerKeychain === undefined) throw fileOwnerUnsupported();
      const ownerCode = generateSecretCode();
      try {
        await storeRestoredOwnerSeed(
          ownerKeychain,
          opened.ownerSeed,
          opened.ownerNostr,
          ownerCode,
          { ...(kdf === undefined ? {} : { kdf }), timeoutMs },
        );
        return asDisplayCode(ownerCode);
      } catch (error) {
        wipe(ownerCode);
        throw error;
      }
    },
  });
}

// --- KeyEraseControl (U3-e) -----------------------------------------------------------------------

export interface KeyEraseControlOptions {
  /** The agent's recorded backend (07 §9.1). */
  readonly backend: 'keychain' | 'file';
  /** The OS keychain (backend `keychain`). */
  readonly keychain?: KeychainBackend;
  /** The keystore folder (backend `file`); default `~/.agentlink/keystore`. */
  readonly keystoreDir?: string;
  /** Test seams. */
  readonly fs?: KeystoreFsOptions;
  readonly timeoutMs?: number;
}

const eraseRefused = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keystore_erase_failed',
    "AgentLink couldn't erase all of this agent's keys. Nothing else was changed. Try again.",
  );

/**
 * U3-e (04 §2.5 "Removing an agent" step 6): the KeyEraseControl of one backend. The request must
 * carry the agent's verifying `agent.revoke` (the revoked-list entry) for the same `agentId`, or
 * nothing is deleted. The keychain backend erases agentEraseAccounts (never an owner account); the
 * file backend erases `<agentId>.alks` (never `owner.alko` or `owner.alkp`).
 */
export function createKeyEraseControl(options: KeyEraseControlOptions): KeyEraseControl {
  const { backend, keychain, fs = {} } = options;
  if (backend !== 'keychain' && backend !== 'file') throw argument('erase: unknown backend');
  if (backend === 'keychain' && keychain === undefined) throw argument('erase: no keychain');
  const keystoreDir = options.keystoreDir ?? defaultKeystoreDir();
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  return Object.freeze<KeyEraseControl>({
    async eraseAgentKeys(request: AgentKeyEraseRequest): Promise<void> {
      if (typeof request !== 'object' || request === null) throw eraseRefused();
      const { agentId, storageIds, revoke } = request as unknown as Record<string, unknown>;
      if (typeof agentId !== 'string' || !/^0x[0-9a-f]{40}$/.test(agentId)) throw eraseRefused();
      if (!Array.isArray(storageIds) || !storageIds.every((id) => typeof id === 'string')) {
        throw eraseRefused();
      }
      // Only a retired agent's keys are erased: its signed `agent.revoke` must verify for it.
      if (!verifyRevokedEntry(revoke, agentId).ok) throw eraseRefused();
      if (backend === 'keychain') {
        await eraseKeychainAgent(keychain as KeychainBackend, agentId, storageIds as string[], {
          timeoutMs,
        });
        return;
      }
      await eraseFileAgent(keystoreDir, agentId, fs);
    },
  });
}

// --- StorageCredentialControl and the own-storage items -------------------------------------------

export interface StorageCredentialControlOptions {
  /** The paired owner store whose sessions are accepted. */
  readonly owner: KeychainOwnerKeyStore;
  /** The agent's recorded item backend (07 §9.1). */
  readonly items: KeychainBackend;
  readonly agentId: string;
  /** The agent's `store.sqlite`; its inter-process lock is `<path>.lock` (06 §6). */
  readonly storePath: string;
  readonly timeoutMs?: number;
}

/** 04 §2.5.1 `storage.set`, §2.2 `s3:<id>`: the StorageCredentialControl of one agent. */
export function createStorageCredentialControl(
  options: StorageCredentialControlOptions,
): StorageCredentialControl {
  const { owner, items, agentId, storePath } = options;
  assertAgentId(agentId);
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  const lockPath = `${storePath}.lock`;
  return Object.freeze({
    async writeCredential(
      session: OwnerSession,
      id: string,
      credential: StorageCredential,
    ): Promise<string> {
      assertOwnerSession(session, owner);
      assertStorageId(id);
      if (typeof credential !== 'object' || credential === null) {
        throw argument('storage credential: the credential must be an object');
      }
      const { accessKeyId, secretAccessKey } = credential as unknown as Record<string, unknown>;
      if (!(accessKeyId instanceof Uint8Array) || !(secretAccessKey instanceof Uint8Array)) {
        throw argument('storage credential: the values must be bytes');
      }
      const account = keychainAccount(agentId, `s3:${id}`);
      const access = accessKeyId.slice();
      const secret = secretAccessKey.slice();
      const salt = randomBytes(16);
      let item: Uint8Array | undefined;
      try {
        item = encodeStorageCredentialItem({ salt, accessKeyId: access, secretAccessKey: secret });
        const value = item;
        return await withInterProcessLock(lockPath, async () => {
          const existing = await guarded(() => items.get(account), timeoutMs);
          if (existing !== null) {
            wipe(existing);
            throw itemExists();
          }
          await guarded(() => items.set(account, value), timeoutMs);
          const back = await guarded(() => items.get(account), timeoutMs);
          try {
            // A write that did not stick is reported; whatever is there is not this run's item.
            if (back === null || !equalBytes(back, value)) throw keychainFailed();
            return credentialDigestOfItem(back);
          } finally {
            if (back !== null) wipe(back);
          }
        });
      } finally {
        wipe(access, secret, salt, item);
      }
    },

    async removeCredential(session: OwnerSession, id: string): Promise<void> {
      assertOwnerSession(session, owner);
      assertStorageId(id);
      const account = keychainAccount(agentId, `s3:${id}`);
      await withInterProcessLock(lockPath, async () => {
        await guarded(() => items.delete(account), timeoutMs);
      });
    },
  });
}

/**
 * core's OwnStorageKeys (M1-9i-a; 04 §2.2) over an agent's item backend: `storage-mark` is written
 * under `withLock` (the agent's inter-process lock) and read back; the credentialDigest of `s3:<id>`
 * is computed here and the item wiped, so the credential never leaves the package (I-7).
 */
export function ownStorageKeysOver(
  items: KeychainBackend,
  agentId: string,
  withLock: <T>(fn: () => Promise<T> | T) => Promise<T>,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): OwnStorageKeys {
  const markAccount = keychainAccount(agentId, 'storage-mark');
  return Object.freeze({
    readMark: (): Promise<Uint8Array | null> => guarded(() => items.get(markAccount), timeoutMs),
    writeMark: (active: string | null): Promise<void> => {
      const value = encodeStorageMark(active);
      return withLock(async () => {
        await guarded(() => items.set(markAccount, value), timeoutMs);
        const back = await guarded(() => items.get(markAccount), timeoutMs);
        const same = back !== null && equalBytes(back, value);
        if (back !== null) wipe(back);
        if (!same) throw keychainFailed();
      });
    },
    credentialDigest: async (id: string): Promise<string | null> => {
      assertStorageId(id);
      const item = await guarded(() => items.get(keychainAccount(agentId, `s3:${id}`)), timeoutMs);
      if (item === null) return null;
      try {
        return credentialDigestOfItem(item);
      } finally {
        wipe(item);
      }
    },
  });
}
