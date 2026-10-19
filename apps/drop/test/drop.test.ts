// M1-27a (D-48): the encrypted drop Worker under Miniflare (07 §5.4, 04 §4). Every request goes
// through the Worker's own fetch handler (SELF) with its R2 bucket and Durable Object bound as in
// vitest.config.ts (test limits: 8 MiB per file, 5 MiB parts, 20 MiB weekly quota per drop key,
// 3 new drop keys per IP per day). Drop keys are fixed test scalars; nothing here is a real secret.
//
// The canary block at the end runs after every other test of this file and searches everything the
// Worker wrote to the console, and every metric name it keeps, for the URLs, object IDs, drop keys,
// signatures and nonces the tests used (I-7, 04 §4 Logging).
import { SELF, env as testEnv } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSha256, encodeBase64url, encodeHex, encodeUtf8 } from '@4thtech-io/crypto';
import { signDropAuthorization } from '@4thtech-io/crypto/testing';
import type { DropEnv } from '../src/index.js';

const env = testEnv as DropEnv;

const HOST = 'https://drop.test';
const MiB = 1024 * 1024;
const ALLOWED_ORIGIN = 'https://console.example';

// Everything a log line must never contain, collected as the tests run (canary block below).
const secrets = new Set<string>();
const captured: string[] = [];
const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
const originals = new Map<string, (...args: unknown[]) => void>();

beforeAll(() => {
  const target = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const method of METHODS) {
    const original = target[method];
    if (original) originals.set(method, original);
    target[method] = (...args: unknown[]) => {
      captured.push(args.map((arg) => (typeof arg === 'string' ? arg : safeJson(arg))).join(' '));
    };
  }
});

afterAll(() => {
  const target = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const [method, original] of originals) target[method] = original;
});

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

let keyCounter = 0;
/** A fresh test drop key (a valid secp256k1 scalar, distinct per call). */
function newKey(): Uint8Array {
  keyCounter += 1;
  const key = new Uint8Array(32);
  key[31] = keyCounter & 0xff;
  key[30] = (keyCounter >> 8) & 0xff;
  key[0] = 0x11;
  return key;
}

let ipCounter = 0;
function newIp(): string {
  ipCounter += 1;
  return `198.51.${String(100 + Math.floor(ipCounter / 250))}.${String(ipCounter % 250)}`;
}

const now = (): number => Math.floor(Date.now() / 1000);

function nonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const text = encodeBase64url(bytes);
  secrets.add(text);
  return text;
}

function hashHex(data: Uint8Array): string {
  return encodeHex(createSha256().update(data).digest());
}

function bytesOf(size: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

interface Signed {
  readonly url: string;
  readonly method: 'POST' | 'DELETE';
  readonly body: Record<string, unknown>;
  readonly key: Uint8Array;
  readonly ip: string;
  readonly ts?: number;
  readonly tamper?: (authorization: string) => string;
}

async function signedFetch(request: Signed): Promise<Response> {
  const text = JSON.stringify(request.body);
  const body = encodeUtf8(text);
  const ts = request.ts ?? now();
  const { authorization, pubkey } = signDropAuthorization(
    request.key,
    { method: request.method, url: request.url, body },
    ts,
  );
  secrets.add(pubkey);
  secrets.add(authorization.slice('Nostr '.length));
  return SELF.fetch(request.url, {
    method: request.method,
    headers: {
      authorization: request.tamper ? request.tamper(authorization) : authorization,
      'content-type': 'application/json',
      'cf-connecting-ip': request.ip,
    },
    body: text,
  });
}

interface UploadGrant {
  readonly objectId: string;
  readonly uploadUrl?: string;
  readonly parts?: readonly { part: number; size: number; uploadUrl: string }[];
  readonly expiresAt: number;
}

async function requestUpload(
  key: Uint8Array,
  ip: string,
  size: number,
  options: { expiresAt?: number; ts?: number; nonce?: string } = {},
): Promise<Response> {
  const ts = options.ts ?? now();
  return signedFetch({
    url: `${HOST}/v1/upload`,
    method: 'POST',
    key,
    ip,
    ts,
    body: {
      v: 1,
      size,
      expiresAt: options.expiresAt ?? ts + 86_400,
      nonce: options.nonce ?? nonce(),
      ts,
    },
  });
}

async function grant(response: Response): Promise<UploadGrant> {
  expect(response.status).toBe(201);
  const body = (await response.json()) as UploadGrant;
  secrets.add(body.objectId);
  if (body.uploadUrl) secrets.add(body.uploadUrl);
  for (const part of body.parts ?? []) secrets.add(part.uploadUrl);
  return body;
}

async function put(url: string, data: Uint8Array, ip = '203.0.113.9'): Promise<Response> {
  return SELF.fetch(url, {
    method: 'PUT',
    body: data as Uint8Array<ArrayBuffer>,
    headers: { 'cf-connecting-ip': ip },
  });
}

async function commit(
  key: Uint8Array,
  ip: string,
  objectId: string,
  ciphertextSha256: string,
): Promise<Response> {
  const ts = now();
  return signedFetch({
    url: `${HOST}/v1/o/${objectId}/commit`,
    method: 'POST',
    key,
    ip,
    ts,
    body: { v: 1, objectId, ciphertextSha256, nonce: nonce(), ts },
  });
}

async function remove(key: Uint8Array, ip: string, objectId: string): Promise<Response> {
  const ts = now();
  return signedFetch({
    url: `${HOST}/v1/o/${objectId}`,
    method: 'DELETE',
    key,
    ip,
    ts,
    body: { v: 1, objectId, nonce: nonce(), ts },
  });
}

/** Upload, PUT and commit `data`; returns the getUrl. */
async function storeFile(
  key: Uint8Array,
  ip: string,
  data: Uint8Array,
  expiresAt?: number,
): Promise<{ objectId: string; getUrl: string; expiresAt: number }> {
  const g = await grant(await requestUpload(key, ip, data.length, expiresAt ? { expiresAt } : {}));
  if (g.uploadUrl) {
    expect((await put(g.uploadUrl, data)).status).toBe(201);
  } else {
    let offset = 0;
    for (const part of g.parts ?? []) {
      expect((await put(part.uploadUrl, data.subarray(offset, offset + part.size))).status).toBe(
        201,
      );
      offset += part.size;
    }
  }
  const response = await commit(key, ip, g.objectId, hashHex(data));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { getUrl: string; expiresAt: number };
  secrets.add(body.getUrl);
  return { objectId: g.objectId, getUrl: body.getUrl, expiresAt: body.expiresAt };
}

async function errorOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('health', () => {
  it('answers liveness only', async () => {
    const response = await SELF.fetch(`${HOST}/v1/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('answers 404 for unknown paths without echoing them', async () => {
    const response = await SELF.fetch(`${HOST}/v1/unknown-canary-path`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('unknown-canary-path');
  });
});

describe('upload, PUT, commit and GET', () => {
  it('round-trips a single-part object and serves it only as an attachment', async () => {
    const key = newKey();
    const ip = newIp();
    const data = bytesOf(20_000);
    const { getUrl, expiresAt } = await storeFile(key, ip, data);
    expect(getUrl.startsWith(`${HOST}/v1/get/`)).toBe(true);
    expect(expiresAt).toBeGreaterThan(now());
    const response = await SELF.fetch(getUrl);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(data);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toBe('attachment');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('stores objects under random IDs with no metadata', async () => {
    const key = newKey();
    const { objectId } = await storeFile(key, newIp(), bytesOf(13_000));
    expect(objectId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const listed = await env.DROP_BUCKET.list({ include: ['customMetadata', 'httpMetadata'] });
    const object = listed.objects.find((o) => o.key.endsWith(objectId));
    expect(object).toBeDefined();
    expect(object?.customMetadata ?? {}).toEqual({});
    expect(object?.httpMetadata?.contentType).toBeUndefined();
    expect(object?.httpMetadata?.contentDisposition).toBeUndefined();
  });
});

describe('signed requests', () => {
  it('refuses an invalid signature', async () => {
    const ts = now();
    const response = await signedFetch({
      url: `${HOST}/v1/upload`,
      method: 'POST',
      key: newKey(),
      ip: newIp(),
      ts,
      body: { v: 1, size: 20_000, expiresAt: ts + 3600, nonce: nonce(), ts },
      tamper: (auth) => auth.slice(0, -4) + (auth.endsWith('AAAA') ? 'BBBB' : 'AAAA'),
    });
    expect(response.status).toBe(401);
    expect((await errorOf(response)).error).toBe('unauthorized');
  });

  it('refuses a missing Authorization header', async () => {
    const response = await SELF.fetch(`${HOST}/v1/upload`, {
      method: 'POST',
      body: '{}',
      headers: { 'cf-connecting-ip': newIp() },
    });
    expect(response.status).toBe(401);
  });

  it('refuses a replayed nonce', async () => {
    const key = newKey();
    const ip = newIp();
    const ts = now();
    const n = nonce();
    const first = await requestUpload(key, ip, 20_000, { ts, nonce: n });
    expect(first.status).toBe(201);
    const replay = await requestUpload(key, ip, 20_000, { ts, nonce: n });
    expect(replay.status).toBe(409);
    expect((await errorOf(replay)).error).toBe('replayed');
  });

  it('refuses a stale timestamp', async () => {
    const response = await requestUpload(newKey(), newIp(), 20_000, { ts: now() - 600 });
    expect(response.status).toBe(401);
    expect((await errorOf(response)).error).toBe('stale');
  });

  it('refuses a body whose ts differs from the signed timestamp, and unknown fields', async () => {
    const key = newKey();
    const ip = newIp();
    const ts = now();
    const wrongTs = await signedFetch({
      url: `${HOST}/v1/upload`,
      method: 'POST',
      key,
      ip,
      ts,
      body: { v: 1, size: 20_000, expiresAt: ts + 3600, nonce: nonce(), ts: ts - 1 },
    });
    expect(wrongTs.status).toBe(400);
    const extra = await signedFetch({
      url: `${HOST}/v1/upload`,
      method: 'POST',
      key,
      ip,
      ts,
      body: { v: 1, size: 20_000, expiresAt: ts + 3600, nonce: nonce(), ts, name: 'report.pdf' },
    });
    expect(extra.status).toBe(400);
  });

  it('refuses an expiry beyond 7 days or in the past', async () => {
    const ts = now();
    const far = await requestUpload(newKey(), newIp(), 20_000, {
      ts,
      expiresAt: ts + 7 * 86_400 + 1,
    });
    expect(far.status).toBe(400);
    const past = await requestUpload(newKey(), newIp(), 20_000, { ts, expiresAt: ts - 1 });
    expect(past.status).toBe(400);
  });
});

describe('limits', () => {
  it('refuses a size above the cap with a typed limit error', async () => {
    const response = await requestUpload(newKey(), newIp(), 8 * MiB + 1);
    expect(response.status).toBe(413);
    expect(await errorOf(response)).toEqual({ error: 'limit', limit: 'size' });
  });

  it('refuses the upload that would exceed the weekly quota of a drop key', async () => {
    const key = newKey();
    const ip = newIp();
    expect((await requestUpload(key, ip, 8 * MiB)).status).toBe(201);
    expect((await requestUpload(key, ip, 8 * MiB)).status).toBe(201);
    const third = await requestUpload(key, ip, 8 * MiB);
    expect(third.status).toBe(403);
    expect(await errorOf(third)).toEqual({ error: 'limit', limit: 'quota' });
    // Within the remaining quota still works.
    expect((await requestUpload(key, ip, 4 * MiB)).status).toBe(201);
  });

  it('limits many fresh drop keys from one IP, with a retryable rate_limited error', async () => {
    const ip = newIp();
    for (let i = 0; i < 3; i += 1)
      expect((await requestUpload(newKey(), ip, 20_000)).status).toBe(201);
    const fourth = await requestUpload(newKey(), ip, 20_000);
    expect(fourth.status).toBe(429);
    expect(await errorOf(fourth)).toEqual({ error: 'rate_limited', retryable: true });
    expect(Number(fourth.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('counts IPv6 addresses per /64', async () => {
    const prefix = '2001:db8:aa:bb';
    const ips = [`${prefix}::1`, `${prefix}:1:2:3:4`, `${prefix}::ffff`, `${prefix}:0:0:0:9`];
    for (let i = 0; i < 3; i += 1) {
      expect((await requestUpload(newKey(), ips[i] ?? '', 20_000)).status).toBe(201);
    }
    expect((await requestUpload(newKey(), ips[3] ?? '', 20_000)).status).toBe(429);
    // Another /64 is unaffected.
    expect((await requestUpload(newKey(), '2001:db8:aa:bc::1', 20_000)).status).toBe(201);
  });

  it('keeps a known drop key working behind a shared IP once fresh keys are limited', async () => {
    const ip = newIp();
    const known = newKey();
    expect((await requestUpload(known, ip, 20_000)).status).toBe(201);
    for (let i = 0; i < 2; i += 1)
      expect((await requestUpload(newKey(), ip, 20_000)).status).toBe(201);
    expect((await requestUpload(newKey(), ip, 20_000)).status).toBe(429);
    expect((await requestUpload(known, ip, 20_000)).status).toBe(201);
  });
});

describe('per-IP ceiling', () => {
  it('limits every key from one IP only at the absolute ceiling, before any key state', async () => {
    // Test ceiling: 8 signed requests per IP per hour (vitest.config.ts). Two known keys behind one
    // address share it; the fresh-key admission (3 per day) is not what stops them.
    const ip = newIp();
    const a = newKey();
    const b = newKey();
    for (let i = 0; i < 4; i += 1) {
      expect((await requestUpload(a, ip, 20_000)).status).toBe(201);
      expect((await requestUpload(b, ip, 20_000)).status).toBe(201);
    }
    const over = await requestUpload(a, ip, 20_000);
    expect(over.status).toBe(429);
    expect(await errorOf(over)).toEqual({ error: 'rate_limited', retryable: true });
    // The same keys from another address still work: the ceiling is per IP, not per key.
    expect((await requestUpload(a, newIp(), 20_000)).status).toBe(201);
  });
});

describe('PUT target', () => {
  it('accepts exactly the declared size', async () => {
    const key = newKey();
    const ip = newIp();
    const g = await grant(await requestUpload(key, ip, 20_000));
    const short = await put(g.uploadUrl ?? '', bytesOf(19_999));
    expect(short.status).toBe(400);
    expect((await errorOf(short)).error).toBe('length_mismatch');
  });

  it('refuses a second PUT and never overwrites the stored object', async () => {
    const key = newKey();
    const ip = newIp();
    const data = bytesOf(20_000, 3);
    const g = await grant(await requestUpload(key, ip, data.length));
    expect((await put(g.uploadUrl ?? '', data)).status).toBe(201);
    const second = await put(g.uploadUrl ?? '', bytesOf(20_000, 4));
    expect(second.status).toBe(409);
    const committed = await commit(key, ip, g.objectId, hashHex(data));
    expect(committed.status).toBe(200);
  });

  it('refuses a tampered or expired target', async () => {
    const g = await grant(await requestUpload(newKey(), newIp(), 20_000));
    const url = new URL(g.uploadUrl ?? '');
    const mac = url.searchParams.get('m') ?? '';
    url.searchParams.set('m', mac.slice(0, -2) + (mac.endsWith('AA') ? 'BB' : 'AA'));
    expect((await put(url.toString(), bytesOf(20_000))).status).toBe(403);
    const expired = new URL(g.uploadUrl ?? '');
    expired.searchParams.set('e', String(now() - 1));
    expect((await put(expired.toString(), bytesOf(20_000))).status).toBe(403);
  });
});

describe('commit', () => {
  it('a wrong hash deletes the object and leaves nothing readable', async () => {
    const key = newKey();
    const ip = newIp();
    const data = bytesOf(20_000, 5);
    const g = await grant(await requestUpload(key, ip, data.length));
    expect((await put(g.uploadUrl ?? '', data)).status).toBe(201);
    const wrong = await commit(key, ip, g.objectId, hashHex(bytesOf(20_000, 6)));
    expect(wrong.status).toBe(422);
    expect((await errorOf(wrong)).error).toBe('hash_mismatch');
    const listed = await env.DROP_BUCKET.list();
    expect(listed.objects.some((o) => o.key.endsWith(g.objectId))).toBe(false);
    const retry = await commit(key, ip, g.objectId, hashHex(data));
    expect(retry.status).toBe(404);
  });

  it('only the uploading drop key can commit, and only after the PUT', async () => {
    const key = newKey();
    const ip = newIp();
    const data = bytesOf(20_000, 7);
    const g = await grant(await requestUpload(key, ip, data.length));
    expect((await commit(key, ip, g.objectId, hashHex(data))).status).toBe(409);
    expect((await put(g.uploadUrl ?? '', data)).status).toBe(201);
    expect((await commit(newKey(), ip, g.objectId, hashHex(data))).status).toBe(403);
    expect((await commit(key, ip, g.objectId, hashHex(data))).status).toBe(200);
  });
});

describe('GET', () => {
  it('refuses after expiresAt', async () => {
    const key = newKey();
    const ip = newIp();
    // Only Date is faked (timers and I/O stay real), so the expiry window cannot race a slow runner.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      const { getUrl, expiresAt } = await storeFile(key, ip, bytesOf(13_000), now() + 60);
      expect((await SELF.fetch(getUrl)).status).toBe(200);
      vi.setSystemTime((expiresAt + 1) * 1000);
      const late = await SELF.fetch(getUrl);
      expect(late.status).toBe(410);
      expect((await errorOf(late)).error).toBe('expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a tampered getUrl', async () => {
    const { getUrl } = await storeFile(newKey(), newIp(), bytesOf(13_000));
    const url = new URL(getUrl);
    url.searchParams.set('e', String(Number(url.searchParams.get('e')) + 60));
    expect((await SELF.fetch(url.toString())).status).toBe(403);
  });

  it('serves the maximum recipient set twice each, then refuses at the download limit', async () => {
    const { getUrl } = await storeFile(newKey(), newIp(), bytesOf(13_000));
    // 8 recipients (the envelope maximum, 04 §3.1.1), each fetching twice.
    for (let i = 0; i < 16; i += 1) {
      const response = await SELF.fetch(getUrl);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    const over = await SELF.fetch(getUrl);
    expect(over.status).toBe(403);
    expect(await errorOf(over)).toEqual({ error: 'limit', limit: 'downloads' });
  });
});

describe('DELETE', () => {
  it('is refused for another drop key and accepted for the uploader', async () => {
    const key = newKey();
    const ip = newIp();
    const { objectId, getUrl } = await storeFile(key, ip, bytesOf(13_000));
    const other = await remove(newKey(), ip, objectId);
    expect(other.status).toBe(403);
    expect((await SELF.fetch(getUrl)).status).toBe(200);
    expect((await remove(key, ip, objectId)).status).toBe(204);
    expect((await SELF.fetch(getUrl)).status).toBe(404);
    const listed = await env.DROP_BUCKET.list();
    expect(listed.objects.some((o) => o.key.endsWith(objectId))).toBe(false);
  });
});

describe('report', () => {
  it('deletes only the reported object and never blocks the drop key', async () => {
    const key = newKey();
    const ip = newIp();
    const reported = await storeFile(key, ip, bytesOf(13_000, 1));
    const kept = await storeFile(key, ip, bytesOf(13_000, 2));
    const response = await SELF.fetch(`${HOST}/v1/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': newIp() },
      body: JSON.stringify({ v: 1, url: reported.getUrl, reason: 'malware' }),
    });
    expect(response.status).toBe(202);
    expect((await SELF.fetch(reported.getUrl)).status).toBe(404);
    expect((await SELF.fetch(kept.getUrl)).status).toBe(200);
    expect((await requestUpload(key, ip, 20_000)).status).toBe(201);
  });

  it('refuses a report without a valid getUrl, or with extra fields', async () => {
    const { getUrl } = await storeFile(newKey(), newIp(), bytesOf(13_000, 3));
    const forged = new URL(getUrl);
    forged.searchParams.set('m', 'A'.repeat(43));
    for (const body of [
      { v: 1, url: forged.toString(), reason: 'malware' },
      { v: 1, url: getUrl, reason: 'malware', fileKey: 'x' },
      { v: 1, url: getUrl, reason: 'not-a-reason' },
      { v: 1, url: getUrl.replace(HOST, 'https://other.test'), reason: 'malware' },
    ]) {
      const response = await SELF.fetch(`${HOST}/v1/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': newIp() },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect((await SELF.fetch(getUrl)).status).toBe(200);
  });
});

describe('CORS', () => {
  it('answers the preflight for GET only to the documented origins', async () => {
    const { getUrl } = await storeFile(newKey(), newIp(), bytesOf(13_000));
    const ok = await SELF.fetch(getUrl, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(ok.headers.get('access-control-allow-methods')).toBe('GET');
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull();
    expect(ok.headers.get('vary')).toContain('Origin');

    const evil = await SELF.fetch(getUrl, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();

    const put = await SELF.fetch(getUrl, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'PUT' },
    });
    expect(put.status).toBe(403);

    const get = await SELF.fetch(getUrl, { headers: { origin: ALLOWED_ORIGIN } });
    expect(get.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    await get.arrayBuffer();
    const getEvil = await SELF.fetch(getUrl, { headers: { origin: 'https://evil.example' } });
    expect(getEvil.headers.get('access-control-allow-origin')).toBeNull();
    await getEvil.arrayBuffer();
  });

  it('never sends CORS headers on the other endpoints', async () => {
    for (const path of ['/v1/upload', '/v1/report', '/v1/health', '/v1/o/x/commit']) {
      const response = await SELF.fetch(`${HOST}${path}`, {
        method: 'OPTIONS',
        headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'POST' },
      });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
  });
});

// Runs last in this file (Vitest runs describe blocks in order).
describe('canary: nothing sensitive is logged or used as a metric label (I-7)', () => {
  function leaks(lines: readonly string[], values: Iterable<string>): string[] {
    const found: string[] = [];
    for (const value of values) {
      if (value.length < 8) continue;
      if (lines.some((line) => line.includes(value))) found.push(value.slice(0, 6));
    }
    return found;
  }

  it('the check itself finds a planted leak (negative control)', () => {
    expect(
      leaks(['upload https://drop.test/v1/get/abc?e=1&m=zzz'], ['https://drop.test/v1/get/abc']),
    ).toHaveLength(1);
  });

  it('the capture sees console output of this isolate, where the Worker runs (positive control)', () => {
    const before = captured.length;
    // eslint-disable-next-line no-console -- the positive control writes one line on purpose
    console.log('drop-canary-probe');
    expect(captured.slice(before)).toEqual(['drop-canary-probe']);
    captured.pop();
  });

  it('collected the values to search for', () => {
    expect(secrets.size).toBeGreaterThan(50);
  });

  it('no request URL, signed URL, object ID, drop key, signature or nonce reached the console', () => {
    // Also the path, query and object-ID parts of every URL on their own.
    const parts = new Set<string>(secrets);
    for (const value of secrets) {
      if (!value.startsWith('https://')) continue;
      const url = new URL(value);
      parts.add(url.pathname);
      for (const [, v] of url.searchParams) parts.add(v);
    }
    expect(leaks(captured, parts)).toEqual([]);
  });

  it('metric names are a fixed set and carry no identifier', async () => {
    const metrics: Record<string, number> = {};
    for (let shard = 0; shard < 8; shard += 1) {
      const stub = env.DROP_STATE.get(env.DROP_STATE.idFromName(`metrics:${String(shard)}`));
      for (const [name, value] of Object.entries(await stub.metrics())) {
        metrics[name] = (metrics[name] ?? 0) + value;
      }
    }
    // The global-cap instance never holds counters (IR-M1-27a-1 M-2).
    const global = env.DROP_STATE.get(env.DROP_STATE.idFromName('global'));
    expect(await global.metrics()).toEqual({});
    expect(metrics.upload_granted).toBeGreaterThan(0);
    const names = Object.keys(metrics);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^[a-z_]+$/);
    expect(leaks(names, secrets)).toEqual([]);
    for (const value of Object.values(metrics)) expect(typeof value).toBe('number');
  });
});
