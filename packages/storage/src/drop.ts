// The encrypted-drop adapter (07 §5.4, 04 §4, D-48): the default store for files that do not go
// inline, so file exchange needs no setup. It talks to the 4thTech drop Worker (apps/drop, M1-27a).
//
// - Zero access (I-2): the drop receives only ALF1 ciphertext, its size and SHA-256, the expiry and a
//   signature. Never a file name, file key, owner key, recipient, plaintext or envelope.
// - Requests to the drop are signed with the agent's drop key through an injected signer, which the
//   KeyStore provides (04 §2.1; the drop key is never the Nostr or EVM identity key). This file never
//   holds a key. The signature travels in the Authorization header, never in a URL.
// - SSRF (04 §4): the endpoint is configuration (default `https://drop.agentlink.4thtech.io`,
//   overridable for staging and self-hosting, IR-D48-1 F16) and passes the same https grammar check
//   as an S3 endpoint. Every `uploadUrl` and `getUrl` the drop returns must be https on exactly that
//   origin, with the expected path and object ID; anything else is refused before a byte is sent.
//   Redirects are never followed. The caller injects the SSRF-safe fetch (M1-15) for the DNS check.
// - I-7: signed URLs are secrets. No URL, object ID, nonce, signature or drop response text reaches a
//   log line or an error; errors are typed codes with fixed messages.
// - One encryption pass (07 §5.4): `put` sends the bytes it is given exactly once, hashing them as
//   they go, and never retries. A retry is the caller's: the same bytes again, or a fresh encryption
//   with a new file key and nonce prefix (putEncrypted always makes a new key).
// - The object's locator is its signed GET URL, so it is a secret like any presigned URL (I-7): the
//   core keeps it with the file key and never logs it. The drop fixes the expiry at upload; a later
//   `presignGet` returns the same URL and cannot extend it.
// - Key epochs (M1-1g-g; 04 §2.1, 07 §5.4): the drop key rotates with `keyEpoch`, and only the
//   uploading drop key can delete. `put` records the epoch the upload and commit were signed under
//   in the object (`keyEpoch`) and refuses an upload whose epoch moved between them; `delete` signs
//   with that epoch, so an object stays deletable after a rotation. A POST never names an epoch.
import {
  createSha256,
  decodeBase64url,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  MAX_KEY_EPOCH,
  randomBytes,
  type DropAuthRequest,
  type EpochOptions,
} from '@4thtech-io/crypto';
import type { Logger } from '@4thtech-io/log';
import {
  checkFuture,
  checkSize,
  type PutOptions,
  type StorageAdapter,
  type StoredObject,
} from './adapter.js';
import { validateS3Endpoint } from './endpoint.js';
import { StorageError, type StorageErrorCode, type StorageLimit } from './errors.js';
import { INVITE_OBJECT_MAX_BYTES, isInviteLookupId } from './drop-invite.js';
import { discard, readCappedText, type FetchLike } from './http.js';

const MiB = 1024 * 1024;

/** The 4thTech drop (beta host, D-28). Overridable for staging and self-hosting. */
export const DROP_DEFAULT_ENDPOINT = 'https://drop.agentlink.4thtech.io';
/** The drop's size cap per file (ciphertext bytes; 07 §5.4 Limits). */
export const DROP_MAX_CIPHERTEXT_BYTES = 100 * MiB;
/** Hard expiry after upload (07 §5.4). */
export const DROP_MAX_EXPIRY_SECONDS = 7 * 86_400;

/** Largest drop JSON response read (a grant lists at most 20 parts at the drop's limits). */
const MAX_RESPONSE_BYTES = 16 * 1024;
/** A hostile Retry-After never makes the caller wait longer than this. */
const MAX_RETRY_AFTER_SECONDS = 3_600;
/** The drop's part numbers (R2 and S3 allow 10 000 parts). */
const MAX_PARTS = 10_000;
const MAX_URL_LENGTH = 512;
const OBJECT_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const MAC_RE = /^[A-Za-z0-9_-]{43}$/;
const EXPIRY_RE = /^(0|[1-9]\d{0,15})$/;
const GET_PATH_RE = /^\/v1\/get\/([A-Za-z0-9_-]{22})$/;

/**
 * Signs one drop request with the agent's drop key (07 §5.4 signature format: a kind-27235 event
 * over the exact URL, method and body, `created_at` = the body's `ts`) and returns the Authorization
 * header value. The KeyStore implements it; the key never leaves the KeyStore.
 *
 * `options.epoch` (DELETE only, M1-1g-f) names the epoch of the drop key that uploaded the object;
 * without it the KeyStore signs at its current epoch. `getPublicBundle` gives the current epoch,
 * which `put` records with the object (M1-1g-g); the adapter reads nothing else from it.
 */
export interface DropSigner {
  signDropRequest(
    request: DropAuthRequest,
    createdAt: number,
    options?: EpochOptions,
  ): Promise<string>;
  getPublicBundle(): Promise<{ readonly keyEpoch: number }>;
}

export interface DropAdapterConfig {
  /** `https://host[:port]`. Defaults to DROP_DEFAULT_ENDPOINT. */
  readonly endpoint?: string;
  readonly signer: DropSigner;
  /** Required: the caller passes the SSRF-safe fetch (M1-15) where one exists. */
  readonly fetch: FetchLike;
  /** The drop's size cap, when a self-hosted or staging drop has a smaller one. At most 100 MiB. */
  readonly maxBytes?: number;
  readonly now?: () => Date;
  readonly logger?: Logger;
}

export interface DropPresignedGet {
  readonly url: string;
  /** The object's expiry, fixed at upload. */
  readonly expiresAt: Date;
}

export interface DropAdapter extends StorageAdapter {
  readonly kind: 'drop';
  /** The configured drop origin, `https://host[:port]`. */
  readonly origin: string;
  /** The size cap this adapter applies before asking the drop. */
  readonly maxBytes: number;
  /** The longest `getUrl` this drop can return: for sizing an envelope before upload (G-27). */
  readonly maxGetUrlLength: number;
  /** Like `presignGet`, and also returns the object's expiry. */
  presign(obj: StoredObject, expiresAt: Date): Promise<DropPresignedGet>;
  /** W4-SHORT-INVITE: the drop key's current epoch, recorded with an invite before its upload. */
  inviteEpoch(): Promise<number>;
  /**
   * W4-SHORT-INVITE (07 §5.4 `POST /v1/invite`): uploads one `ALI1` object under `lookupId`, signed at
   * `epoch` (refused with `upload_failed`, nothing more sent, if the key moved on). 429 and 503 are
   * `rate_limited` and `unavailable`; any other refusal is `upload_failed`.
   */
  putInvite(input: DropInviteUpload): Promise<{ readonly expiresAt: Date }>;
  /** W4-SHORT-INVITE (`DELETE /v1/i/{lookupId}`), signed at the upload `epoch`; 404 is done. */
  deleteInvite(lookupId: string, epoch: number): Promise<void>;
}

/** One invite object upload (W4-SHORT-INVITE, 04 §3.6.2). */
export interface DropInviteUpload {
  /** Strict 22-character base64url of the 16-byte lookup ID. */
  readonly lookupId: string;
  /** The `ALI1` bytes (at most 17 441). */
  readonly object: Uint8Array;
  /** Equal to the invite's own expiry; at most 7 days ahead. */
  readonly expiresAt: Date;
  /** The drop key epoch the caller recorded before the upload. */
  readonly epoch: number;
}

interface Target {
  readonly part: number;
  readonly size: number;
  readonly url: string;
}

function keyUnavailable(): StorageError {
  return new StorageError('credentials_unavailable', 'the drop key is unavailable');
}

function isKeyEpoch(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_KEY_EPOCH
  );
}

function invalidResponse(): StorageError {
  return new StorageError('invalid_response', 'the drop returned an invalid response');
}

function sizeMismatch(): StorageError {
  return new StorageError('size_mismatch', 'ciphertext length does not match the declared size');
}

function notOurs(): StorageError {
  return new StorageError('invalid_argument', 'not an object of this storage');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isObjectId(value: unknown): value is string {
  if (typeof value !== 'string' || !OBJECT_ID_RE.test(value)) return false;
  try {
    decodeBase64url(value, { length: 16 });
    return true;
  } catch {
    return false;
  }
}

/**
 * A signed drop URL (07 §5.4 Signed URLs) checked against the configured origin: exactly
 * `<origin><path>?e=<expiry>&m=<mac>`, https, no user info, no fragment, nothing else in the query.
 * Returns the expiry, or null.
 */
function signedUrlExpiry(raw: unknown, origin: string, path: RegExp | string): number | null {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH || !/^[\x21-\x7e]+$/.test(raw)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // The exact serialised form: no normalisation can turn one origin or path into another.
  if (url.href !== raw || url.origin !== origin || url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '' || url.hash !== '') return null;
  if (typeof path === 'string' ? url.pathname !== path : !path.test(url.pathname)) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2 || keys[0] !== 'e' || keys[1] !== 'm') return null;
  const e = url.searchParams.get('e') ?? '';
  const m = url.searchParams.get('m') ?? '';
  if (!EXPIRY_RE.test(e) || !MAC_RE.test(m)) return null;
  const expiry = Number(e);
  return Number.isSafeInteger(expiry) ? expiry : null;
}

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw === null || !/^\d{1,10}$/.test(raw)) return undefined;
  return Math.min(Number(raw), MAX_RETRY_AFTER_SECONDS);
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  const text = await readCappedText(response, MAX_RESPONSE_BYTES).catch(() => null);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** Maps a refused drop request to a typed error. Only fixed codes are read from the body. */
async function refusal(
  response: Response,
  fallback: Extract<StorageErrorCode, 'upload_failed' | 'delete_failed'>,
): Promise<StorageError> {
  const status = response.status;
  const body = status >= 400 && status < 600 ? await readJson(response) : null;
  if (body === null) await discard(response);
  const error = body?.error;
  if (status === 429) {
    const wait = retryAfter(response);
    return new StorageError('rate_limited', 'the drop is busy; try again later', status, {
      ...(wait === undefined ? {} : { retryAfter: wait }),
    });
  }
  if (status === 503) {
    const wait = retryAfter(response);
    return new StorageError('unavailable', 'the drop is unavailable; try again later', status, {
      ...(wait === undefined ? {} : { retryAfter: wait }),
    });
  }
  if ((status === 403 || status === 413) && error === 'limit') {
    const limit = body?.limit;
    if (limit === 'size' || limit === 'quota') {
      return new StorageError('needs_setup', 'the file is above the drop limits', status, {
        limit: limit satisfies StorageLimit,
      });
    }
  }
  if (status === 422 && error === 'hash_mismatch') {
    return new StorageError('integrity_failed', 'the drop stored different bytes', status);
  }
  if (status === 410 && error === 'expired') {
    return new StorageError('expired', 'the drop link has expired', status);
  }
  return new StorageError(
    fallback,
    fallback === 'upload_failed' ? 'drop upload failed' : 'drop delete failed',
    status,
  );
}

/** Reads exactly the declared bytes, part by part, from bytes or a stream. */
interface PartSource {
  read(size: number): Promise<Uint8Array<ArrayBuffer>>;
  /** Fails unless the source has ended with nothing left over. */
  finish(): Promise<void>;
  cancel(): Promise<void>;
}

function partSource(input: ReadableStream<Uint8Array> | Uint8Array): PartSource {
  if (input instanceof Uint8Array) {
    let offset = 0;
    return {
      async read(size) {
        // A private copy: the bytes hashed are the bytes sent, even if the caller reuses its buffer.
        const out = input.slice(offset, offset + size);
        if (out.length !== size) throw sizeMismatch();
        offset += size;
        return out;
      },
      async finish() {
        if (offset !== input.length) throw sizeMismatch();
      },
      async cancel() {},
    };
  }
  const reader = input.getReader();
  let pending: Uint8Array | null = null;
  let released = false;
  const next = async (): Promise<Uint8Array | null> => {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch (error) {
      // The caller's stream can throw anything, a URL included (M1-6b-b L4).
      if (error instanceof StorageError) throw error;
      throw new StorageError('upload_failed', 'the ciphertext stream failed');
    }
    const { done, value } = result;
    if (done) return null;
    if (!(value instanceof Uint8Array)) {
      throw new StorageError('invalid_argument', 'ciphertext stream must yield bytes');
    }
    return value;
  };
  const release = (): void => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  return {
    async read(size) {
      const out = new Uint8Array(size);
      let filled = 0;
      while (filled < size) {
        if (pending === null || pending.length === 0) {
          pending = await next();
          if (pending === null) throw sizeMismatch();
          continue;
        }
        const take = Math.min(size - filled, pending.length);
        out.set(pending.subarray(0, take), filled);
        filled += take;
        pending = pending.subarray(take);
      }
      return out;
    },
    async finish() {
      if (pending !== null && pending.length > 0) throw sizeMismatch();
      for (;;) {
        const chunk = await next();
        if (chunk === null) break;
        if (chunk.length > 0) throw sizeMismatch();
      }
      release();
    },
    async cancel() {
      if (released) return;
      await reader.cancel().catch(() => undefined);
      release();
    },
  };
}

export function createDropAdapter(config: DropAdapterConfig): DropAdapter {
  if (config === null || typeof config !== 'object') {
    throw new StorageError('invalid_config', 'invalid drop configuration');
  }
  const origin = validateS3Endpoint(config.endpoint ?? DROP_DEFAULT_ENDPOINT);
  const signer = config.signer;
  if (
    signer === null ||
    typeof signer !== 'object' ||
    typeof signer.signDropRequest !== 'function' ||
    typeof signer.getPublicBundle !== 'function'
  ) {
    throw new StorageError('invalid_config', 'invalid drop signer');
  }
  if (typeof config.fetch !== 'function') {
    throw new StorageError('invalid_config', 'invalid drop fetch');
  }
  const fetchImpl = config.fetch;
  const maxBytes = config.maxBytes ?? DROP_MAX_CIPHERTEXT_BYTES;
  if (!isPositiveInt(maxBytes) || maxBytes > DROP_MAX_CIPHERTEXT_BYTES) {
    throw new StorageError('invalid_config', 'invalid drop size limit');
  }
  const now = config.now ?? (() => new Date());
  const log = config.logger?.child({ storage: 'drop' });
  // `<origin>/v1/get/<22>?e=<up to 16 digits>&m=<43>`.
  const maxGetUrlLength =
    origin.length + '/v1/get/'.length + 22 + '?e='.length + 16 + '&m='.length + 43;

  async function send(request: Request): Promise<Response> {
    try {
      return await fetchImpl(request);
    } catch {
      // The underlying error can carry the URL; it is dropped (I-7).
      throw new StorageError('network', 'drop request failed');
    }
  }

  /** The signer's current drop key epoch (M1-1g-g); anything but a key epoch is refused. */
  async function currentEpoch(): Promise<number> {
    let epoch: unknown;
    try {
      epoch = (await signer.getPublicBundle()).keyEpoch;
    } catch {
      throw keyUnavailable();
    }
    if (!isKeyEpoch(epoch)) throw keyUnavailable();
    return epoch;
  }

  /**
   * One signed request (upload, commit, DELETE): JSON body with v, nonce and ts. A POST is signed at
   * the current epoch, which must still be `epoch` once it is signed, so the object's recorded epoch
   * is the one that signed it (M1-1g-g); otherwise nothing is sent. A DELETE names `epoch` when the
   * object recorded one.
   */
  async function signed(
    method: 'POST' | 'DELETE',
    path: string,
    fields: Record<string, string | number>,
    at: Date,
    epoch: number | undefined,
  ): Promise<Response> {
    const url = new URL(path, origin).href;
    const ts = Math.floor(at.getTime() / 1000);
    const nonce = encodeBase64url(randomBytes(16));
    const body = new Uint8Array(encodeUtf8(JSON.stringify({ v: 1, ...fields, nonce, ts })));
    let authorization: unknown;
    try {
      authorization =
        method === 'DELETE' && epoch !== undefined
          ? await signer.signDropRequest({ method, url, body }, ts, { epoch })
          : await signer.signDropRequest({ method, url, body }, ts);
    } catch {
      throw keyUnavailable();
    }
    if (typeof authorization !== 'string' || !/^Nostr [A-Za-z0-9_-]+={0,2}$/.test(authorization)) {
      throw keyUnavailable();
    }
    if (method === 'POST' && (await currentEpoch()) !== epoch) {
      // The key rotated while this upload was in flight: its epoch is not known for certain.
      throw new StorageError('upload_failed', 'drop upload failed');
    }
    return send(
      new Request(url, {
        method,
        headers: { authorization, 'content-type': 'application/json' },
        body,
        redirect: 'manual',
      }),
    );
  }

  function parseGrant(
    grant: Record<string, unknown>,
    size: number,
  ): {
    objectId: string;
    targets: Target[];
  } {
    const objectId = grant.objectId;
    if (!isObjectId(objectId)) throw invalidResponse();
    const putPath = (part: number): string => `/v1/put/${objectId}/${String(part)}`;
    let targets: Target[];
    if (grant.parts === undefined) {
      if (signedUrlExpiry(grant.uploadUrl, origin, putPath(0)) === null) throw invalidResponse();
      targets = [{ part: 0, size, url: grant.uploadUrl as string }];
    } else {
      const parts = grant.parts;
      if (grant.uploadUrl !== undefined || !Array.isArray(parts)) throw invalidResponse();
      if (parts.length < 2 || parts.length > MAX_PARTS) throw invalidResponse();
      targets = parts.map((entry: unknown, i): Target => {
        if (!isObject(entry) || entry.part !== i + 1 || !isPositiveInt(entry.size)) {
          throw invalidResponse();
        }
        if (signedUrlExpiry(entry.uploadUrl, origin, putPath(i + 1)) === null) {
          throw invalidResponse();
        }
        return { part: i + 1, size: entry.size, url: entry.uploadUrl as string };
      });
      if (targets.reduce((sum, t) => sum + t.size, 0) !== size) throw invalidResponse();
    }
    return { objectId, targets };
  }

  /** Best effort: an object that will never be committed is removed at once (04 §4 retention). */
  async function cleanup(objectId: string, epoch: number): Promise<void> {
    try {
      const response = await signed('DELETE', `/v1/o/${objectId}`, { objectId }, now(), epoch);
      await discard(response);
    } catch {
      // The drop expires an uncommitted upload anyway; nothing more to do.
    }
  }

  async function upload(source: PartSource, opts: PutOptions, at: Date): Promise<StoredObject> {
    const ts = Math.floor(at.getTime() / 1000);
    const expiresAt = Math.min(
      Math.floor(opts.expiresAt.getTime() / 1000),
      ts + DROP_MAX_EXPIRY_SECONDS,
    );
    if (expiresAt <= ts) {
      throw new StorageError('invalid_argument', 'expiresAt must be at least a second away');
    }
    const epoch = await currentEpoch();
    const granted = await signed('POST', '/v1/upload', { size: opts.size, expiresAt }, at, epoch);
    if (granted.status !== 201) throw await refusal(granted, 'upload_failed');
    const grant = await readJson(granted);
    if (grant === null) throw invalidResponse();
    const { objectId, targets } = parseGrant(grant, opts.size);

    try {
      const hasher = createSha256();
      for (const target of targets) {
        const bytes = await source.read(target.size);
        hasher.update(bytes);
        const response = await send(
          new Request(target.url, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream' },
            body: bytes,
            redirect: 'manual',
          }),
        );
        if (response.status !== 201) throw await refusal(response, 'upload_failed');
        await discard(response);
      }
      await source.finish();
      const sha256 = encodeHex(hasher.digest());

      const committed = await signed(
        'POST',
        `/v1/o/${objectId}/commit`,
        { objectId, ciphertextSha256: sha256 },
        now(),
        epoch,
      );
      if (committed.status !== 200) throw await refusal(committed, 'upload_failed');
      const result = await readJson(committed);
      if (result === null) throw invalidResponse();
      const expiry = signedUrlExpiry(result.getUrl, origin, `/v1/get/${objectId}`);
      // The drop may not grant a longer life than requested (IR-M1-6c-1 L1).
      if (expiry === null || result.expiresAt !== expiry || expiry > expiresAt) {
        throw invalidResponse();
      }
      log?.debug('drop put', { size: opts.size, parts: targets.length });
      return {
        kind: 'drop',
        locator: result.getUrl as string,
        size: opts.size,
        sha256,
        keyEpoch: epoch,
      };
    } catch (error) {
      await source.cancel();
      await cleanup(objectId, epoch);
      throw error;
    }
  }

  /** The signed GET URL and object ID of one of this drop's objects. */
  function own(obj: StoredObject): { url: string; objectId: string; expiresAt: number } {
    if (obj === null || typeof obj !== 'object' || obj.kind !== 'drop') throw notOurs();
    const expiresAt = signedUrlExpiry(obj.locator, origin, GET_PATH_RE);
    if (expiresAt === null) throw notOurs();
    const objectId = GET_PATH_RE.exec(new URL(obj.locator).pathname)?.[1];
    if (!isObjectId(objectId)) throw notOurs();
    return { url: obj.locator, objectId, expiresAt };
  }

  async function presign(obj: StoredObject, expiresAt: Date): Promise<DropPresignedGet> {
    const { url, expiresAt: expiry } = own(obj);
    const at = now();
    checkFuture(expiresAt, at, 'expiresAt');
    if (at.getTime() >= expiry * 1000) {
      throw new StorageError('expired', 'the drop link has expired');
    }
    log?.debug('drop presign', { ttlSeconds: expiry - Math.floor(at.getTime() / 1000) });
    return { url, expiresAt: new Date(expiry * 1000) };
  }

  return {
    kind: 'drop',
    origin,
    maxBytes,
    maxGetUrlLength,

    async put(ciphertext, opts: PutOptions): Promise<StoredObject> {
      let at: Date;
      try {
        if (opts === null || typeof opts !== 'object') {
          throw new StorageError('invalid_argument', 'missing upload options');
        }
        checkSize(opts.size, Number.MAX_SAFE_INTEGER);
        if (opts.size > maxBytes) {
          throw new StorageError('needs_setup', 'the file is above the drop limits', undefined, {
            limit: 'size',
          });
        }
        at = now();
        checkFuture(opts.expiresAt, at, 'expiresAt');
        if (ciphertext instanceof Uint8Array && ciphertext.length !== opts.size) {
          throw sizeMismatch();
        }
        if (!(ciphertext instanceof Uint8Array) && !(ciphertext instanceof ReadableStream)) {
          throw new StorageError('invalid_argument', 'ciphertext must be bytes or a stream');
        }
      } catch (error) {
        // A refused stream is cancelled, so its source stops (IR-M1-6c-1 L4).
        if (ciphertext instanceof ReadableStream && !ciphertext.locked) {
          await ciphertext.cancel().catch(() => undefined);
        }
        throw error;
      }
      const source = partSource(ciphertext);
      try {
        return await upload(source, opts, at);
      } catch (error) {
        await source.cancel();
        if (error instanceof StorageError) {
          log?.warn('drop put failed', {
            code: error.code,
            ...(error.status === undefined ? {} : { status: error.status }),
          });
        }
        throw error;
      }
    },

    async presignGet(obj: StoredObject, expiresAt: Date): Promise<string> {
      return (await presign(obj, expiresAt)).url;
    },

    inviteEpoch: currentEpoch,

    async putInvite(input: DropInviteUpload): Promise<{ readonly expiresAt: Date }> {
      if (
        input === null ||
        typeof input !== 'object' ||
        !isInviteLookupId(input.lookupId) ||
        !(input.object instanceof Uint8Array) ||
        input.object.length < 1 ||
        input.object.length > INVITE_OBJECT_MAX_BYTES ||
        !isKeyEpoch(input.epoch)
      ) {
        throw new StorageError('invalid_argument', 'invalid invite upload');
      }
      const at = now();
      checkFuture(input.expiresAt, at, 'expiresAt');
      const expiresAt = Math.floor(input.expiresAt.getTime() / 1000);
      const response = await signed(
        'POST',
        '/v1/invite',
        { lookupId: input.lookupId, expiresAt, object: encodeBase64url(input.object) },
        at,
        input.epoch,
      );
      if (response.status !== 201) {
        const error = await refusal(response, 'upload_failed');
        log?.warn('drop invite upload failed', { code: error.code, status: response.status });
        throw error;
      }
      const body = await readJson(response);
      if (body?.expiresAt !== expiresAt) throw invalidResponse();
      return { expiresAt: new Date(expiresAt * 1000) };
    },

    async deleteInvite(lookupId: string, epoch: number): Promise<void> {
      if (!isInviteLookupId(lookupId) || !isKeyEpoch(epoch)) {
        throw new StorageError('invalid_argument', 'invalid invite delete');
      }
      const response = await signed('DELETE', `/v1/i/${lookupId}`, { lookupId }, now(), epoch);
      if (response.status !== 204 && response.status !== 404) {
        const error = await refusal(response, 'delete_failed');
        log?.warn('drop invite delete failed', { code: error.code, status: response.status });
        throw error.code === 'rate_limited' || error.code === 'unavailable'
          ? error
          : new StorageError('delete_failed', 'drop delete failed', response.status);
      }
      await discard(response);
    },

    presign,

    async delete(obj: StoredObject): Promise<void> {
      const { objectId } = own(obj);
      // The upload epoch (M1-1g-g). An object recorded before epochs were kept has none and is
      // deleted at the current epoch, as before.
      const epoch: unknown = obj.keyEpoch;
      if (epoch !== undefined && !isKeyEpoch(epoch)) {
        throw new StorageError('invalid_argument', 'invalid drop key epoch');
      }
      const response = await signed('DELETE', `/v1/o/${objectId}`, { objectId }, now(), epoch);
      // 404: already gone, which is the goal of a delete.
      if (response.status !== 204 && response.status !== 404) {
        const error = await refusal(response, 'delete_failed');
        log?.warn('drop delete failed', { code: error.code, status: response.status });
        throw error.code === 'rate_limited' || error.code === 'unavailable'
          ? error
          : new StorageError('delete_failed', 'drop delete failed', response.status);
      }
      await discard(response);
      log?.debug('drop delete');
    },
  };
}
