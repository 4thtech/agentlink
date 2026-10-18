// M1-6a: S3-compatible adapter (07 §5.2, 04 §4) over aws4fetch, against an in-memory fake endpoint.
import { describe, expect, it } from 'vitest';
import { encodeHex, sha256 } from '@4thtech-io/crypto';
import {
  MAX_PRESIGN_SECONDS,
  MULTIPART_DEFAULT_PART_BYTES,
  MULTIPART_MAX_BYTES,
  S3_MAX_SINGLE_PUT_BYTES,
  StorageError,
  createS3Adapter,
  type S3AdapterConfig,
  type S3Credentials,
} from './index.js';
import {
  BUCKET,
  DAY_MS,
  ENDPOINT,
  NOW,
  bytes,
  fakeEndpoint,
  streamOf,
  testPrefix,
  type FakeEndpoint,
} from './fake-s3.fixture.js';
import { chunked, fakeMultipartS3, patternBytes } from './multipart.fixture.js';

const ACCESS_KEY_ID = 'AKIDEXAMPLETESTONLY';
const SECRET = 'test-secret-access-key-never-logged';

function setup(
  over: Partial<S3AdapterConfig> = {},
  fake: FakeEndpoint = fakeEndpoint(),
  creds: Partial<S3Credentials> = {},
) {
  const storagePrefix = testPrefix();
  const adapter = createS3Adapter({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    storagePrefix,
    credentials: async () => ({ accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET, ...creds }),
    fetch: fake.fetch,
    now: () => NOW,
    ...over,
  });
  return { adapter, fake, storagePrefix };
}

const inADay = new Date(NOW.getTime() + DAY_MS);

describe('S3 adapter: put', () => {
  it('PUTs the ciphertext under agentlink/<storagePrefix>/<random>, signed, with no metadata', async () => {
    const { adapter, fake, storagePrefix } = setup();
    const ct = bytes(2048, 9);
    const obj = await adapter.put(ct, { size: ct.length, expiresAt: inADay });

    expect(adapter.kind).toBe('s3');
    expect(obj.kind).toBe('s3');
    expect(obj.size).toBe(2048);
    expect(obj.sha256).toBe(encodeHex(sha256(ct)));
    expect(obj.locator).toMatch(new RegExp(`^agentlink/${storagePrefix}/[A-Za-z0-9_-]{22}$`));

    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0]!;
    expect(req.method).toBe('PUT');
    expect(req.url).toBe(`${ENDPOINT}/${BUCKET}/${obj.locator}`);
    expect(req.body).toEqual(ct);
    expect(req.redirect).toBe('error');
    expect(req.headers.get('authorization')).toMatch(
      new RegExp(`^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY_ID}/20261017/auto/s3/aws4_request`),
    );
    expect(req.headers.get('x-amz-content-sha256')).toBe(obj.sha256);
    expect(req.headers.get('content-type')).toBe('application/octet-stream');
    for (const [name] of req.headers) {
      expect(name.startsWith('x-amz-meta-')).toBe(false);
    }
  });

  it('never puts the agent ID, a file name or other metadata on the object', async () => {
    const { adapter, fake } = setup();
    await adapter.put(bytes(16), { size: 16, expiresAt: inADay });
    const req = fake.requests[0]!;
    expect(req.headers.get('content-disposition')).toBeNull();
    expect(new URL(req.url).search).toBe('');
  });

  it('uses a fresh random key per object', async () => {
    const { adapter } = setup();
    const a = await adapter.put(bytes(16), { size: 16, expiresAt: inADay });
    const b = await adapter.put(bytes(16), { size: 16, expiresAt: inADay });
    expect(a.locator).not.toBe(b.locator);
  });

  it('accepts a stream and hashes what it sends', async () => {
    const { adapter, fake } = setup();
    const obj = await adapter.put(streamOf(bytes(100, 1), bytes(50, 2)), {
      size: 150,
      expiresAt: inADay,
    });
    const sent = fake.requests[0]!.body;
    expect(sent.length).toBe(150);
    expect(obj.sha256).toBe(encodeHex(sha256(sent)));
  });

  it('refuses a size mismatch before any request', async () => {
    const { adapter, fake } = setup();
    await expect(
      adapter.put(streamOf(bytes(100), bytes(51)), { size: 150, expiresAt: inADay }),
    ).rejects.toMatchObject({ code: 'size_mismatch' });
    await expect(adapter.put(bytes(149), { size: 150, expiresAt: inADay })).rejects.toMatchObject({
      code: 'size_mismatch',
    });
    expect(fake.requests).toHaveLength(0);
  });

  // M1-6c (open question from #260): above the single-PUT limit, `put` routes to multipart upload
  // (07 §5.2) instead of refusing; only objects above the multipart maximum are too large.
  it('refuses objects above the multipart maximum before any request', async () => {
    const { adapter, fake } = setup();
    expect(S3_MAX_SINGLE_PUT_BYTES).toBe(64 * 1024 * 1024);
    await expect(
      adapter.put(bytes(1), { size: MULTIPART_MAX_BYTES + 1, expiresAt: inADay }),
    ).rejects.toMatchObject({ code: 'too_large' });
    expect(fake.requests).toHaveLength(0);
  });

  // Timeout: CI run 39164524348 timed out at the 20 s default on the loaded Linux runner (1.5 s on
  // macOS). Three SHA-256 passes over 64 MiB are inherent to the path under test (multipart's running
  // hash, the SigV4 payload hash of each part, the fake's ETag), plus the test's expected hash; the
  // data is a cheap fill instead of a PRNG. 90 s leaves margin over the measured CI time.
  it('routes a put above 64 MiB to multipart upload, reading at most one part ahead', async () => {
    const fake = fakeMultipartS3(BUCKET);
    const storagePrefix = testPrefix();
    const adapter = createS3Adapter({
      endpoint: ENDPOINT,
      bucket: BUCKET,
      storagePrefix,
      credentials: async () => ({ accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET }),
      fetch: fake.fetch,
      now: () => NOW,
    });
    const size = S3_MAX_SINGLE_PUT_BYTES + 1;
    const CHUNK = 1024 * 1024;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i += CHUNK) data.fill((i / CHUNK) & 0xff, i, i + CHUNK);
    data[size - 1] = 0xa5;

    // Structural memory check: when a part reaches the store, the source has been read at most
    // one chunk beyond the bytes of the parts sent so far, so no more than one part is buffered.
    let pulled = 0;
    let sent = 0;
    let maxAhead = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= size) {
          controller.close();
          return;
        }
        const end = Math.min(pulled + CHUNK, size);
        controller.enqueue(data.slice(pulled, end));
        pulled = end;
      },
    });
    const partSizes: number[] = [];
    fake.override = (req) => {
      if (req.method === 'PUT' && req.url.searchParams.has('partNumber')) {
        sent += req.body.length;
        partSizes.push(req.body.length);
        maxAhead = Math.max(maxAhead, pulled - sent);
      }
      return undefined;
    };

    const obj = await adapter.put(source, { size, expiresAt: inADay });
    const expected = encodeHex(sha256(data));
    expect(obj).toMatchObject({ kind: 's3', size, sha256: expected });
    expect(obj.locator).toMatch(new RegExp(`^agentlink/${storagePrefix}/[A-Za-z0-9_-]{22}$`));
    expect(fake.objects.get(obj.locator)?.length).toBe(size);
    const methods = fake.requests.map((r) => r.method);
    expect(methods[0]).toBe('POST');
    expect(partSizes.length).toBeGreaterThan(1);
    expect(partSizes.reduce((n, p) => n + p, 0)).toBe(size);
    for (const part of partSizes) expect(part).toBeLessThanOrEqual(MULTIPART_DEFAULT_PART_BYTES);
    expect(maxAhead).toBeLessThanOrEqual(CHUNK);
    expect(fake.uploads.size).toBe(0);
    // The object it stored is the adapter's own: presign and delete accept it.
    await expect(adapter.presignGet(obj, inADay)).resolves.toMatch(/^https:/);
  }, 90_000);

  it('aborts a routed multipart upload when a part fails, leaving no open upload (IR-M1-6c-1 L3)', async () => {
    const fake = fakeMultipartS3(BUCKET);
    const adapter = createS3Adapter({
      endpoint: ENDPOINT,
      bucket: BUCKET,
      storagePrefix: testPrefix(),
      credentials: async () => ({ accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET }),
      fetch: fake.fetch,
      now: () => NOW,
    });
    let parts = 0;
    fake.override = (req) => {
      if (req.method === 'PUT' && req.url.searchParams.has('partNumber')) {
        parts += 1;
        if (parts === 2) return new Response(`<Error>${SECRET}</Error>`, { status: 500 });
      }
      return undefined;
    };
    const size = S3_MAX_SINGLE_PUT_BYTES + 1;
    const error = await adapter
      .put(chunked(patternBytes(size, 6), 1024 * 1024), { size, expiresAt: inADay })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as Error).message).not.toContain(SECRET);
    expect(fake.uploads.size).toBe(0);
    expect(fake.objects.size).toBe(0);
    expect(
      fake.requests.some((r) => r.method === 'DELETE' && r.url.searchParams.has('uploadId')),
    ).toBe(true);
  });

  it('keeps a put of exactly 64 MiB a single PUT', async () => {
    const { adapter, fake } = setup();
    const size = S3_MAX_SINGLE_PUT_BYTES;
    await adapter.put(new Uint8Array(size), { size, expiresAt: inADay });
    expect(fake.requests.map((r) => r.method)).toEqual(['PUT']);
  });

  it('refuses an expiry in the past', async () => {
    const { adapter } = setup();
    await expect(
      adapter.put(bytes(4), { size: 4, expiresAt: new Date(NOW.getTime() - 1) }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('maps an HTTP error to upload_failed with the status only, never the response text', async () => {
    const fake = fakeEndpoint(
      () => new Response(`<Error>SignatureDoesNotMatch ${SECRET}</Error>`, { status: 403 }),
    );
    const { adapter } = setup({}, fake);
    const err = await adapter.put(bytes(4), { size: 4, expiresAt: inADay }).catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err).toMatchObject({ code: 'upload_failed', status: 403 });
    const text = `${err.message} ${String(err.stack)} ${JSON.stringify(err)}`;
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('SignatureDoesNotMatch');
    // No object key (the stack holds file paths, so match the key shape, not a bare `agentlink/`).
    expect(text).not.toMatch(/agentlink\/[A-Za-z0-9_-]{22}\//);
    expect(text).not.toContain(ENDPOINT);
    expect(err.cause).toBeUndefined();
  });

  it('maps a network failure to network, without the URL', async () => {
    const fake = fakeEndpoint((req) => {
      throw new TypeError(`fetch failed for ${req.url}`);
    });
    const { adapter } = setup({}, fake);
    const err = await adapter.put(bytes(4), { size: 4, expiresAt: inADay }).catch((e) => e);
    expect(err).toMatchObject({ code: 'network' });
    expect(err.message).not.toContain(ENDPOINT);
    expect(err.cause).toBeUndefined();
  });

  it('maps a failing credentials provider to credentials_unavailable', async () => {
    const { adapter, fake } = setup({
      credentials: async () => {
        throw new Error(`keychain says ${SECRET}`);
      },
    });
    const err = await adapter.put(bytes(4), { size: 4, expiresAt: inADay }).catch((e) => e);
    expect(err).toMatchObject({ code: 'credentials_unavailable' });
    expect(err.message).not.toContain(SECRET);
    expect(err.cause).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses expired temporary credentials before any request', async () => {
    const { adapter, fake } = setup({}, fakeEndpoint(), {
      sessionToken: 'tok',
      expiresAt: new Date(NOW.getTime() - 1000),
    });
    await expect(adapter.put(bytes(4), { size: 4, expiresAt: inADay })).rejects.toMatchObject({
      code: 'credentials_expired',
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('sends the session token of temporary credentials as a signed header', async () => {
    const { adapter, fake } = setup({}, fakeEndpoint(), {
      sessionToken: 'session-token-value',
      expiresAt: new Date(NOW.getTime() + DAY_MS),
    });
    await adapter.put(bytes(4), { size: 4, expiresAt: inADay });
    expect(fake.requests[0]!.headers.get('x-amz-security-token')).toBe('session-token-value');
  });
});

describe('S3 adapter: presignGet', () => {
  it('returns a SigV4 presigned GET for the object, valid until expiresAt', async () => {
    const { adapter, fake } = setup();
    const obj = await adapter.put(bytes(32, 5), { size: 32, expiresAt: inADay });
    const url = new URL(await adapter.presignGet(obj, inADay));
    expect(`${url.origin}${url.pathname}`).toBe(`${ENDPOINT}/${BUCKET}/${obj.locator}`);
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('86400');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261017T120000Z');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      `${ACCESS_KEY_ID}/20261017/auto/s3/aws4_request`,
    );
    // Presigning is local: no request.
    expect(fake.requests).toHaveLength(1);
  });

  it('clamps an expiry beyond 7 days to 7 days (SigV4 limit, 04 §4)', async () => {
    const { adapter } = setup();
    const obj = await adapter.put(bytes(4), { size: 4, expiresAt: inADay });
    expect(MAX_PRESIGN_SECONDS).toBe(604_800);
    const far = new Date(NOW.getTime() + 30 * DAY_MS);
    const presigned = await adapter.presign(obj, far);
    expect(new URL(presigned.url).searchParams.get('X-Amz-Expires')).toBe('604800');
    expect(presigned.expiresAt.getTime()).toBe(NOW.getTime() + 7 * DAY_MS);
    const viaInterface = new URL(await adapter.presignGet(obj, far));
    expect(viaInterface.searchParams.get('X-Amz-Expires')).toBe('604800');
  });

  it('clamps to the expiry of temporary credentials', async () => {
    const credsExpire = new Date(NOW.getTime() + 3_600_000);
    const { adapter } = setup({}, fakeEndpoint(), {
      sessionToken: 'tok',
      expiresAt: credsExpire,
    });
    const obj = await adapter.put(bytes(4), { size: 4, expiresAt: inADay });
    const presigned = await adapter.presign(obj, inADay);
    const url = new URL(presigned.url);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('tok');
    expect(presigned.expiresAt).toEqual(credsExpire);
  });

  it('refuses an expiry that is not in the future', async () => {
    const { adapter } = setup();
    const obj = await adapter.put(bytes(4), { size: 4, expiresAt: inADay });
    await expect(adapter.presignGet(obj, NOW)).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(adapter.presignGet(obj, new Date(Number.NaN))).rejects.toMatchObject({
      code: 'invalid_argument',
    });
  });

  it('refuses an object that is not one of its own keys', async () => {
    const { adapter } = setup();
    const obj = await adapter.put(bytes(4), { size: 4, expiresAt: inADay });
    const foreign = obj.locator.replace(/^agentlink\/[^/]+\//, `agentlink/${testPrefix()}/`);
    for (const bad of [
      { ...obj, kind: 'inline' },
      { ...obj, locator: foreign },
      { ...obj, locator: `${obj.locator}/../../other` },
      { ...obj, locator: 'agentlink/../secret' },
      { ...obj, locator: `${obj.locator}?x=1` },
    ]) {
      await expect(adapter.presignGet(bad, inADay)).rejects.toMatchObject({
        code: 'invalid_argument',
      });
      await expect(adapter.delete(bad)).rejects.toMatchObject({ code: 'invalid_argument' });
    }
  });
});

describe('S3 adapter: delete and round trip', () => {
  it('upload, presign, download, delete against the fake endpoint', async () => {
    const { adapter, fake } = setup();
    const ct = bytes(512, 0xab);
    const obj = await adapter.put(ct, { size: ct.length, expiresAt: inADay });
    const url = await adapter.presignGet(obj, inADay);
    const got = await fake.fetch(new Request(url));
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(ct);
    await adapter.delete(obj);
    const del = fake.requests.at(-1)!;
    expect(del.method).toBe('DELETE');
    expect(del.url).toBe(`${ENDPOINT}/${BUCKET}/${obj.locator}`);
    expect(del.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(del.redirect).toBe('error');
    expect(fake.objects.size).toBe(0);
  });

  it('treats a missing object as deleted', async () => {
    const fake = fakeEndpoint((req) =>
      req.method === 'DELETE'
        ? new Response(null, { status: 404 })
        : new Response(null, { status: 200 }),
    );
    const { adapter } = setup({}, fake);
    const obj = await adapter.put(bytes(4), { size: 4, expiresAt: inADay });
    await expect(adapter.delete(obj)).resolves.toBeUndefined();
  });

  it('maps a delete error to delete_failed with the status only', async () => {
    const fake = fakeEndpoint((req) =>
      req.method === 'DELETE'
        ? new Response('internal detail', { status: 500 })
        : new Response(null, { status: 200 }),
    );
    const { adapter } = setup({}, fake);
    const obj = await adapter.put(bytes(4), { size: 4, expiresAt: inADay });
    const err = await adapter.delete(obj).catch((e) => e);
    expect(err).toMatchObject({ code: 'delete_failed', status: 500 });
    expect(err.message).not.toContain('internal detail');
    expect(err.message).not.toContain(obj.locator);
  });
});

describe('S3 adapter: configuration', () => {
  it('refuses an invalid endpoint, bucket, region or prefix at creation', () => {
    const base = {
      endpoint: ENDPOINT,
      bucket: BUCKET,
      storagePrefix: testPrefix(),
      credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
    };
    for (const over of [
      { endpoint: 'http://s3.example.com' },
      { endpoint: 'https://127.0.0.1' },
      { bucket: 'Upper' },
      { bucket: 'a' },
      { bucket: 'has..dots' },
      { bucket: 'has/slash' },
      { region: 'us east' },
      { region: '' },
      { storagePrefix: '0x' + 'ab'.repeat(20) },
    ]) {
      expect(() => createS3Adapter({ ...base, ...over })).toThrow(
        expect.objectContaining({ code: 'invalid_config' }),
      );
    }
  });

  it('uses the given region in the signature', async () => {
    const { adapter } = setup({ region: 'eu-central-1' });
    const obj = await adapter.put(bytes(4), { size: 4, expiresAt: inADay });
    const url = new URL(await adapter.presignGet(obj, inADay));
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/eu-central-1/s3/');
  });
});
