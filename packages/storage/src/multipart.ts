// Multipart upload for the S3-compatible storage (07 §5.2, M1-6b part 1).
//
// - Streams ALF1 ciphertext in parts: at most one part is in memory at a time, and the SHA-256 of the
//   whole object is computed incrementally over exactly the bytes sent (`StoredObject.sha256`, 07 §5.1).
// - The part size adapts to the object size (S3: at least 5 MiB except the last part, at most 10 000
//   parts).
// - On any failure after the upload is created (a part, the source stream, a size mismatch, completion)
//   the upload is aborted, so no open multipart upload is left behind. `abortOpenUploads` cleans up after
//   a crash, under this agent's own prefix only; the lifecycle rule (lifecycle.ts) is the backstop: it
//   aborts incomplete uploads under `agentlink/` after a day and expires objects after 30.
// - The same rules as the adapter (s3.ts, 04 §4, I-7): endpoint grammar check before any request,
//   redirects refused, credentials per request and never logged, no URL, object key, upload ID or
//   provider response text in a log or an error.
//
// STREAM encryption feeding this, and routing the adapter's `put` above 64 MiB here, are M1-6b part 2.
import { createSha256, encodeHex, sha256 } from '@4thtech-io/crypto';
import { checkFuture, checkSize, type PutOptions, type StoredObject } from './adapter.js';
import { isOwnObjectKey, newObjectKey, validateStoragePrefix } from './endpoint.js';
import { StorageError } from './errors.js';
import {
  createS3Session,
  discard,
  readCappedText,
  xmlEscape,
  xmlText,
  type S3Session,
  type S3SessionConfig,
} from './session.js';

const MiB = 1024 * 1024;

/** S3's smallest part (every part but the last). */
export const MULTIPART_MIN_PART_BYTES = 5 * MiB;
/** The part size used until an object needs more than 10 000 parts. */
export const MULTIPART_DEFAULT_PART_BYTES = 8 * MiB;
/** S3's largest part. */
export const MULTIPART_MAX_PART_BYTES = 5 * 1024 * MiB;
/** S3's part count limit. */
export const MULTIPART_MAX_PARTS = 10_000;
/** S3's largest object (5 TiB). */
export const MULTIPART_MAX_BYTES = 5 * 1024 * 1024 * MiB;

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_LIST_PAGES = 100;
const UPLOAD_ID_RE = /^[\x21-\x7e]{1,1024}$/;
const ETAG_RE = /^(?:"[A-Za-z0-9_-]{1,128}"|[A-Za-z0-9_-]{1,128})$/;

/** The S3 adapter's configuration fits here as it is. */
export interface S3MultipartConfig extends S3SessionConfig {
  /** 16 random bytes, base64url (04 §2.9); never the agent ID. */
  readonly storagePrefix: string;
}

export interface MultipartPutOptions extends PutOptions {
  /** Defaults to `multipartPartSize(size)`. At least 5 MiB. */
  readonly partSize?: number;
}

export interface S3Multipart {
  /** Uploads `size` bytes of ciphertext as one object, in parts; aborts the upload on any failure. */
  put(
    ciphertext: ReadableStream<Uint8Array> | Uint8Array,
    opts: MultipartPutOptions,
  ): Promise<StoredObject>;
  /** The number of open (never completed or aborted) multipart uploads under this agent's prefix. */
  openUploads(): Promise<number>;
  /** Aborts every open multipart upload under this agent's prefix; returns how many were aborted. */
  abortOpenUploads(): Promise<number>;
}

/** The adaptive part size: 8 MiB, or more in whole MiB when the object needs over 10 000 parts. */
export function multipartPartSize(size: number): number {
  checkSize(size, MULTIPART_MAX_BYTES);
  const least = Math.ceil(size / MULTIPART_MAX_PARTS);
  return Math.max(MULTIPART_DEFAULT_PART_BYTES, Math.ceil(least / MiB) * MiB);
}

function checkPartSize(partSize: number, size: number): number {
  if (
    !Number.isSafeInteger(partSize) ||
    partSize < MULTIPART_MIN_PART_BYTES ||
    partSize > MULTIPART_MAX_PART_BYTES ||
    Math.ceil(size / partSize) > MULTIPART_MAX_PARTS
  ) {
    throw new StorageError('invalid_argument', 'invalid multipart part size');
  }
  return partSize;
}

function sizeMismatch(): StorageError {
  return new StorageError('size_mismatch', 'ciphertext length does not match the declared size');
}

function failed(status?: number): StorageError {
  return new StorageError('upload_failed', 'storage upload failed', status);
}

/**
 * Reads the caller's stream. An error it throws (which can carry anything, a URL included) is replaced
 * by a fixed StorageError (M1-6b-b L4); a StorageError from an upstream stage is kept.
 */
async function readSource(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  try {
    return await reader.read();
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('upload_failed', 'the ciphertext stream failed');
  }
}

/**
 * Yields the input as parts of `partSize` bytes (the last one shorter), each a private copy, and
 * refuses a total other than `size`. A stream is read with a cap: a longer stream is cancelled, never
 * buffered.
 */
async function* partsOf(
  input: ReadableStream<Uint8Array> | Uint8Array,
  size: number,
  partSize: number,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  if (input instanceof Uint8Array) {
    if (input.length !== size) throw sizeMismatch();
    for (let offset = 0; offset < size; offset += partSize) {
      yield input.slice(offset, Math.min(offset + partSize, size));
    }
    return;
  }
  const reader = input.getReader();
  let done = false;
  try {
    let leftover: Uint8Array = new Uint8Array(0);
    let total = 0;
    while (total < size) {
      const part = new Uint8Array(Math.min(partSize, size - total));
      let filled = 0;
      if (leftover.length > 0) {
        const n = Math.min(leftover.length, part.length);
        part.set(leftover.subarray(0, n), 0);
        leftover = leftover.subarray(n);
        filled = n;
      }
      while (filled < part.length) {
        const next = await readSource(reader);
        if (next.done) {
          done = true;
          throw sizeMismatch();
        }
        const value: unknown = next.value;
        if (!(value instanceof Uint8Array)) {
          throw new StorageError('invalid_argument', 'ciphertext stream must yield bytes');
        }
        const n = Math.min(value.length, part.length - filled);
        part.set(value.subarray(0, n), filled);
        filled += n;
        // Bytes past this part start the next one; past `size` they are a mismatch, caught below.
        if (n < value.length) leftover = value.subarray(n);
      }
      total += part.length;
      if (total === size && leftover.length > 0) throw sizeMismatch();
      yield part;
    }
    // The declared size is reached: the stream must end here.
    for (;;) {
      const next = await readSource(reader);
      if (next.done) {
        done = true;
        break;
      }
      if (!(next.value instanceof Uint8Array) || next.value.length > 0) throw sizeMismatch();
    }
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createS3Multipart(config: S3MultipartConfig): S3Multipart {
  const session: S3Session = createS3Session(config, 's3-multipart');
  const storagePrefix = validateStoragePrefix(config.storagePrefix);
  const { log } = session;
  const objectUrl = (key: string): URL => new URL(`${session.bucketUrl}/${key}`);

  async function create(key: string): Promise<string> {
    const url = objectUrl(key);
    url.searchParams.set('uploads', '');
    const response = await session.send(url.toString(), { method: 'POST' });
    if (!response.ok) {
      await discard(response);
      throw failed(response.status);
    }
    const text = await readCappedText(response, MAX_RESPONSE_BYTES);
    const uploadId = text === null ? null : xmlText(text, 'UploadId');
    if (uploadId === null || !UPLOAD_ID_RE.test(uploadId)) throw failed(response.status);
    return uploadId;
  }

  async function uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    part: Uint8Array<ArrayBuffer>,
  ): Promise<string> {
    const url = objectUrl(key);
    url.searchParams.set('partNumber', String(partNumber));
    url.searchParams.set('uploadId', uploadId);
    const response = await session.send(url.toString(), {
      method: 'PUT',
      headers: { 'X-Amz-Content-Sha256': encodeHex(sha256(part)) },
      body: part,
    });
    await discard(response);
    if (!response.ok) throw failed(response.status);
    const etag = response.headers.get('ETag');
    if (etag === null || !ETAG_RE.test(etag)) throw failed(response.status);
    return etag;
  }

  async function complete(key: string, uploadId: string, etags: readonly string[]): Promise<void> {
    const url = objectUrl(key);
    url.searchParams.set('uploadId', uploadId);
    const parts = etags
      .map(
        (etag, i) =>
          `<Part><PartNumber>${i + 1}</PartNumber><ETag>${xmlEscape(etag)}</ETag></Part>`,
      )
      .join('');
    const body = new TextEncoder().encode(
      `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${parts}</CompleteMultipartUpload>`,
    );
    const response = await session.send(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
        'X-Amz-Content-Sha256': encodeHex(sha256(body)),
      },
      body,
    });
    if (!response.ok) {
      await discard(response);
      throw failed(response.status);
    }
    // S3 can answer 200 and still fail, with an error document in the body.
    const text = await readCappedText(response, MAX_RESPONSE_BYTES);
    if (
      text === null ||
      !text.includes('<CompleteMultipartUploadResult') ||
      text.includes('<Error>')
    ) {
      throw failed(response.status);
    }
  }

  /** Aborts an upload; true when it existed, false when it was already gone (404). */
  async function abort(key: string, uploadId: string): Promise<boolean> {
    const url = objectUrl(key);
    url.searchParams.set('uploadId', uploadId);
    const response = await session.send(url.toString(), { method: 'DELETE' });
    await discard(response);
    // 404: the upload is already gone, which is the goal.
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new StorageError('delete_failed', 'storage abort failed', response.status);
    }
    return true;
  }

  /** Deletes one of this upload's own objects; 404 is fine. */
  async function removeObject(key: string): Promise<void> {
    const response = await session.send(objectUrl(key).toString(), { method: 'DELETE' });
    await discard(response);
    if (!response.ok && response.status !== 404) {
      throw new StorageError('delete_failed', 'storage delete failed', response.status);
    }
  }

  /**
   * Open uploads whose key starts with `keyPrefix` and that this storage prefix could have produced.
   * The default is the whole own prefix; a full object key narrows it to that one key.
   */
  async function listOwn(
    keyPrefix: string = `agentlink/${storagePrefix}/`,
  ): Promise<Array<{ key: string; uploadId: string }>> {
    const own: Array<{ key: string; uploadId: string }> = [];
    let keyMarker: string | null = null;
    let uploadIdMarker: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const url = new URL(session.bucketUrl);
      url.searchParams.set('uploads', '');
      url.searchParams.set('prefix', keyPrefix);
      if (keyMarker !== null) url.searchParams.set('key-marker', keyMarker);
      if (uploadIdMarker !== null) url.searchParams.set('upload-id-marker', uploadIdMarker);
      const response = await session.send(url.toString(), { method: 'GET' });
      if (!response.ok) {
        await discard(response);
        throw new StorageError('network', 'storage request failed', response.status);
      }
      const text = await readCappedText(response, MAX_RESPONSE_BYTES);
      if (text === null || !text.includes('<ListMultipartUploadsResult')) {
        throw new StorageError('network', 'storage request failed', response.status);
      }
      for (const block of text.split('<Upload>').slice(1)) {
        const key = xmlText(block, 'Key');
        const uploadId = xmlText(block, 'UploadId');
        if (
          key !== null &&
          uploadId !== null &&
          isOwnObjectKey(storagePrefix, key) &&
          UPLOAD_ID_RE.test(uploadId)
        ) {
          own.push({ key, uploadId });
        }
      }
      if (xmlText(text, 'IsTruncated') !== 'true') return own;
      keyMarker = xmlText(text, 'NextKeyMarker');
      uploadIdMarker = xmlText(text, 'NextUploadIdMarker');
      if (keyMarker === null) return own;
    }
    return own;
  }

  /** Best effort: aborts the open upload(s) for exactly this key. Logs status codes only. */
  async function reclaimByKey(key: string): Promise<void> {
    try {
      for (const found of await listOwn(key)) {
        if (found.key === key) await abort(found.key, found.uploadId);
      }
    } catch (error) {
      log?.warn('storage multipart reclaim failed', {
        status: error instanceof StorageError ? error.status : undefined,
      });
    }
  }

  return {
    async put(ciphertext, opts: MultipartPutOptions): Promise<StoredObject> {
      if (opts === null || typeof opts !== 'object') {
        throw new StorageError('invalid_argument', 'missing upload options');
      }
      const { size } = opts;
      checkSize(size, MULTIPART_MAX_BYTES);
      checkFuture(opts.expiresAt, session.now(), 'expiresAt');
      const partSize =
        opts.partSize === undefined ? multipartPartSize(size) : checkPartSize(opts.partSize, size);
      if (ciphertext instanceof Uint8Array) {
        if (ciphertext.length !== size) throw sizeMismatch();
      } else if (!(ciphertext instanceof ReadableStream)) {
        throw new StorageError('invalid_argument', 'ciphertext must be bytes or a byte stream');
      }

      const key = newObjectKey(storagePrefix);
      let uploadId: string;
      try {
        uploadId = await create(key);
      } catch (error) {
        // A lost or unreadable create answer can still have opened the upload (M1-6b-b L5): find it by
        // its exact key and abort it. A refusal from the provider (4xx, 5xx) opened nothing.
        if (
          error instanceof StorageError &&
          (error.code === 'network' ||
            (error.code === 'upload_failed' && error.status !== undefined && error.status < 300))
        ) {
          await reclaimByKey(key);
        }
        throw error;
      }
      const hasher = createSha256();
      const etags: string[] = [];
      let completing = false;
      try {
        for await (const part of partsOf(ciphertext, size, partSize)) {
          hasher.update(part);
          etags.push(await uploadPart(key, uploadId, etags.length + 1, part));
        }
        completing = true;
        await complete(key, uploadId, etags);
      } catch (error) {
        try {
          const existed = await abort(key, uploadId);
          // The upload is gone and the complete call failed: its answer may have been lost after the
          // object was stored (M1-6b-b L5). The caller is told the upload failed, so remove it.
          if (!existed && completing) await removeObject(key);
        } catch (abortError) {
          // The cleanup failed: `abortOpenUploads` or the provider's own expiry removes it later.
          log?.warn('storage multipart abort failed', {
            status: abortError instanceof StorageError ? abortError.status : undefined,
          });
        }
        log?.warn('storage multipart put failed', {
          status: error instanceof StorageError ? error.status : undefined,
          parts: etags.length,
        });
        throw error;
      }
      log?.debug('storage multipart put', { size, parts: etags.length });
      return { kind: 's3', locator: key, size, sha256: encodeHex(hasher.digest()) };
    },

    async openUploads(): Promise<number> {
      return (await listOwn()).length;
    },

    async abortOpenUploads(): Promise<number> {
      const open = await listOwn();
      let aborted = 0;
      let failures = 0;
      for (const { key, uploadId } of open) {
        try {
          await abort(key, uploadId);
          aborted += 1;
        } catch {
          failures += 1;
        }
      }
      log?.debug('storage multipart cleanup', { aborted, failures });
      if (failures > 0) throw new StorageError('delete_failed', 'storage abort failed');
      return aborted;
    },
  };
}
