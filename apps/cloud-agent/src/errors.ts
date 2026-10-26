// Errors of the cloud agent (M2-3a). Every message is a fixed sentence; no secret, seed, key, SQL,
// row value, URL or runtime error text is interpolated, and no native error is attached as `cause`
// (I-7). Callers branch on `code`. Schema violations by a write are core's StoreConstraintError and
// misuse is core's StoreUsageError, as for every Store.

export type CloudAgentErrorCode =
  /** The stored schema version is newer than this code: it is never opened or downgraded (07 §3.7). */
  | 'store_too_new'
  /** The stored schema version is older and no forward migration exists for it yet. */
  | 'store_needs_migration'
  /** The object's storage holds tables that are not this schema. */
  | 'store_foreign'
  /** SQLite failed the operation. */
  | 'store_failed'
  /** A stored row holds a value outside its column's type (07 §3.1: fail closed, never absent). */
  | 'store_unreadable'
  /** Neither AGENT_SEED nor a sealed seed is there yet: the agent is not set up. */
  | 'seed_missing'
  /** AGENT_SEED or SEED_WRAP_KEY is not in its form (64 lowercase hex; 43 base64url characters). */
  | 'seed_secret_invalid'
  /** AGENT_SEED is set and a sealed seed is stored too: which one is the agent is not decided here. */
  | 'seed_conflict'
  /** The sealed seed does not open under SEED_WRAP_KEY. */
  | 'seed_unreadable'
  /** A sealed seed needs SEED_WRAP_KEY, which is not set. */
  | 'seed_wrap_key_missing'
  /** The seed does not derive the agent recorded in the store (04 §2.9). */
  | 'identity_mismatch'
  /** The policy-version mark is not in its canonical form (04 §2.2): fail closed. */
  | 'mark_malformed';

const MESSAGES: Readonly<Record<CloudAgentErrorCode, string>> = {
  store_too_new: "This agent's data was written by a newer version of the cloud agent. Update it.",
  store_needs_migration: "This agent's data needs an update that this version does not have.",
  store_foreign: "This agent's storage holds data that is not AgentLink's, or it is damaged.",
  store_failed: "The cloud agent could not read or write this agent's data.",
  store_unreadable: "Part of this agent's data is damaged and was not used.",
  seed_missing: 'This cloud agent is not set up yet. Open its setup page to finish.',
  seed_secret_invalid: 'A secret of this cloud agent is not in its expected form. Set it again.',
  seed_conflict:
    "This cloud agent has two identities configured. Remove the one that isn't this agent's.",
  seed_unreadable: "This cloud agent's identity does not open with its wrap key.",
  seed_wrap_key_missing: "This cloud agent's wrap key secret is missing. Set it again.",
  identity_mismatch: "This cloud agent's identity does not match its stored data.",
  mark_malformed: "This cloud agent's rules version mark is damaged.",
};

export class CloudAgentError extends Error {
  readonly code: CloudAgentErrorCode;

  constructor(code: CloudAgentErrorCode) {
    super(MESSAGES[code]);
    this.name = 'CloudAgentError';
    this.code = code;
  }
}
