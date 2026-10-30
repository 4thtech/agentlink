// Typed storage errors. Messages are fixed strings: they never carry a URL, an object key, a
// credential or response text from the storage provider (I-7, 04 §4), and never a `cause`, whose
// message could carry any of these.

export type StorageErrorCode =
  | 'invalid_config'
  | 'invalid_argument'
  | 'too_large'
  | 'size_mismatch'
  | 'not_supported'
  | 'credentials_unavailable'
  | 'credentials_expired'
  | 'network'
  | 'upload_failed'
  | 'delete_failed'
  | 'lifecycle_failed'
  /** M1-6b: the downloaded file did not decrypt or did not match its hashes (04 §4). */
  | 'integrity_failed'
  /** M1-6b: the ciphertext source of a download failed. */
  | 'download_failed'
  /**
   * M1-6c: the drop refused a size or quota limit (07 §5.4 Limits); `limit` says which. The core maps
   * it to `needs_setup` (06 §2.3), naming the limit and the own-storage option.
   */
  | 'needs_setup'
  /** M1-6c: the drop is busy (HTTP 429). Retryable, never `needs_setup` (IR-D48-1 F10). */
  | 'rate_limited'
  /** M1-6c: the drop is unavailable (HTTP 503). Retryable, never `needs_setup` (IR-D48-1 F10). */
  | 'unavailable'
  /** M1-6c: the object's link has expired; the drop cannot extend it (07 §5.4). */
  | 'expired'
  /** M1-6c: a storage service answered with something this client refuses (off-origin URL, bad JSON). */
  | 'invalid_response'
  /** W4-SHORT-INVITE: no invite object under that ID (the drop's uniform 404; 07 §5.4). */
  | 'not_found';

/** M1-6c: the drop limits that mean "set up own storage" (07 §5.4 Limits). */
export type StorageLimit = 'size' | 'quota';

export interface StorageErrorDetails {
  readonly limit?: StorageLimit;
  /** Seconds to wait before retrying, from a capped `Retry-After`. */
  readonly retryAfter?: number;
}

export class StorageError extends Error {
  override readonly name = 'StorageError';
  readonly code: StorageErrorCode;
  /** HTTP status of a failed storage request, when there was one. */
  readonly status?: number;
  /** For `needs_setup`: which drop limit was reached. */
  readonly limit?: StorageLimit;
  /** For `rate_limited` and `unavailable`: seconds to wait, when the service said. */
  readonly retryAfter?: number;

  constructor(
    code: StorageErrorCode,
    message: string,
    status?: number,
    details: StorageErrorDetails = {},
  ) {
    super(message);
    this.code = code;
    if (status !== undefined) this.status = status;
    if (details.limit !== undefined) this.limit = details.limit;
    if (details.retryAfter !== undefined) this.retryAfter = details.retryAfter;
  }
}
