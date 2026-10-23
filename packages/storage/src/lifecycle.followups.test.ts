// M1-6b-b L3: the lifecycle read-modify-write is not atomic on S3 (no conditional write), so the helper
// re-reads before writing, retries on a change, and checks the result by reading it back (07 §5.2).
import { describe, expect, it } from 'vitest';
import { captureOutput } from '@4thtech-io/log/testing';
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
        fake.lifecycle = (fake.lifecycle ?? '').replace(
          '<Prefix>logs/</Prefix>',
          '<Prefix>other/</Prefix>',
        );
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
        fake.lifecycle = (fake.lifecycle ?? '').replace(
          '<Prefix>agentlink/</Prefix>',
          '<Prefix>x/</Prefix>',
        );
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

  let fakeRef: FakeMultipartS3;
  const runWith = async (rewrite: (doc: string) => string): Promise<unknown> => {
    fakeRef = fakeMultipartS3(BUCKET);
    fakeRef.lifecycle = doc(OTHER_RULE);
    const fetchRewrite = async (req: Request): Promise<Response> => {
      const response = await fakeRef.fetch(req);
      if (req.method === 'PUT') fakeRef.lifecycle = rewrite(fakeRef.lifecycle ?? '');
      return response;
    };
    return setup({ fetch: fetchRewrite }, fakeRef)
      .apply()
      .then(() => 'ok')
      .catch((e: unknown) => e);
  };
  const own30 = `<Rule><ID>${LIFECYCLE_RULE_ID}</ID><Filter><Prefix>agentlink/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>30</Days></Expiration><AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule>`;

  it('accepts a MinIO-style rewrite: abort element dropped, order changed, empty placeholders (M1-6b-c)', async () => {
    const minio = `<Rule><Expiration><Days>30</Days><ExpiredObjectDeleteMarker>false</ExpiredObjectDeleteMarker></Expiration><ID>${LIFECYCLE_RULE_ID}</ID><Filter><Prefix>agentlink/</Prefix></Filter><NoncurrentVersionExpiration></NoncurrentVersionExpiration><Status>Enabled</Status></Rule>`;
    expect(await runWith((d) => d.replace(own30, minio))).toBe('ok');
  });

  it('accepts an R2/S3-style rewrite: And-wrapped filter, legacy prefix and empty elements (M1-6b-c)', async () => {
    const wrapped = own30.replace(
      '<Filter><Prefix>agentlink/</Prefix></Filter>',
      '<Filter><And><Prefix>agentlink/</Prefix></And></Filter>',
    );
    expect(await runWith((d) => d.replace(own30, wrapped))).toBe('ok');
    const legacy = own30.replace(
      '<Filter><Prefix>agentlink/</Prefix></Filter>',
      '<Prefix>agentlink/</Prefix><Filter/>',
    );
    expect(await runWith((d) => d.replace(own30, legacy))).toBe('ok');
  });

  it('rejects changed content: status, days, a tag, a transition, a different abort (M1-6b-c)', async () => {
    const edits: Array<[string, string]> = [
      ['<Status>Enabled</Status>', '<Status>Disabled</Status>'],
      ['<Days>30</Days>', '<Days>3</Days>'],
      ['</Filter>', '<Tag><Key>a</Key><Value>b</Value></Tag></Filter>'],
      [
        '</Rule>',
        '<Transition><Days>5</Days><StorageClass>GLACIER</StorageClass></Transition></Rule>',
      ],
      ['<DaysAfterInitiation>1<', '<DaysAfterInitiation>9<'],
    ];
    for (const [from, to] of edits) {
      const result = await runWith((d) => d.replace(from, to));
      expect(codeOf(result)).toBe('lifecycle_failed');
    }
  });

  it('rejects a kept rule whose value changed (M1-6b-c)', async () => {
    const result = await runWith((d) => d.replace('<Days>7</Days>', '<Days>8</Days>'));
    expect(codeOf(result)).toBe('lifecycle_failed');
  });
});

describe('lifecycle: provider drops the abort-incomplete element (M1-6b-d)', () => {
  const dropAbort = (fake: FakeMultipartS3) => async (req: Request): Promise<Response> => {
    const response = await fake.fetch(req);
    if (req.method === 'PUT') {
      fake.lifecycle = (fake.lifecycle ?? '').replace(
        /<AbortIncompleteMultipartUpload>[\s\S]*?<\/AbortIncompleteMultipartUpload>/,
        '',
      );
    }
    return response;
  };

  it('succeeds but reports a plain-words warning when the element was dropped', async () => {
    const fake = fakeMultipartS3(BUCKET);
    fake.lifecycle = doc(OTHER_RULE);
    const result = await setup({ fetch: dropAbort(fake) }, fake).apply();
    expect(result.abortIncomplete).toBe('dropped');
    expect(result.warning).toMatch(/unfinished uploads/i);
    expect(result.warning).not.toMatch(/https?:|wallet|gas|multipart/i);
  });

  it('reports no warning when the provider keeps the element', async () => {
    const fake = fakeMultipartS3(BUCKET);
    const result = await setup({}, fake).apply();
    expect(result.abortIncomplete).toBe('kept');
    expect(result.warning).toBeNull();
  });

  it('logs the warning without a URL, bucket name or credential', async () => {
    const fake = fakeMultipartS3(BUCKET);
    const lines = await captureOutput(async ({ logger }) => {
      await setup({ fetch: dropAbort(fake), logger }, fake).apply();
    });
    const all = lines.map((l) => l.line).join('\n');
    expect(all).toContain('abort');
    for (const needle of ['AKIDLIFECYCLEL3', 'l3-secret', ENDPOINT, BUCKET, 'X-Amz-']) {
      expect(all).not.toContain(needle);
    }
  });
});
