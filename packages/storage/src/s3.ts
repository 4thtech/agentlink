// S3-compatible adapter (07 §5.2) over aws4fetch (SigV4 over fetch; Node, browsers and Workers).
//
// - Stores only ALF1 ciphertext, under `agentlink/<storagePrefix>/<random 128-bit>`, with no object
//   metadata, file name or agent ID (04 §2.9, I-2).
// - Credentials come from an injected provider for each operation and are never kept, logged or put
//   in an error. Presigned URLs and object keys are never logged (I-7).
// - Presigned GETs are clamped to 7 days (the SigV4 limit) and to the expiry of temporary
//   credentials (04 §4).
// - Requests go through an injected fetch with redirects refused. The caller passes the SSRF-safe
//   fetch (M1-15) where one is available; the endpoint grammar check here runs either way.
// The configuration checks, credentials and signed sending live in session.ts, shared with multipart
// upload and the lifecycle helper (M1-6b). Multipart for objects above 64 MiB is multipart.ts; routing
// `put` there, with streaming encryption, is M1-6b part 2.
import {
  checkFuture,
  checkSize,
  readExactly,
  sha256Hex,
  type PutOptions,
  type StorageAdapter,
  type StoredObject,
} from './adapter.js';
import { isOwnObjectKey, newObjectKey, validateStoragePrefix } from './endpoint.js';
import { StorageError } from './errors.js';
import { createS3Session, discard, type S3SessionConfig } from './session.js';

export type { FetchLike, S3Credentials, S3CredentialsProvider } from './session.js';

/** SigV4 presigned URLs are valid for at most 7 days. */
export const MAX_PRESIGN_SECONDS = 604_800;
/** Larger objects need multipart upload (07 §5.2, M1-6b). */
export const S3_MAX_SINGLE_PUT_BYTES = 64 * 1024 * 1024;

export interface S3AdapterConfig extends S3SessionConfig {
  /** 16 random bytes, base64url (04 §2.9); never the agent ID. */
  readonly storagePrefix: string;
}

export interface PresignedGet {
  readonly url: string;
  /** The expiry actually granted, after clamping. */
  readonly expiresAt: Date;
}

export interface S3Adapter extends StorageAdapter {
  readonly kind: 's3';
  /** Like `presignGet`, and also returns the expiry granted after clamping. */
  presign(obj: StoredObject, expiresAt: Date): Promise<PresignedGet>;
}

export function createS3Adapter(config: S3AdapterConfig): S3Adapter {
  const session = createS3Session(config, 's3');
  const storagePrefix = validateStoragePrefix(config.storagePrefix);
  const { log, now } = session;

  const objectUrl = (key: string): string => `${session.bucketUrl}/${key}`;

  function checkOwn(obj: StoredObject): string {
    if (obj === null || typeof obj !== 'object' || obj.kind !== 's3') {
      throw new StorageError('invalid_argument', 'not an object of this storage');
    }
    if (!isOwnObjectKey(storagePrefix, obj.locator)) {
      throw new StorageError('invalid_argument', 'not an object of this storage');
    }
    return obj.locator;
  }

  async function presign(obj: StoredObject, expiresAt: Date): Promise<PresignedGet> {
    const key = checkOwn(obj);
    const at = now();
    checkFuture(expiresAt, at, 'expiresAt');
    const creds = await session.credentials(at);
    let until = Math.min(expiresAt.getTime(), at.getTime() + MAX_PRESIGN_SECONDS * 1000);
    if (creds.expiresAt !== undefined) until = Math.min(until, creds.expiresAt.getTime());
    const seconds = Math.floor((until - at.getTime()) / 1000);
    if (seconds < 1) {
      throw new StorageError('invalid_argument', 'expiresAt must be at least a second away');
    }
    const url = new URL(objectUrl(key));
    url.searchParams.set('X-Amz-Expires', String(seconds));
    const signed = await session.client(creds).sign(url.toString(), {
      method: 'GET',
      aws: { signQuery: true, datetime: session.amzDate(at) },
    });
    log?.debug('storage presign', { ttlSeconds: seconds });
    return { url: signed.url, expiresAt: new Date(at.getTime() + seconds * 1000) };
  }

  return {
    kind: 's3',

    async put(ciphertext, opts: PutOptions): Promise<StoredObject> {
      checkSize(opts.size, S3_MAX_SINGLE_PUT_BYTES);
      const at = now();
      checkFuture(opts.expiresAt, at, 'expiresAt');
      const bytes = await readExactly(ciphertext, opts.size);
      const hash = sha256Hex(bytes);
      const key = newObjectKey(storagePrefix);
      const response = await session.send(
        objectUrl(key),
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Amz-Content-Sha256': hash,
          },
          body: bytes,
        },
        at,
      );
      await discard(response);
      if (!response.ok) {
        log?.warn('storage put failed', { status: response.status });
        throw new StorageError('upload_failed', 'storage upload failed', response.status);
      }
      log?.debug('storage put', { size: bytes.length });
      return { kind: 's3', locator: key, size: bytes.length, sha256: hash };
    },

    async presignGet(obj: StoredObject, expiresAt: Date): Promise<string> {
      return (await presign(obj, expiresAt)).url;
    },

    presign,

    async delete(obj: StoredObject): Promise<void> {
      const key = checkOwn(obj);
      const response = await session.send(objectUrl(key), { method: 'DELETE' });
      await discard(response);
      // 404: already gone, which is the goal of a delete.
      if (!response.ok && response.status !== 404) {
        log?.warn('storage delete failed', { status: response.status });
        throw new StorageError('delete_failed', 'storage delete failed', response.status);
      }
      log?.debug('storage delete');
    },
  };
}
