// M1-6b part 1: multipart upload with abort and cleanup (07 §5.2, 04 §4, I-2, I-7), against an
// in-memory S3. The STREAM encryption wiring is part 2; here the input stands in for ALF1 ciphertext.
import { describe, expect, it } from 'vitest';
import { encodeHex, sha256 } from '@4thtech-io/crypto';
import { captureOutput } from '@4thtech-io/log/testing';
import {
  MULTIPART_DEFAULT_PART_BYTES,
  MULTIPART_MAX_BYTES,
  MULTIPART_MAX_PARTS,
  MULTIPART_MIN_PART_BYTES,
  StorageError,
  createS3Multipart,
  multipartPartSize,
  type S3MultipartConfig,
} from './index.js';
import { BUCKET, DAY_MS, ENDPOINT, NOW, testPrefix } from './fake-s3.fixture.js';
import {
  chunked,
  failingStream,
  fakeMultipartS3,
  patternBytes,
  type FakeMultipartS3,
} from './multipart.fixture.js';

const MiB = 1024 * 1024;
const ACCESS_KEY_ID = 'AKIDMULTIPARTTESTONLY';
const SECRET = 'multipart-secret-access-key-never-logged';
const inADay = new Date(NOW.getTime() + DAY_MS);

function setup(
  over: Partial<S3MultipartConfig> = {},
  fake: FakeMultipartS3 = fakeMultipartS3(BUCKET),
) {
  const storagePrefix = testPrefix();
  const mp = createS3Multipart({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    storagePrefix,
    credentials: async () => ({ accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET }),
    fetch: fake.fetch,
    now: () => NOW,
    ...over,
  });
  return { mp, fake, storagePrefix };
}

const hex = (b: Uint8Array): string => encodeHex(sha256(b));
const codeOf = (e: unknown): string | undefined => (e instanceof StorageError ? e.code : undefined);

describe('multipart: part size', () => {
  it('uses the default part size up to 10 000 parts, then grows in whole MiB', () => {
    expect(MULTIPART_MIN_PART_BYTES).toBe(5 * MiB);
    expect(MULTIPART_DEFAULT_PART_BYTES).toBe(8 * MiB);
    expect(multipartPartSize(65 * MiB)).toBe(8 * MiB);
    expect(multipartPartSize(1024 * MiB)).toBe(8 * MiB);
    const big = 200 * 1024 * MiB;
    const part = multipartPartSize(big);
    expect(part % MiB).toBe(0);
    expect(Math.ceil(big / part) <= MULTIPART_MAX_PARTS).toBe(true);
    expect(part).toBeGreaterThan(8 * MiB);
    expect(
      Math.ceil(MULTIPART_MAX_BYTES / multipartPartSize(MULTIPART_MAX_BYTES)),
    ).toBeLessThanOrEqual(MULTIPART_MAX_PARTS);
  });

  it('refuses a size that is not a positive integer or is above the limit', () => {
    expect(() => multipartPartSize(0)).toThrow(StorageError);
    expect(() => multipartPartSize(1.5)).toThrow(StorageError);
    expect(() => multipartPartSize(MULTIPART_MAX_BYTES + 1)).toThrow(StorageError);
  });
});

describe('multipart: upload', () => {
  it('streams the ciphertext in parts, hashes it incrementally and completes one object', async () => {
    const { mp, fake, storagePrefix } = setup();
    const data = patternBytes(11 * MiB + 123, 5);
    const obj = await mp.put(chunked(data, 700_001), {
      size: data.length,
      expiresAt: inADay,
      partSize: 5 * MiB,
    });

    expect(obj.kind).toBe('s3');
    expect(obj.size).toBe(data.length);
    expect(obj.sha256).toBe(hex(data));
    expect(obj.locator).toMatch(new RegExp(`^agentlink/${storagePrefix}/[A-Za-z0-9_-]{22}$`));
    expect(hex(fake.objects.get(obj.locator)!)).toBe(hex(data));
    expect(fake.uploads.size).toBe(0);

    const parts = fake.requests.filter((r) => r.method === 'PUT');
    expect(parts.map((r) => r.body.length)).toEqual([5 * MiB, 5 * MiB, MiB + 123]);
    expect(parts.map((r) => r.url.searchParams.get('partNumber'))).toEqual(['1', '2', '3']);
    for (const r of fake.requests) {
      expect(r.redirect).toBe('error');
      expect(r.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID/);
    }
    // Each part is signed over its own hash; no metadata rides on the object.
    for (const r of parts) expect(r.headers.get('x-amz-content-sha256')).toBe(hex(r.body));
    for (const r of fake.requests) {
      for (const name of r.headers.keys()) expect(name.startsWith('x-amz-meta-')).toBe(false);
    }
  });

  it('accepts a Uint8Array and uses the adaptive part size by default', async () => {
    const { mp, fake } = setup();
    const data = patternBytes(9 * MiB, 9);
    const obj = await mp.put(data, { size: data.length, expiresAt: inADay });
    expect(obj.sha256).toBe(hex(data));
    expect(fake.requests.filter((r) => r.method === 'PUT').map((r) => r.body.length)).toEqual([
      8 * MiB,
      MiB,
    ]);
  });

  it('refuses a part size below 5 MiB, a past expiry and a size above the limit, before any request', async () => {
    const { mp, fake } = setup();
    const data = patternBytes(6 * MiB);
    const tooSmall = await mp
      .put(data, { size: data.length, expiresAt: inADay, partSize: MiB })
      .catch((e: unknown) => e);
    expect(codeOf(tooSmall)).toBe('invalid_argument');
    const past = await mp
      .put(data, { size: data.length, expiresAt: new Date(NOW.getTime() - 1) })
      .catch((e: unknown) => e);
    expect(codeOf(past)).toBe('invalid_argument');
    const tooBig = await mp
      .put(data, { size: MULTIPART_MAX_BYTES + 1, expiresAt: inADay })
      .catch((e: unknown) => e);
    expect(codeOf(tooBig)).toBe('too_large');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('multipart: abort leaves no open uploads', () => {
  it('aborts when a part upload fails, and reports the status only', async () => {
    const fake = fakeMultipartS3(BUCKET);
    let puts = 0;
    fake.override = (req) => {
      if (req.method === 'PUT' && ++puts === 2) {
        return new Response(`<Error>denied ${req.url.toString()}</Error>`, { status: 500 });
      }
      return undefined;
    };
    const { mp } = setup({}, fake);
    const data = patternBytes(12 * MiB);
    const error = await mp
      .put(data, { size: data.length, expiresAt: inADay, partSize: 5 * MiB })
      .catch((e: unknown) => e);
    expect(codeOf(error)).toBe('upload_failed');
    expect((error as StorageError).status).toBe(500);
    expect((error as Error).message).not.toContain('denied');
    expect((error as Error).message).not.toContain(ENDPOINT);
    expect(fake.uploads.size).toBe(0);
    expect(fake.requests.at(-1)!.method).toBe('DELETE');
    expect(fake.requests.at(-1)!.url.searchParams.has('uploadId')).toBe(true);
    expect(fake.objects.size).toBe(0);
    expect(await setup({}, fake).mp.openUploads()).toBe(0);
  });

  it('aborts when the source stream fails mid-upload', async () => {
    const { mp, fake } = setup();
    const error = await mp
      .put(failingStream(7 * MiB), { size: 20 * MiB, expiresAt: inADay, partSize: 5 * MiB })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(fake.uploads.size).toBe(0);
    expect(fake.objects.size).toBe(0);
    expect(fake.requests.some((r) => r.method === 'DELETE')).toBe(true);
  });

  it('aborts when the stream is longer or shorter than the declared size', async () => {
    for (const actual of [11 * MiB, 9 * MiB]) {
      const { mp, fake } = setup();
      const error = await mp
        .put(chunked(patternBytes(actual), MiB), {
          size: 10 * MiB,
          expiresAt: inADay,
          partSize: 5 * MiB,
        })
        .catch((e: unknown) => e);
      expect(codeOf(error)).toBe('size_mismatch');
      expect(fake.uploads.size).toBe(0);
      expect(fake.objects.size).toBe(0);
    }
  });

  it('aborts when completion returns 200 with an error document', async () => {
    const fake = fakeMultipartS3(BUCKET);
    fake.override = (req) =>
      req.method === 'POST' && req.url.searchParams.has('uploadId')
        ? new Response('<?xml version="1.0"?><Error><Code>InternalError</Code></Error>', {
            status: 200,
          })
        : undefined;
    const { mp } = setup({}, fake);
    const data = patternBytes(6 * MiB);
    const error = await mp
      .put(data, { size: data.length, expiresAt: inADay, partSize: 5 * MiB })
      .catch((e: unknown) => e);
    expect(codeOf(error)).toBe('upload_failed');
    expect(fake.uploads.size).toBe(0);
  });

  it('aborts on a network failure, without the URL in the error', async () => {
    const fake = fakeMultipartS3(BUCKET);
    fake.override = (req) => {
      if (req.method === 'PUT') throw new TypeError(`fetch failed: ${req.url.toString()}`);
      return undefined;
    };
    const { mp } = setup({}, fake);
    const data = patternBytes(6 * MiB);
    const error = await mp
      .put(data, { size: data.length, expiresAt: inADay, partSize: 5 * MiB })
      .catch((e: unknown) => e);
    expect(codeOf(error)).toBe('network');
    expect((error as Error).message).not.toContain(ENDPOINT);
    expect(fake.uploads.size).toBe(0);
  });

  it('refuses an upload ID or ETag that is not well formed, and aborts', async () => {
    const fake = fakeMultipartS3(BUCKET);
    fake.override = (req) =>
      req.method === 'PUT'
        ? new Response(null, { status: 200, headers: { ETag: '"bad<etag>"' } })
        : undefined;
    const { mp } = setup({}, fake);
    const data = patternBytes(6 * MiB);
    const error = await mp
      .put(data, { size: data.length, expiresAt: inADay, partSize: 5 * MiB })
      .catch((e: unknown) => e);
    expect(codeOf(error)).toBe('upload_failed');
    expect(fake.uploads.size).toBe(0);
  });
});

describe('multipart: cleanup of open uploads', () => {
  it('lists and aborts open uploads under its own prefix only', async () => {
    const fake = fakeMultipartS3(BUCKET);
    const mine = setup({}, fake);
    const other = setup({}, fake);
    // Leftovers, as after a crash: uploads created and never completed or aborted.
    fake.override = (req) =>
      req.method === 'PUT' ? new Response(null, { status: 503 }) : undefined;
    const noAbort = (req: Request): Promise<Response> =>
      req.method === 'DELETE'
        ? Promise.resolve(new Response(null, { status: 500 }))
        : fake.fetch(req);
    for (const s of [mine, mine, other]) {
      const crashed = createS3Multipart({
        endpoint: ENDPOINT,
        bucket: BUCKET,
        storagePrefix: s.storagePrefix,
        credentials: async () => ({ accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET }),
        fetch: noAbort,
        now: () => NOW,
      });
      await crashed
        .put(patternBytes(6 * MiB), { size: 6 * MiB, expiresAt: inADay, partSize: 5 * MiB })
        .catch(() => undefined);
    }
    fake.override = undefined;
    expect(fake.uploads.size).toBe(3);
    expect(await mine.mp.openUploads()).toBe(2);
    expect(await mine.mp.abortOpenUploads()).toBe(2);
    expect(await mine.mp.openUploads()).toBe(0);
    expect(await other.mp.openUploads()).toBe(1);
    expect(fake.uploads.size).toBe(1);
    const list = fake.requests.find(
      (r) => r.method === 'GET' && r.url.searchParams.has('uploads'),
    )!;
    expect(list.url.searchParams.get('prefix')).toBe(`agentlink/${mine.storagePrefix}/`);
  });

  it('never aborts an upload whose key is not one of its own, even if the listing returns it', async () => {
    const fake = fakeMultipartS3(BUCKET);
    const { mp, storagePrefix } = setup({}, fake);
    fake.uploads.set('foreign-id', {
      key: `agentlink/${storagePrefix}/../../etc`,
      parts: new Map(),
    });
    fake.uploads.set('foreign-2', { key: `agentlink/${storagePrefix}/x/y`, parts: new Map() });
    expect(await mp.abortOpenUploads()).toBe(0);
    expect(fake.uploads.size).toBe(2);
    expect(fake.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });
});

describe('multipart: configuration (04 §4)', () => {
  it('refuses a non-https, IP-literal, local or malformed endpoint before any request', () => {
    const fake = fakeMultipartS3(BUCKET);
    for (const endpoint of [
      'http://acct.r2.example.com',
      'https://127.0.0.1',
      'https://[::1]',
      'https://localhost',
      'https://minio.local',
      'https://169.254.169.254',
      'https://0x7f.0.0.1',
      'https://acct.r2.example.com/path',
      'https://user@acct.r2.example.com',
      'https://acct%2er2.example.com',
    ]) {
      expect(() => setup({ endpoint }, fake), endpoint).toThrow(StorageError);
    }
    expect(() => setup({ bucket: '../x' }, fake)).toThrow(StorageError);
    expect(() => setup({ storagePrefix: 'agent-id' }, fake)).toThrow(StorageError);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('multipart: log canary (I-7)', () => {
  it('logs no credentials, URLs, upload IDs or object keys, on success and failure', async () => {
    const fake = fakeMultipartS3(BUCKET);
    const seen: string[] = [];
    const lines = await captureOutput(async ({ logger }) => {
      const { mp } = setup({ logger }, fake);
      const obj = await mp.put(patternBytes(6 * MiB), {
        size: 6 * MiB,
        expiresAt: inADay,
        partSize: 5 * MiB,
      });
      seen.push(obj.locator);
      fake.override = (req) =>
        req.method === 'PUT'
          ? new Response(`denied ${req.url.toString()}`, { status: 403 })
          : undefined;
      await mp
        .put(patternBytes(6 * MiB), { size: 6 * MiB, expiresAt: inADay, partSize: 5 * MiB })
        .catch(() => undefined);
      fake.override = undefined;
      await mp.abortOpenUploads();
    });
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.map((l) => l.line).join('\n');
    const uploadIds = fake.requests
      .map((r) => r.url.searchParams.get('uploadId'))
      .filter((id): id is string => id !== null);
    expect(uploadIds.length).toBeGreaterThan(0);
    for (const needle of [
      ACCESS_KEY_ID,
      SECRET,
      seen[0]!,
      ...uploadIds,
      'X-Amz-',
      'agentlink/',
      ENDPOINT,
      'denied',
      '?',
    ]) {
      expect(all).not.toContain(needle);
    }
  });
});
