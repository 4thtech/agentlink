// W4-SHORT-INVITE (D-139): short-invite objects on the encrypted drop (07 §5.4 `POST /v1/invite`,
// `GET /v1/i/{lookupId}`, `DELETE /v1/i/{lookupId}`, the `POST /v1/report` invite form, Limits
// "Invite objects" and State; 04 §3.6.2 and §4 "Invite objects"). Runs in its own Miniflare project
// (vitest.config.ts `drop-invite`) with the spec's invite limits and a high per-IP signed-request
// ceiling, so the per-key invite limits are what the tests meet. Drop keys are fixed test scalars and
// lookupIds are random test values; nothing here is a real secret.
//
// Internal names the tests read directly (as drop.test.ts reads `metrics:<n>`): an invite object's
// state lives in the Durable Object `inv:<hex of the 16 lookupId bytes>`, its bytes in R2 under
// `i/<hex of the 16 lookupId bytes>`, never under the request string.
import { SELF, env as testEnv, runDurableObjectAlarm } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBase64url, encodeBase64url, encodeHex, encodeUtf8 } from '@4thtech-io/crypto';
import { signDropAuthorization } from '@4thtech-io/crypto/testing';
import type { DropEnv } from '../src/lib.js';

const env = testEnv as DropEnv;

const HOST = 'https://drop.test';
const INVITE_ORIGIN = 'https://invite.example';
const FILE_ORIGIN = 'https://console.example';
const MAX_OBJECT = 17_441;
const HOUR = 3600;
const DAY = 86_400;

// Everything a log line must never contain (canary block at the end).
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
      captured.push(args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '));
    };
  }
});

afterAll(() => {
  const target = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const [method, original] of originals) target[method] = original;
});

let keyCounter = 0;
function newKey(): Uint8Array {
  keyCounter += 1;
  const key = new Uint8Array(32);
  key[31] = keyCounter & 0xff;
  key[30] = (keyCounter >> 8) & 0xff;
  key[0] = 0x33;
  return key;
}

let ipCounter = 0;
function newIp(): string {
  ipCounter += 1;
  return `203.0.${String(100 + Math.floor(ipCounter / 250))}.${String(ipCounter % 250)}`;
}

const now = (): number => Math.floor(Date.now() / 1000);

function nonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const text = encodeBase64url(bytes);
  secrets.add(text);
  return text;
}

/** A fresh random lookupId (16 bytes, canonical base64url: 22 chars ending in A, Q, g or w). */
function newLookupId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const text = encodeBase64url(bytes);
  secrets.add(text);
  return text;
}

const hexOf = (lookupId: string): string => encodeHex(decodeBase64url(lookupId, { length: 16 }));

/** An `ALI1` v1 object of `size` bytes (header, then filler standing in for ciphertext and tag). */
function aliObject(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  out.set([0x41, 0x4c, 0x49, 0x31, 0x01]);
  for (let i = 5; i < size; i += 1) out[i] = (i * 29 + seed) & 0xff;
  return out;
}

interface Signed {
  readonly url: string;
  readonly method: 'POST' | 'DELETE';
  readonly text: string;
  readonly key: Uint8Array;
  readonly ip: string;
  readonly ts: number;
}

async function signedFetch(request: Signed): Promise<Response> {
  const { authorization, pubkey } = signDropAuthorization(
    request.key,
    { method: request.method, url: request.url, body: encodeUtf8(request.text) },
    request.ts,
  );
  secrets.add(pubkey);
  secrets.add(authorization.slice('Nostr '.length));
  return SELF.fetch(request.url, {
    method: request.method,
    headers: {
      authorization,
      'content-type': 'application/json',
      'cf-connecting-ip': request.ip,
    },
    body: request.text,
  });
}

interface InviteOptions {
  readonly object?: Uint8Array | string;
  readonly expiresAt?: number;
  readonly extra?: Record<string, unknown>;
}

async function uploadInvite(
  key: Uint8Array,
  ip: string,
  lookupId: string,
  options: InviteOptions = {},
): Promise<Response> {
  const ts = now();
  const object =
    typeof options.object === 'string'
      ? options.object
      : encodeBase64url(options.object ?? aliObject(2_081));
  const body = {
    v: 1,
    lookupId,
    expiresAt: options.expiresAt ?? ts + 3 * DAY,
    object,
    nonce: nonce(),
    ts,
    ...options.extra,
  };
  return signedFetch({
    url: `${HOST}/v1/invite`,
    method: 'POST',
    text: JSON.stringify(body),
    key,
    ip,
    ts,
  });
}

async function deleteInvite(
  key: Uint8Array,
  ip: string,
  lookupId: string,
  bodyLookupId = lookupId,
): Promise<Response> {
  const ts = now();
  return signedFetch({
    url: `${HOST}/v1/i/${lookupId}`,
    method: 'DELETE',
    text: JSON.stringify({ v: 1, lookupId: bodyLookupId, nonce: nonce(), ts }),
    key,
    ip,
    ts,
  });
}

async function fetchInvite(
  lookupId: string,
  ip: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(`${HOST}/v1/i/${lookupId}`, {
    headers: { 'cf-connecting-ip': ip, ...headers },
  });
}

async function report(lookupId: unknown, ip: string, reason = 'spam'): Promise<Response> {
  return SELF.fetch(`${HOST}/v1/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ v: 1, lookupId, reason }),
  });
}

async function expectUniform404(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'not_found' });
}

async function stored(lookupId: string): Promise<boolean> {
  return (await env.DROP_BUCKET.head(`i/${hexOf(lookupId)}`)) !== null;
}

/** Runs from the start of a fresh hour of faked Date (timers and I/O stay real). */
function startFakeHour(): void {
  const start = (Math.floor(Date.now() / 1000 / HOUR) + 1) * HOUR + 5;
  vi.useFakeTimers({ toFake: ['Date'], now: start * 1000 });
}

function advance(seconds: number): void {
  vi.setSystemTime(Date.now() + seconds * 1000);
}

describe('POST /v1/invite and GET /v1/i/{lookupId}', () => {
  it('round-trips an invite object with the documented headers', async () => {
    const key = newKey();
    const lookupId = newLookupId();
    const object = aliObject(3_105, 7);
    const ts = now();
    const response = await uploadInvite(key, newIp(), lookupId, {
      object,
      expiresAt: ts + 2 * DAY,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ expiresAt: ts + 2 * DAY });

    const got = await fetchInvite(lookupId, newIp());
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('application/octet-stream');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('cache-control')).toBe('no-store');
    expect(got.headers.get('referrer-policy')).toBe('no-referrer');
    expect(got.headers.get('access-control-allow-origin')).toBeNull();
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(object);
  });

  it('stores the bytes under the decoded lookupId, never the request string', async () => {
    const lookupId = newLookupId();
    expect((await uploadInvite(newKey(), newIp(), lookupId)).status).toBe(201);
    expect(await stored(lookupId)).toBe(true);
    const listed = await env.DROP_BUCKET.list({ prefix: 'i/' });
    expect(listed.objects.some((o) => o.key.includes(lookupId))).toBe(false);
  });

  it('refuses an existing lookupId with conflict and never overwrites it', async () => {
    const lookupId = newLookupId();
    const first = aliObject(1_200, 1);
    expect((await uploadInvite(newKey(), newIp(), lookupId, { object: first })).status).toBe(201);
    for (const key of [newKey(), newKey()]) {
      const again = await uploadInvite(key, newIp(), lookupId, { object: aliObject(1_300, 2) });
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: 'conflict' });
    }
    const got = await fetchInvite(lookupId, newIp());
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(first);
  });

  it('accepts an object of exactly 17 441 bytes and refuses 17 442', async () => {
    const key = newKey();
    const ip = newIp();
    const okId = newLookupId();
    expect((await uploadInvite(key, ip, okId, { object: aliObject(MAX_OBJECT) })).status).toBe(201);
    const got = await fetchInvite(okId, newIp());
    expect((await got.arrayBuffer()).byteLength).toBe(MAX_OBJECT);

    const bigId = newLookupId();
    const big = await uploadInvite(key, ip, bigId, { object: aliObject(MAX_OBJECT + 1) });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'limit', limit: 'size' });
    expect(await stored(bigId)).toBe(false);
  });

  it('refuses a wrong magic or version, a too-short object and a non-canonical encoding', async () => {
    const key = newKey();
    const ip = newIp();
    const badMagic = aliObject(1_200);
    badMagic[0] = 0x42; // "BLI1"
    const badVersion = aliObject(1_200);
    badVersion[4] = 0x02;
    const alf = aliObject(1_200);
    alf.set([0x41, 0x4c, 0x46, 0x31]); // a file object, "ALF1"
    const valid = encodeBase64url(aliObject(1_201));
    for (const object of [
      badMagic,
      badVersion,
      alf,
      aliObject(32), // header (17) + tag (16) is the least an ALI1 object can be
      `${valid}=`, // padding
      valid.replace(/^./, '+'), // a character outside base64url
      `${valid.slice(0, -1)}B`, // non-zero trailing bits
      '',
    ]) {
      const lookupId = newLookupId();
      const response = await uploadInvite(key, ip, lookupId, { object });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'bad_request' });
      expect(await stored(lookupId)).toBe(false);
    }
  });

  it('refuses a non-strict lookupId in the body', async () => {
    const key = newKey();
    const ip = newIp();
    const good = newLookupId();
    for (const lookupId of [
      good.slice(0, 21),
      `${good}A`,
      `${good.slice(0, 21)}B`,
      `${good.slice(0, 20)}==`,
      `${good.slice(0, 21)}+`,
      12345,
    ]) {
      const response = await uploadInvite(key, ip, lookupId as string);
      expect(response.status).toBe(400);
    }
  });

  it('refuses an expiresAt beyond 7 days, in the past or not an integer, and extra fields', async () => {
    const key = newKey();
    const ip = newIp();
    const ts = now();
    for (const options of [
      { expiresAt: ts + 7 * DAY + 60 },
      { expiresAt: ts - 1 },
      { expiresAt: ts },
      { extra: { expiresAt: 'soon' } },
      { extra: { label: 'x' } },
    ] as InviteOptions[]) {
      const response = await uploadInvite(key, ip, newLookupId(), options);
      expect(response.status).toBe(400);
    }
    expect((await uploadInvite(key, ip, newLookupId(), { expiresAt: ts + 7 * DAY })).status).toBe(
      201,
    );
  });

  it('refuses an unsigned or wrongly signed upload', async () => {
    const text = JSON.stringify({
      v: 1,
      lookupId: newLookupId(),
      expiresAt: now() + DAY,
      object: encodeBase64url(aliObject(1_200)),
      nonce: nonce(),
      ts: now(),
    });
    const unsigned = await SELF.fetch(`${HOST}/v1/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': newIp() },
      body: text,
    });
    expect(unsigned.status).toBe(401);
    // Signed for the upload route, sent to the invite route: the URL binding fails.
    const ts = now();
    const { authorization } = signDropAuthorization(
      newKey(),
      { method: 'POST', url: `${HOST}/v1/upload`, body: encodeUtf8(text) },
      ts,
    );
    const crossRoute = await SELF.fetch(`${HOST}/v1/invite`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'cf-connecting-ip': newIp() },
      body: text,
    });
    expect(crossRoute.status).toBe(401);
  });

  it('refuses an invite body above its own cap', async () => {
    const response = await uploadInvite(newKey(), newIp(), newLookupId(), {
      extra: { pad: 'x'.repeat(24 * 1024) },
    });
    expect(response.status).toBe(400);
  });

  it('only GET, OPTIONS and DELETE reach /v1/i/{lookupId}', async () => {
    const lookupId = newLookupId();
    for (const method of ['POST', 'PUT', 'PATCH']) {
      const response = await SELF.fetch(`${HOST}/v1/i/${lookupId}`, {
        method,
        headers: { 'cf-connecting-ip': newIp() },
      });
      expect(response.status).toBe(405);
    }
    const get = await SELF.fetch(`${HOST}/v1/invite`, { headers: { 'cf-connecting-ip': newIp() } });
    expect(get.status).toBe(405);
  });
});

describe('strict lookupId on GET', () => {
  it('answers the uniform 404 for every non-strict form, without a lookup', async () => {
    const lookupId = newLookupId();
    expect((await uploadInvite(newKey(), newIp(), lookupId)).status).toBe(201);
    const nonCanonical = `${lookupId.slice(0, 21)}${
      { A: 'B', Q: 'R', g: 'h', w: 'x' }[lookupId.slice(-1)] ?? 'B'
    }`;
    const ip = newIp();
    const forms = [
      lookupId.slice(0, 21),
      `${lookupId}A`,
      `${lookupId}=`,
      `${lookupId.slice(0, 20)}==`,
      `${lookupId.slice(0, 21)}+`,
      `${lookupId.slice(0, 10)}/${lookupId.slice(11)}`,
      nonCanonical, // decodes to the same 16 bytes under a lax decoder: must not alias
      `%${encodeHex(encodeUtf8(lookupId.slice(0, 1))).toUpperCase()}${lookupId.slice(1)}`,
      `${lookupId.slice(0, 21)}%${encodeHex(encodeUtf8(lookupId.slice(-1))).toUpperCase()}`,
      '',
    ];
    // More malformed requests than the per-IP fetch limit (30): none of them reaches a Durable
    // Object, so none is counted, and the strict fetch below still answers.
    for (let round = 0; round < 4; round += 1) {
      for (const form of forms) {
        await expectUniform404(await fetchInvite(form, ip));
      }
    }
    const ok = await fetchInvite(lookupId, ip);
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
  });

  it('two strings never alias one object', async () => {
    const lookupId = newLookupId();
    expect((await uploadInvite(newKey(), newIp(), lookupId)).status).toBe(201);
    const last = lookupId.slice(-1);
    const sibling = `${lookupId.slice(0, 21)}${String.fromCharCode(last.charCodeAt(0) + 1)}`;
    await expectUniform404(await fetchInvite(sibling, newIp()));
    // The same non-canonical form cannot be used to upload a second object either.
    const response = await uploadInvite(newKey(), newIp(), sibling);
    expect(response.status).toBe(400);
  });
});

describe('download limit, expiry and the uniform 404', () => {
  it('serves 8 downloads, then answers the same 404 as an unknown object', async () => {
    const lookupId = newLookupId();
    expect((await uploadInvite(newKey(), newIp(), lookupId)).status).toBe(201);
    for (let i = 0; i < 8; i += 1) {
      const response = await fetchInvite(lookupId, newIp());
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    const used = await fetchInvite(lookupId, newIp());
    const unknown = await fetchInvite(newLookupId(), newIp());
    expect(used.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await used.text()).toBe(await unknown.text());
    expect([...used.headers.entries()].sort()).toEqual([...unknown.headers.entries()].sort());
  });

  it('answers the uniform 404 after expiresAt, and the alarm deletes the bytes', async () => {
    startFakeHour();
    try {
      const lookupId = newLookupId();
      const ts = now();
      expect(
        (await uploadInvite(newKey(), newIp(), lookupId, { expiresAt: ts + 120 })).status,
      ).toBe(201);
      const fresh = await fetchInvite(lookupId, newIp());
      expect(fresh.status).toBe(200);
      await fresh.arrayBuffer();
      advance(121);
      await expectUniform404(await fetchInvite(lookupId, newIp()));
      const stub = env.DROP_STATE.get(env.DROP_STATE.idFromName(`inv:${hexOf(lookupId)}`));
      await runDurableObjectAlarm(stub);
      expect(await stored(lookupId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fetch limits', () => {
  it('limits one IP to 30 fetches per hour, 404s included, before any lookup', async () => {
    const lookupId = newLookupId();
    expect((await uploadInvite(newKey(), newIp(), lookupId)).status).toBe(201);
    const ip = newIp();
    for (let i = 0; i < 30; i += 1) await expectUniform404(await fetchInvite(newLookupId(), ip));
    const limited = await fetchInvite(lookupId, ip);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited', retryable: true });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // The refused fetch used none of the object's downloads.
    const elsewhere = await fetchInvite(lookupId, newIp());
    expect(elsewhere.status).toBe(200);
    await elsewhere.arrayBuffer();
  });

  it('counts IPv6 fetches per /64', async () => {
    const prefix = '2001:db8:77:1';
    for (let i = 0; i < 30; i += 1) {
      await expectUniform404(await fetchInvite(newLookupId(), `${prefix}::${String(i + 1)}`));
    }
    const limited = await fetchInvite(newLookupId(), `${prefix}:ffff::1`);
    expect(limited.status).toBe(429);
    await limited.arrayBuffer();
    await expectUniform404(await fetchInvite(newLookupId(), '2001:db8:77:2::1'));
  });
});

describe('per-key invite limits', () => {
  it('allows 20 invite uploads per hour per drop key', async () => {
    startFakeHour();
    try {
      const key = newKey();
      const ip = newIp();
      for (let i = 0; i < 20; i += 1) {
        expect((await uploadInvite(key, ip, newLookupId())).status).toBe(201);
      }
      const limited = await uploadInvite(key, ip, newLookupId());
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: 'rate_limited', retryable: true });
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      // Another key from the same IP is not affected.
      expect((await uploadInvite(newKey(), ip, newLookupId())).status).toBe(201);
      advance(HOUR);
      expect((await uploadInvite(key, ip, newLookupId())).status).toBe(201);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows 100 invite uploads per rolling 24 hours per drop key', async () => {
    startFakeHour();
    try {
      const key = newKey();
      const ip = newIp();
      // 5 hours of 20 uploads, each deleted again so the live cap (50) is never the limit.
      for (let hour = 0; hour < 5; hour += 1) {
        for (let i = 0; i < 20; i += 1) {
          const lookupId = newLookupId();
          expect((await uploadInvite(key, ip, lookupId)).status).toBe(201);
          expect((await deleteInvite(key, ip, lookupId)).status).toBe(204);
        }
        advance(HOUR);
      }
      const limited = await uploadInvite(key, ip, newLookupId());
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      advance(19 * HOUR + 60);
      expect((await uploadInvite(key, ip, newLookupId())).status).toBe(201);
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);

  it('allows 50 live invite objects; delete, report, use-up and expiry free a slot', async () => {
    startFakeHour();
    try {
      const key = newKey();
      const ip = newIp();
      const ids: string[] = [];
      const first = now();
      // The first object expires soon; the others last three days.
      for (let i = 0; i < 50; i += 1) {
        if (i > 0 && i % 20 === 0) advance(HOUR);
        const lookupId = newLookupId();
        const expiresAt = i === 0 ? first + 2 * HOUR + 600 : now() + 3 * DAY;
        expect((await uploadInvite(key, ip, lookupId, { expiresAt })).status).toBe(201);
        ids.push(lookupId);
      }
      const full = await uploadInvite(key, ip, newLookupId());
      expect(full.status).toBe(429);
      await full.arrayBuffer();

      // DELETE by the uploader frees one.
      expect((await deleteInvite(key, ip, ids[1] ?? '')).status).toBe(204);
      expect((await uploadInvite(key, ip, newLookupId())).status).toBe(201);
      expect((await uploadInvite(key, ip, newLookupId())).status).toBe(429);

      // A report frees one.
      expect((await report(ids[2], newIp())).status).toBe(202);
      expect((await uploadInvite(key, ip, newLookupId())).status).toBe(201);
      expect((await uploadInvite(key, ip, newLookupId())).status).toBe(429);

      // Using up the download limit frees one.
      for (let i = 0; i < 8; i += 1) {
        const response = await fetchInvite(ids[3] ?? '', newIp());
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      }
      expect((await uploadInvite(key, ip, newLookupId())).status).toBe(201);
      expect((await uploadInvite(key, ip, newLookupId())).status).toBe(429);

      // Expiry (the object's alarm) frees one.
      advance(HOUR);
      const stub = env.DROP_STATE.get(env.DROP_STATE.idFromName(`inv:${hexOf(ids[0] ?? '')}`));
      await runDurableObjectAlarm(stub);
      expect(await stored(ids[0] ?? '')).toBe(false);
      expect((await uploadInvite(key, ip, newLookupId())).status).toBe(201);
      expect((await uploadInvite(key, ip, newLookupId())).status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);

  it('applies the per-IP fresh-key admission to a first invite upload', async () => {
    // The test project admits 3 fresh drop keys per IP per day (DROP_IP_NEW_KEYS_PER_DAY).
    const ip = newIp();
    for (let i = 0; i < 3; i += 1) {
      expect((await uploadInvite(newKey(), ip, newLookupId())).status).toBe(201);
    }
    const lookupId = newLookupId();
    const limited = await uploadInvite(newKey(), ip, lookupId);
    expect(limited.status).toBe(429);
    await limited.arrayBuffer();
    expect(await stored(lookupId)).toBe(false);
  });

  it('a refused upload uses none of the key quota, rate or live slots', async () => {
    startFakeHour();
    try {
      const key = newKey();
      const ip = newIp();
      const taken = newLookupId();
      expect((await uploadInvite(newKey(), newIp(), taken)).status).toBe(201);
      // 19 successes and 5 conflicts in one hour: the conflicts are refunded, so the 20th succeeds.
      for (let i = 0; i < 5; i += 1) {
        expect((await uploadInvite(key, ip, taken)).status).toBe(409);
      }
      for (let i = 0; i < 20; i += 1) {
        expect((await uploadInvite(key, ip, newLookupId())).status).toBe(201);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DELETE /v1/i/{lookupId}', () => {
  it('only the uploading drop key can delete; afterwards the uniform 404', async () => {
    const key = newKey();
    const ip = newIp();
    const lookupId = newLookupId();
    expect((await uploadInvite(key, ip, lookupId)).status).toBe(201);
    const other = await deleteInvite(newKey(), newIp(), lookupId);
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: 'forbidden' });
    expect(await stored(lookupId)).toBe(true);

    const own = await deleteInvite(key, ip, lookupId);
    expect(own.status).toBe(204);
    expect(await stored(lookupId)).toBe(false);
    await expectUniform404(await fetchInvite(lookupId, newIp()));
    const again = await deleteInvite(key, ip, lookupId);
    expect(again.status).toBe(404);
    await again.arrayBuffer();
  });

  it('refuses a body lookupId other than the path value, and a non-strict path', async () => {
    const key = newKey();
    const ip = newIp();
    const lookupId = newLookupId();
    expect((await uploadInvite(key, ip, lookupId)).status).toBe(201);
    const mismatch = await deleteInvite(key, ip, lookupId, newLookupId());
    expect(mismatch.status).toBe(400);
    const nonStrict = `${lookupId.slice(0, 21)}B`;
    await expectUniform404(await deleteInvite(key, ip, nonStrict));
    expect(await stored(lookupId)).toBe(true);
  });
});

describe('POST /v1/report with a lookupId', () => {
  it('deletes only that invite object and answers the same whether or not it existed', async () => {
    const reported = newLookupId();
    const kept = newLookupId();
    const key = newKey();
    const ip = newIp();
    expect((await uploadInvite(key, ip, reported)).status).toBe(201);
    expect((await uploadInvite(key, ip, kept)).status).toBe(201);

    const existing = await report(reported, newIp(), 'malware');
    const missing = await report(newLookupId(), newIp(), 'malware');
    expect(existing.status).toBe(202);
    expect(missing.status).toBe(202);
    expect(await existing.text()).toBe(await missing.text());

    await expectUniform404(await fetchInvite(reported, newIp()));
    expect(await stored(reported)).toBe(false);
    const ok = await fetchInvite(kept, newIp());
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
    // The uploading key is never blocked.
    expect((await uploadInvite(key, ip, newLookupId())).status).toBe(201);
  });

  it('refuses a malformed invite report', async () => {
    const lookupId = newLookupId();
    for (const body of [
      { v: 1, lookupId, reason: 'nope' },
      { v: 1, lookupId: `${lookupId.slice(0, 21)}B`, reason: 'spam' },
      { v: 1, lookupId, reason: 'spam', url: 'https://drop.test/v1/get/x' },
      { v: 2, lookupId, reason: 'spam' },
    ]) {
      const response = await SELF.fetch(`${HOST}/v1/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': newIp() },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });

  it('applies the per-IP report limit', async () => {
    const ip = newIp();
    for (let i = 0; i < 20; i += 1) expect((await report(newLookupId(), ip)).status).toBe(202);
    const limited = await report(newLookupId(), ip);
    expect(limited.status).toBe(429);
    await limited.arrayBuffer();
  });
});

describe('CORS on invite fetches', () => {
  it('allows only the invite host origin, and the file GET keeps its own origins', async () => {
    const lookupId = newLookupId();
    expect((await uploadInvite(newKey(), newIp(), lookupId)).status).toBe(201);

    const preflight = await SELF.fetch(`${HOST}/v1/i/${lookupId}`, {
      method: 'OPTIONS',
      headers: { origin: INVITE_ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(INVITE_ORIGIN);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET');
    expect(preflight.headers.get('vary')).toContain('Origin');

    for (const [origin, method] of [
      [FILE_ORIGIN, 'GET'],
      ['https://evil.example', 'GET'],
      [INVITE_ORIGIN, 'DELETE'],
    ] as const) {
      const refused = await SELF.fetch(`${HOST}/v1/i/${lookupId}`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': method },
      });
      expect(refused.status).toBe(403);
      expect(refused.headers.get('access-control-allow-origin')).toBeNull();
    }

    const allowed = await fetchInvite(lookupId, newIp(), { origin: INVITE_ORIGIN });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(INVITE_ORIGIN);
    await allowed.arrayBuffer();
    const console_ = await fetchInvite(lookupId, newIp(), { origin: FILE_ORIGIN });
    expect(console_.status).toBe(200);
    expect(console_.headers.get('access-control-allow-origin')).toBeNull();
    await console_.arrayBuffer();
    // A 404 carries no CORS header for any origin.
    const missing = await fetchInvite(newLookupId(), newIp(), { origin: INVITE_ORIGIN });
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();
  });

  it('the invite origin gets no CORS on file GETs or on POST /v1/invite', async () => {
    const preflight = await SELF.fetch(`${HOST}/v1/get/${newLookupId()}?e=1&m=x`, {
      method: 'OPTIONS',
      headers: { origin: INVITE_ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    const invite = await SELF.fetch(`${HOST}/v1/invite`, {
      method: 'OPTIONS',
      headers: { origin: INVITE_ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(invite.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('signed body cap of the other routes', () => {
  it('stays 1024 bytes for upload, commit and DELETE', async () => {
    const key = newKey();
    for (const [method, path, fields] of [
      ['POST', '/v1/upload', { size: 1000, expiresAt: now() + DAY }],
      ['POST', `/v1/o/${newLookupId()}/commit`, { objectId: 'x', ciphertextSha256: 'y' }],
      ['DELETE', `/v1/o/${newLookupId()}`, { objectId: 'x' }],
    ] as const) {
      const ts = now();
      const text = JSON.stringify({ v: 1, ...fields, pad: 'x'.repeat(1100), nonce: nonce(), ts });
      const response = await signedFetch({
        url: `${HOST}${path}`,
        method,
        text,
        key,
        ip: newIp(),
        ts,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'bad_request' });
    }
  });
});

// Runs last in this file.
describe('canary: no lookupId, drop key, signature or nonce is logged or a metric label (I-7)', () => {
  it('nothing the tests sent reached the console', () => {
    expect(secrets.size).toBeGreaterThan(50);
    const found: string[] = [];
    for (const value of secrets) {
      if (value.length < 8) continue;
      if (captured.some((line) => line.includes(value))) found.push(value.slice(0, 6));
    }
    expect(found).toEqual([]);
  });

  it('the invite metrics are fixed names and carry no identifier', async () => {
    const metrics: Record<string, number> = {};
    for (let shard = 0; shard < 8; shard += 1) {
      const stub = env.DROP_STATE.get(env.DROP_STATE.idFromName(`metrics:${String(shard)}`));
      for (const [name, value] of Object.entries(await stub.metrics())) {
        metrics[name] = (metrics[name] ?? 0) + value;
      }
    }
    expect(metrics.invite_upload).toBeGreaterThan(0);
    expect(metrics.invite_download).toBeGreaterThan(0);
    for (const name of Object.keys(metrics)) {
      expect(name).toMatch(/^[a-z_]+$/);
      for (const value of secrets) expect(name.includes(value)).toBe(false);
    }
  });
});
