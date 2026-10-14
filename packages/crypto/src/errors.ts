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
  | 'decrypt_failed';

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
