// M1-6a-2: the S3 adapter against a real S3-compatible endpoint (07 §5.2, 04 §4, I-2, I-7).
//
// Two CI jobs run this file, each with AGENTLINK_STORAGE_IT set:
//   - `minio`: a MinIO container with a CI-generated TLS certificate, on every pull request
//     (`ci.yml`, job `storage-minio`, no secrets);
//   - `r2`: a Cloudflare R2 test bucket, daily and on dispatch, on `main` only
//     (`storage-r2.yml`, environment `r2-test`).
// Without AGENTLINK_STORAGE_IT the suite is skipped (a developer machine has no endpoint). With it set, a
// missing or malformed variable FAILS the suite, so a CI job that lost its configuration cannot pass by
// skipping. The jobs also check the test report for skipped tests.
//
// What it stores is random bytes standing in for ALF1 ciphertext (the adapter only ever sees ciphertext).
// Objects live under a random per-run storage prefix and are deleted afterwards; the R2 bucket also has
// a 7-day lifecycle rule as a backstop. Assertions are booleans and numbers only: a failed assertion must
// never print a URL, an object key or a credential.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AwsClient } from 'aws4fetch';
import { encodeBase64url, encodeHex, randomBytes, sha256 } from '@agentlink/crypto';
import { captureOutput, findCanaryLeaks, type Canary } from '@agentlink/log/testing';
import {
  LIFECYCLE_RULE_ID,
  MAX_PRESIGN_SECONDS,
  createS3Adapter,
  createS3Lifecycle,
  createS3Multipart,
  type S3Adapter,
  type S3AdapterConfig,
  type StoredObject,
} from './index.js';

// The package has no Node type definitions (it runs in Workers too); only this test reads the environment.
const env: Record<string, string | undefined> =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const MODE = env['AGENTLINK_STORAGE_IT'];
const DAY_MS = 86_400_000;

interface Target {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

function target(): Target {
  const need = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.length === 0) {
      // The name only; never a value.
      throw new Error(`storage integration: ${name} is not set`);
    }
    return value;
  };
  if (MODE !== 'minio' && MODE !== 'r2') {
    throw new Error('storage integration: AGENTLINK_STORAGE_IT must be "minio" or "r2"');
  }
  return {
    endpoint: need('AGENTLINK_STORAGE_IT_ENDPOINT'),
    bucket: need('AGENTLINK_STORAGE_IT_BUCKET'),
    region: need('AGENTLINK_STORAGE_IT_REGION'),
    accessKeyId: need('AGENTLINK_STORAGE_IT_ACCESS_KEY_ID'),
    secretAccessKey: need('AGENTLINK_STORAGE_IT_SECRET_ACCESS_KEY'),
  };
}

const hexOf = (bytes: Uint8Array): string => encodeHex(sha256(bytes));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const inFuture = (ms: number): Date => new Date(Date.now() + ms);
const MiB = 1024 * 1024;
const toBase64 = (bytes: Uint8Array): string => {
  const url = encodeBase64url(bytes).replace(/-/g, '+').replace(/_/g, '/');
  return url + '='.repeat((4 - (url.length % 4)) % 4);
};

/** A stream of `total` random bytes in 1 MiB chunks that errors after `failAfter` bytes, if given. */
function randomStream(total: number, failAfter?: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfter !== undefined && sent >= failAfter) {
        controller.error(new Error('source failed'));
        return;
      }
      if (sent >= total) {
        controller.close();
        return;
      }
      const n = Math.min(MiB, total - sent);
      controller.enqueue(randomBytes(n));
      sent += n;
    },
  });
}

describe.skipIf(MODE === undefined)(`S3 adapter against ${MODE ?? 'no endpoint'}`, () => {
  // Resolved in the first hook, so a missing variable fails the suite instead of the import.
  let cfg: Target;
  let prefix: string;
  const created: StoredObject[] = [];
  let cleaner: S3Adapter;

  const make = (extra: Partial<S3AdapterConfig> = {}): S3Adapter =>
    createS3Adapter({
      endpoint: cfg.endpoint,
      bucket: cfg.bucket,
      region: cfg.region,
      storagePrefix: prefix,
      credentials: async () => ({
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      }),
      ...extra,
    });

  const ciphertext = (): Uint8Array => randomBytes(2048);

  const putOne = async (s3: S3Adapter, data: Uint8Array): Promise<StoredObject> => {
    const obj = await s3.put(data, { size: data.length, expiresAt: inFuture(DAY_MS) });
    created.push(obj);
    return obj;
  };

  // Independent of the code under test: raw signed requests for setup and for checks.
  const raw = (): AwsClient =>
    new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: 's3',
      region: cfg.region,
      retries: 0,
    });

  /** Open multipart uploads under this run's prefix, counted from a raw ListMultipartUploads. */
  const openUploads = async (): Promise<number> => {
    const url = new URL(`${cfg.endpoint}/${cfg.bucket}`);
    url.searchParams.set('uploads', '');
    url.searchParams.set('prefix', `agentlink/${prefix}/`);
    const res = await raw().fetch(url.toString(), { method: 'GET', redirect: 'error' });
    expect(res.status).toBe(200);
    const text = await res.text();
    return text.split('<Upload>').length - 1;
  };

  beforeAll(async () => {
    cfg = target();
    prefix = encodeBase64url(randomBytes(16));
    cleaner = make();
    if (MODE === 'minio') {
      // A fresh MinIO has no bucket. R2 uses the existing test bucket.
      const aws = raw();
      const res = await aws.fetch(`${cfg.endpoint}/${cfg.bucket}`, { method: 'PUT' });
      await res.body?.cancel();
      expect([200, 409].includes(res.status)).toBe(true);
    }
  });

  afterAll(async () => {
    // Best effort: everything this run created, nothing else is touched.
    for (const obj of created) await cleaner.delete(obj).catch(() => undefined);
    await multipart()
      .abortOpenUploads()
      .catch(() => undefined);
  });

  const multipart = () =>
    createS3Multipart({
      endpoint: cfg.endpoint,
      bucket: cfg.bucket,
      region: cfg.region,
      storagePrefix: prefix,
      credentials: async () => ({
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      }),
    });

  it('multipart (M1-6b): uploads in parts and round-trips through a presigned URL', async () => {
    const mp = multipart();
    const size = 11 * MiB + 17;
    const source = randomStream(size);
    const [forUpload, forHash] = source.tee();
    const hashing = (async () => {
      const chunks: Uint8Array[] = [];
      const reader = forHash.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const all = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        all.set(c, offset);
        offset += c.length;
      }
      return hexOf(all);
    })();
    const obj = await mp.put(forUpload, { size, expiresAt: inFuture(DAY_MS), partSize: 5 * MiB });
    created.push(obj);
    expect(obj.size).toBe(size);
    expect(obj.sha256).toBe(await hashing);
    expect(obj.locator.startsWith(`agentlink/${prefix}/`)).toBe(true);

    const response = await fetch(await make().presignGet(obj, inFuture(60 * 60 * 1000)), {
      redirect: 'error',
    });
    expect(response.status).toBe(200);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.length).toBe(size);
    expect(hexOf(body)).toBe(obj.sha256);
    expect(await openUploads()).toBe(0);
  }, 120_000);

  it('multipart (M1-6b): an aborted upload leaves no open multipart uploads', async () => {
    const mp = multipart();
    expect(await openUploads()).toBe(0);
    // The source fails after two full parts have been uploaded.
    const failed = await mp
      .put(randomStream(20 * MiB, 11 * MiB), {
        size: 20 * MiB,
        expiresAt: inFuture(DAY_MS),
        partSize: 5 * MiB,
      })
      .then(() => false)
      .catch(() => true);
    expect(failed).toBe(true);
    // A declared size longer than the stream fails too.
    const short = await mp
      .put(randomStream(6 * MiB), { size: 7 * MiB, expiresAt: inFuture(DAY_MS), partSize: 5 * MiB })
      .then(() => false)
      .catch(() => true);
    expect(short).toBe(true);
    expect(await openUploads()).toBe(0);
    expect(await mp.openUploads()).toBe(0);
  }, 120_000);

  // The lifecycle rule is a bucket setting. It runs on MinIO only: the R2 job uses a shared test bucket
  // with an object-scoped token and its own 7-day backstop rule, which this test must not rewrite. The
  // test is not registered (rather than skipped) on R2, since the jobs fail on a skipped test.
  if (MODE === 'minio') {
    it("lifecycle (M1-6b): rule set and read back, the bucket's other rules kept", async () => {
      // Seed an unrelated rule, as a user's bucket may already have one.
      const other =
        '<Rule><ID>it-keep-other</ID><Filter><Prefix>other/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>7</Days></Expiration></Rule>';
      const doc = new TextEncoder().encode(
        `<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${other}</LifecycleConfiguration>`,
      );
      const seeded = await raw().fetch(`${cfg.endpoint}/${cfg.bucket}?lifecycle`, {
        method: 'PUT',
        body: doc,
        headers: {
          'Content-Type': 'application/xml',
          'x-amz-checksum-sha256': toBase64(sha256(doc)),
          'x-amz-sdk-checksum-algorithm': 'SHA256',
        },
        redirect: 'error',
      });
      await seeded.body?.cancel();
      expect(seeded.status).toBe(200);

      const lc = createS3Lifecycle({
        endpoint: cfg.endpoint,
        bucket: cfg.bucket,
        region: cfg.region,
        credentials: async () => ({
          accessKeyId: cfg.accessKeyId,
          secretAccessKey: cfg.secretAccessKey,
        }),
      });
      expect(await lc.read()).toBeNull();
      await lc.apply();
      expect(await lc.read()).toEqual({ prefix: 'agentlink/', days: 30, enabled: true });
      await lc.apply({ days: 31 });
      expect(await lc.read()).toEqual({ prefix: 'agentlink/', days: 31, enabled: true });

      // Read back independently: both rules are on the bucket, ours once.
      const res = await raw().fetch(`${cfg.endpoint}/${cfg.bucket}?lifecycle`, {
        method: 'GET',
        redirect: 'error',
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.includes('<ID>it-keep-other</ID>')).toBe(true);
      expect(text.split(`<ID>${LIFECYCLE_RULE_ID}</ID>`).length).toBe(2);
    });
  }

  it('round-trips: put, presign, download through the presigned URL, delete', async () => {
    const s3 = make();
    const data = ciphertext();
    const obj = await putOne(s3, data);
    expect(obj.size).toBe(data.length);
    expect(obj.sha256).toBe(hexOf(data));
    expect(obj.locator.startsWith(`agentlink/${prefix}/`)).toBe(true);

    const url = await s3.presignGet(obj, inFuture(60 * 60 * 1000));
    const response = await fetch(url, { redirect: 'error' });
    expect(response.status).toBe(200);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.length).toBe(data.length);
    expect(hexOf(body)).toBe(obj.sha256);

    await s3.delete(obj);
    const gone = await fetch(await s3.presignGet(obj, inFuture(60_000)), { redirect: 'error' });
    await gone.body?.cancel();
    expect(gone.status).toBe(404);
    // Deleting an object that is already gone is not an error.
    await s3.delete(obj);
  });

  it('caps a presigned URL at 7 days and the URL works at the cap', async () => {
    const s3 = make();
    const obj = await putOne(s3, ciphertext());

    const before = Date.now();
    const granted = await s3.presign(obj, inFuture(30 * DAY_MS));
    const seconds = Number(new URL(granted.url).searchParams.get('X-Amz-Expires'));
    expect(seconds).toBe(MAX_PRESIGN_SECONDS);
    expect(granted.expiresAt.getTime() - before <= MAX_PRESIGN_SECONDS * 1000 + 5_000).toBe(true);

    const response = await fetch(granted.url, { redirect: 'error' });
    await response.body?.cancel();
    expect(response.status).toBe(200);
  });

  it('stops serving after the presigned URL expires', async () => {
    const s3 = make();
    const obj = await putOne(s3, ciphertext());

    const url = await s3.presignGet(obj, inFuture(2_000));
    await sleep(4_000);
    const response = await fetch(url, { redirect: 'error' });
    await response.body?.cancel();
    expect(response.status >= 400 && response.status < 500).toBe(true);
  }, 30_000);

  it('refuses a ciphertext whose length differs from the declared size', async () => {
    const s3 = make();
    const data = ciphertext();
    const error = await s3
      .put(data, { size: data.length + 1, expiresAt: inFuture(DAY_MS) })
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('size_mismatch');
  });

  it('log canary: no URL, query string, object key, credential or host reaches any log or console', async () => {
    const seen: string[] = [];
    const lines = await captureOutput(async ({ logger }) => {
      const s3 = make({ logger });
      const data = ciphertext();
      const obj = await putOne(s3, data);
      const url = await s3.presignGet(obj, inFuture(30 * DAY_MS));
      const response = await fetch(url, { redirect: 'error' });
      await response.body?.cancel();
      const parsed = new URL(url);
      seen.push(obj.locator, url, parsed.search.slice(1), parsed.hostname);
      await s3.delete(obj);
      // Failure paths as well: an object that is already gone, and a wrong secret.
      await s3.delete(obj).catch(() => undefined);
      const wrong = make({
        logger,
        credentials: async () => ({
          accessKeyId: cfg.accessKeyId,
          secretAccessKey: `${cfg.secretAccessKey}x`,
        }),
      });
      const rejected = await wrong
        .put(data, { size: data.length, expiresAt: inFuture(DAY_MS) })
        .then(() => true)
        .catch(() => false);
      expect(rejected).toBe(false);
    });
    expect(lines.length).toBeGreaterThan(0);

    const key = seen[0]!;
    const canaries: Canary[] = [
      { name: 'object key', value: key, forms: [key.split('/')[2]!] },
      { name: 'presigned URL', value: seen[1]! },
      { name: 'query string', value: seen[2]! },
      { name: 'host', value: seen[3]! },
      { name: 'secret access key', value: cfg.secretAccessKey },
      { name: 'access key id', value: cfg.accessKeyId },
      { name: 'storage prefix', value: prefix },
    ];
    // Canary names and positions only; never the line.
    expect(findCanaryLeaks(lines, canaries).map((leak) => leak.canary)).toEqual([]);
  });
});
