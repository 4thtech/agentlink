// M1-7f: a file through the encrypted drop (D-48) between two in-process agents, with no own storage
// configured: the real drop Worker (apps/drop, M1-27a) under Miniflare (workerd), as in
// packages/storage's drop.worker.test.ts. The sender's core signs every drop request with its
// KeyStore's drop key (KeyStore.signDropRequest, M1-1g-e); the recipient downloads the signed GET
// URL from the payload. Test limits (vitest.config.ts, project `drop-worker`): 8 MiB per file.
import { SELF } from 'cloudflare:test';
import { MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { encodeHex, sha256, type JsonObject } from '@4thtech-io/crypto';
import type { FetchLike } from '@4thtech-io/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { rowKeyOf } from '../store/store.js';
import type { Sealed } from '../store/schema.js';
import { FakeClock, passphrase, seed } from '../testing/fixtures.js';
import {
  INBOX,
  deliver,
  fileBytes,
  openFileAgent,
  outgoing,
  pairForFiles,
  type FileAgent,
} from '../testing/files.js';

const ORIGIN = 'https://drop.test';
const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);
const ownerA = new MemoryOwnerKeyStore(seed(221), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(222), passphrase());

/** Every request that reached the drop, as the drop saw it. */
const seen: { method: string; url: string; body: string; headers: string }[] = [];

let ip = 0;
function dropFetch(): FetchLike {
  ip += 1;
  const addr = `203.0.113.${String(ip)}`;
  return async (request) => {
    const body = new Uint8Array(await request.clone().arrayBuffer());
    seen.push({
      method: request.method,
      url: request.url,
      body: new TextDecoder('utf-8', { fatal: false }).decode(body),
      headers: JSON.stringify([...request.headers]),
    });
    const headers = new Headers(request.headers);
    headers.set('cf-connecting-ip', addr);
    return SELF.fetch(
      new Request(request.url, {
        method: request.method,
        headers,
        ...(request.method === 'GET' ? {} : { body }),
        redirect: 'manual',
      }),
    );
  };
}

let clock: FakeClock;
let a: FileAgent;
let b: FileAgent;

beforeEach(async () => {
  seen.length = 0;
  // The drop Worker checks request times against its own clock: the agents use the real one.
  clock = new FakeClock(Math.floor(Date.now() / 1000));
  a = await openFileAgent(clock, 21, ownerA, 'alice', {
    relays: RELAYS_A,
    drop: { endpoint: ORIGIN, fetch: dropFetch() },
  });
  b = await openFileAgent(clock, 22, ownerB, 'bob', {
    relays: RELAYS_B,
    drop: { endpoint: ORIGIN, fetch: dropFetch() },
    // The recipient's download: the signed GET URL from the payload, read to the byte cap.
    download: (url) => async (maxBytes, onChunk) => {
      const response = await SELF.fetch(new Request(url, { redirect: 'manual' }));
      if (response.status !== 200 || response.body === null) throw new Error('download failed');
      const reader = response.body.getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        await onChunk(value);
        if (total > maxBytes) break;
      }
    },
  });
  await pairForFiles(clock, a, b);
});

describe('a file through the encrypted drop, no own storage (D-48, 07 §5.6)', () => {
  it('a 5 MB file: ciphertext only at the drop, verified and saved by the recipient', async () => {
    const bytes = fileBytes(5_000_000, 'DROP-PLAINTEXT-MARKER-7f');
    const sent = await a.client.sendMessage({
      to: b.id,
      text: 'big file',
      files: [outgoing('big.bin', bytes)],
    });
    expect(sent).toMatchObject({ status: 'ok', files: [{ index: 0, delivery: 'drop' }] });
    if (sent.status !== 'ok') return;

    // Zero access: the drop saw no name, no plaintext, no file key.
    for (const r of seen) {
      expect(r.url.startsWith(`${ORIGIN}/v1/`)).toBe(true);
      expect(r.body).not.toContain('big.bin');
      expect(r.body).not.toContain('DROP-PLAINTEXT-MARKER-7f');
    }

    await deliver(a, b);
    const fetched = await b.client.fetchFile({ envelopeId: sent.envelopeId });
    expect(fetched).toEqual({
      status: 'ok',
      savedTo: `${INBOX}/big.bin`,
      name: 'big.bin',
      size: 5_000_000,
      integrity: 'verified',
    });
    const saved = b.inbox.files().get('big.bin') as Uint8Array;
    expect(encodeHex(sha256(saved))).toBe(encodeHex(sha256(bytes)));
  }, 120_000);

  it('the drop locator (a signed GET URL) is stored sealed and never logged (I-7)', async () => {
    const sent = await a.client.sendMessage({
      to: b.id,
      text: 'file',
      files: [outgoing('note.txt', fileBytes(40_000))],
    });
    if (sent.status !== 'ok') throw new Error('not sent');
    await deliver(a, b);
    expect((await b.client.fetchFile({ envelopeId: sent.envelopeId })).status).toBe('ok');

    const row = (await a.store.transaction((tx) => tx.select('files')))[0];
    const locator = JSON.parse(
      await a.cipher.open(
        { table: 'files', column: 'locator', rowKey: rowKeyOf([sent.envelopeId, 0]) },
        row?.locator as Sealed,
      ),
    ) as JsonObject;
    expect(locator.kind).toBe('drop');
    const url = locator.locator as string;
    expect(url).toMatch(
      /^https:\/\/drop\.test\/v1\/get\/[A-Za-z0-9_-]{22}\?e=\d+&m=[A-Za-z0-9_-]{43}$/,
    );
    const objectId = /\/v1\/get\/([A-Za-z0-9_-]{22})/.exec(url)?.[1] as string;
    const mac = /&m=([A-Za-z0-9_-]{43})/.exec(url)?.[1] as string;

    for (const line of [...a.lines, ...b.lines]) {
      for (const canary of [url, objectId, mac]) expect(line).not.toContain(canary);
    }
    for (const agent of [a, b]) {
      const raw = await agent.store.transaction((tx) =>
        JSON.stringify([tx.select('envelopes'), tx.select('files'), tx.select('outbox')]),
      );
      for (const canary of [url, objectId, mac]) expect(raw).not.toContain(canary);
    }
  });
});
