// Errors of the Node KeyStore backends. Every message is a fixed sentence that says how to fix the
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
  /** The recorded backend is not available in this build (the file KeyStore is M1-8f). */
  | 'backend_unavailable';

export class NodeKeyStoreError extends Error {
  readonly code: NodeKeyStoreErrorCode;

  constructor(code: NodeKeyStoreErrorCode, message: string) {
    super(message);
    this.name = 'NodeKeyStoreError';
    this.code = code;
  }
}
