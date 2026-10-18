// Internal: the signed-request plumbing of the S3-compatible storage, shared by the adapter (s3.ts),
// multipart upload and the lifecycle helper (M1-6a, M1-6b). Not exported from the package entry,
// except the credential and fetch types, which s3.ts re-exports.
//
// One place for the rules (04 §4, I-7):
// - the endpoint passes the 04 §4 grammar check before any request; the caller injects the SSRF-safe
//   fetch (M1-15) for the DNS-level check;
// - every request refuses redirects;
// - credentials come from the injected provider for each operation and are never kept, logged or put
//   in an error;
// - a network error is replaced by a fixed one, since the original can carry the URL.
import { AwsClient } from 'aws4fetch';
import type { Logger } from '@4thtech-io/log';
import { validateBucket, validateRegion, validateS3Endpoint } from './endpoint.js';
import { StorageError } from './errors.js';

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

export interface S3SessionConfig {
  /** `https://host[:port]`; path-style requests go to `<endpoint>/<bucket>/...`. */
  readonly endpoint: string;
  readonly bucket: string;
  /** Defaults to `auto` (Cloudflare R2). */
  readonly region?: string;
  readonly credentials: S3CredentialsProvider;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
  readonly logger?: Logger;
}

export interface SignedRequest {
  readonly method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  readonly headers?: Record<string, string>;
  readonly body?: Uint8Array<ArrayBuffer>;
}

export interface S3Session {
  readonly now: () => Date;
  readonly log: Logger | undefined;
  /** `<origin>/<bucket>` with no trailing slash. */
  readonly bucketUrl: string;
  /** Fresh, checked credentials. Throws `credentials_unavailable` or `credentials_expired`. */
  credentials(at: Date): Promise<S3Credentials>;
  /** A SigV4 signer for these credentials, in this session's region. */
  client(creds: S3Credentials): AwsClient;
  /** The SigV4 timestamp for `at`. */
  amzDate(at: Date): string;
  /**
   * Signs (at `at`, default now) and sends one request with redirects refused. Throws `credentials_*`
   * or `network`; never echoes the URL.
   */
  send(url: string, request: SignedRequest, at?: Date): Promise<Response>;
}

export function createS3Session(config: S3SessionConfig, scope: string): S3Session {
  if (config === null || typeof config !== 'object') {
    throw new StorageError('invalid_config', 'invalid storage configuration');
  }
  const origin = validateS3Endpoint(config.endpoint);
  const bucket = validateBucket(config.bucket);
  const region = validateRegion(config.region ?? 'auto');
  if (typeof config.credentials !== 'function') {
    throw new StorageError('invalid_config', 'invalid storage credentials provider');
  }
  const provider = config.credentials;
  const fetchImpl: FetchLike = config.fetch ?? ((request) => globalThis.fetch(request));
  const now = config.now ?? (() => new Date());
  const log = config.logger?.child({ storage: scope });

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

  return {
    now,
    log,
    bucketUrl: `${origin}/${bucket}`,
    credentials,
    client,
    amzDate,
    async send(url: string, request: SignedRequest, at: Date = now()): Promise<Response> {
      const creds = await credentials(at);
      const signed = await client(creds).sign(url, {
        method: request.method,
        ...(request.headers !== undefined ? { headers: request.headers } : {}),
        ...(request.body !== undefined ? { body: request.body } : {}),
        redirect: 'error',
        aws: { datetime: amzDate(at) },
      });
      try {
        return await fetchImpl(signed);
      } catch {
        // The underlying error can carry the URL; it is dropped (I-7).
        throw new StorageError('network', 'storage request failed');
      }
    },
  };
}

/**
 * Reads a response body as text, refusing more than `max` bytes (a hostile or broken endpoint cannot
 * make the client buffer without bound). Returns null when the body is over the cap.
 */
export async function readCappedText(response: Response, max: number): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    throw new StorageError('network', 'storage request failed');
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(out);
}

/** Discards a response body we do not need. */
export async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Escapes text for an XML element body. */
export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The text of the first `<tag>...</tag>` in `xml`, entity-decoded, or null. */
export function xmlText(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  if (match === null) return null;
  return (match[1] ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
