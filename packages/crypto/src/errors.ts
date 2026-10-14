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
  | 'no_secure_random';

/**
 * The one error type @agentlink/crypto throws for input it refuses.
 *
 * I-7: the message is a fixed sentence that names the rule that failed. It never contains the input,
 * any part of it, its length or an offset into it, because inputs here are often keys, salts,
 * plaintext or file keys, and errors end up in logs and tool results.
 */
export class CryptoInputError extends Error {
  readonly code: CryptoInputErrorCode;

  constructor(code: CryptoInputErrorCode, message: string) {
    super(message);
    this.name = 'CryptoInputError';
    this.code = code;
  }
}
