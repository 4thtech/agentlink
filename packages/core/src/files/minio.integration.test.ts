// M1-7f-3: the files round trip through real own S3 storage (07 §5.2, §5.6; 04 §4), with the core's
// send, fetch and refresh-link on two agents, against the MinIO of CI's `storage-minio` job.
//
// The job sets AGENTLINK_STORAGE_IT=minio and the endpoint variables (packages/storage's
// integration.test.ts reads the same ones, runs first and creates the bucket). Without AGENTLINK_STORAGE_IT the suite is skipped (a
// developer machine has no endpoint); with it set, a missing variable FAILS the suite, so a job that
// lost its configuration cannot pass by skipping, and the job checks its report for skipped tests.
//
// What the test does not cover: the platform's SSRF-safe download (@4thtech-io/node safeFetch), which
// refuses MinIO's loopback address by design. The download here is a plain fetch of the URL after the
// core's own raw-string check (checkFetchUrl) passed it. Assertions are booleans and numbers only: a
// failed assertion must never print a URL, an object key or a credential (I-7).
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { encodeBase64url, randomBytes } from '@4thtech-io/crypto';
import {
  createS3Adapter,
  type CiphertextSource,
  type S3Adapter,
  type StorageAdapter,
  type StoredObject,
} from '@4thtech-io/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoreError } from '../errors.js';
import { FakeClock, passphrase, seed } from '../testing/fixtures.js';
import {
  deliver,
  fileBytes,
  openFileAgent,
  outgoing,
  pairForFiles,
  type FileAgent,
} from '../testing/files.js';

const env: Record<string, string | undefined> =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const MODE = env['AGENTLINK_STORAGE_IT'];
const MiB = 1024 * 1024;
const MARKER = 'MINIO-ROUND-TRIP';

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
    // The name only; never a value.
    if (value === undefined || value.length === 0)
      throw new Error(`files minio: ${name} is not set`);
    return value;
  };
  if (MODE !== 'minio') throw new Error('files minio: AGENTLINK_STORAGE_IT must be "minio"');
  return {
    endpoint: need('AGENTLINK_STORAGE_IT_ENDPOINT'),
    bucket: need('AGENTLINK_STORAGE_IT_BUCKET'),
    region: need('AGENTLINK_STORAGE_IT_REGION'),
    accessKeyId: need('AGENTLINK_STORAGE_IT_ACCESS_KEY_ID'),
    secretAccessKey: need('AGENTLINK_STORAGE_IT_SECRET_ACCESS_KEY'),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A plain download of a presigned URL, capped, with redirects refused (see the header). */
function download(url: string): CiphertextSource {
  return async (maxBytes, onChunk) => {
    const response = await fetch(url, { redirect: 'error' });
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new Error('download refused');
    }
    const reader = response.body.getReader();
    let seen = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.length;
      await onChunk(value);
      if (seen > maxBytes) {
        await reader.cancel();
        break;
      }
    }
  };
}

/**
 * Own storage whose next presigned URL lives `shortMs` only: a link the storage refuses before the
 * payload's expiresAt (07 §5.2: shorter with temporary credentials). Every object is remembered for
 * the cleanup.
 */
class ShortFirstLink implements StorageAdapter {
  readonly kind = 's3' as const;
  readonly created: StoredObject[] = [];
  shortMs: number | undefined;
  presigned = 0;

  constructor(readonly s3: S3Adapter) {}

  async put(...args: Parameters<StorageAdapter['put']>): Promise<StoredObject> {
    const obj = await this.s3.put(...args);
    this.created.push(obj);
    return obj;
  }

  presignGet(obj: StoredObject, expiresAt: Date): Promise<string> {
    this.presigned += 1;
    const short = this.shortMs;
    this.shortMs = undefined;
    return this.s3.presignGet(obj, short === undefined ? expiresAt : new Date(Date.now() + short));
  }

  delete(obj: StoredObject): Promise<void> {
    return this.s3.delete(obj);
  }
}

describe.skipIf(MODE === undefined)('files through own S3 storage (MinIO)', () => {
  let cfg: Target;
  let storage: ShortFirstLink;
  let a: FileAgent;
  let b: FileAgent;

  beforeAll(async () => {
    cfg = target();
    // The bucket exists: the job runs packages/storage's integration test first, which creates it.
    storage = new ShortFirstLink(
      createS3Adapter({
        endpoint: cfg.endpoint,
        bucket: cfg.bucket,
        region: cfg.region,
        storagePrefix: encodeBase64url(randomBytes(16)),
        credentials: async () => ({
          accessKeyId: cfg.accessKeyId,
          secretAccessKey: cfg.secretAccessKey,
        }),
      }),
    );
    // Presigned URLs are signed on the real clock, so the agents' clock starts at it.
    const clock = new FakeClock(Math.floor(Date.now() / 1000));
    const options = { ownAdapter: storage, download };
    a = await openFileAgent(
      clock,
      new MemoryKeyStore(seed(71)),
      new MemoryOwnerKeyStore(seed(171), passphrase()),
      'alice',
      { ...options, relays: ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'] },
    );
    b = await openFileAgent(
      clock,
      new MemoryKeyStore(seed(72)),
      new MemoryOwnerKeyStore(seed(172), passphrase()),
      'bob',
      { ...options, relays: ['wss://one.relay-beta.net', 'wss://two.relay-beta.net'] },
    );
    // Own storage for every stored file (07 §5.6), and room for 5 MB.
    await pairForFiles(clock, a, b, (p) => {
      p.files.storage = 'own';
    });
  }, 60_000);

  afterAll(async () => {
    // Best effort: only what this run created.
    for (const obj of storage?.created ?? []) await storage.delete(obj).catch(() => undefined);
  });

  async function send(bytes: Uint8Array): Promise<string> {
    const sent = await a.client.sendMessage({
      to: b.id,
      text: 'file',
      files: [outgoing('report.bin', bytes)],
    });
    expect(sent.status).toBe('ok');
    if (sent.status !== 'ok') throw new Error('not sent');
    expect(sent.files?.[0]?.delivery).toBe('own');
    await deliver(a, b);
    return sent.envelopeId;
  }

  const saved = (): Uint8Array[] => [...b.inbox.files().values()];

  it('5 MB round trip: own storage, a presigned URL, both hashes verified', async () => {
    const bytes = fileBytes(5 * MiB, MARKER);
    const envelopeId = await send(bytes);
    const result = await b.client.fetchFile({ envelopeId });
    expect(result).toMatchObject({ status: 'ok', size: 5 * MiB, integrity: 'verified' });
    const out = saved().find((s) => s.length === 5 * MiB);
    expect(out !== undefined && out.every((v, i) => v === bytes[i])).toBe(true);
  }, 60_000);

  it('an expired link: refresh-link returns a working URL from own storage', async () => {
    const bytes = fileBytes(64 * 1024, MARKER);
    storage.shortMs = 2_000;
    const before = storage.presigned;
    const envelopeId = await send(bytes);
    await sleep(4_000);
    // MinIO refuses the expired presigned URL.
    const failed = await b.client.fetchFile({ envelopeId }).catch((e: unknown) => e);
    expect(failed instanceof CoreError && failed.code === 'file_download_failed').toBe(true);

    const asked = await b.client.requestFileLink({ envelopeId });
    expect(asked.status).toBe('ok');
    await deliver(b, a);
    await deliver(a, b);
    expect(storage.presigned).toBe(before + 2);

    const result = await b.client.fetchFile({ envelopeId });
    expect(result).toMatchObject({ status: 'ok', size: bytes.length, integrity: 'verified' });
  }, 60_000);

  it('no presigned URL or credential reaches a log line', () => {
    for (const line of [...a.lines, ...b.lines]) {
      expect(line.includes('X-Amz-')).toBe(false);
      expect(line.includes(cfg.accessKeyId)).toBe(false);
      expect(line.includes(cfg.secretAccessKey)).toBe(false);
    }
  });
});
