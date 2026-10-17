// The storage adapter interface (07 §5.1) and the helpers every adapter shares. Every adapter
// receives only ALF1 ciphertext (04 §4, I-2); none sees a file key, a file name or plaintext.
import { encodeHex, sha256 } from '@agentlink/crypto';
import { StorageError } from './errors.js';

export type StorageKind = 'inline' | 'drop' | 's3' | 'gdrive' | 'dropbox' | 'onedrive' | 'ipfs';

/** 07 §5.1. `sha256` is the lowercase hex SHA-256 of the stored ciphertext. */
export interface StoredObject {
  readonly kind: string;
  readonly locator: string;
  readonly size: number;
  readonly sha256: string;
}

export interface PutOptions {
  /** The exact ciphertext length in bytes; any other length is refused. */
  readonly size: number;
  readonly expiresAt: Date;
}

/** 07 §5.1. */
export interface StorageAdapter {
  readonly kind: StorageKind;
  put(ciphertext: ReadableStream<Uint8Array> | Uint8Array, opts: PutOptions): Promise<StoredObject>;
  /** URL the recipient can use without credentials. A secret: carry it only inside the envelope (I-7). */
  presignGet(obj: StoredObject, expiresAt: Date): Promise<string>;
  delete(obj: StoredObject): Promise<void>;
}

/** Checks the declared size against an adapter's limit. */
export function checkSize(size: number, max: number): void {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new StorageError('invalid_argument', 'size must be a positive integer');
  }
  if (size > max) {
    throw new StorageError('too_large', 'object is larger than this storage accepts');
  }
}

/** Checks that a date is valid and after `now`. */
export function checkFuture(date: Date, now: Date, what: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) {
    throw new StorageError('invalid_argument', `${what} must be a date in the future`);
  }
}

/**
 * Reads the ciphertext into a private buffer, refusing any length other than `size`. A stream is read with a
 * cap of `size` bytes, so a longer stream is cancelled rather than buffered. Streaming upload without
 * buffering and multipart are M1-6b.
 */
export async function readExactly(
  input: ReadableStream<Uint8Array> | Uint8Array,
  size: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (input instanceof Uint8Array) {
    if (input.length !== size) throw sizeMismatch();
    // A private copy: the bytes hashed are the bytes sent, even if the caller reuses its buffer.
    return new Uint8Array(input);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  const reader = input.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new StorageError('invalid_argument', 'ciphertext stream must yield bytes');
      }
      if (offset + value.length > size) throw sizeMismatch();
      out.set(value, offset);
      offset += value.length;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (offset !== size) throw sizeMismatch();
  return out;
}

function sizeMismatch(): StorageError {
  return new StorageError('size_mismatch', 'ciphertext length does not match the declared size');
}

export function sha256Hex(bytes: Uint8Array): string {
  return encodeHex(sha256(bytes));
}
