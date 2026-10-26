// M1-8b: opening an agent's local store: the SQLite file and the cipher of its `enc` columns under the
// agent's store key (07 §3, §3.1). The store key is read from the agent's recorded KeyStore backend
// once, imported into non-extractable keys and wiped (withStoreKey); it never leaves this package.
// M1-8g: the store also comes with the agent's policy-version mark (04 §2.5.1; 07 §3.4), a KeyStore
// item raised under the store's inter-process lock, for AgentLinkClient.create's `policyMark`.
import {
  StoreUsageError,
  type OwnStorageKeys,
  type PolicyVersionMark,
  type ReceiptsKeptMark,
  type Store,
  type StoreTx,
} from '@4thtech-io/core';
import type { UnlockedFileAgent } from './file-keystore.js';
import { ownStorageKeysOver } from './key-controls.js';
import {
  KeychainKeyStore,
  recordedBackend,
  type KeychainKeyStoreOptions,
} from './keychain-keystore.js';
import { osKeychain, type KeyStoreBackendKind, type KeychainBackend } from './keychain.js';
import { keychainPolicyMark } from './policy-mark.js';
import { keychainReceiptsKept } from './receipts-kept.js';
import { SqliteStore } from './sqlite-store.js';
import { createAgentStoreCipher, type AgentStoreCipher } from './store-cipher.js';

export interface AgentStore {
  /** The Store (07 §3.7) over the agent's SQLite file. */
  readonly store: Store & {
    /** The agent's inter-process lock (06 §6; 07 §3.4). */
    withInterProcessLock<T>(fn: () => Promise<T> | T): Promise<T>;
  };
  /** Seals and opens the store's `enc` columns, and computes its keyed digests (07 §3.1). */
  readonly cipher: AgentStoreCipher;
  /**
   * The policy-version high-water mark of the agent's recorded backend (M1-8g), raised under this
   * store's inter-process lock. Pass it as AgentLinkClient.create's `policyMark`: without it no
   * policy.set applies and a loaded policy fails closed (M1-7d).
   */
  readonly policyMark: PolicyVersionMark;
  /**
   * The receipts-kept marker of the agent's recorded backend (M1-33a; 04 §2.2, 06 §3), written under
   * this store's inter-process lock. Pass it as AgentLinkClient.create's `receiptsKept`.
   */
  readonly receiptsKept: ReceiptsKeptMark;
  /**
   * The own-storage KeyStore items of the agent's recorded backend (M1-9i-c; 04 §2.2): the
   * `storage-mark`, written under this store's inter-process lock and read back, and the
   * credentialDigest of `s3:<id>` (never the credential). Pass it to core's own-storage load.
   */
  readonly ownStorageKeys: OwnStorageKeys;
  /** Closes the store and drops the cipher's keys. */
  close(): Promise<void>;
}

export interface AgentStoreOptions {
  /** Limit for each keychain call in milliseconds (KeychainKeyStoreOptions). */
  readonly timeoutMs?: number;
  /** For the backend `file` (M1-8f): the handle unlockFileKeyStoreAgent returned for this agent. */
  readonly fileAgent?: UnlockedFileAgent;
}

/**
 * A frozen object with exactly the Store methods and the inter-process lock (IR-M1-8b-1 L-1, as
 * keyStoreFacade for the KeyStore): code holding an AgentStore reaches no connection, statement or
 * SqliteStore instance to run its own SQL through.
 */
function storeFacade(store: SqliteStore): AgentStore['store'] {
  return Object.freeze({
    schemaVersion: store.schemaVersion,
    transaction: <R>(body: (tx: StoreTx) => R): Promise<R> => store.transaction(body),
    withInterProcessLock: <T>(fn: () => Promise<T> | T): Promise<T> =>
      store.withInterProcessLock(fn),
    close: (): Promise<void> => store.close(),
  });
}

/** @internal The same as openAgentStore over a given keychain backend (tests use a double). */
export async function openAgentStoreWith(
  backend: KeyStoreBackendKind,
  agentId: string,
  path: string,
  backends: { readonly keychain: KeychainBackend; readonly file?: UnlockedFileAgent },
  options: AgentStoreOptions = {},
): Promise<AgentStore> {
  // M1-8f: the file backend's items are the `ALKS` entries of the unlocked file, behind the same
  // item interface, so the store key, the policy-version mark and the receipts-kept marker below
  // are the keychain code unchanged (04 §2.8).
  const items = recordedBackend(backend, agentId, backends);
  const keyOptions: KeychainKeyStoreOptions =
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
  const keys = await KeychainKeyStore.open(items, agentId, keyOptions);
  let cipher: AgentStoreCipher;
  try {
    cipher = await keys.withStoreKey((storeKey) => createAgentStoreCipher(storeKey));
  } finally {
    await keys.close();
  }
  let store: SqliteStore;
  try {
    store = await SqliteStore.open(path);
  } catch (error) {
    cipher.close();
    throw error;
  }
  let closed = false;
  const mark = keychainPolicyMark(
    items,
    agentId,
    (fn) => store.withInterProcessLock(fn),
    keyOptions,
  );
  const storeClosed = (): Promise<never> =>
    Promise.reject(new StoreUsageError('store: the store is closed'));
  const policyMark: PolicyVersionMark = Object.freeze({
    read: (): Promise<number> => (closed ? storeClosed() : mark.read()),
    raise: (version: number): Promise<number> => (closed ? storeClosed() : mark.raise(version)),
  });
  const kept = keychainReceiptsKept(
    items,
    agentId,
    (fn) => store.withInterProcessLock(fn),
    keyOptions,
  );
  const receiptsKept: ReceiptsKeptMark = Object.freeze({
    read: (): Promise<number | null> => (closed ? storeClosed() : kept.read()),
    write: (version: number): Promise<void> => (closed ? storeClosed() : kept.write(version)),
  });
  const own = ownStorageKeysOver(
    items,
    agentId,
    (fn) => store.withInterProcessLock(fn),
    options.timeoutMs,
  );
  const ownStorageKeys: OwnStorageKeys = Object.freeze({
    readMark: (): Promise<Uint8Array | null> => (closed ? storeClosed() : own.readMark()),
    writeMark: (active: string | null): Promise<void> =>
      closed ? storeClosed() : own.writeMark(active),
    credentialDigest: (id: string): Promise<string | null> =>
      closed ? storeClosed() : own.credentialDigest(id),
  });
  return Object.freeze({
    store: storeFacade(store),
    cipher,
    policyMark,
    receiptsKept,
    ownStorageKeys,
    close: async (): Promise<void> => {
      closed = true;
      cipher.close();
      await store.close();
    },
  });
}

/**
 * Opens the local store of `agentId` at `path` with the agent's recorded KeyStore backend (07 §9.1):
 * the SQLite file (created with owner-only permissions, migrated forward) and its column cipher.
 */
export function openAgentStore(
  backend: KeyStoreBackendKind,
  agentId: string,
  path: string,
  options: AgentStoreOptions = {},
): Promise<AgentStore> {
  const { fileAgent, ...rest } = options;
  return openAgentStoreWith(
    backend,
    agentId,
    path,
    fileAgent === undefined
      ? { keychain: osKeychain() }
      : { keychain: osKeychain(), file: fileAgent },
    rest,
  );
}
