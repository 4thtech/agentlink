// Errors of the SQLite Store (M1-8b). Every message is a fixed sentence that says how to fix the
// problem; no path, SQL, row value or SQLite text is interpolated, and no native error is attached
// as `cause` (I-7). Callers branch on `code`. Schema violations by a write are core's
// StoreConstraintError and misuse is core's StoreUsageError, as for every Store.

export type NodeStoreErrorCode =
  /** The store's schema version is newer than this code: it is never opened or downgraded (07 §3.7). */
  | 'store_too_new'
  /** The file is not an AgentLink store, or its tables are not the schema they claim to be. */
  | 'store_foreign'
  /** Another process held the store's write lock or the inter-process lock past the time limit. */
  | 'store_busy'
  /** SQLite failed the operation (I/O, a full disk, a damaged file, a lost transaction). */
  | 'store_failed'
  /** A stored row holds a value outside its column's type (07 §3.1: fail closed, never absent). */
  | 'store_unreadable';

const MESSAGES: Readonly<Record<NodeStoreErrorCode, string>> = {
  store_too_new:
    "This agent's local data was written by a newer version of AgentLink. Update AgentLink.",
  store_foreign:
    "This file is not AgentLink's local data, or it is damaged. Check the agent's config with `agentlink doctor`.",
  store_busy:
    "Another AgentLink process is busy with this agent's local data. Try again in a moment.",
  store_failed:
    "AgentLink could not read or write this agent's local data. Check free disk space, then `agentlink doctor`.",
  store_unreadable:
    "Part of this agent's local data is damaged and was not used. Run `agentlink doctor`.",
};

export class NodeStoreError extends Error {
  readonly code: NodeStoreErrorCode;

  constructor(code: NodeStoreErrorCode) {
    super(MESSAGES[code]);
    this.name = 'NodeStoreError';
    this.code = code;
  }
}
