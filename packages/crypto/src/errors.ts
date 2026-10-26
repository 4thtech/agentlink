/**
 * Why an input was refused. Stable strings: callers branch on `code`, never on the message.
 */
export type CryptoInputErrorCode =
  | 'invalid_argument'
  | 'invalid_hex'
  | 'invalid_base64url'
  | 'invalid_uint256'
  | 'invalid_utf8'
  | 'invalid_length'
  | 'invalid_json'
  | 'jcs_unsupported_value'
  | 'no_secure_random'
  | 'wipe_failed'
  /** A byte string that is not a valid curve point (M1-1b: evmAddressFromPublicKey). */
  | 'invalid_public_key'
  /** A ciphertext payload with the wrong format, version or size (M1-1g: NIP-44). */
  | 'invalid_payload'
  /** Authentication failed, or the authenticated plaintext is malformed (M1-1g: NIP-44). */
  | 'decrypt_failed'
  /** An envelope that breaks the 04 §3.1 v1 structure or a §2.4.1 encoding (M1-1c). */
  | 'invalid_envelope'
  /**
   * Decryption refused (M1-1c): a CEK unwrap or a payload that does not authenticate (wrong key,
   * wrong envelope, tampered bytes) or whose X25519 shared secret is all zero. One code for every
   * cause, so a caller cannot tell them apart.
   */
  | 'open_failed'
  | 'invalid_signature'
  | 'invalid_typed_data'
  | 'invalid_card'
  /** M1-1j: an OCC v2 proof message or domain outside the 05 §3.1 JSON form (04 §2.4.1). */
  | 'invalid_proof_struct'
  /** M1-1f: a secret refused by 04 §2.8 password() before any KDF runs (not a wrong secret). */
  | 'invalid_secret'
  /**
   * M1-1f: an ALKS file or ALKO blob that does not open. One code and one message for a wrong
   * secret, a tampered or truncated file, unknown header values and out-of-bounds KDF parameters, so
   * they are indistinguishable (04 §2.8).
   */
  | 'open_failed'
  /** M1-1f: a chosen owner passphrase (secretKind 2) on a file-KeyStore machine (04 §2.8). */
  | 'secret_kind_refused'
  /** M1-1f: the owner passphrase wrap is for local storage only, never for relay publication (04 §2.3). */
  | 'relay_publication_refused'
  /** M1-1f (IR-M1-1f-1 M-2): codeReveal (nonceA) does not open codeCommit; no code (04 §3.6.1 step 3). */
  | 'commitment_mismatch'
  /** M1-1f (IR-M1-1f-1 L-4): a chosen agent passphrase under 12 code points after NFKC (04 §2.8). */
  | 'passphrase_too_short'
  /**
   * M1-4c-b: a transaction KeyStore.signTransaction does not sign (07 §6.2 direct mode). The message
   * is one of TRANSACTION_REFUSED's fixed sentences, which name the rule, never the input.
   */
  | 'transaction_refused'
  /**
   * M3-4b-t-1: a token's EIP-712 domain as read from chain does not match the configured chain and
   * token, or does not reproduce the token's own DOMAIN_SEPARATOR(); nothing may be signed under it.
   */
  | 'token_domain_mismatch';

/**
 * The one error type @4thtech-io/crypto throws for input it refuses.
 *
 * I-7: the message is a fixed sentence that names the rule that failed. It never contains the input,
 * any part of it, its length or an offset into it, because inputs here are often keys, salts,
 * plaintext or file keys, and errors end up in logs and tool results.
 */
export class CryptoInputError extends Error {
  readonly code: CryptoInputErrorCode;

  constructor(code: CryptoInputErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CryptoInputError';
    this.code = code;
  }
}
