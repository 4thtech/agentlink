// M1-6a acceptance: the adapters never write credentials, presigned URLs, URL query strings or object
// keys to any log or the console (I-7, 04 §4). Exercises every operation, including failures.
import { describe, expect, it } from 'vitest';
import { captureOutput } from '@agentlink/log/testing';
import { createInlineAdapter, createS3Adapter } from './index.js';
import {
  BUCKET,
  DAY_MS,
  ENDPOINT,
  NOW,
  bytes,
  fakeEndpoint,
  testPrefix,
} from './fake-s3.fixture.js';

const ACCESS_KEY_ID = 'AKIDCANARYKEYIDVALUE';
const SECRET = 'canary-secret-access-key-value';
const SESSION = 'canary-session-token-value';

describe('storage log canary', () => {
  it('logs no credentials, URLs, query strings or object keys', async () => {
    const seen: string[] = [];
    let failing = false;
    const fake = fakeEndpoint((req) => {
      if (failing) return new Response(`denied ${req.url}`, { status: 403 });
      return new Response(null, { status: req.method === 'DELETE' ? 204 : 200 });
    });
    const inADay = new Date(NOW.getTime() + DAY_MS);

    const lines = await captureOutput(async ({ logger }) => {
      const s3 = createS3Adapter({
        endpoint: ENDPOINT,
        bucket: BUCKET,
        storagePrefix: testPrefix(),
        credentials: async () => ({
          accessKeyId: ACCESS_KEY_ID,
          secretAccessKey: SECRET,
          sessionToken: SESSION,
          expiresAt: new Date(NOW.getTime() + 2 * DAY_MS),
        }),
        fetch: fake.fetch,
        now: () => NOW,
        logger,
      });
      const obj = await s3.put(bytes(64), { size: 64, expiresAt: inADay });
      seen.push(obj.locator, await s3.presignGet(obj, new Date(NOW.getTime() + 30 * DAY_MS)));
      await s3.delete(obj);
      failing = true;
      await s3.put(bytes(64), { size: 64, expiresAt: inADay }).catch(() => undefined);
      await s3.delete(obj).catch(() => undefined);

      const inline = createInlineAdapter({ logger });
      const small = await inline.put(bytes(8), { size: 8, expiresAt: inADay });
      seen.push(small.locator);
      await inline.presignGet(small, inADay).catch(() => undefined);
    });

    expect(lines.length).toBeGreaterThan(0);
    const all = lines.map((l) => l.line).join('\n');
    const presigned = seen[1]!;
    for (const needle of [
      ACCESS_KEY_ID,
      SECRET,
      SESSION,
      seen[0]!,
      presigned,
      new URL(presigned).search,
      'X-Amz-',
      'agentlink/',
      ENDPOINT,
      '?',
    ]) {
      expect(all).not.toContain(needle);
    }
  });
});
