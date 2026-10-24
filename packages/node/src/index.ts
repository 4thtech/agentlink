// @4thtech-io/node: Node implementations (07 §1). M1-8a: the OS keychain KeyStore (04 §2.2, 07 §9).
// The SQLite Store (M1-8b), the owner passphrase store (M1-8c), the local approval server (M1-8d)
// and the file KeyStore (M1-8f) land with their backlog tasks.
//
// This entry is the fence around the agent seed (04 §8.1, IR-M1-8a-1 M-2): it exports only opaque
// entry points. The raw keychain backend, account names and the store key stay inside the package
// (fence.test.ts checks the exact export list).
export const packageName = '@4thtech-io/node';

export { NodeKeyStoreError, type NodeKeyStoreErrorCode } from './errors.js';
export {
  KEYCHAIN_SERVICE,
  assertAgentId,
  selectKeyStoreBackend,
  type KeyStoreBackendKind,
  type KeyStoreSelection,
  type KeychainProbe,
  type ProbeOptions,
} from './keychain.js';
export {
  createFileKeyStoreAgent,
  createOsKeychainAgent,
  openAgentKeyStore,
  probeOsKeychain,
  type KeychainKeyStoreOptions,
  type OpenAgentKeyStoreOptions,
} from './keychain-keystore.js';
// M1-8f (04 §2.8, D-54): the passphrase-locked file KeyStore for headless machines. Only the unlock
// and passphrase-change entry points and an opaque handle: no kek, file reader, directory or KDF seam.
export {
  PASSPHRASE_ENV,
  PASSPHRASE_FILE_ENV,
  changeFileKeyStorePassphrase,
  unlockFileKeyStoreAgent,
  type FileKeyStoreSetupOptions,
  type FileKeyStoreWarning,
  type UnlockedFileAgent,
} from './file-keystore.js';
// M1-8c: owner steps at a TTY prompt (04 §2.2, §2.5, D-67). Only the prompting entry points are
// exported: no OwnerKeyStore, session, owner item or presence argument is reachable from here.
export {
  initOwner,
  type OwnerInitOptions,
  type OwnerInitResult,
  type OwnerSetupOptions,
} from './owner-init.js';
// M1-9t (D-78): `owner add-agent` signs a further agent's first card with the existing owner key, at
// the same TTY prompt; the owner store and session stay inside the package.
// M1-9x: with no local agent naming the owner, add-agent takes the owner keys from the owner item;
// hasOwnerOnMachine is a store-only check (no secret read, nothing unlocked) for doctor and messages.
export {
  addAgentToOwner,
  hasOwnerOnMachine,
  type AddAgentOptions,
  type AddAgentResult,
} from './owner-add-agent.js';
// M1-9z: `owner change-code` re-wraps the owner seed under a new generated owner code, at the same
// TTY prompt; the owner identity does not change and nothing secret leaves the package.
export {
  changeOwnerCode,
  hasUnfinishedOwnerCodeChange,
  type ChangeOwnerCodeOptions,
  type ChangeOwnerCodeResult,
} from './owner-change-code.js';
// M1-8h: `owner init` signs the agent's first card; the caller passes core's IdentityService. Only
// types: the restricted session stays inside the package (owner-first-card.ts).
export type {
  FirstAgentCard,
  FirstCardIdentity,
  FirstPolicy,
  FirstPolicyActions,
} from './owner-first-card.js';
// M1-36b-2: the first rules (the Send folder) signed in the same entry; only the result type.
export type { SendFolderResult } from './owner-first-policy.js';
// M1-11b-6: whether the first-run page may offer owner setup (no owner anywhere: card, owner items,
// file-KeyStore owner files). A store-only boolean like hasOwnerOnMachine; the keychain seam stays.
export { ownerSetupAvailable } from './owner-setup.js';
export {
  performOwnerOperation,
  type OwnerOperationItem,
  type OwnerSignature,
} from './owner-operation.js';
export {
  LOCAL_APPROVAL_LIFETIME_S,
  MAX_APPROVAL_BATCH_ITEMS,
  decideReviewedApprovals,
  type ApprovalContext,
  type ReviewedApproval,
} from './owner-approval.js';
// M1-8d: the local approval server (08 §1). Only the entry point and its types: the owner store,
// browser opener and notifier seams stay inside the package (startApprovalServerWith).
export {
  APPROVAL_SERVER_HOST,
  startApprovalServer,
  type ApprovalDetails,
  type ApprovalForDecision,
  type ApprovalServer,
  type ApprovalServerEvent,
  type ApprovalServerOptions,
  type ApprovalServerSource,
  type PendingApprovalView,
} from './approval-server.js';
// M1-11s-b: what the caller wires into the local UI (D-118): the app's in-memory files and the
// agent's core client. The route registry and the presence gate stay inside the package.
export type {
  LocalUiAssets,
  LocalUiContext,
  LocalUiOptions,
  LocalUiOwnerSetup,
} from './local-ui/context.js';
// M1-8b: the agent's local SQLite store and the cipher of its `enc` columns (07 §3). The store key
// stays inside the package: the entry returns only the Store and the cipher (fence.test.ts).
export { NodeStoreError, type NodeStoreErrorCode } from './store-errors.js';
export { openAgentStore, type AgentStore, type AgentStoreOptions } from './agent-store.js';
export type { AgentStoreCipher } from './store-cipher.js';
// M1-5b-b: the relay I/O of @4thtech-io/transport-nostr's RelayPool (07 §4.2). The CLI wiring (M1-9a)
// injects them; their test seams (a CA, a route to a local port, an injected lookup) stay inside.
export {
  NIP11_TIMEOUT_MS,
  nodeHostResolver,
  nodeNip11Fetcher,
  nodeRelayConnector,
} from './relay-io.js';
// M1-15: the SSRF-safe download (DNS-pinned, 04 §4) and the allowed-folder and inbox file guards.
// The test seams (an injected lookup, a CA, a route to a local port) stay inside.
export {
  SAFE_FETCH_TIMEOUT_MS,
  SafeFetchError,
  nodeSafeFetch,
  type SafeFetch,
  type SafeFetchErrorCode,
  type SafeFetchOptions,
  type SafeFetchResult,
} from './safe-fetch.js';
// M1-4a (IR-M1-4a-1 M-1): the address-checked fetch for chain RPC requests (no lookup, CA or route
// seam).
export {
  RPC_FETCH_MAX_BYTES,
  RpcFetchError,
  nodeRpcFetch,
  type RpcFetch,
  type RpcFetchErrorCode,
} from './rpc-fetch.js';
export {
  AllowedPathError,
  createInboxFile,
  openAllowedFile,
  resolveAllowedFile,
  type AllowedFile,
  type AllowedPathErrorCode,
  type AllowedPathOptions,
} from './allowed-path.js';
