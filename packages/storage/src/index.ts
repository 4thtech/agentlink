// @agentlink/storage: storage adapters (07 §5). Every adapter receives only ALF1 ciphertext (I-2).
// M1-6a: the StorageAdapter interface, the inline adapter and the S3-compatible adapter.
export const packageName = '@agentlink/storage';

export { StorageError, type StorageErrorCode } from './errors.js';
export type { PutOptions, StorageAdapter, StorageKind, StoredObject } from './adapter.js';
export {
  INLINE_MAX_CIPHERTEXT_BYTES,
  createInlineAdapter,
  type InlineAdapter,
  type InlineAdapterOptions,
} from './inline.js';
export {
  MAX_PRESIGN_SECONDS,
  S3_MAX_SINGLE_PUT_BYTES,
  createS3Adapter,
  type FetchLike,
  type PresignedGet,
  type S3Adapter,
  type S3AdapterConfig,
  type S3Credentials,
  type S3CredentialsProvider,
} from './s3.js';
export { newObjectKey, validateS3Endpoint, validateStoragePrefix } from './endpoint.js';
// M1-6b part 1: multipart upload with abort and cleanup, and the bucket lifecycle rule.
export {
  MULTIPART_DEFAULT_PART_BYTES,
  MULTIPART_MAX_BYTES,
  MULTIPART_MAX_PARTS,
  MULTIPART_MAX_PART_BYTES,
  MULTIPART_MIN_PART_BYTES,
  createS3Multipart,
  multipartPartSize,
  type MultipartPutOptions,
  type S3Multipart,
  type S3MultipartConfig,
} from './multipart.js';
export {
  LIFECYCLE_ABORT_INCOMPLETE_DAYS,
  LIFECYCLE_DEFAULT_DAYS,
  LIFECYCLE_PREFIX,
  LIFECYCLE_RULE_ID,
  createS3Lifecycle,
  type LifecycleRuleState,
  type S3Lifecycle,
  type S3LifecycleConfig,
} from './lifecycle.js';
// M1-6b part 2: STREAM (ALF1) encryption into an upload, and the streaming download with decryption,
// a byte cap and a provisional output that is committed only once the whole file verified.
export {
  alf1CiphertextSize,
  putEncrypted,
  type EncryptedObject,
  type EncryptedPutOptions,
  type EncryptedPutTarget,
} from './stream-upload.js';
export {
  decryptDownload,
  type CiphertextSource,
  type DecryptDownloadOptions,
  type DecryptedFile,
} from './stream-download.js';
export {
  createTempFileSink,
  type ProvisionalSink,
  type TempFileHandle,
  type TempFileOps,
} from './stream-sink.js';
