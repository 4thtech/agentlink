// M1-6b part 2: a file stream → ALF1 STREAM encryption → a storage upload, in one pass (07 §5.2,
// 04 §4, D-80).
//
// - The file key is 32 fresh CSPRNG bytes made here for every file and never taken from the caller,
//   so a key (and with it a nonce sequence) is never reused for another file (04 §4 "File key").
//   The caller puts it in the envelope only (I-2) and never logs it.
// - Encryption goes through @agentlink/crypto (alf1EncryptStream: random nonce prefix, 1 MiB
//   chunks); nothing here touches a primitive (I-8).
// - Memory is bounded by the target: the S3 multipart target (multipart.ts) holds one part, the
//   sealer one chunk. Nothing buffers the file.
// - The ciphertext length follows from the plaintext length, so the target gets the exact size up
//   front. A plaintext longer or shorter than declared fails (`size_mismatch`), and the target
//   aborts the upload: the multipart target leaves no open multipart upload on any failure.
// - Hashes are computed as the bytes go (04 §4 Integrity): the target hashes exactly what it sent
//   (`StoredObject.sha256`), the sealer hashes the whole object and the plaintext; the two
//   ciphertext hashes must agree.
import {
  ALF1_DEFAULT_CHUNK_SIZE,
  ALF1_FILE_KEY_LENGTH,
  ALF1_HEADER_LENGTH,
  ALF1_TAG_LENGTH,
  alf1EncryptStream,
  encodeHex,
  randomBytes,
  wipe,
} from '@agentlink/crypto';
import type { PutOptions, StoredObject } from './adapter.js';
import { StorageError } from './errors.js';

/** Where the ciphertext goes: a storage adapter, or the S3 multipart upload. */
export interface EncryptedPutTarget {
  put(ciphertext: ReadableStream<Uint8Array>, opts: PutOptions): Promise<StoredObject>;
}

export interface EncryptedPutOptions {
  /** The exact plaintext length in bytes. */
  readonly plaintextSize: number;
  readonly expiresAt: Date;
}

/** What the envelope's `files[]` entry needs (04 §3.4). */
export interface EncryptedObject {
  readonly object: StoredObject;
  /** 32 fresh bytes. A secret: only inside the end-to-end-encrypted envelope (I-2, I-7). */
  readonly fileKey: Uint8Array;
  /** Lowercase hex SHA-256 of the whole ALF1 object; equal to `object.sha256`. */
  readonly ciphertextSha256: string;
  /** Lowercase hex SHA-256 of the plaintext. */
  readonly plaintextSha256: string;
  readonly plaintextSize: number;
}

/** Bytes per plaintext piece when the plaintext is given as bytes. */
const PIECE = 1024 * 1024;

function invalid(message: string): StorageError {
  return new StorageError('invalid_argument', message);
}

function sizeMismatch(): StorageError {
  return new StorageError('size_mismatch', 'plaintext length does not match the declared size');
}

/**
 * The length of the ALF1 object for a plaintext of `plaintextSize` bytes at the sender's 1 MiB chunk
 * size (04 §4): the 17-byte header, then one 16-byte tag per chunk; an exact multiple of the chunk
 * size ends with a full final chunk, and the empty file is one empty final chunk.
 */
export function alf1CiphertextSize(plaintextSize: number): number {
  if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0) {
    throw invalid('plaintext size must be a non-negative integer');
  }
  const chunks = Math.max(1, Math.ceil(plaintextSize / ALF1_DEFAULT_CHUNK_SIZE));
  const size = ALF1_HEADER_LENGTH + chunks * ALF1_TAG_LENGTH + plaintextSize;
  if (!Number.isSafeInteger(size)) throw invalid('plaintext size is too large');
  return size;
}

/** The plaintext as a stream: bytes are served in 1 MiB views (the sealer copies them). */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + PIECE, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

/** Passes the plaintext through and refuses any total other than `size`, as early as it can. */
function exactly(size: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!(chunk instanceof Uint8Array)) throw invalid('plaintext stream must yield bytes');
      total += chunk.length;
      if (total > size) throw sizeMismatch();
      controller.enqueue(chunk);
    },
    flush() {
      if (total !== size) throw sizeMismatch();
    },
  });
}

/**
 * Encrypts the plaintext with a fresh file key and uploads the ALF1 object to `target` as one
 * stream. On any failure the target aborts its upload (the multipart target leaves no open upload),
 * the plaintext source is cancelled, and the file key is wiped.
 */
export async function putEncrypted(
  target: EncryptedPutTarget,
  plaintext: ReadableStream<Uint8Array> | Uint8Array,
  opts: EncryptedPutOptions,
): Promise<EncryptedObject> {
  if (target === null || typeof target !== 'object' || typeof target.put !== 'function') {
    throw invalid('missing upload target');
  }
  if (opts === null || typeof opts !== 'object') throw invalid('missing upload options');
  const { plaintextSize, expiresAt } = opts;
  const size = alf1CiphertextSize(plaintextSize);
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    throw invalid('expiresAt must be a date');
  }
  let source: ReadableStream<Uint8Array>;
  if (plaintext instanceof Uint8Array) {
    if (plaintext.length !== plaintextSize) throw sizeMismatch();
    source = streamOf(plaintext);
  } else if (plaintext instanceof ReadableStream) {
    source = plaintext;
  } else {
    throw invalid('plaintext must be bytes or a byte stream');
  }

  const fileKey = randomBytes(ALF1_FILE_KEY_LENGTH);
  let ciphertext: ReadableStream<Uint8Array> | undefined;
  try {
    // The transform copies the key in and wipes its copy when it finishes, fails or is cancelled.
    const enc = alf1EncryptStream(fileKey);
    ciphertext = source
      .pipeThrough(exactly(plaintextSize))
      .pipeThrough(enc as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    const object = await target.put(ciphertext, { size, expiresAt });
    // The target read exactly `size` bytes and then the end of the stream, so the sealer finished.
    const digests = await enc.done;
    const ciphertextSha256 = encodeHex(digests.ciphertextSha256);
    if (
      digests.ciphertextLength !== size ||
      digests.plaintextLength !== plaintextSize ||
      object.size !== size ||
      object.sha256 !== ciphertextSha256
    ) {
      // Never expected: the stored object is not what was sealed. The lifecycle rule removes it.
      throw new StorageError('upload_failed', 'storage upload failed');
    }
    return {
      object,
      fileKey,
      ciphertextSha256,
      plaintextSha256: encodeHex(digests.plaintextSha256),
      plaintextSize,
    };
  } catch (error) {
    wipe(fileKey);
    // A target that failed before reading (or stopped without cancelling) leaves the pipe open:
    // cancelling it cancels the plaintext source. Refused while the target still holds the reader.
    await ciphertext?.cancel().catch(() => undefined);
    throw error;
  }
}
