// M1-27b: the encrypted drop's deploy smoke test (release-and-deployment.md §4.5, D-25). One set of
// steps, two runners:
//   - test/smoke.test.ts runs them on every `pnpm test` against the Worker under Miniflare (workerd);
//   - test/smoke-remote.test.ts runs them in the deploy workflow against the deployed staging Worker
//     (`DROP_SMOKE_URL`), with plain fetch and no credentials.
//
// The drop key is a fresh random key per run (a test key, never stored); the uploaded bytes are
// random, since the drop sees only opaque ciphertext. Zero access (AGENTS.md, I-7): nothing here
// prints a URL, object ID, drop key, signature or nonce. Failures carry fixed text and HTTP status
// codes only, never a response body or URL.
import {
  createSha256,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  randomBytes,
} from '@4thtech-io/crypto';

export interface DropAuthRequest {
  readonly method: string;
  readonly url: string;
  readonly body: Uint8Array;
}

export interface SmokeTarget {
  /** The drop's origin, `https://host[:port]`, with no path. */
  readonly base: string;
  /** fetch for this target (SELF.fetch under Miniflare, global fetch remotely). */
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Signs a drop request with a drop key (the crypto test seam, injected by the test file). */
  readonly sign: (
    key: Uint8Array,
    request: DropAuthRequest,
    createdAt: number,
  ) => { readonly authorization: string };
  /** Extra headers on every request (Miniflare: a client IP). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Waits `ms` milliseconds. */
  readonly sleep: (ms: number) => Promise<void>;
}

export class SmokeFailure extends Error {
  constructor(step: string, detail: string) {
    super(`drop smoke: ${step}: ${detail}`);
    this.name = 'SmokeFailure';
  }
}

function check(condition: boolean, step: string, detail: string): void {
  if (!condition) throw new SmokeFailure(step, detail);
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** A random secp256k1 scalar: the first byte below 0x80 keeps it under the group order. */
export function newSmokeKey(): Uint8Array {
  const key = randomBytes(32);
  key[0] = ((key[0] ?? 0) & 0x7f) | 0x01;
  return key;
}

/** The origin of `text` when it is a bare `https://host[:port]` origin, else null. */
export function smokeOrigin(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    return null;
  }
  return url.origin;
}

function hashHex(data: Uint8Array): string {
  return encodeHex(createSha256().update(data).digest());
}

async function drain(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // The body is not needed; a broken stream is not the smoke's concern.
  }
}

async function signed(
  t: SmokeTarget,
  key: Uint8Array,
  method: 'POST' | 'DELETE',
  path: string,
  body: Record<string, unknown>,
  ts: number,
): Promise<Response> {
  const url = `${t.base}${path}`;
  const text = JSON.stringify(body);
  const { authorization } = t.sign(key, { method, url, body: encodeUtf8(text) }, ts);
  return t.fetch(url, {
    method,
    headers: { ...t.headers, authorization, 'content-type': 'application/json' },
    body: text,
  });
}

interface Stored {
  readonly objectId: string;
  readonly getUrl: string;
  readonly expiresAt: number;
}

/** Upload grant, PUT and commit of `data` with the given expiry. */
async function store(
  t: SmokeTarget,
  key: Uint8Array,
  data: Uint8Array<ArrayBuffer>,
  expiresAt: number,
): Promise<Stored> {
  const ts = nowSeconds();
  const grant = await signed(
    t,
    key,
    'POST',
    '/v1/upload',
    { v: 1, size: data.length, expiresAt, nonce: encodeBase64url(randomBytes(16)), ts },
    ts,
  );
  check(grant.status === 201, 'upload grant', `status ${String(grant.status)}`);
  const granted = (await grant.json()) as { objectId?: unknown; uploadUrl?: unknown };
  check(
    typeof granted.objectId === 'string' && typeof granted.uploadUrl === 'string',
    'upload grant',
    'no single-part target',
  );
  const objectId = granted.objectId as string;
  const uploadUrl = granted.uploadUrl as string;
  check(uploadUrl.startsWith(`${t.base}/v1/put/`), 'upload grant', 'target is not on this drop');

  const put = await t.fetch(uploadUrl, { method: 'PUT', headers: { ...t.headers }, body: data });
  check(put.status === 201, 'PUT', `status ${String(put.status)}`);
  await drain(put);

  const commitTs = nowSeconds();
  const commit = await signed(
    t,
    key,
    'POST',
    `/v1/o/${objectId}/commit`,
    {
      v: 1,
      objectId,
      ciphertextSha256: hashHex(data),
      nonce: encodeBase64url(randomBytes(16)),
      ts: commitTs,
    },
    commitTs,
  );
  check(commit.status === 200, 'commit', `status ${String(commit.status)}`);
  const committed = (await commit.json()) as { getUrl?: unknown; expiresAt?: unknown };
  check(
    typeof committed.getUrl === 'string' && typeof committed.expiresAt === 'number',
    'commit',
    'no getUrl',
  );
  const getUrl = committed.getUrl as string;
  check(getUrl.startsWith(`${t.base}/v1/get/`), 'commit', 'getUrl is not on this drop');
  return { objectId, getUrl, expiresAt: committed.expiresAt as number };
}

async function remove(t: SmokeTarget, key: Uint8Array, objectId: string): Promise<Response> {
  const ts = nowSeconds();
  return signed(
    t,
    key,
    'DELETE',
    `/v1/o/${objectId}`,
    { v: 1, objectId, nonce: encodeBase64url(randomBytes(16)), ts },
    ts,
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Liveness, and proof that the Worker has a valid configuration (secret set): an unsigned upload
 * is refused as unauthorized (401), not as unavailable (503). */
export async function smokeHealth(t: SmokeTarget): Promise<void> {
  const health = await t.fetch(`${t.base}/v1/health`, { headers: { ...t.headers } });
  check(health.status === 200, 'health', `status ${String(health.status)}`);
  const body = (await health.json()) as unknown;
  check(JSON.stringify(body) === '{"ok":true}', 'health', 'unexpected body');
  check(
    health.headers.get('x-content-type-options') === 'nosniff',
    'health',
    'missing nosniff header',
  );

  const unsigned = await t.fetch(`${t.base}/v1/upload`, {
    method: 'POST',
    headers: { ...t.headers, 'content-type': 'application/json' },
    body: '{}',
  });
  check(
    unsigned.status === 401,
    'configuration',
    `an unsigned upload answered ${String(unsigned.status)}, expected 401 (503 means DROP_URL_KEY is missing or invalid)`,
  );
  await drain(unsigned);
}

/** Signed upload, GET (bytes and headers), DELETE by the uploader, then GET refused. */
export async function smokeRoundTrip(t: SmokeTarget): Promise<void> {
  const key = newSmokeKey();
  const data = randomBytes(4096) as Uint8Array<ArrayBuffer>;
  const stored = await store(t, key, data, nowSeconds() + 600);

  const get = await t.fetch(stored.getUrl, { headers: { ...t.headers } });
  check(get.status === 200, 'GET', `status ${String(get.status)}`);
  check(sameBytes(new Uint8Array(await get.arrayBuffer()), data), 'GET', 'bytes differ');
  check(get.headers.get('content-disposition') === 'attachment', 'GET', 'not an attachment');
  check(
    get.headers.get('content-type') === 'application/octet-stream',
    'GET',
    'unexpected content type',
  );

  const removed = await remove(t, key, stored.objectId);
  check(removed.status === 204, 'DELETE', `status ${String(removed.status)}`);
  await drain(removed);

  const gone = await t.fetch(stored.getUrl, { headers: { ...t.headers } });
  check(gone.status === 404, 'GET after DELETE', `status ${String(gone.status)}`);
  await drain(gone);
}

/** An object stored with a short expiry is served before expiresAt and refused (410) after it. */
export async function smokeExpiredGet(t: SmokeTarget, ttlSeconds = 3): Promise<void> {
  const key = newSmokeKey();
  const data = randomBytes(1024) as Uint8Array<ArrayBuffer>;
  const stored = await store(t, key, data, nowSeconds() + ttlSeconds);

  const early = await t.fetch(stored.getUrl, { headers: { ...t.headers } });
  check(early.status === 200, 'GET before expiry', `status ${String(early.status)}`);
  await drain(early);

  // Wait past expiresAt (as the Worker reported it) with a margin for clock skew.
  const waitMs = Math.max(0, (stored.expiresAt - nowSeconds() + 2) * 1000);
  await t.sleep(waitMs);

  const late = await t.fetch(stored.getUrl, { headers: { ...t.headers } });
  check(late.status === 410, 'GET after expiry', `status ${String(late.status)}`);
  const body = (await late.json()) as { error?: unknown };
  check(body.error === 'expired', 'GET after expiry', 'error is not "expired"');

  // Clean up; the lifecycle rule removes anything left behind.
  await drain(await remove(t, key, stored.objectId));
}
