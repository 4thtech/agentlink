// The 4thTech encrypted drop (M1-27a, D-48): a Cloudflare Worker in front of an R2 bucket that holds
// only ALF1 ciphertext, under random 128-bit object IDs, for at most 7 days (07 §5.4, 04 §4).
//
//   POST   /v1/upload                 signed by the drop key: {v, size, expiresAt, nonce, ts}
//   PUT    /v1/put/{id}/{part}?e&m    single-use signed target, exactly the declared size
//   POST   /v1/o/{id}/commit          signed: {v, objectId, ciphertextSha256, nonce, ts}
//   GET    /v1/get/{id}?e&m           signed GET until expiresAt, up to the download limit
//   DELETE /v1/o/{id}                 signed by the uploading drop key: {v, objectId, nonce, ts}
//   POST   /v1/report                 {v, url, reason}: deletes only that object
//   GET    /v1/health                 liveness only
//
// Logging (I-7): this Worker writes nothing to the console and logs no request, URL, object ID,
// drop key, signature, nonce or IP. It keeps only the aggregate counters in state.ts (METRICS).
// Errors are typed codes; no response echoes request input.
import {
  DROP_OBJECT_ID_LENGTH,
  createSha256,
  decodeBase64url,
  decodeUtf8,
  dropUrlMac,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  hkdfSha256,
  hmacSha256,
  parseJson,
  randomBytes,
  verifyDropAuthorization,
  verifyDropUrlMac,
  type DropUrlPurpose,
} from '@4thtech-io/crypto';
import { readConfig, type DropConfig, type Limits } from './config.js';
import { ipBucket } from './ip.js';
import { DropState, type Metric, type ObjectRefusal, type Refusal } from './state.js';

export interface DropEnv {
  readonly DROP_BUCKET: R2Bucket;
  readonly DROP_STATE: DurableObjectNamespace<DropState>;
  readonly [name: string]: unknown;
}

/** Largest signed JSON body (upload, commit, DELETE) and report body. */
const MAX_SIGNED_BODY = 1024;
const MAX_REPORT_BODY = 2048;
const REPORT_REASONS = ['malware', 'illegal', 'spam', 'other'] as const;
const OBJECT_ID = '[A-Za-z0-9_-]{22}';
const HEX_64 = /^[0-9a-f]{64}$/;
const MAC_INFO = 'agentlink/v1/drop-url-mac';
const IP_INFO = 'agentlink/v1/drop-ip-bucket';

/** Headers on every response: nothing the drop serves can render as a page. */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

interface Context {
  readonly env: DropEnv;
  readonly ctx: ExecutionContext;
  readonly config: DropConfig;
  readonly limits: Limits;
  readonly request: Request;
  readonly url: URL;
  readonly now: number;
  readonly macKey: Uint8Array;
  readonly ipKey: Uint8Array;
}

function respond(
  status: number,
  body: Record<string, unknown> | null,
  extra: Record<string, string> = {},
): Response {
  const headers = new Headers({ ...BASE_HEADERS, 'cache-control': 'no-store', ...extra });
  if (body === null) return new Response(null, { status, headers });
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Refusals that need no valid signature or MAC to trigger. They are counted in this isolate only and
 * flushed with the next counted event, so a flood of junk requests costs no Durable Object write.
 */
const DEFERRED: ReadonlySet<Metric> = new Set<Metric>([
  'bad_request',
  'unauthorized',
  'download_refused',
  'put_refused',
  'unavailable',
  'internal_error',
]);
const METRIC_SHARDS = 8;
let pending: Partial<Record<Metric, number>> = {};

/**
 * Counts one event. Counters live in `metrics:<0..7>` shards, never in the `global` instance that
 * holds the global cap, so counting can never slow an upload grant (IR-M1-27a-1 M-2).
 */
function bump(c: Pick<Context, 'env' | 'ctx'>, name: Metric): void {
  pending[name] = (pending[name] ?? 0) + 1;
  if (DEFERRED.has(name)) return;
  const counts = pending;
  pending = {};
  const shard = `metrics:${String((randomBytes(1)[0] ?? 0) % METRIC_SHARDS)}`;
  const stub = c.env.DROP_STATE.get(c.env.DROP_STATE.idFromName(shard));
  c.ctx.waitUntil(stub.bump(counts).catch(() => undefined));
}

function badRequest(c: Context): Response {
  bump(c, 'bad_request');
  return respond(400, { error: 'bad_request' });
}

function stateStub(c: Context, name: string): DurableObjectStub<DropState> {
  return c.env.DROP_STATE.get(c.env.DROP_STATE.idFromName(name));
}

function refused(c: Context, refusal: Refusal): Response {
  switch (refusal.error) {
    case 'replayed':
      bump(c, 'replayed');
      return respond(409, { error: 'replayed' });
    case 'quota':
      bump(c, 'limit_refused');
      return respond(403, { error: 'limit', limit: 'quota' });
    case 'rate_limited':
      bump(c, 'rate_limited');
      return respond(
        429,
        { error: 'rate_limited', retryable: true },
        { 'retry-after': String(refusal.retryAfter) },
      );
    case 'unavailable':
      bump(c, 'unavailable');
      return respond(
        503,
        { error: 'unavailable', retryable: true },
        { 'retry-after': String(refusal.retryAfter) },
      );
  }
}

function objectRefused(c: Context, refusal: ObjectRefusal, metric: Metric): Response {
  bump(c, metric);
  switch (refusal.error) {
    case 'not_found':
      return respond(404, { error: 'not_found' });
    case 'forbidden':
      return respond(403, { error: 'forbidden' });
    case 'conflict':
      return respond(409, { error: 'conflict' });
    case 'expired':
      return respond(410, { error: 'expired' });
    case 'length_mismatch':
      return respond(400, { error: 'length_mismatch' });
    case 'limit':
      return respond(403, { error: 'limit', limit: 'downloads' });
  }
}

async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > max)) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
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
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function parseObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value = parseJson(decodeUtf8(bytes), { integersOnly: true });
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasExactly(object: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(object).sort();
  const want = [...keys].sort();
  return own.length === want.length && own.every((key, i) => key === want[i]);
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isNonce(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 22) return false;
  try {
    decodeBase64url(value, { length: 16 });
    return true;
  } catch {
    return false;
  }
}

function decodeObjectId(text: string): Uint8Array | null {
  try {
    return decodeBase64url(text, { length: DROP_OBJECT_ID_LENGTH });
  } catch {
    return null;
  }
}

function signedUrl(
  c: Context,
  purpose: DropUrlPurpose,
  objectId: Uint8Array,
  part: number,
  expiresAt: number,
): string {
  const mac = encodeBase64url(dropUrlMac(c.macKey, { purpose, objectId, part, expiresAt }));
  const id = encodeBase64url(objectId);
  const path = purpose === 'get' ? `/v1/get/${id}` : `/v1/put/${id}/${String(part)}`;
  return `https://${c.url.host}${path}?e=${String(expiresAt)}&m=${mac}`;
}

/** The object ID, part and expiry of a signed URL whose MAC verifies, or null. */
function checkSignedUrl(
  c: Context,
  url: URL,
  purpose: DropUrlPurpose,
): { objectId: Uint8Array; idText: string; part: number; expiresAt: number } | null {
  const pattern =
    purpose === 'get'
      ? new RegExp(`^/v1/get/(${OBJECT_ID})$`)
      : new RegExp(`^/v1/put/(${OBJECT_ID})/(0|[1-9]\\d{0,4})$`);
  const match = pattern.exec(url.pathname);
  if (!match) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2 || !url.searchParams.has('e') || !url.searchParams.has('m')) return null;
  const e = url.searchParams.get('e') ?? '';
  const m = url.searchParams.get('m') ?? '';
  if (!/^(0|[1-9]\d{0,15})$/.test(e)) return null;
  const idText = match[1] ?? '';
  const objectId = decodeObjectId(idText);
  if (objectId === null) return null;
  const part = purpose === 'get' ? 0 : Number(match[2]);
  const expiresAt = Number(e);
  let mac: Uint8Array;
  try {
    mac = decodeBase64url(m, { length: 32 });
  } catch {
    return null;
  }
  if (!verifyDropUrlMac(c.macKey, { purpose, objectId, part, expiresAt }, mac)) return null;
  return { objectId, idText, part, expiresAt };
}

/** Reads and verifies a signed request; returns the drop key and the parsed body, or a response. */
async function readSigned(
  c: Context,
): Promise<{ pubkey: string; createdAt: number; body: Record<string, unknown> } | Response> {
  const bytes = await readCapped(c.request, MAX_SIGNED_BODY);
  if (bytes === null) return badRequest(c);
  const auth = verifyDropAuthorization(
    c.request.headers.get('authorization'),
    { method: c.request.method, url: c.request.url, body: bytes },
    c.now,
  );
  if (!auth.ok) {
    bump(c, 'unauthorized');
    return respond(401, { error: auth.reason === 'stale' ? 'stale' : 'unauthorized' });
  }
  const body = parseObject(bytes);
  if (body === null || body.v !== 1 || !isNonce(body.nonce) || body.ts !== auth.createdAt) {
    return badRequest(c);
  }
  return { pubkey: auth.pubkey, createdAt: auth.createdAt, body };
}

function ipName(c: Context): string {
  const bucket = ipBucket(c.request.headers.get('cf-connecting-ip'));
  return `i:${encodeHex(hmacSha256(c.ipKey, encodeUtf8(bucket))).slice(0, 32)}`;
}

function partSizes(size: number, partSize: number): number[] {
  if (size <= partSize) return [size];
  const sizes: number[] = [];
  for (let offset = 0; offset < size; offset += partSize) {
    sizes.push(Math.min(partSize, size - offset));
  }
  return sizes;
}

async function handleUpload(c: Context): Promise<Response> {
  const signed = await readSigned(c);
  if (signed instanceof Response) return signed;
  const { body, pubkey } = signed;
  if (!hasExactly(body, ['v', 'size', 'expiresAt', 'nonce', 'ts'])) return badRequest(c);
  const { size, expiresAt, nonce, ts } = body as {
    size: unknown;
    expiresAt: unknown;
    nonce: string;
    ts: number;
  };
  if (!isInt(size) || size < 1 || !isInt(expiresAt)) return badRequest(c);
  if (size > c.limits.maxSize) {
    bump(c, 'limit_refused');
    return respond(413, { error: 'limit', limit: 'size' });
  }
  const maxExpiry = c.limits.maxExpirySeconds;
  if (expiresAt <= c.now || expiresAt > ts + maxExpiry || expiresAt > c.now + maxExpiry) {
    return badRequest(c);
  }

  // The per-IP ceiling runs first, before any drop key's state is created or touched.
  const ipStub = stateStub(c, ipName(c));
  const ipGate = await ipStub.ipRequest({ now: c.now, limits: c.limits });
  if (!ipGate.ok) {
    bump(c, 'upload_refused');
    return refused(c, ipGate);
  }
  const keyStub = stateStub(c, `k:${pubkey}`);
  const key = await keyStub.keyRequest({ nonce, now: c.now, limits: c.limits, uploadSize: size });
  if (!key.ok) {
    bump(c, 'upload_refused');
    return refused(c, key);
  }
  // Only a key's first upload needs admission from this IP; a key admitted before keeps working.
  const freshKey = !key.known;
  if (freshKey) {
    const admitted = await ipStub.ipAdmitFreshKey({ now: c.now, limits: c.limits });
    if (!admitted.ok) {
      await keyStub.keyRefund({ now: c.now, size, known: key.known });
      bump(c, 'upload_refused');
      return refused(c, admitted);
    }
  }
  const undoAdmission = async (): Promise<void> => {
    await keyStub.keyRefund({ now: c.now, size, known: key.known });
    if (freshKey) await ipStub.ipUnadmitFreshKey({ now: c.now });
  };
  const globalStub = stateStub(c, 'global');
  const global = await globalStub.globalReserve({ now: c.now, size, limits: c.limits });
  if (!global.ok) {
    await undoAdmission();
    bump(c, 'upload_refused');
    return refused(c, global);
  }

  const objectId = randomBytes(DROP_OBJECT_ID_LENGTH);
  const idText = encodeBase64url(objectId);
  const r2Key = `o/${idText}`;
  const sizes = partSizes(size, c.limits.partSize);
  const multipart = sizes.length > 1;
  let uploadId: string | undefined;
  if (multipart) {
    try {
      uploadId = (await c.env.DROP_BUCKET.createMultipartUpload(r2Key)).uploadId;
    } catch {
      await undoAdmission();
      await globalStub.globalRefund({ now: c.now, size });
      return refused(c, { ok: false, error: 'unavailable', retryAfter: 60 });
    }
  }
  const putExpiresAt = Math.min(c.now + c.limits.uploadTargetSeconds, expiresAt);
  await stateStub(c, `o:${idText}`).objCreate({
    r2Key,
    owner: pubkey,
    size,
    expiresAt,
    putExpiresAt,
    partSizes: sizes,
    multipart,
    ...(uploadId === undefined ? {} : { uploadId }),
  });
  bump(c, 'upload_granted');
  const grant: Record<string, unknown> = {
    objectId: idText,
    expiresAt,
    uploadExpiresAt: putExpiresAt,
  };
  if (multipart) {
    grant.parts = sizes.map((partSize, i) => ({
      part: i + 1,
      size: partSize,
      uploadUrl: signedUrl(c, 'put', objectId, i + 1, putExpiresAt),
    }));
  } else {
    grant.uploadUrl = signedUrl(c, 'put', objectId, 0, putExpiresAt);
  }
  return respond(201, grant);
}

async function handlePut(c: Context): Promise<Response> {
  const target = checkSignedUrl(c, c.url, 'put');
  if (target === null || c.now >= target.expiresAt) {
    bump(c, 'put_refused');
    return respond(403, { error: 'forbidden' });
  }
  const declared = c.request.headers.get('content-length');
  if (declared === null || !/^\d{1,10}$/.test(declared) || c.request.body === null) {
    bump(c, 'put_refused');
    return respond(411, { error: 'length_required' });
  }
  const contentLength = Number(declared);
  const objectStub = stateStub(c, `o:${target.idText}`);
  const begin = await objectStub.objBeginPut({ part: target.part, contentLength, now: c.now });
  if (!begin.ok) return objectRefused(c, begin, 'put_refused');
  let etag: string | null;
  try {
    if (begin.multipart && begin.uploadId !== undefined) {
      const upload = c.env.DROP_BUCKET.resumeMultipartUpload(begin.r2Key, begin.uploadId);
      etag = (await upload.uploadPart(target.part, c.request.body)).etag;
    } else {
      const stored = await c.env.DROP_BUCKET.put(begin.r2Key, c.request.body);
      etag = stored !== null && stored.size === contentLength ? stored.etag : null;
    }
  } catch {
    etag = null;
  }
  await objectStub.objFinishPut({ part: target.part, etag });
  if (etag === null) {
    if (!begin.multipart) await c.env.DROP_BUCKET.delete(begin.r2Key).catch(() => undefined);
    bump(c, 'put_refused');
    return respond(400, { error: 'length_mismatch' });
  }
  bump(c, 'put_stored');
  return respond(201, { part: target.part, size: contentLength });
}

async function hashStored(
  bucket: R2Bucket,
  key: string,
): Promise<{ sha256: string; size: number }> {
  const stored = await bucket.get(key);
  if (stored === null) throw new Error('missing');
  const hasher = createSha256();
  const reader = stored.body.getReader();
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
    size += value.length;
  }
  return { sha256: encodeHex(hasher.digest()), size };
}

async function handleCommit(c: Context, idText: string): Promise<Response> {
  const signed = await readSigned(c);
  if (signed instanceof Response) return signed;
  const { body, pubkey } = signed;
  if (!hasExactly(body, ['v', 'objectId', 'ciphertextSha256', 'nonce', 'ts'])) return badRequest(c);
  const { objectId, ciphertextSha256, nonce } = body as Record<string, unknown> & { nonce: string };
  if (
    objectId !== idText ||
    typeof ciphertextSha256 !== 'string' ||
    !HEX_64.test(ciphertextSha256)
  ) {
    return badRequest(c);
  }
  const objectIdBytes = decodeObjectId(idText);
  if (objectIdBytes === null) return badRequest(c);
  const ipGate = await stateStub(c, ipName(c)).ipRequest({ now: c.now, limits: c.limits });
  if (!ipGate.ok) return refused(c, ipGate);
  const key = await stateStub(c, `k:${pubkey}`).keyRequest({ nonce, now: c.now, limits: c.limits });
  if (!key.ok) return refused(c, key);
  const objectStub = stateStub(c, `o:${idText}`);
  const begin = await objectStub.objBeginCommit({ owner: pubkey, now: c.now });
  if (!begin.ok) return objectRefused(c, begin, 'bad_request');

  const bucket = c.env.DROP_BUCKET;
  let matches = false;
  let failed = false;
  try {
    if (begin.multipart && begin.uploadId !== undefined) {
      await bucket.resumeMultipartUpload(begin.r2Key, begin.uploadId).complete(begin.parts);
    }
    const stored = await hashStored(bucket, begin.r2Key);
    matches = stored.size === begin.size && stored.sha256 === ciphertextSha256;
  } catch {
    failed = true;
  }
  if (!matches) {
    // Nothing readable is left: the bytes go, and the object is forgotten.
    await bucket.delete(begin.r2Key).catch(() => undefined);
    if (failed && begin.multipart && begin.uploadId !== undefined) {
      await bucket
        .resumeMultipartUpload(begin.r2Key, begin.uploadId)
        .abort()
        .catch(() => undefined);
    }
    await objectStub.objFinishCommit({ ok: false });
    if (failed) {
      bump(c, 'internal_error');
      return respond(500, { error: 'internal' });
    }
    bump(c, 'commit_mismatch');
    return respond(422, { error: 'hash_mismatch' });
  }
  await objectStub.objFinishCommit({ ok: true });
  bump(c, 'commit_ok');
  return respond(200, {
    getUrl: signedUrl(c, 'get', objectIdBytes, 0, begin.expiresAt),
    expiresAt: begin.expiresAt,
  });
}

function allowedOrigin(c: Context): string | null {
  const origin = c.request.headers.get('origin');
  return origin !== null && c.config.corsOrigins.includes(origin) ? origin : null;
}

function handlePreflight(c: Context): Response {
  const origin = allowedOrigin(c);
  if (origin === null || c.request.headers.get('access-control-request-method') !== 'GET') {
    return respond(403, null, { vary: 'Origin' });
  }
  return respond(204, null, {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET',
    'access-control-max-age': '600',
    vary: 'Origin',
  });
}

async function handleGet(c: Context): Promise<Response> {
  const target = checkSignedUrl(c, c.url, 'get');
  if (target === null) {
    bump(c, 'download_refused');
    return respond(403, { error: 'forbidden' });
  }
  if (c.now >= target.expiresAt) {
    bump(c, 'download_refused');
    return respond(410, { error: 'expired' });
  }
  // Fetch first and count after: a failed R2 read never uses up one of the object's downloads
  // (IR-M1-27a-1 L-1). The count is still checked and taken atomically in the object's state.
  const stored = await c.env.DROP_BUCKET.get(`o/${target.idText}`);
  if (stored === null) {
    bump(c, 'download_refused');
    return respond(404, { error: 'not_found' });
  }
  const download = await stateStub(c, `o:${target.idText}`).objDownload({
    now: c.now,
    limit: c.limits.downloadLimit,
  });
  if (!download.ok) {
    await stored.body.cancel().catch(() => undefined);
    return objectRefused(c, download, 'download_refused');
  }
  const headers = new Headers({
    ...BASE_HEADERS,
    'content-type': 'application/octet-stream',
    'content-disposition': 'attachment',
    'content-length': String(stored.size),
    'cache-control': 'private, no-store',
    vary: 'Origin',
  });
  const origin = allowedOrigin(c);
  if (origin !== null) headers.set('access-control-allow-origin', origin);
  bump(c, 'download');
  return new Response(stored.body, { status: 200, headers });
}

async function handleDelete(c: Context, idText: string): Promise<Response> {
  const signed = await readSigned(c);
  if (signed instanceof Response) return signed;
  const { body, pubkey } = signed;
  if (!hasExactly(body, ['v', 'objectId', 'nonce', 'ts']) || body.objectId !== idText) {
    return badRequest(c);
  }
  const ipGate = await stateStub(c, ipName(c)).ipRequest({ now: c.now, limits: c.limits });
  if (!ipGate.ok) return refused(c, ipGate);
  const key = await stateStub(c, `k:${pubkey}`).keyRequest({
    nonce: body.nonce as string,
    now: c.now,
    limits: c.limits,
  });
  if (!key.ok) return refused(c, key);
  const removed = await stateStub(c, `o:${idText}`).objDelete({ owner: pubkey });
  if (!removed.ok) return objectRefused(c, removed, 'bad_request');
  await deleteStored(c, removed);
  bump(c, 'delete');
  return respond(204, null);
}

async function deleteStored(
  c: Context,
  removed: { r2Key: string; multipart: boolean; uploadId?: string; committed: boolean },
): Promise<void> {
  const bucket = c.env.DROP_BUCKET;
  await bucket.delete(removed.r2Key);
  if (removed.multipart && !removed.committed && removed.uploadId !== undefined) {
    await bucket
      .resumeMultipartUpload(removed.r2Key, removed.uploadId)
      .abort()
      .catch(() => undefined);
  }
}

async function handleReport(c: Context): Promise<Response> {
  const bytes = await readCapped(c.request, MAX_REPORT_BODY);
  const body = bytes === null ? null : parseObject(bytes);
  if (body === null || !hasExactly(body, ['v', 'url', 'reason']) || body.v !== 1) {
    return badRequest(c);
  }
  const { url, reason } = body;
  if (
    typeof reason !== 'string' ||
    !(REPORT_REASONS as readonly string[]).includes(reason) ||
    typeof url !== 'string' ||
    url.length > 512
  ) {
    return badRequest(c);
  }
  let reported: URL;
  try {
    reported = new URL(url);
  } catch {
    return badRequest(c);
  }
  // Only a getUrl of this drop, with a valid MAC (expired or not), can be reported: knowing an
  // object ID alone is not enough to delete it.
  if (reported.origin !== `https://${c.url.host}` || reported.hash !== '') return badRequest(c);
  const target = checkSignedUrl(c, reported, 'get');
  if (target === null) return badRequest(c);
  const rate = await stateStub(c, ipName(c)).ipReport({ now: c.now, limits: c.limits });
  if (!rate.ok) return refused(c, rate);
  // Deletes only that object; the uploading drop key is never blocked automatically (04 §4).
  const removed = await stateStub(c, `o:${target.idText}`).objDelete({ owner: null });
  if (removed.ok) await deleteStored(c, removed);
  bump(c, 'report');
  return respond(202, { ok: true });
}

async function route(request: Request, env: DropEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === '/v1/health') {
    return method === 'GET'
      ? respond(200, { ok: true })
      : respond(405, { error: 'method_not_allowed' });
  }
  const config = readConfig(env);
  if (config === null) {
    bump({ env, ctx }, 'unavailable');
    return respond(503, { error: 'unavailable', retryable: true }, { 'retry-after': '60' });
  }
  const c: Context = {
    env,
    ctx,
    config,
    limits: config.limits,
    request,
    url,
    now: Math.floor(Date.now() / 1000),
    macKey: hkdfSha256(config.urlKey, new Uint8Array(0), encodeUtf8(MAC_INFO), 32),
    ipKey: hkdfSha256(config.urlKey, new Uint8Array(0), encodeUtf8(IP_INFO), 32),
  };

  if (path.startsWith('/v1/get/')) {
    if (method === 'GET') return handleGet(c);
    if (method === 'OPTIONS') return handlePreflight(c);
    return respond(405, { error: 'method_not_allowed' });
  }
  if (path.startsWith('/v1/put/')) {
    return method === 'PUT' ? handlePut(c) : respond(405, { error: 'method_not_allowed' });
  }
  if (path === '/v1/upload') {
    return method === 'POST' ? handleUpload(c) : respond(405, { error: 'method_not_allowed' });
  }
  if (path === '/v1/report') {
    return method === 'POST' ? handleReport(c) : respond(405, { error: 'method_not_allowed' });
  }
  const objectPath = new RegExp(`^/v1/o/(${OBJECT_ID})(/commit)?$`).exec(path);
  if (objectPath) {
    const idText = objectPath[1] ?? '';
    if (objectPath[2] === '/commit') {
      return method === 'POST'
        ? handleCommit(c, idText)
        : respond(405, { error: 'method_not_allowed' });
    }
    return method === 'DELETE'
      ? handleDelete(c, idText)
      : respond(405, { error: 'method_not_allowed' });
  }
  return respond(404, { error: 'not_found' });
}

export default {
  async fetch(request: Request, env: DropEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch {
      // Never logged: an error could carry a URL or an ID (I-7). Counted only.
      bump({ env, ctx }, 'internal_error');
      return respond(500, { error: 'internal' });
    }
  },
};
