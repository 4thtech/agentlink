// M1-27a: a multipart upload through the drop Worker (07 §5.4: one signed target per part, any order,
// each single-use). Its own Miniflare project (vitest.config.ts `drop-multipart`), so the 5 MiB part
// never queues the other tests of the single workerd isolate behind it (IR-M1-27a-1 H-1). The data is
// the smallest two-part object the R2 rules allow: one 5 MiB part (R2's minimum for a non-final part)
// and a 1 KiB final part.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createSha256, encodeBase64url, encodeHex, encodeUtf8 } from '@4thtech-io/crypto';
import { signDropAuthorization } from '@4thtech-io/crypto/testing';

const HOST = 'https://drop.test';
const PART = 5 * 1024 * 1024;
const IP = '192.0.2.50';

const SECRET = (() => {
  const out = new Uint8Array(32);
  out[0] = 0x33;
  out[31] = 1;
  return out;
})();

async function signedPost(
  url: string,
  body: Record<string, unknown>,
  ts: number,
): Promise<Response> {
  const text = JSON.stringify(body);
  const { authorization } = signDropAuthorization(
    SECRET,
    { method: 'POST', url, body: encodeUtf8(text) },
    ts,
  );
  return SELF.fetch(url, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', 'cf-connecting-ip': IP },
    body: text,
  });
}

function nonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return encodeBase64url(bytes);
}

/** A cheap deterministic fill: one 64 KiB block repeated, the last bytes varied by `seed`. */
function data(size: number, seed: number): Uint8Array<ArrayBuffer> {
  const block = new Uint8Array(65_536);
  for (let i = 0; i < block.length; i += 1) block[i] = (i * 31 + seed) & 0xff;
  const out = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += block.length) {
    out.set(block.subarray(0, Math.min(block.length, size - offset)), offset);
  }
  out[size - 1] = seed;
  return out;
}

describe('multipart', () => {
  it('round-trips a two-part object, parts in any order, each target single-use', async () => {
    const bytes = data(PART + 1024, 9);
    const ts = Math.floor(Date.now() / 1000);
    const granted = await signedPost(
      `${HOST}/v1/upload`,
      { v: 1, size: bytes.length, expiresAt: ts + 3600, nonce: nonce(), ts },
      ts,
    );
    expect(granted.status).toBe(201);
    const g = (await granted.json()) as {
      objectId: string;
      uploadUrl?: string;
      parts?: { part: number; size: number; uploadUrl: string }[];
    };
    expect(g.uploadUrl).toBeUndefined();
    expect(g.parts?.map((p) => [p.part, p.size])).toEqual([
      [1, PART],
      [2, 1024],
    ]);
    const [first, second] = g.parts ?? [];
    const put = (url: string, body: Uint8Array<ArrayBuffer>): Promise<Response> =>
      SELF.fetch(url, { method: 'PUT', body, headers: { 'cf-connecting-ip': IP } });
    expect((await put(second?.uploadUrl ?? '', bytes.subarray(PART))).status).toBe(201);
    expect((await put(first?.uploadUrl ?? '', bytes.subarray(0, PART))).status).toBe(201);
    expect((await put(second?.uploadUrl ?? '', bytes.subarray(PART))).status).toBe(409);

    const sha = encodeHex(createSha256().update(bytes).digest());
    const commitTs = Math.floor(Date.now() / 1000);
    const committed = await signedPost(
      `${HOST}/v1/o/${g.objectId}/commit`,
      { v: 1, objectId: g.objectId, ciphertextSha256: sha, nonce: nonce(), ts: commitTs },
      commitTs,
    );
    expect(committed.status).toBe(200);
    const { getUrl } = (await committed.json()) as { getUrl: string };
    const response = await SELF.fetch(getUrl);
    expect(response.status).toBe(200);
    const got = new Uint8Array(await response.arrayBuffer());
    expect(got.length).toBe(bytes.length);
    expect(encodeHex(createSha256().update(got).digest())).toBe(sha);
  });
});
