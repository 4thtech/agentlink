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
//   kit's. importOwner writes the owner seed under a new generated master code with the `owner-next`
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
  KEY_LABELS,
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
  type OwnerPresence,
  type OwnerPublicKeys,
  type OwnerSession,
  type RecoveryCodeSecret,
  type RecoveryKitExportRequest,
  type RecoveryKitImport,
  type RecoveryKitSource,
  type StorageCredential,
  type StorageCredentialControl,
} from '@4thtech-io/crypto';
import {
  derivePublicKey,
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
  KeychainOwnerKeyStore,
  OWNER_ACCOUNT,
  OWNER_NEXT_ACCOUNT,
  exportSeedOf,
  issuedBy,
  storeRestoredOwnerSeed,
} from './owner-keystore.js';
import { storeOwnerPasskeyKey, storeOwnerPasskeySeed } from './owner-passkey.js';
import {
  checkQuarantinedSnapshot,
  discardQuarantineSync,
  checkedSnapshotKeyEpoch,
  isQuarantineSink,
} from './restore-quarantine.js';
import { encodeKeyEpoch } from './key-epoch.js';

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
  /** KIT-NAMES: the ID's owner-set name, sealed inside the kit. */
  readonly label?: string;
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
    const { agentId, name, label } = (agent ?? {}) as Record<string, unknown>;
    assertAgentId(agentId);
    if (typeof name !== 'string' || !AGENT_NAME.test(name)) {
      throw argument('backup export: an agent name is not valid');
    }
    // KIT-NAMES: the label rule itself is the sealer's (refused there before anything is written).
    if (label !== undefined && typeof label !== 'string') {
      throw argument('backup export: an agent label is not valid');
    }
    if (seen.has(agentId)) throw argument('backup export: an agent is listed twice');
    seen.add(agentId);
    return Object.freeze(label === undefined ? { agentId, name } : { agentId, name, label });
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
            ...(agent.label === undefined ? {} : { label: agent.label }),
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
              ...(agent.label === undefined ? {} : { label: agent.label.slice() }),
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
      // kit's owner. A card naming that owner is never enough. UX1113-R1 (D-147 (4)): or the
      // seedless restore-only session that presence on this store minted (unlockForRestore).
      if (await ownerPresent()) {
        const session = importOptions.owner;
        if (
          ownerStore === undefined ||
          !(issuedBy(session, ownerStore) || restoreSessionOf(session, ownerStore))
        ) {
          throw presenceRequired();
        }
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
      // W4-RENAME-REACHES-CONTACTS (D-141; 04 §2.3.3): a kit made before `key-epoch` was carried has
      // none; the epoch then comes from the verified snapshot's identity row (equal to its card's),
      // so a renamed agent still opens its KeyStore at the epoch its store holds.
      if (!agent.items.some((item) => item.name === 'key-epoch')) {
        const epoch = checkedSnapshotKeyEpoch(agent.store);
        if (epoch !== undefined && epoch > 0) {
          entries.push({ name: 'key-epoch', value: encodeKeyEpoch(epoch) });
        }
      }
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

// --- Restore in the app (UX1113-R1, D-147) --------------------------------------------------------

/**
 * UX1113-R1 (D-147 (5); 04 §2.3.3 step 6 "In the app"): after importOwner wrote the owner under its
 * new master code, also writes the `ALKP` passkey wrap of the kit's owner seed under the PRF output
 * of the restore's fresh user-verified WebAuthn create, as first run does (04 §2.3.1), and keeps its
 * credential public key. The seed never leaves this package; the PRF output is wiped. False when the
 * wrap could not be written (the owner then approves with the master code, as without PRF).
 */
export async function importOwnerPasskey(
  kit: RecoveryKitImport,
  keychain: KeychainBackend,
  passkey: {
    readonly prfOutput: Uint8Array;
    readonly credentialId: Uint8Array;
    readonly authenticatorData: Uint8Array;
  },
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<boolean> {
  const opened = stateOf(kit);
  try {
    const owner = ownerKeysOfSeed(opened.ownerSeed);
    if (!equalBytes(owner.ownerNostr, opened.ownerNostr)) return false;
    await storeOwnerPasskeySeed(
      keychain,
      opened.ownerSeed,
      owner,
      passkey.prfOutput,
      passkey.credentialId,
      { timeoutMs },
    );
    await storeOwnerPasskeyKey(
      keychain,
      passkey.credentialId,
      passkey.authenticatorData,
      timeoutMs,
    ).catch(() => false);
    return true;
  } catch {
    return false;
  } finally {
    wipe(passkey.prfOutput);
  }
}

/**
 * REL051-CF3 (04 §2.3.3 step 6 "In the app", T-7): importOwner of the app's restore, the same write
 * (a new generated master code, the `owner-next` protocol, never overwrites), with `beforeWrite`
 * awaited with the sealed `ALKO` blob before anything is written, so the restore can mark the item
 * it is about to store (master-code-unsaved.ts). Returns the new code for the one answer.
 */
export async function importRestoredOwner(
  kit: RecoveryKitImport,
  keychain: KeychainBackend,
  options: {
    readonly kdf?: Argon2idParams;
    readonly timeoutMs?: number;
    readonly beforeWrite: (blob: Uint8Array) => Promise<void>;
  },
): Promise<DisplayCode> {
  const opened = stateOf(kit);
  const ownerCode = generateSecretCode();
  try {
    await storeRestoredOwnerSeed(keychain, opened.ownerSeed, opened.ownerNostr, ownerCode, {
      ...(options.kdf === undefined ? {} : { kdf: options.kdf }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      beforeWrite: options.beforeWrite,
    });
    return asDisplayCode(ownerCode);
  } catch (error) {
    wipe(ownerCode);
    throw error;
  }
}

/** The owner public keys a seed derives (04 §2.1, epoch 0). */
function ownerKeysOfSeed(seed: Uint8Array): OwnerPublicKeys {
  const evm = derivePublicKey(seed, KEY_LABELS.evm, 0);
  const nostr = derivePublicKey(seed, KEY_LABELS.nostr, 0);
  const enc = derivePublicKey(seed, KEY_LABELS.enc, 0);
  if (
    evm.label !== KEY_LABELS.evm ||
    nostr.label !== KEY_LABELS.nostr ||
    enc.label !== KEY_LABELS.enc
  ) {
    throw argument('restore: the owner keys cannot be derived');
  }
  return Object.freeze({
    ownerEvm: evm.address,
    ownerNostr: nostr.publicKey,
    ownerEnc: enc.publicKey,
  });
}

/**
 * UX1113-R1 (04 §2.3.3 "never overwrites"; T-7): removes the keychain items of `agentId` that
 * importAgent just wrote, when the rest of that ID (its folder, store or config) could not be
 * written, so a failed ID leaves none of its items. Only the restore engine calls it, only for an ID
 * whose importAgent succeeded in the same apply (it checked every item was absent before writing).
 * Never an owner account or an `s3:*` item.
 */
export async function discardImportedAgent(
  keychain: KeychainBackend,
  agentId: string,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<void> {
  assertAgentId(agentId);
  for (const name of KIT_ITEMS) {
    await guarded(() => keychain.delete(keychainAccount(agentId, name)), timeoutMs).catch(
      () => false,
    );
  }
}

/** The binding and state of one restore-only owner session (module-private, by identity). */
interface RestoreSessionState {
  readonly store: KeychainOwnerKeyStore;
  readonly headerHash: Uint8Array;
  readonly expiresAt: number;
  active: boolean;
}

const RESTORE_SESSIONS = new WeakMap<object, RestoreSessionState>();

/** True when `session` is a live restore-only session of `store` (by identity, never by shape). */
function restoreSessionOf(session: unknown, store: KeychainOwnerKeyStore): boolean {
  if (typeof session !== 'object' || session === null) return false;
  const state = RESTORE_SESSIONS.get(session);
  if (state === undefined || state.store !== store || !state.active) return false;
  if (Date.now() >= state.expiresAt) {
    state.active = false;
    return false;
  }
  return true;
}

/** UX1113-R1: the restore-only owner session (04 §2.5 "Restore-only owner session"). */
export interface RestoreOwnerSessionHold {
  /** The seedless session: `isActive` and `getPublicKeys` only; every sign refuses. */
  readonly session: OwnerSession;
  /** The store it pairs with, for KeyImportControl's `ownerStore` (public keys only). */
  readonly store: KeychainOwnerKeyStore;
  /** True when this session is bound to exactly this 32-byte header hash. */
  boundTo(headerHash: Uint8Array): boolean;
  /** Ends it (idempotent): importAgent refuses it from then on. */
  end(): void;
}

const restoreRefused = (): KeyStoreError =>
  new KeyStoreError('operation_not_allowed', 'restore session: it signs nothing');

/**
 * UX1113-R1 (D-147 (4); 04 §2.5 "Restore-only owner session"): verifies owner presence (the master
 * code on `owner`, or the passkey PRF output on `owner-passkey`; the caller checked the assertion)
 * by opening this computer's owner item to exactly `ownerNostr` (the kit header's owner), **wipes
 * the owner seed at once** (the unlock session is ended before this returns) and answers a seedless
 * session bound to `headerHash` (SHA-256 of the kit's 74-byte header). It answers only `isActive()`
 * and `getPublicKeys()`; every sign, encrypt and decrypt refuses; only KeyImportControl.importAgent
 * accepts it (by identity), to check that the owner on this computer is the kit's. A wrong secret,
 * another owner and a damaged item are one answer, `presence_rejected`. It holds no secret, so it is
 * not an unlock session in the sense of D-68 (1). Lives at most `ttlMs` (default 10 minutes).
 */
export async function unlockForRestore(
  keychain: KeychainBackend,
  ownerNostr: Uint8Array,
  options: {
    readonly presence: OwnerPresence;
    readonly headerHash: Uint8Array;
    readonly ttlMs?: number;
    readonly timeoutMs?: number;
  },
): Promise<RestoreOwnerSessionHold> {
  if (!(options.headerHash instanceof Uint8Array) || options.headerHash.length !== 32) {
    throw argument('restore session: the header hash must be 32 bytes');
  }
  const ttlMs = options.ttlMs ?? 600_000;
  // unlockForOwnerNostr wipes the presented bytes, whether or not they unlock.
  const unlocked = await KeychainOwnerKeyStore.unlockForOwnerNostr(
    keychain,
    ownerNostr,
    options.presence,
    { ttlMs: 60_000, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) },
  );
  // The seed-derived keys are wiped now: the restore session never holds them.
  await unlocked.session.close();
  const state: RestoreSessionState = {
    store: unlocked.store,
    headerHash: options.headerHash.slice(),
    expiresAt: Date.now() + ttlMs,
    active: true,
  };
  const keys = unlocked.owner;
  const refuse = (): Promise<never> => Promise.reject(restoreRefused());
  const session = Object.freeze({
    expiresAt: state.expiresAt,
    isActive: (): boolean => restoreSessionOf(session, state.store),
    getPublicKeys: () =>
      Promise.resolve(
        Object.freeze({
          ownerEvm: keys.ownerEvm.slice(),
          ownerNostr: keys.ownerNostr.slice(),
          ownerEnc: keys.ownerEnc.slice(),
        }),
      ),
    signOwnerAction: refuse,
    sign712: refuse,
    signEnvelopeHash: refuse,
    signNostr: refuse,
    nip44Encrypt: refuse,
    nip44Decrypt: refuse,
    unwrapCek: refuse,
    close: (): Promise<void> => {
      state.active = false;
      return Promise.resolve();
    },
  }) as unknown as OwnerSession;
  RESTORE_SESSIONS.set(session, state);
  return Object.freeze({
    session,
    store: state.store,
    boundTo: (headerHash: Uint8Array): boolean =>
      state.active && headerHash instanceof Uint8Array && equalBytes(headerHash, state.headerHash),
    end: (): void => {
      state.active = false;
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
