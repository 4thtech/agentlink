// M1-27a (IR-D48-1 F10): when the global cap is exhausted the drop fails closed with a typed,
// retryable `unavailable` and stores nothing (07 §5.4 Limits, 04 §4). This file runs in its own
// Miniflare project (vitest.config.ts `drop-global-cap`) whose global cap is 1 MiB per day.
import { SELF, env as testEnv } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { encodeBase64url, encodeUtf8 } from '@4thtech-io/crypto';
import { signDropAuthorization } from '@4thtech-io/crypto/testing';
import type { DropEnv } from '../src/index.js';

const env = testEnv as DropEnv;

const HOST = 'https://drop.test';

function key(n: number): Uint8Array {
  const out = new Uint8Array(32);
  out[0] = 0x22;
  out[31] = n;
  return out;
}

async function requestUpload(secret: Uint8Array, ip: string, size: number): Promise<Response> {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const text = JSON.stringify({
    v: 1,
    size,
    expiresAt: ts + 3600,
    nonce: encodeBase64url(nonce),
    ts,
  });
  const url = `${HOST}/v1/upload`;
  const { authorization } = signDropAuthorization(
    secret,
    { method: 'POST', url, body: encodeUtf8(text) },
    ts,
  );
  return SELF.fetch(url, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: text,
  });
}

describe('global cap', () => {
  it('returns a retryable unavailable once the global cap is reached, and stores nothing', async () => {
    const first = await requestUpload(key(1), '192.0.2.1', 600 * 1024);
    expect(first.status).toBe(201);
    const { objectId } = (await first.json()) as { objectId: string };

    const second = await requestUpload(key(2), '192.0.2.2', 600 * 1024);
    expect(second.status).toBe(503);
    expect(await second.json()).toEqual({ error: 'unavailable', retryable: true });
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);

    // Only the first grant exists, and nothing has been written to the bucket for either.
    const listed = await env.DROP_BUCKET.list();
    expect(listed.objects.filter((o) => !o.key.endsWith(objectId))).toEqual([]);
    expect(listed.objects).toHaveLength(0);
  });

  it('a refused upload does not use up the drop key quota', async () => {
    // The key that was refused for the global cap can still upload once room exists (a smaller file
    // that fits under the remaining global allowance).
    const response = await requestUpload(key(2), '192.0.2.2', 300 * 1024);
    expect(response.status).toBe(201);
  });
});
