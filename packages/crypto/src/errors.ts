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
  | 'invalid_signature'
  | 'invalid_typed_data'
  | 'invalid_card'
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
  | 'relay_publication_refused';

/**
 * The one error type @agentlink/crypto throws for input it refuses.
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
