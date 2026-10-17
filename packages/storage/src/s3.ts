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
// Multipart upload and streaming without buffering are M1-6b.
import { AwsClient } from 'aws4fetch';
import type { Logger } from '@agentlink/log';
import {
  checkFuture,
  checkSize,
  readExactly,
  sha256Hex,
  type PutOptions,
  type StorageAdapter,
  type StoredObject,
} from './adapter.js';
import {
  isOwnObjectKey,
  newObjectKey,
  validateBucket,
  validateRegion,
  validateS3Endpoint,
  validateStoragePrefix,
} from './endpoint.js';
import { StorageError } from './errors.js';

/** SigV4 presigned URLs are valid for at most 7 days. */
export const MAX_PRESIGN_SECONDS = 604_800;
/** Larger objects need multipart upload (07 §5.2, M1-6b). */
export const S3_MAX_SINGLE_PUT_BYTES = 64 * 1024 * 1024;

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  /** Expiry of temporary credentials; presigned URLs never outlive it. */
  readonly expiresAt?: Date;
}

/** Called for every operation, so rotated or refreshed credentials take effect at once. */
export type S3CredentialsProvider = () => Promise<S3Credentials>;

export type FetchLike = (request: Request) => Promise<Response>;

export interface S3AdapterConfig {
  /** `https://host[:port]`; path-style requests go to `<endpoint>/<bucket>/<key>`. */
  readonly endpoint: string;
  readonly bucket: string;
  /** Defaults to `auto` (Cloudflare R2). */
  readonly region?: string;
  /** 16 random bytes, base64url (04 §2.9); never the agent ID. */
  readonly storagePrefix: string;
  readonly credentials: S3CredentialsProvider;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
  readonly logger?: Logger;
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
  const origin = validateS3Endpoint(config.endpoint);
  const bucket = validateBucket(config.bucket);
  const region = validateRegion(config.region ?? 'auto');
  const storagePrefix = validateStoragePrefix(config.storagePrefix);
  if (typeof config.credentials !== 'function') {
    throw new StorageError('invalid_config', 'invalid storage credentials provider');
  }
  const provider = config.credentials;
  const fetchImpl: FetchLike = config.fetch ?? ((request) => globalThis.fetch(request));
  const now = config.now ?? (() => new Date());
  const log = config.logger?.child({ storage: 's3' });

  const objectUrl = (key: string): string => `${origin}/${bucket}/${key}`;

  async function credentials(at: Date): Promise<S3Credentials> {
    let creds: S3Credentials;
    try {
      creds = await provider();
    } catch {
      throw new StorageError('credentials_unavailable', 'storage credentials are unavailable');
    }
    if (
      creds === null ||
      typeof creds !== 'object' ||
      typeof creds.accessKeyId !== 'string' ||
      creds.accessKeyId.length === 0 ||
      typeof creds.secretAccessKey !== 'string' ||
      creds.secretAccessKey.length === 0
    ) {
      throw new StorageError('credentials_unavailable', 'storage credentials are unavailable');
    }
    if (creds.expiresAt !== undefined) {
      const t = creds.expiresAt instanceof Date ? creds.expiresAt.getTime() : Number.NaN;
      if (Number.isNaN(t) || t <= at.getTime()) {
        throw new StorageError('credentials_expired', 'storage credentials have expired');
      }
    }
    return creds;
  }

  function client(creds: S3Credentials): AwsClient {
    return new AwsClient({
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken !== undefined ? { sessionToken: creds.sessionToken } : {}),
      service: 's3',
      region,
      retries: 0,
    });
  }

  function amzDate(at: Date): string {
    return at.toISOString().replace(/[:-]|\.\d{3}/g, '');
  }

  async function send(request: Request): Promise<Response> {
    try {
      return await fetchImpl(request);
    } catch {
      // The underlying error can carry the URL; it is dropped (I-7).
      throw new StorageError('network', 'storage request failed');
    }
  }

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
    const creds = await credentials(at);
    let until = Math.min(expiresAt.getTime(), at.getTime() + MAX_PRESIGN_SECONDS * 1000);
    if (creds.expiresAt !== undefined) until = Math.min(until, creds.expiresAt.getTime());
    const seconds = Math.floor((until - at.getTime()) / 1000);
    if (seconds < 1) {
      throw new StorageError('invalid_argument', 'expiresAt must be at least a second away');
    }
    const url = new URL(objectUrl(key));
    url.searchParams.set('X-Amz-Expires', String(seconds));
    const signed = await client(creds).sign(url.toString(), {
      method: 'GET',
      aws: { signQuery: true, datetime: amzDate(at) },
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
      const creds = await credentials(at);
      const key = newObjectKey(storagePrefix);
      const request = await client(creds).sign(objectUrl(key), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Amz-Content-Sha256': hash,
        },
        body: bytes,
        redirect: 'error',
        aws: { datetime: amzDate(at) },
      });
      const response = await send(request);
      await response.body?.cancel().catch(() => undefined);
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
      const at = now();
      const creds = await credentials(at);
      const request = await client(creds).sign(objectUrl(key), {
        method: 'DELETE',
        redirect: 'error',
        aws: { datetime: amzDate(at) },
      });
      const response = await send(request);
      await response.body?.cancel().catch(() => undefined);
      // 404: already gone, which is the goal of a delete.
      if (!response.ok && response.status !== 404) {
        log?.warn('storage delete failed', { status: response.status });
        throw new StorageError('delete_failed', 'storage delete failed', response.status);
      }
      log?.debug('storage delete');
    },
  };
}
