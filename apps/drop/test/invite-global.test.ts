// W4-SHORT-INVITE (D-139): the global ceiling on unauthenticated invite fetches (07 §5.4 Limits,
// "Invite objects"). Runs in its own Miniflare project (vitest.config.ts `drop-invite-global`) whose
// ceiling is 40 invite fetches per hour instead of 20 000. Past it the drop answers a retryable
// `unavailable` (503, Retry-After) before any object is looked up.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { encodeBase64url, encodeUtf8 } from '@4thtech-io/crypto';
import { signDropAuthorization } from '@4thtech-io/crypto/testing';

const HOST = 'https://drop.test';

function lookupId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return encodeBase64url(bytes);
}

async function upload(id: string): Promise<Response> {
  const ts = Math.floor(Date.now() / 1000);
  const object = new Uint8Array(1_200);
  object.set([0x41, 0x4c, 0x49, 0x31, 0x01]);
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const text = JSON.stringify({
    v: 1,
    lookupId: id,
    expiresAt: ts + 3600,
    object: encodeBase64url(object),
    nonce: encodeBase64url(nonce),
    ts,
  });
  const key = new Uint8Array(32);
  key[0] = 0x44;
  key[31] = 1;
  const url = `${HOST}/v1/invite`;
  const { authorization } = signDropAuthorization(
    key,
    { method: 'POST', url, body: encodeUtf8(text) },
    ts,
  );
  return SELF.fetch(url, {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json',
      'cf-connecting-ip': '192.0.2.50',
    },
    body: text,
  });
}

describe('global invite fetch ceiling', () => {
  it('answers a retryable unavailable past the ceiling, without using a download', async () => {
    const id = lookupId();
    expect((await upload(id)).status).toBe(201);
    // 40 fetches from 4 IPs (10 each, under the per-IP limit): unknown IDs, all counted.
    for (let i = 0; i < 40; i += 1) {
      const response = await SELF.fetch(`${HOST}/v1/i/${lookupId()}`, {
        headers: { 'cf-connecting-ip': `192.0.2.${String(1 + (i % 4))}` },
      });
      expect(response.status).toBe(404);
      await response.arrayBuffer();
    }
    const over = await SELF.fetch(`${HOST}/v1/i/${id}`, {
      headers: { 'cf-connecting-ip': '192.0.2.9' },
    });
    expect(over.status).toBe(503);
    expect(await over.json()).toEqual({ error: 'unavailable', retryable: true });
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('a malformed lookupId is not counted toward the ceiling', async () => {
    // Already past the ceiling: a malformed ID still gets the uniform 404, not the 503, because
    // nothing is counted or looked up for it.
    const response = await SELF.fetch(`${HOST}/v1/i/${'A'.repeat(21)}B`, {
      headers: { 'cf-connecting-ip': '192.0.2.10' },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });
});
