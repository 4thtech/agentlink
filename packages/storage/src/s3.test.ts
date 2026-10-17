// M1-6a: S3-compatible adapter (07 §5.2, 04 §4) over aws4fetch, against an in-memory fake endpoint.
import { describe, expect, it } from 'vitest';
import { encodeHex, sha256 } from '@agentlink/crypto';
import {
  MAX_PRESIGN_SECONDS,
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

  it('refuses objects above the single-PUT limit (multipart is M1-6b)', async () => {
    const { adapter, fake } = setup();
    expect(S3_MAX_SINGLE_PUT_BYTES).toBe(64 * 1024 * 1024);
    await expect(
      adapter.put(bytes(1), { size: S3_MAX_SINGLE_PUT_BYTES + 1, expiresAt: inADay }),
    ).rejects.toMatchObject({ code: 'too_large' });
    expect(fake.requests).toHaveLength(0);
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
    expect(text).not.toContain('agentlink/');
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
