// M1-6b-b L3: the lifecycle read-modify-write is not atomic on S3 (no conditional write), so the helper
// re-reads before writing, retries on a change, and checks the result by reading it back (07 §5.2).
import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_RULE_ID,
  StorageError,
  createS3Lifecycle,
  type S3LifecycleConfig,
} from './index.js';
import { BUCKET, ENDPOINT, NOW } from './fake-s3.fixture.js';
import { fakeMultipartS3, type FakeMultipartS3 } from './multipart.fixture.js';

function setup(over: Partial<S3LifecycleConfig>, fake: FakeMultipartS3) {
  return createS3Lifecycle({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    credentials: async () => ({ accessKeyId: 'AKIDLIFECYCLEL3', secretAccessKey: 'l3-secret' }),
    fetch: fake.fetch,
    now: () => NOW,
    ...over,
  });
}

const codeOf = (e: unknown): string | undefined => (e instanceof StorageError ? e.code : undefined);
const rule = (id: string, prefix: string): string =>
  `<Rule><ID>${id}</ID><Filter><Prefix>${prefix}</Prefix></Filter><Status>Enabled</Status><Expiration><Days>7</Days></Expiration></Rule>`;
const OTHER_RULE = rule('keep-logs', 'logs/');
const CONCURRENT_RULE = rule('other-writer', 'tmp/');
const doc = (...rules: string[]): string =>
  `<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${rules.join('')}</LifecycleConfiguration>`;
const isLifecycleGet = (r: Request): boolean =>
  r.method === 'GET' && new URL(r.url).searchParams.has('lifecycle');

describe('lifecycle: concurrent changes (L3)', () => {
  it('re-reads before writing and keeps a rule another writer added after the first read', async () => {
    const fake = fakeMultipartS3(BUCKET);
    fake.lifecycle = doc(OTHER_RULE);
    let gets = 0;
    const racing = async (req: Request): Promise<Response> => {
      const get = isLifecycleGet(req);
      const response = await fake.fetch(req);
      // Another writer changes the configuration right after our first read.
      if (get && ++gets === 1) fake.lifecycle = doc(OTHER_RULE, CONCURRENT_RULE);
      return response;
    };
    await setup({ fetch: racing }, fake).apply();
    expect(fake.lifecycle).toContain(OTHER_RULE);
    expect(fake.lifecycle).toContain(CONCURRENT_RULE);
    expect(fake.lifecycle).toContain(`<ID>${LIFECYCLE_RULE_ID}</ID>`);
  });

  it('writes nothing when the configuration keeps changing', async () => {
    const fake = fakeMultipartS3(BUCKET);
    fake.lifecycle = doc(OTHER_RULE);
    let n = 0;
    const racing = async (req: Request): Promise<Response> => {
      const get = isLifecycleGet(req);
      const response = await fake.fetch(req);
      if (get) fake.lifecycle = doc(OTHER_RULE, rule(`r${++n}`, `p${n}/`));
      return response;
    };
    const error = await setup({ fetch: racing }, fake)
      .apply()
      .catch((e: unknown) => e);
    expect(codeOf(error)).toBe('lifecycle_failed');
    expect((error as Error).message).not.toContain(ENDPOINT);
    expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
  });

  it('reports a failure when the read-back shows the rules were replaced after the write', async () => {
    const fake = fakeMultipartS3(BUCKET);
    fake.lifecycle = doc(OTHER_RULE);
    const racing = async (req: Request): Promise<Response> => {
      const response = await fake.fetch(req);
      if (req.method === 'PUT') fake.lifecycle = doc(CONCURRENT_RULE);
      return response;
    };
    const error = await setup({ fetch: racing }, fake)
      .apply()
      .catch((e: unknown) => e);
    expect(codeOf(error)).toBe('lifecycle_failed');
  });

  it('fails when another writer changes the content of a kept rule that keeps its ID (M1-6b-c)', async () => {
    const fake = fakeMultipartS3(BUCKET);
    fake.lifecycle = doc(OTHER_RULE);
    const racing = async (req: Request): Promise<Response> => {
      const response = await fake.fetch(req);
      if (req.method === 'PUT') {
        fake.lifecycle = (fake.lifecycle ?? '').replace('<Prefix>logs/</Prefix>', '<Prefix>other/</Prefix>');
      }
      return response;
    };
    const error = await setup({ fetch: racing }, fake)
      .apply()
      .catch((e: unknown) => e);
    expect(codeOf(error)).toBe('lifecycle_failed');
    expect((error as Error).message).not.toContain(ENDPOINT);
  });

  it('fails when our own rule changes in content but keeps its days (M1-6b-c)', async () => {
    const fake = fakeMultipartS3(BUCKET);
    fake.lifecycle = doc(OTHER_RULE);
    const racing = async (req: Request): Promise<Response> => {
      const response = await fake.fetch(req);
      if (req.method === 'PUT') {
        fake.lifecycle = (fake.lifecycle ?? '').replace('<Prefix>agentlink/</Prefix>', '<Prefix>x/</Prefix>');
      }
      return response;
    };
    const error = await setup({ fetch: racing }, fake)
      .apply()
      .catch((e: unknown) => e);
    expect(codeOf(error)).toBe('lifecycle_failed');
  });

  it('still succeeds when the provider only reformats whitespace between elements (M1-6b-c)', async () => {
    const fake = fakeMultipartS3(BUCKET);
    fake.lifecycle = doc(OTHER_RULE);
    const racing = async (req: Request): Promise<Response> => {
      const response = await fake.fetch(req);
      if (req.method === 'PUT') fake.lifecycle = (fake.lifecycle ?? '').replace(/></g, '>\n  <');
      return response;
    };
    await setup({ fetch: racing }, fake).apply();
  });
});
