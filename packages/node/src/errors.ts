// Errors of the Node KeyStore backends and the owner flows (M1-8c). Every message is a fixed sentence that says how to fix the
// problem; no input, agent ID, keychain text or key material is ever interpolated, and no native
// error is attached as `cause` (I-7). Callers branch on `code`.

export type NodeKeyStoreErrorCode =
  /** The agent ID is not `0x` + 40 lowercase hex (04 §2.9). */
  | 'agent_id_invalid'
  /** The agent's keychain item is missing. Never answered by creating a new identity. */
  | 'identity_missing'
  /** The keychain item does not derive the agent ID it is stored under (04 §2.9). */
  | 'identity_mismatch'
  /** The store key item is not 32 bytes (07 §3). */
  | 'store_key_invalid'
  /** An item for this agent already exists; it is never overwritten. */
  | 'identity_exists'
  /** The OS keychain refused or failed the operation. */
  | 'keychain_failed'
  /** The recorded backend is not one this build knows. */
  | 'backend_unavailable'
  /** No owner is set up on this computer (`needs_setup`, reason `owner_missing`; 04 §2.2). */
  | 'owner_missing'
  /** An owner already exists; `owner init` never replaces it (04 §2.8). */
  | 'owner_exists'
  /** The stored owner item is damaged or belongs to another owner (04 §2.8 "Expected owner"). */
  | 'owner_mismatch'
  /** No interactive terminal: owner secrets are read only at a TTY prompt (D-54, 04 §2.8). */
  | 'owner_prompt_unavailable'
  /** The owner cancelled the prompt (Ctrl-C or Ctrl-D). */
  | 'owner_prompt_cancelled'
  /** A new owner secret was refused: too short, not re-typed correctly, or not allowed here. */
  | 'owner_secret_refused'
  /** An AI app's environment marker is set; the owner step is refused (04 §2.8, UX guard). */
  | 'harness_detected'
  /** The owner operation's item list is empty, too long or malformed. */
  | 'owner_operation_invalid'
  /**
   * M1-8h: the object is not one an owner flow of 04 §2.5 signs (EIP-712 other than the agent card,
   * an owner-action op 04 §2.5.1 does not define, or a second signature in one operation).
   */
  | 'owner_operation_refused'
  /** M1-8h: `owner init` could not issue the first agent card; the new owner item was removed. */
  | 'owner_card_failed'
  /** The stored policy-version mark is not a canonical version (M1-8g). Never read as 0. */
  | 'policy_mark_invalid'
  /** A policy version outside [0, 2^53 - 1] was given to the mark (M1-8g). */
  | 'policy_version_invalid'
  /** The mark did not read back as raised after the write (M1-8g). */
  | 'policy_mark_not_raised'
  /** M1-33a: the receipts-kept marker did not read back as written; the owner is asked again. */
  | 'receipts_kept_not_written'
  /** M1-8e: a localhost passkey is already set up for this OS user (one in M1b); never replaced. */
  | 'owner_passkey_exists'
  /** M1-8e: the authenticator returned no PRF output; nothing is stored, the owner code stays. */
  | 'passkey_unsupported'
  /**
   * M1-8f: the file KeyStore has no unlock source, was closed, or its file changed under the
   * in-memory key (a passphrase change elsewhere): `needs_setup` (`keystore_locked`) until restarted.
   */
  | 'keystore_locked'
  /** M1-8f: a wrong unlock secret, or a damaged or foreign key file: one error for all (04 §2.8). */
  | 'keystore_open_failed'
  /** M1-8f: the key file, its folder or the passphrase file fails the 04 §2.8 file checks. */
  | 'keystore_file_unsafe'
  /** M1-8f: the key file could not be read or written (I/O or lock failure). */
  | 'keystore_failed'
  /** M1-8f: the file KeyStore opt-in was refused (a keychain works, or no interactive terminal). */
  | 'keystore_opt_in_refused'
  /** M1-8f: a new agent secret was refused (too short, invalid, the owner code, not confirmed). */
  | 'keystore_passphrase_refused'
  /**
   * U3-e: an agent's keys were not all erased (04 §2.5 step 6): a backend call failed, an item is
   * still there, or the request was refused (no verifying `agent.revoke`). Removal stops before the
   * agent's folder is deleted.
   */
  | 'keystore_erase_failed';

export class NodeKeyStoreError extends Error {
  readonly code: NodeKeyStoreErrorCode;

  constructor(code: NodeKeyStoreErrorCode, message: string) {
    super(message);
    this.name = 'NodeKeyStoreError';
    this.code = code;
  }
}
