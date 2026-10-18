// M1-6c (D-48): the drop adapter against the real drop Worker (apps/drop, M1-27a) under Miniflare
// (workerd), with its in-memory R2 bucket and Durable Object. The adapter's injected fetch is the
// Worker's own fetch handler (SELF), wrapped to record every request that reaches the drop.
//
// Test limits (vitest.config.ts, project `drop-worker`): 8 MiB per file, 5 MiB parts (the R2
// minimum), 24 MiB weekly quota per drop key. Drop keys are fixed test scalars signed through the
// crypto test seam (signDropAuthorization), standing in for the KeyStore's drop-key signer.
//
// The 100 MiB round trip of the card is not run here: Miniflare's R2 took 32.6 s for 6 MiB of
// multipart on the Linux CI runner (IR-M1-27a-1 H-1). The 5 MB single-part and 6 MiB two-part
// round trips cover both upload shapes; 100 MiB is left to the deployed-drop smoke (M1-13c).
import { SELF, env as testEnv } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { encodeBase64url, encodeHex, encodeUtf8, sha256 } from '@4thtech-io/crypto';
import { signDropAuthorization } from '@4thtech-io/crypto/testing';
import { captureOutput } from '@4thtech-io/log/testing';
import { createDropAdapter, type DropAdapter } from './drop.js';
import { selectionForError } from './select.js';
import { decryptDownload } from './stream-download.js';
import { putEncrypted } from './stream-upload.js';
import type { ProvisionalSink } from './stream-sink.js';

interface R2Like {
  list(): Promise<{ objects: { key: string }[] }>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}
const env = testEnv as { DROP_BUCKET: R2Like };

const ORIGIN = 'https://drop.test';
const MiB = 1024 * 1024;
const DAY_MS = 86_400_000;
const MARKER = 'PLAINTEXT-MARKER-0c1a';

let keyCounter = 0;
function newKey(): Uint8Array {
  keyCounter += 1;
  const key = new Uint8Array(32);
  key[0] = 0x21;
  key[30] = (keyCounter >> 8) & 0xff;
  key[31] = keyCounter & 0xff;
  return key;
}

let ipCounter = 0;
function newIp(): string {
  ipCounter += 1;
  return `203.0.113.${String(ipCounter)}`;
}

interface Captured {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

function harness(opts: { maxBytes?: number } = {}) {
  const key = newKey();
  const ip = newIp();
  const requests: Captured[] = [];
  let lastPubkey = '';
  const make = (logger?: Parameters<typeof createDropAdapter>[0]['logger']): DropAdapter =>
    createDropAdapter({
      endpoint: ORIGIN,
      signer: {
        async signDropRequest(request, createdAt) {
          const { authorization, pubkey } = signDropAuthorization(key, request, createdAt);
          lastPubkey = pubkey;
          return authorization;
        },
      },
      fetch: async (request) => {
        const body = new Uint8Array(await request.clone().arrayBuffer());
        requests.push({ method: request.method, url: request.url, headers: request.headers, body });
        const headers = new Headers(request.headers);
        headers.set('cf-connecting-ip', ip);
        return SELF.fetch(
          new Request(request.url, {
            method: request.method,
            headers,
            redirect: request.redirect,
            ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body }),
          }),
        );
      },
      ...(logger === undefined ? {} : { logger }),
      ...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }),
    });
  return { key, ip, requests, make, pubkey: () => lastPubkey };
}

function plaintextOf(size: number): Uint8Array {
  const out = new Uint8Array(size);
  const marker = encodeUtf8(MARKER);
  for (let i = 0; i < size; i += 1) out[i] = marker[i % marker.length] ?? 0;
  return out;
}

function memorySink(): ProvisionalSink & { bytes(): Uint8Array; committed: boolean } {
  const chunks: Uint8Array[] = [];
  const sink = {
    committed: false,
    async write(chunk: Uint8Array) {
      chunks.push(new Uint8Array(chunk));
    },
    async commit() {
      sink.committed = true;
    },
    async discard() {
      chunks.length = 0;
    },
    bytes() {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      return out;
    },
  };
  return sink;
}

function includes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

async function roundTrip(size: number): Promise<void> {
  const h = harness();
  const adapter = h.make();
  const plaintext = plaintextOf(size);
  const result = await putEncrypted(adapter, plaintext, {
    plaintextSize: plaintext.length,
    expiresAt: new Date(Date.now() + DAY_MS),
  });
  const getUrl = await adapter.presignGet(result.object, new Date(Date.now() + DAY_MS));
  expect(new URL(getUrl).origin).toBe(ORIGIN);
  const response = await SELF.fetch(getUrl);
  expect(response.status).toBe(200);
  const sink = memorySink();
  const file = await decryptDownload(response.body!, sink, {
    fileKey: result.fileKey,
    plaintextSize: plaintext.length,
    ciphertextSha256: result.ciphertextSha256,
    plaintextSha256: result.plaintextSha256,
  });
  expect(sink.committed).toBe(true);
  expect(file.plaintextSize).toBe(size);
  expect(encodeHex(sha256(sink.bytes()))).toBe(encodeHex(sha256(plaintext)));
}

describe('drop adapter × drop Worker (Miniflare)', () => {
  it('round trip: the drop only ever receives ciphertext, never the plaintext or the file key', async () => {
    const h = harness();
    const plaintext = plaintextOf(200_000);
    let needles: string[] = [];
    const lines = await captureOutput(async ({ logger }) => {
      const adapter = h.make(logger);
      const result = await putEncrypted(adapter, plaintext, {
        plaintextSize: plaintext.length,
        expiresAt: new Date(Date.now() + DAY_MS),
      });
      const getUrl = await adapter.presignGet(result.object, new Date(Date.now() + DAY_MS));

      // What reached the drop: no plaintext, no file key (raw, hex or base64url), no file name.
      const fileKeyTexts = [encodeHex(result.fileKey), encodeBase64url(result.fileKey)];
      const marker = encodeUtf8(MARKER);
      expect(h.requests.length).toBeGreaterThanOrEqual(3);
      for (const r of h.requests) {
        expect(includes(r.body, marker)).toBe(false);
        expect(includes(r.body, result.fileKey)).toBe(false);
        const text = new TextDecoder().decode(r.body);
        for (const needle of fileKeyTexts) {
          expect(text).not.toContain(needle);
          expect(r.url).not.toContain(needle);
          for (const value of r.headers.values()) expect(value).not.toContain(needle);
        }
      }
      // And what the drop stored: ciphertext only.
      const listed = await env.DROP_BUCKET.list();
      for (const { key } of listed.objects) {
        const stored = await env.DROP_BUCKET.get(key);
        if (stored === null) continue;
        expect(includes(new Uint8Array(await stored.arrayBuffer()), marker)).toBe(false);
      }

      // The recipient's side: download and decrypt.
      const response = await SELF.fetch(getUrl);
      expect(response.status).toBe(200);
      const sink = memorySink();
      await decryptDownload(response.body!, sink, {
        fileKey: result.fileKey,
        plaintextSize: plaintext.length,
        ciphertextSha256: result.ciphertextSha256,
        plaintextSha256: result.plaintextSha256,
      });
      expect(sink.bytes()).toEqual(plaintext);

      // Retention: the uploading drop key deletes; the link stops working.
      await adapter.delete(result.object);
      expect((await SELF.fetch(getUrl)).status).toBe(404);

      // Canary needles: every URL the adapter used or returned, the drop key and the signatures.
      needles = [
        getUrl,
        ...h.requests.map((r) => r.url),
        h.pubkey(),
        ...h.requests
          .filter((r) => r.method !== 'PUT')
          .map((r) => (JSON.parse(new TextDecoder().decode(r.body)) as { nonce: string }).nonce),
        ...h.requests.map((r) => r.headers.get('authorization') ?? '').filter(Boolean),
      ];
    });
    expect(needles.length).toBeGreaterThan(3);
    const all = lines.map((l) => l.line).join('\n');
    for (const needle of [...needles, MARKER, '/v1/', 'drop.test']) {
      expect(all).not.toContain(needle);
    }
  });

  it('5 MB round trip (single PUT)', async () => {
    await roundTrip(5_000_000);
  }, 90_000);

  it('6 MiB round trip (multipart: one signed target per 5 MiB part)', async () => {
    const h = harness();
    const adapter = h.make();
    const plaintext = plaintextOf(6 * MiB);
    const result = await putEncrypted(adapter, plaintext, {
      plaintextSize: plaintext.length,
      expiresAt: new Date(Date.now() + DAY_MS),
    });
    const puts = h.requests.filter((r) => r.method === 'PUT');
    expect(puts.map((r) => new URL(r.url).pathname.split('/').pop())).toEqual(['1', '2']);
    const response = await SELF.fetch(await adapter.presignGet(result.object, new Date(Date.now() + DAY_MS)));
    const sink = memorySink();
    await decryptDownload(response.body!, sink, {
      fileKey: result.fileKey,
      plaintextSize: plaintext.length,
      ciphertextSha256: result.ciphertextSha256,
      plaintextSha256: result.plaintextSha256,
    });
    expect(sink.committed).toBe(true);
  }, 120_000);

  it('refuses an expired link: the adapter will not hand it out and the drop answers 410', async () => {
    const h = harness();
    const adapter = h.make();
    const ct = new Uint8Array(4_000).fill(9);
    const obj = await adapter.put(ct, { size: ct.length, expiresAt: new Date(Date.now() + 2_000) });
    const getUrl = await adapter.presignGet(obj, new Date(Date.now() + 2_000));
    expect((await SELF.fetch(getUrl)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 3_100));
    await expect(adapter.presignGet(obj, new Date(Date.now() + DAY_MS))).rejects.toMatchObject({
      code: 'expired',
    });
    expect((await SELF.fetch(getUrl)).status).toBe(410);
  });

  it('a size above the drop limit maps to needs_setup (size), with nothing uploaded', async () => {
    const h = harness();
    const adapter = h.make();
    const size = 8 * MiB + 1;
    const error = await adapter
      .put(new Uint8Array(size), { size, expiresAt: new Date(Date.now() + DAY_MS) })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'needs_setup', limit: 'size' });
    expect(selectionForError(error)).toEqual({ mode: 'needs_setup', reason: 'size' });
    expect(h.requests.map((r) => r.method)).toEqual(['POST']);
  });

  it('an exhausted weekly quota maps to needs_setup (quota)', async () => {
    const h = harness();
    // Reserve the 24 MiB quota with three raw 8 MiB grants signed by the same drop key.
    for (let i = 0; i < 3; i += 1) {
      const url = `${ORIGIN}/v1/upload`;
      const ts = Math.floor(Date.now() / 1000);
      const nonce = encodeBase64url(crypto.getRandomValues(new Uint8Array(16)));
      const text = JSON.stringify({ v: 1, size: 8 * MiB, expiresAt: ts + 3600, nonce, ts });
      const body = encodeUtf8(text);
      const { authorization } = signDropAuthorization(h.key, { method: 'POST', url, body }, ts);
      const response = await SELF.fetch(url, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json', 'cf-connecting-ip': h.ip },
        body: text,
      });
      expect(response.status).toBe(201);
    }
    const adapter = h.make();
    const error = await adapter
      .put(new Uint8Array(1_000), { size: 1_000, expiresAt: new Date(Date.now() + DAY_MS) })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'needs_setup', limit: 'quota' });
    expect(selectionForError(error)).toEqual({ mode: 'needs_setup', reason: 'quota' });
  });

  it('a replayed upload signature is rejected by the drop', async () => {
    const h = harness();
    const adapter = h.make();
    const ct = new Uint8Array(1_000).fill(5);
    await adapter.put(ct, { size: ct.length, expiresAt: new Date(Date.now() + DAY_MS) });
    const upload = h.requests.find((r) => new URL(r.url).pathname === '/v1/upload')!;
    const replay = await SELF.fetch(upload.url, {
      method: 'POST',
      headers: {
        authorization: upload.headers.get('authorization') ?? '',
        'content-type': 'application/json',
        'cf-connecting-ip': h.ip,
      },
      body: upload.body,
    });
    expect(replay.status).toBe(409);
  });

  it('only the uploading drop key can delete', async () => {
    const owner = harness();
    const obj = await owner
      .make()
      .put(new Uint8Array(500).fill(1), { size: 500, expiresAt: new Date(Date.now() + DAY_MS) });
    const other = harness().make();
    await expect(other.delete(obj)).rejects.toMatchObject({ code: 'delete_failed', status: 403 });
    const getUrl = await owner.make().presignGet(obj, new Date(Date.now() + DAY_MS));
    expect((await SELF.fetch(getUrl)).status).toBe(200);
  });
});
