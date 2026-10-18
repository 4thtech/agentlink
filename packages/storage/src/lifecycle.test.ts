// M1-6b part 1: the bucket lifecycle helper (07 §5.2): a rule that deletes `agentlink/` objects after
// 30 days, set and read back, without touching the bucket's other rules. Against an in-memory S3.
import { describe, expect, it } from 'vitest';
import { captureOutput } from '@agentlink/log/testing';
import {
  LIFECYCLE_DEFAULT_DAYS,
  LIFECYCLE_PREFIX,
  LIFECYCLE_RULE_ID,
  StorageError,
  createS3Lifecycle,
  type S3LifecycleConfig,
} from './index.js';
import { BUCKET, ENDPOINT, NOW } from './fake-s3.fixture.js';
import { fakeMultipartS3, type FakeMultipartS3 } from './multipart.fixture.js';

const ACCESS_KEY_ID = 'AKIDLIFECYCLETESTONLY';
const SECRET = 'lifecycle-secret-access-key-never-logged';

function setup(
  over: Partial<S3LifecycleConfig> = {},
  fake: FakeMultipartS3 = fakeMultipartS3(BUCKET),
) {
  const lc = createS3Lifecycle({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    credentials: async () => ({ accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET }),
    fetch: fake.fetch,
    now: () => NOW,
    ...over,
  });
  return { lc, fake };
}

const codeOf = (e: unknown): string | undefined => (e instanceof StorageError ? e.code : undefined);

const OTHER_RULE =
  '<Rule><ID>keep-logs</ID><Filter><Prefix>logs/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>7</Days></Expiration></Rule>';

describe('lifecycle: constants', () => {
  it('covers agentlink/ objects with a 30-day default (07 §5.2)', () => {
    expect(LIFECYCLE_PREFIX).toBe('agentlink/');
    expect(LIFECYCLE_DEFAULT_DAYS).toBe(30);
    expect(LIFECYCLE_RULE_ID).toMatch(/^agentlink-/);
  });
});

describe('lifecycle: apply and read back', () => {
  it('sets the rule on a bucket with no lifecycle and reads it back', async () => {
    const { lc, fake } = setup();
    expect(await lc.read()).toBeNull();
    await lc.apply();
    expect(await lc.read()).toEqual({ prefix: 'agentlink/', days: 30, enabled: true });

    const put = fake.requests.find((r) => r.method === 'PUT')!;
    expect(put.url.searchParams.has('lifecycle')).toBe(true);
    expect(put.url.pathname).toBe(`/${BUCKET}`);
    expect(put.redirect).toBe('error');
    // A checksum the provider can verify (S3 requires one for this call); SHA-256, never MD5.
    expect(put.headers.get('x-amz-checksum-sha256')).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(put.headers.get('content-md5')).toBeNull();
    const doc = new TextDecoder().decode(put.body);
    expect(doc).toContain(`<ID>${LIFECYCLE_RULE_ID}</ID>`);
    expect(doc).toContain('<Prefix>agentlink/</Prefix>');
    expect(doc).toContain('<Days>30</Days>');
  });

  it('keeps the bucket’s other rules and replaces only its own', async () => {
    const fake = fakeMultipartS3(BUCKET);
    fake.lifecycle = `<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${OTHER_RULE}<Rule><ID>${LIFECYCLE_RULE_ID}</ID><Filter><Prefix>agentlink/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>90</Days></Expiration></Rule></LifecycleConfiguration>`;
    const { lc } = setup({}, fake);
    expect(await lc.read()).toEqual({ prefix: 'agentlink/', days: 90, enabled: true });
    await lc.apply({ days: 14 });
    expect(await lc.read()).toEqual({ prefix: 'agentlink/', days: 14, enabled: true });
    expect(fake.lifecycle).toContain(OTHER_RULE);
    expect(fake.lifecycle!.split(`<ID>${LIFECYCLE_RULE_ID}</ID>`)).toHaveLength(2);
  });

  it('is idempotent', async () => {
    const { lc, fake } = setup();
    await lc.apply();
    const first = fake.lifecycle;
    await lc.apply();
    expect(fake.lifecycle).toBe(first);
  });

  it('reads a rule with the legacy top-level Prefix form', async () => {
    const fake = fakeMultipartS3(BUCKET);
    fake.lifecycle = `<LifecycleConfiguration><Rule><ID>${LIFECYCLE_RULE_ID}</ID><Prefix>agentlink/</Prefix><Status>Disabled</Status><Expiration><Days>30</Days></Expiration></Rule></LifecycleConfiguration>`;
    const { lc } = setup({}, fake);
    expect(await lc.read()).toEqual({ prefix: 'agentlink/', days: 30, enabled: false });
  });

  it('returns null when the bucket has rules but none of its own', async () => {
    const fake = fakeMultipartS3(BUCKET);
    fake.lifecycle = `<LifecycleConfiguration>${OTHER_RULE}</LifecycleConfiguration>`;
    const { lc } = setup({}, fake);
    expect(await lc.read()).toBeNull();
  });

  it('refuses a number of days outside 1..3650 before any request', async () => {
    const { lc, fake } = setup();
    for (const days of [0, -1, 1.5, 3651, Number.NaN]) {
      expect(codeOf(await lc.apply({ days }).catch((e: unknown) => e)), String(days)).toBe(
        'invalid_argument',
      );
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe('lifecycle: failures', () => {
  it('maps a refused PUT to lifecycle_failed with the status only, never the response text', async () => {
    const fake = fakeMultipartS3(BUCKET);
    fake.override = (req) =>
      req.method === 'PUT'
        ? new Response(`<Error>AccessDenied ${req.url.toString()}</Error>`, { status: 403 })
        : undefined;
    const { lc } = setup({}, fake);
    const error = await lc.apply().catch((e: unknown) => e);
    expect(codeOf(error)).toBe('lifecycle_failed');
    expect((error as StorageError).status).toBe(403);
    expect((error as Error).message).not.toContain('AccessDenied');
    expect((error as Error).message).not.toContain(ENDPOINT);
  });

  it('maps a failed read to lifecycle_failed, and does not PUT over a configuration it could not read', async () => {
    const fake = fakeMultipartS3(BUCKET);
    fake.override = (req) =>
      req.method === 'GET' ? new Response('nope', { status: 500 }) : undefined;
    const { lc } = setup({}, fake);
    expect(codeOf(await lc.read().catch((e: unknown) => e))).toBe('lifecycle_failed');
    expect(codeOf(await lc.apply().catch((e: unknown) => e))).toBe('lifecycle_failed');
    expect(fake.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('refuses an oversized or malformed lifecycle document', async () => {
    for (const body of ['x'.repeat(300 * 1024), '<NotLifecycle/>']) {
      const fake = fakeMultipartS3(BUCKET);
      fake.override = (req) =>
        req.method === 'GET' ? new Response(body, { status: 200 }) : undefined;
      const { lc } = setup({}, fake);
      expect(codeOf(await lc.apply().catch((e: unknown) => e))).toBe('lifecycle_failed');
      expect(fake.requests.some((r) => r.method === 'PUT')).toBe(false);
    }
  });

  it('refuses a non-https, IP-literal or local endpoint before any request (04 §4)', () => {
    const fake = fakeMultipartS3(BUCKET);
    for (const endpoint of [
      'http://acct.r2.example.com',
      'https://10.0.0.1',
      'https://localhost:9000',
      'https://metadata.google.internal',
      'https://acct.r2.example.com/x?y',
    ]) {
      expect(() => setup({ endpoint }, fake), endpoint).toThrow(StorageError);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('logs no credentials, URLs or bucket names', async () => {
    const fake = fakeMultipartS3(BUCKET);
    const lines = await captureOutput(async ({ logger }) => {
      const { lc } = setup({ logger }, fake);
      await lc.apply();
      await lc.read();
      fake.override = () => new Response('denied', { status: 403 });
      await lc.apply().catch(() => undefined);
    });
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.map((l) => l.line).join('\n');
    for (const needle of [ACCESS_KEY_ID, SECRET, ENDPOINT, BUCKET, 'X-Amz-', '?', 'denied']) {
      expect(all).not.toContain(needle);
    }
  });
});
