// M1-6b-b L4 and L5: errors thrown by the caller's stream surface as StorageError, and an upload whose
// create or complete response was lost is aborted or its object removed (07 §5.2, 04 §4, I-7).
import { describe, expect, it } from 'vitest';
import { captureOutput } from '@4thtech-io/log/testing';
import { StorageError, createS3Multipart, putEncrypted, type S3MultipartConfig } from './index.js';
import { BUCKET, DAY_MS, ENDPOINT, NOW, testPrefix } from './fake-s3.fixture.js';
import {
  chunked,
  fakeMultipartS3,
  patternBytes,
  type FakeMultipartS3,
} from './multipart.fixture.js';

const MiB = 1024 * 1024;
const ACCESS_KEY_ID = 'AKIDFOLLOWUPTESTONLY';
const SECRET = 'followup-secret-access-key-never-logged';
const inADay = new Date(NOW.getTime() + DAY_MS);
const codeOf = (e: unknown): string | undefined => (e instanceof StorageError ? e.code : undefined);

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

const isCreate = (r: Request): boolean =>
  r.method === 'POST' && new URL(r.url).searchParams.has('uploads');
const isComplete = (r: Request): boolean =>
  r.method === 'POST' && new URL(r.url).searchParams.has('uploadId');

/** A fetch that runs the request for real, then loses the response when `lose` says so. */
function losingResponse(fake: FakeMultipartS3, lose: (req: Request) => boolean) {
  return async (req: Request): Promise<Response> => {
    const probe = req.clone();
    const response = await fake.fetch(req);
    if (lose(probe)) throw new TypeError(`connection reset: ${probe.url}`);
    return response;
  };
}

const erroring = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error('boom https://secret.example/x?token=abc'));
    },
  });

describe('multipart: caller stream errors are StorageError (L4)', () => {
  it('wraps an error thrown by the caller stream, with a fixed message and no cause', async () => {
    const { mp, fake } = setup();
    const error = await mp
      .put(erroring(), { size: 10 * MiB, expiresAt: inADay, partSize: 5 * MiB })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect(codeOf(error)).toBe('upload_failed');
    expect((error as Error).message).not.toContain('boom');
    expect((error as Error).message).not.toContain('secret.example');
    expect((error as Error).cause).toBeUndefined();
    expect(fake.uploads.size).toBe(0);
  });

  it('keeps a StorageError from the stream as it is', async () => {
    const { mp } = setup();
    const error = await mp
      .put(chunked(patternBytes(11 * MiB), MiB), {
        size: 10 * MiB,
        expiresAt: inADay,
        partSize: 5 * MiB,
      })
      .catch((e: unknown) => e);
    expect(codeOf(error)).toBe('size_mismatch');
  });

  it('putEncrypted surfaces an erroring plaintext stream as StorageError', async () => {
    const { mp } = setup();
    const target = {
      put: (c: ReadableStream<Uint8Array>, o: { size: number; expiresAt: Date }) => mp.put(c, o),
    };
    const error = await putEncrypted(target, erroring(), {
      plaintextSize: 6 * MiB,
      expiresAt: inADay,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as Error).message).not.toContain('secret.example');
  });

  it('putEncrypted wraps a non-StorageError thrown by the target', async () => {
    const target = {
      put: async (): Promise<never> => {
        throw new Error('https://secret.example/leak');
      },
    };
    const error = await putEncrypted(target, new Uint8Array(10), {
      plaintextSize: 10,
      expiresAt: inADay,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as Error).message).not.toContain('secret.example');
  });
});

describe('multipart: orphaned uploads are reclaimed (L5)', () => {
  it('aborts an upload whose create response was lost', async () => {
    const fake = fakeMultipartS3(BUCKET);
    const { mp } = setup({ fetch: losingResponse(fake, isCreate) }, fake);
    const data = patternBytes(6 * MiB);
    const error = await mp
      .put(data, { size: data.length, expiresAt: inADay, partSize: 5 * MiB })
      .catch((e: unknown) => e);
    expect(codeOf(error)).toBe('network');
    expect((error as Error).message).not.toContain(ENDPOINT);
    expect(fake.uploads.size).toBe(0);
    expect(fake.objects.size).toBe(0);
  });

  it('aborts an upload whose create answer cannot be read', async () => {
    const fake = fakeMultipartS3(BUCKET);
    const unreadable = async (req: Request): Promise<Response> => {
      const probe = req.clone();
      const response = await fake.fetch(req);
      return isCreate(probe) ? new Response('<garbage/>', { status: 200 }) : response;
    };
    const { mp } = setup({ fetch: unreadable }, fake);
    const data = patternBytes(6 * MiB);
    const error = await mp
      .put(data, { size: data.length, expiresAt: inADay, partSize: 5 * MiB })
      .catch((e: unknown) => e);
    expect(codeOf(error)).toBe('upload_failed');
    expect(fake.uploads.size).toBe(0);
  });

  it('removes the object when the complete response was lost but the object was stored', async () => {
    const fake = fakeMultipartS3(BUCKET);
    const { mp } = setup({ fetch: losingResponse(fake, isComplete) }, fake);
    const data = patternBytes(6 * MiB);
    const error = await mp
      .put(data, { size: data.length, expiresAt: inADay, partSize: 5 * MiB })
      .catch((e: unknown) => e);
    expect(codeOf(error)).toBe('network');
    expect(fake.uploads.size).toBe(0);
    // The caller was told the upload failed, so nothing may stay behind unreferenced.
    expect(fake.objects.size).toBe(0);
  });

  it('never aborts uploads of other keys while reclaiming', async () => {
    const fake = fakeMultipartS3(BUCKET);
    const mine = setup({}, fake);
    fake.uploads.set('other-upload', {
      key: `agentlink/${mine.storagePrefix}/zzzz`,
      parts: new Map(),
    });
    const { mp } = setup({ fetch: losingResponse(fake, isCreate) }, fake);
    await mp
      .put(patternBytes(6 * MiB), { size: 6 * MiB, expiresAt: inADay, partSize: 5 * MiB })
      .catch(() => undefined);
    expect([...fake.uploads.keys()]).toEqual(['other-upload']);
  });

  it('logs no URL, key, credential or upload ID while reclaiming', async () => {
    const fake = fakeMultipartS3(BUCKET);
    const lines = await captureOutput(async ({ logger }) => {
      const { mp } = setup({ logger, fetch: losingResponse(fake, isCreate) }, fake);
      await mp
        .put(patternBytes(6 * MiB), { size: 6 * MiB, expiresAt: inADay, partSize: 5 * MiB })
        .catch(() => undefined);
    });
    const all = lines.map((l) => l.line).join('\n');
    for (const needle of [ACCESS_KEY_ID, SECRET, 'agentlink/', ENDPOINT, 'X-Amz-']) {
      expect(all).not.toContain(needle);
    }
  });
});
