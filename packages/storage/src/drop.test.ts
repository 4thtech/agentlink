// M1-6c (D-48): the encrypted-drop adapter against a scripted drop behind an injected fetch (07 §5.4,
// 04 §4). The real Worker round trips run under Miniflare in drop.worker.test.ts; here every
// response, including hostile ones, is under the test's control: off-origin targets, typed limit
// errors, transient refusals, expired links, response text that must never be echoed, and the log
// canary (I-7).
import { describe, expect, it } from 'vitest';
import {
  decodeUtf8,
  encodeBase64url,
  encodeHex,
  sha256,
  type DropAuthRequest,
} from '@4thtech-io/crypto';
import { captureOutput } from '@4thtech-io/log/testing';
import {
  DROP_DEFAULT_ENDPOINT,
  DROP_MAX_CIPHERTEXT_BYTES,
  StorageError,
  createDropAdapter,
  putEncrypted,
  type DropAdapterConfig,
  type DropSigner,
  type StoredObject,
} from './index.js';

const ORIGIN = 'https://drop.example.com';
const NOW = new Date('2026-10-18T12:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const DAY_MS = 86_400_000;
const inADay = new Date(NOW.getTime() + DAY_MS);
const OBJECT_ID = encodeBase64url(new Uint8Array(16).fill(0x42));
const MAC = encodeBase64url(new Uint8Array(32).fill(0x24));
const SIGNATURE = 'Nostr eyJjYW5hcnkiOiJkcm9wLXNpZ25hdHVyZS12YWx1ZSJ9';
const ECHO_SECRET = 'response-text-that-must-never-be-echoed';

const putUrl = (part: number, origin = ORIGIN): string =>
  `${origin}/v1/put/${OBJECT_ID}/${String(part)}?e=${String(NOW_S + 900)}&m=${MAC}`;
const getUrl = (expiresAt: number, origin = ORIGIN): string =>
  `${origin}/v1/get/${OBJECT_ID}?e=${String(expiresAt)}&m=${MAC}`;

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly redirect: RequestRedirect;
  readonly body: Uint8Array;
}

type Script = (req: Seen) => Response | undefined;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A scripted drop: the default answers a single-PUT upload; `script` overrides any request. */
function fakeDrop(script?: Script) {
  const requests: Seen[] = [];
  const signed: DropAuthRequest[] = [];
  const objects = new Map<string, Uint8Array>();
  let objectExpiry = 0;
  const signer: DropSigner = {
    async signDropRequest(request, createdAt) {
      expect(createdAt).toBe(NOW_S);
      signed.push(request);
      return SIGNATURE;
    },
  };
  const fetch = async (request: Request): Promise<Response> => {
    const body = new Uint8Array(await request.arrayBuffer());
    const seen: Seen = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      redirect: request.redirect,
      body,
    };
    requests.push(seen);
    const scripted = script?.(seen);
    if (scripted !== undefined) return scripted;
    const path = new URL(request.url).pathname;
    if (path === '/v1/upload') {
      const parsed = JSON.parse(decodeUtf8(body)) as { expiresAt: number };
      objectExpiry = parsed.expiresAt;
      return json(201, {
        objectId: OBJECT_ID,
        uploadUrl: putUrl(0),
        expiresAt: parsed.expiresAt,
        uploadExpiresAt: NOW_S + 900,
      });
    }
    if (path.startsWith('/v1/put/')) {
      objects.set(OBJECT_ID, body);
      return json(201, { part: 0, size: body.length });
    }
    if (path.endsWith('/commit')) {
      return json(200, { getUrl: getUrl(objectExpiry), expiresAt: objectExpiry });
    }
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    return json(404, { error: 'not_found' });
  };
  return { requests, signed, objects, signer, fetch };
}

function setup(script?: Script, overrides: Partial<DropAdapterConfig> = {}) {
  const drop = fakeDrop(script);
  const adapter = createDropAdapter({
    endpoint: ORIGIN,
    signer: drop.signer,
    fetch: drop.fetch,
    now: () => NOW,
    ...overrides,
  });
  return { drop, adapter };
}

function ciphertext(size: number, seed = 3): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 7 + seed) & 0xff;
  return out;
}

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StorageError);
  return error;
}

describe('drop adapter: configuration (04 §4 SSRF rules, IR-D48-1 F16)', () => {
  const base = (): Omit<DropAdapterConfig, 'endpoint'> => ({
    signer: fakeDrop().signer,
    fetch: async () => new Response(null, { status: 500 }),
  });

  it('defaults to the 4thTech drop and accepts a configured https endpoint', () => {
    expect(DROP_DEFAULT_ENDPOINT).toBe('https://drop.agentlink.4thtech.io');
    expect(createDropAdapter(base()).origin).toBe(DROP_DEFAULT_ENDPOINT);
    expect(createDropAdapter({ ...base(), endpoint: 'https://drop.staging.example.com/' }).origin).toBe(
      'https://drop.staging.example.com',
    );
    expect(DROP_MAX_CIPHERTEXT_BYTES).toBe(100 * 1024 * 1024);
  });

  it.each([
    ['http scheme', 'http://drop.example.com'],
    ['IPv4 literal', 'https://127.0.0.1'],
    ['IPv6 literal', 'https://[::1]'],
    ['numeric host', 'https://2130706433'],
    ['localhost', 'https://localhost'],
    ['local name', 'https://drop.internal'],
    ['userinfo', 'https://user:pw@drop.example.com'],
    ['path', 'https://drop.example.com/v1'],
    ['query', 'https://drop.example.com?x=1'],
    ['percent-encoding', 'https://drop%2eexample.com'],
    ['single label', 'https://drop'],
    ['empty', ''],
  ])('refuses a bad drop endpoint (%s) before any request', (_name, endpoint) => {
    let requests = 0;
    const config = {
      ...base(),
      endpoint,
      fetch: async () => {
        requests += 1;
        return new Response(null);
      },
    };
    let error: unknown;
    try {
      createDropAdapter(config);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: 'invalid_config' });
    expect(String((error as Error).message)).not.toContain(endpoint || '\u0000');
    expect(requests).toBe(0);
  });

  it('refuses a missing signer or fetch', () => {
    expect(() =>
      createDropAdapter({ ...base(), signer: undefined as unknown as DropSigner }),
    ).toThrow(expect.objectContaining({ code: 'invalid_config' }) as Error);
    expect(() =>
      createDropAdapter({ ...base(), fetch: undefined as unknown as DropAdapterConfig['fetch'] }),
    ).toThrow(expect.objectContaining({ code: 'invalid_config' }) as Error);
  });
});

describe('drop adapter: put, presignGet and delete', () => {
  it('uploads, commits with the hash of exactly the bytes sent, and returns the drop object', async () => {
    const { drop, adapter } = setup();
    const data = ciphertext(4_000);
    const obj = await adapter.put(data, { size: data.length, expiresAt: inADay });
    expect(obj).toMatchObject({ kind: 'drop', size: 4_000, sha256: encodeHex(sha256(data)) });
    expect(drop.objects.get(OBJECT_ID)).toEqual(data);
    expect(drop.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'POST /v1/upload',
      `PUT /v1/put/${OBJECT_ID}/0`,
      `POST /v1/o/${OBJECT_ID}/commit`,
    ]);
    // Redirects are never followed (04 §4).
    for (const r of drop.requests) expect(r.redirect).not.toBe('follow');
    const commit = JSON.parse(decodeUtf8(drop.requests[2]!.body)) as Record<string, unknown>;
    expect(commit.ciphertextSha256).toBe(obj.sha256);
    const url = await adapter.presignGet(obj, inADay);
    expect(url).toBe(getUrl(Math.floor(inADay.getTime() / 1000)));
  });

  it('sends nothing but size, expiry, hash, nonce and timestamp, signed in a header (07 §5.4)', async () => {
    const { drop, adapter } = setup();
    const data = ciphertext(2_048);
    const obj = await adapter.put(data, { size: data.length, expiresAt: inADay });
    await adapter.delete(obj);
    const signedBodies = drop.requests.filter((r) => r.method !== 'PUT');
    expect(signedBodies).toHaveLength(3);
    const keys = signedBodies.map((r) => Object.keys(JSON.parse(decodeUtf8(r.body)) as object).sort());
    expect(keys).toEqual([
      ['expiresAt', 'nonce', 'size', 'ts', 'v'],
      ['ciphertextSha256', 'nonce', 'objectId', 'ts', 'v'],
      ['nonce', 'objectId', 'ts', 'v'],
    ]);
    for (const r of signedBodies) {
      expect(r.headers.get('authorization')).toBe(SIGNATURE);
      expect(new URL(r.url).search).toBe('');
      const body = JSON.parse(decodeUtf8(r.body)) as { v: number; ts: number; nonce: string };
      expect(body.v).toBe(1);
      expect(body.ts).toBe(NOW_S);
      expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
    // The signer covers the exact URL, method and body bytes that were sent.
    expect(drop.signed).toHaveLength(3);
    for (const [i, r] of signedBodies.entries()) {
      expect(drop.signed[i]).toMatchObject({ method: r.method, url: r.url });
      expect(drop.signed[i]!.body).toEqual(r.body);
    }
    // Every nonce is fresh.
    const nonces = signedBodies.map((r) => (JSON.parse(decodeUtf8(r.body)) as { nonce: string }).nonce);
    expect(new Set(nonces).size).toBe(3);
    // The PUT carries the ciphertext only: no signature, no metadata headers.
    const put = drop.requests.find((r) => r.method === 'PUT')!;
    expect(put.headers.get('authorization')).toBeNull();
    expect([...put.headers.keys()].filter((k) => k.startsWith('x-'))).toEqual([]);
  });

  it('clamps the requested expiry to the drop maximum of 7 days', async () => {
    const { drop, adapter } = setup();
    await adapter.put(ciphertext(10), {
      size: 10,
      expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    });
    const upload = JSON.parse(decodeUtf8(drop.requests[0]!.body)) as { expiresAt: number };
    expect(upload.expiresAt).toBe(NOW_S + 7 * 86_400);
  });

  it('PUTs each part to its own target when the drop grants a multipart upload', async () => {
    const sizes = [6, 6, 3];
    const data = ciphertext(15);
    const { drop, adapter } = setup((req) => {
      if (new URL(req.url).pathname === '/v1/upload') {
        return json(201, {
          objectId: OBJECT_ID,
          parts: sizes.map((size, i) => ({ part: i + 1, size, uploadUrl: putUrl(i + 1) })),
          expiresAt: NOW_S + 86_400,
          uploadExpiresAt: NOW_S + 900,
        });
      }
      return undefined;
    });
    const obj = await adapter.put(new Blob([data]).stream(), { size: 15, expiresAt: inADay });
    const puts = drop.requests.filter((r) => r.method === 'PUT');
    expect(puts.map((r) => new URL(r.url).pathname.split('/').pop())).toEqual(['1', '2', '3']);
    expect(puts.map((r) => r.body.length)).toEqual(sizes);
    expect(obj.sha256).toBe(encodeHex(sha256(data)));
  });

  it('refuses a size mismatch, cancelling the upload it was granted', async () => {
    const { drop, adapter } = setup();
    const error = await codeOf(
      adapter.put(new Blob([ciphertext(9)]).stream(), { size: 10, expiresAt: inADay }),
    );
    expect(error).toMatchObject({ code: 'size_mismatch' });
    expect(drop.requests.some((r) => r.url.endsWith('/commit'))).toBe(false);
  });

  it('refuses a size above the configured drop limit before any request', async () => {
    const { drop, adapter } = setup(undefined, { maxBytes: 1_000 });
    const error = await codeOf(adapter.put(ciphertext(1_001), { size: 1_001, expiresAt: inADay }));
    expect(error).toMatchObject({ code: 'needs_setup', limit: 'size' });
    expect(drop.requests).toHaveLength(0);
  });

  it('presign never extends the expiry fixed at upload', async () => {
    const { adapter } = setup();
    const obj = await adapter.put(ciphertext(10), { size: 10, expiresAt: inADay });
    const granted = await adapter.presign(obj, new Date(NOW.getTime() + 5 * DAY_MS));
    expect(granted.expiresAt.getTime()).toBe(Math.floor(inADay.getTime() / 1000) * 1000);
  });

  it('refuses an expired link (presignGet after the object expiry)', async () => {
    let at = NOW;
    const drop = fakeDrop();
    const adapter = createDropAdapter({
      endpoint: ORIGIN,
      signer: { signDropRequest: async () => SIGNATURE },
      fetch: drop.fetch,
      now: () => at,
    });
    const obj = await adapter.put(ciphertext(10), { size: 10, expiresAt: inADay });
    at = new Date(inADay.getTime() + 1_000);
    const error = await codeOf(adapter.presignGet(obj, new Date(at.getTime() + DAY_MS)));
    expect(error).toMatchObject({ code: 'expired' });
  });

  it('refuses an object of another storage or an off-origin locator for presign and delete', async () => {
    const { adapter, drop } = setup();
    const foreign: StoredObject[] = [
      { kind: 's3', locator: getUrl(NOW_S + 3600), size: 1, sha256: '0'.repeat(64) },
      { kind: 'drop', locator: getUrl(NOW_S + 3600, 'https://evil.example.com'), size: 1, sha256: '0'.repeat(64) },
      { kind: 'drop', locator: getUrl(NOW_S + 3600).replace('https:', 'http:'), size: 1, sha256: '0'.repeat(64) },
      { kind: 'drop', locator: `${ORIGIN}/v1/put/${OBJECT_ID}/0?e=1&m=${MAC}`, size: 1, sha256: '0'.repeat(64) },
      { kind: 'drop', locator: `${getUrl(NOW_S + 3600)}&x=1`, size: 1, sha256: '0'.repeat(64) },
    ];
    for (const obj of foreign) {
      expect(await codeOf(adapter.presignGet(obj, inADay))).toMatchObject({ code: 'invalid_argument' });
      expect(await codeOf(adapter.delete(obj))).toMatchObject({ code: 'invalid_argument' });
    }
    expect(drop.requests).toHaveLength(0);
  });

  it('deletes with a signed DELETE; a missing object counts as deleted', async () => {
    let status = 204;
    const { adapter, drop } = setup((req) =>
      req.method === 'DELETE' ? new Response(null, { status }) : undefined,
    );
    const obj = await adapter.put(ciphertext(10), { size: 10, expiresAt: inADay });
    await adapter.delete(obj);
    const del = drop.requests.at(-1)!;
    expect(del.method).toBe('DELETE');
    expect(new URL(del.url).pathname).toBe(`/v1/o/${OBJECT_ID}`);
    status = 404;
    await adapter.delete(obj);
    status = 403;
    expect(await codeOf(adapter.delete(obj))).toMatchObject({ code: 'delete_failed', status: 403 });
  });
});

describe('drop adapter: SSRF and response checks (04 §4)', () => {
  it.each([
    ['another host', putUrl(0, 'https://evil.example.com')],
    ['http', putUrl(0).replace('https:', 'http:')],
    ['a port', putUrl(0, 'https://drop.example.com:8443')],
    ['userinfo', putUrl(0, 'https://x@drop.example.com')],
    ['a get path', getUrl(NOW_S + 60)],
    ['another object', putUrl(0).replace(OBJECT_ID, encodeBase64url(new Uint8Array(16)))],
    ['an extra query parameter', `${putUrl(0)}&x=1`],
    ['a fragment', `${putUrl(0)}#f`],
    ['not a URL', 'not a url'],
  ])('refuses an uploadUrl on %s and never PUTs the ciphertext', async (_name, uploadUrl) => {
    const { drop, adapter } = setup((req) =>
      new URL(req.url).pathname === '/v1/upload'
        ? json(201, { objectId: OBJECT_ID, uploadUrl, expiresAt: NOW_S + 3600, uploadExpiresAt: NOW_S + 900 })
        : undefined,
    );
    const error = await codeOf(adapter.put(ciphertext(10), { size: 10, expiresAt: inADay }));
    expect(error).toMatchObject({ code: 'invalid_response' });
    expect((error as Error).message).not.toContain('evil');
    expect(drop.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
    expect(drop.requests.every((r) => new URL(r.url).origin === ORIGIN)).toBe(true);
  });

  it.each([
    ['another host', getUrl(NOW_S + 3600, 'https://evil.example.com')],
    ['http', getUrl(NOW_S + 3600).replace('https:', 'http:')],
    ['another object', getUrl(NOW_S + 3600).replace(OBJECT_ID, encodeBase64url(new Uint8Array(16)))],
    ['a put path', putUrl(0)],
  ])('refuses a getUrl on %s from the commit', async (_name, url) => {
    const { adapter } = setup((req) =>
      req.url.endsWith('/commit') ? json(200, { getUrl: url, expiresAt: NOW_S + 3600 }) : undefined,
    );
    const error = await codeOf(adapter.put(ciphertext(10), { size: 10, expiresAt: inADay }));
    expect(error).toMatchObject({ code: 'invalid_response' });
  });

  it('does not follow a redirect', async () => {
    const { drop, adapter } = setup((req) =>
      new URL(req.url).pathname === '/v1/upload'
        ? new Response(null, { status: 307, headers: { location: 'https://evil.example.com/v1/upload' } })
        : undefined,
    );
    const error = await codeOf(adapter.put(ciphertext(10), { size: 10, expiresAt: inADay }));
    expect(error).toMatchObject({ code: 'upload_failed' });
    expect(drop.requests).toHaveLength(1);
  });

  it('refuses an oversized or malformed grant without echoing it', async () => {
    const huge = `{"objectId":"${OBJECT_ID}","pad":"${'x'.repeat(100_000)}"}`;
    for (const body of [huge, `not json ${ECHO_SECRET}`, '[]', '{"objectId":1}']) {
      const { adapter } = setup((req) =>
        new URL(req.url).pathname === '/v1/upload' ? new Response(body, { status: 201 }) : undefined,
      );
      const error = await codeOf(adapter.put(ciphertext(10), { size: 10, expiresAt: inADay }));
      expect(error).toMatchObject({ code: 'invalid_response' });
      expect((error as Error).message).not.toContain(ECHO_SECRET);
    }
  });
});

describe('drop adapter: typed errors (07 §5.4 Limits, IR-D48-1 F10)', () => {
  const upload = (response: () => Response) =>
    setup((req) => (new URL(req.url).pathname === '/v1/upload' ? response() : undefined));

  it.each([
    ['size', 413],
    ['quota', 403],
  ])('maps limit %s to needs_setup', async (limit, status) => {
    const { adapter } = upload(() => json(status, { error: 'limit', limit, note: ECHO_SECRET }));
    const error = await codeOf(adapter.put(ciphertext(10), { size: 10, expiresAt: inADay }));
    expect(error).toMatchObject({ code: 'needs_setup', limit, status });
    expect((error as Error).message).not.toContain(ECHO_SECRET);
  });

  it('maps a 429 to the retryable rate_limited, never needs_setup', async () => {
    const { adapter } = upload(() =>
      json(429, { error: 'rate_limited', retryable: true }, { 'retry-after': '120' }),
    );
    const error = await codeOf(adapter.put(ciphertext(10), { size: 10, expiresAt: inADay }));
    expect(error).toMatchObject({ code: 'rate_limited', retryAfter: 120, status: 429 });
  });

  it('maps a 503 to the retryable unavailable, never needs_setup', async () => {
    const { adapter } = upload(() =>
      json(503, { error: 'unavailable', retryable: true }, { 'retry-after': '60' }),
    );
    const error = await codeOf(adapter.put(ciphertext(10), { size: 10, expiresAt: inADay }));
    expect(error).toMatchObject({ code: 'unavailable', retryAfter: 60, status: 503 });
  });

  it('caps a hostile Retry-After and ignores a malformed one', async () => {
    const big = upload(() => json(429, { error: 'rate_limited' }, { 'retry-after': '99999999' }));
    expect(await codeOf(big.adapter.put(ciphertext(10), { size: 10, expiresAt: inADay }))).toMatchObject(
      { code: 'rate_limited', retryAfter: 3600 },
    );
    const bad = upload(() => json(503, { error: 'unavailable' }, { 'retry-after': 'soon' }));
    const error = await codeOf(bad.adapter.put(ciphertext(10), { size: 10, expiresAt: inADay }));
    expect(error).toMatchObject({ code: 'unavailable' });
    expect((error as StorageError).retryAfter).toBeUndefined();
  });

  it('maps a commit hash mismatch to integrity_failed', async () => {
    const { adapter } = setup((req) =>
      req.url.endsWith('/commit') ? json(422, { error: 'hash_mismatch' }) : undefined,
    );
    const error = await codeOf(adapter.put(ciphertext(10), { size: 10, expiresAt: inADay }));
    expect(error).toMatchObject({ code: 'integrity_failed', status: 422 });
  });

  it('maps any other refusal to upload_failed with the status only', async () => {
    const { adapter } = upload(() => new Response(`<html>${ECHO_SECRET}</html>`, { status: 500 }));
    const error = await codeOf(adapter.put(ciphertext(10), { size: 10, expiresAt: inADay }));
    expect(error).toMatchObject({ code: 'upload_failed', status: 500 });
    expect((error as Error).message).not.toContain(ECHO_SECRET);
  });

  it('replaces a network error, which can carry the URL, with a fixed one', async () => {
    const { adapter } = setup(undefined, {
      fetch: async (req) => {
        throw new TypeError(`fetch failed: ${req.url}`);
      },
    });
    const error = await codeOf(adapter.put(ciphertext(10), { size: 10, expiresAt: inADay }));
    expect(error).toMatchObject({ code: 'network' });
    expect((error as Error).message).not.toContain(ORIGIN);
    expect((error as Error).cause).toBeUndefined();
  });

  it('maps a failed signer to credentials_unavailable without its message', async () => {
    const { adapter } = setup(undefined, {
      signer: {
        signDropRequest: async () => {
          throw new Error(`keystore locked ${ECHO_SECRET}`);
        },
      },
    });
    const error = await codeOf(adapter.put(ciphertext(10), { size: 10, expiresAt: inADay }));
    expect(error).toMatchObject({ code: 'credentials_unavailable' });
    expect((error as Error).message).not.toContain(ECHO_SECRET);
  });
});

describe('drop adapter: one encryption pass per file (07 §5.4)', () => {
  it('putEncrypted reads the plaintext once and uploads exactly the bytes it encrypted', async () => {
    const { drop, adapter } = setup();
    const plaintext = new TextEncoder().encode('PLAINTEXT-MARKER '.repeat(4_000));
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        pulls += 1;
        controller.enqueue(plaintext);
        controller.close();
      },
    });
    const result = await putEncrypted(adapter, source, {
      plaintextSize: plaintext.length,
      expiresAt: inADay,
    });
    expect(pulls).toBe(1);
    const stored = drop.objects.get(OBJECT_ID)!;
    expect(encodeHex(sha256(stored))).toBe(result.ciphertextSha256);
    expect(drop.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    // Ciphertext only: no plaintext marker and no file key anywhere in what reached the drop.
    const fileKeyHex = encodeHex(result.fileKey);
    const fileKeyB64 = encodeBase64url(result.fileKey);
    for (const r of drop.requests) {
      const text = new TextDecoder().decode(r.body);
      expect(text).not.toContain('PLAINTEXT-MARKER');
      expect(text).not.toContain(fileKeyHex);
      expect(text).not.toContain(fileKeyB64);
      expect(r.url).not.toContain(fileKeyB64);
      expect(includesBytes(r.body, result.fileKey)).toBe(false);
    }
  });

  it('a failed upload is never retried with the same bytes under a new grant by the adapter', async () => {
    let uploads = 0;
    const { drop, adapter } = setup((req) => {
      if (new URL(req.url).pathname === '/v1/upload') uploads += 1;
      if (req.method === 'PUT') return json(400, { error: 'length_mismatch' });
      return undefined;
    });
    const error = await codeOf(
      putEncrypted(adapter, ciphertext(5_000), { plaintextSize: 5_000, expiresAt: inADay }),
    );
    expect(error).toMatchObject({ code: 'upload_failed' });
    expect(uploads).toBe(1);
    expect(drop.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
  });
});

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

describe('drop adapter: log canary (I-7, 04 §4)', () => {
  it('logs no URL, object ID, MAC, signature, nonce or response text, on success or failure', async () => {
    let failing = false;
    const seenUrls: string[] = [];
    const nonces: string[] = [];
    const lines = await captureOutput(async ({ logger }) => {
      const drop = fakeDrop((req) => {
        if (req.method !== 'PUT') {
          nonces.push((JSON.parse(decodeUtf8(req.body)) as { nonce: string }).nonce);
        }
        if (failing) return json(403, { error: 'forbidden', echo: ECHO_SECRET });
        return undefined;
      });
      const adapter = createDropAdapter({
        endpoint: ORIGIN,
        signer: drop.signer,
        fetch: async (req) => {
          seenUrls.push(req.url);
          return drop.fetch(req);
        },
        now: () => NOW,
        logger,
      });
      const obj = await adapter.put(ciphertext(64), { size: 64, expiresAt: inADay });
      seenUrls.push(await adapter.presignGet(obj, inADay));
      await adapter.delete(obj);
      failing = true;
      await adapter.put(ciphertext(64), { size: 64, expiresAt: inADay }).catch(() => undefined);
      await adapter.delete(obj).catch(() => undefined);
    });
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.map((l) => l.line).join('\n');
    for (const needle of [
      ...seenUrls,
      ...nonces,
      ORIGIN,
      'drop.example.com',
      OBJECT_ID,
      MAC,
      SIGNATURE,
      SIGNATURE.slice('Nostr '.length),
      ECHO_SECRET,
      '/v1/',
      '?e=',
      '&m=',
    ]) {
      expect(all).not.toContain(needle);
    }
  });
});
