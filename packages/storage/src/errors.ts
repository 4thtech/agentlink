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
  | 'download_failed';

export class StorageError extends Error {
  override readonly name = 'StorageError';
  readonly code: StorageErrorCode;
  /** HTTP status of a failed storage request, when there was one. */
  readonly status?: number;

  constructor(code: StorageErrorCode, message: string, status?: number) {
    super(message);
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
