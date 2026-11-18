// SEC-REFUSED-UPLOAD-CLEANUP through the encrypted drop (D-48): a send refused after the file was
// uploaded to the drop deletes it there (a DELETE signed by the drop key), keeps no row and logs no
// drop URL. The real drop Worker under Miniflare, as in files.worker.test.ts.
import { SELF } from 'cloudflare:test';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import type { FetchLike } from '@4thtech-io/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, passphrase, seed } from '../testing/fixtures.js';
import {
  fileBytes,
  openFileAgent,
  outgoing,
  pairForFiles,
  type FileAgent,
} from '../testing/files.js';

const ORIGIN = 'https://drop.test';
const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);
const ownerA = new MemoryOwnerKeyStore(seed(241), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(242), passphrase());

const seen: { method: string; url: string; status: number }[] = [];
/** Runs after each upload the drop answered. */
let afterUpload: (() => Promise<void>) | undefined;

let ip = 0;
function dropFetch(): FetchLike {
  ip += 1;
  const addr = `203.0.113.${String(40 + ip)}`;
  return async (request) => {
    const body = new Uint8Array(await request.clone().arrayBuffer());
    const headers = new Headers(request.headers);
    headers.set('cf-connecting-ip', addr);
    const response = await SELF.fetch(
      new Request(request.url, {
        method: request.method,
        headers,
        ...(request.method === 'GET' ? {} : { body }),
        redirect: 'manual',
      }),
    );
    seen.push({ method: request.method, url: request.url, status: response.status });
    if ((request.method === 'PUT' || request.method === 'POST') && response.ok) {
      await afterUpload?.();
    }
    return response;
  };
}

let clock: FakeClock;
let a: FileAgent;
let b: FileAgent;

beforeEach(async () => {
  seen.length = 0;
  afterUpload = undefined;
  clock = new FakeClock(Math.floor(Date.now() / 1000));
  a = await openFileAgent(clock, new MemoryKeyStore(seed(41)), ownerA, 'alice', {
    relays: RELAYS_A,
    drop: { endpoint: ORIGIN, fetch: dropFetch() },
  });
  b = await openFileAgent(clock, new MemoryKeyStore(seed(42)), ownerB, 'bob', {
    relays: RELAYS_B,
    drop: { endpoint: ORIGIN, fetch: dropFetch() },
  });
  await pairForFiles(clock, a, b);
});

describe('a refused send through the drop (D-48)', () => {
  it('a cap reached during the upload: the drop object is deleted, no row, no URL logged', async () => {
    afterUpload = async () => {
      await a.store.transaction((tx) => {
        if (tx.get('outgoing_log', { envelope_id: 'f'.repeat(64) }) !== undefined) return;
        tx.insert('outgoing_log', {
          envelope_id: 'f'.repeat(64),
          contact_id: b.id,
          t: clock.t,
          files: 100_000,
          bytes: 1,
        });
      });
    };
    const result = await a.client.sendMessage({
      to: b.id,
      text: 'big file',
      files: [outgoing('big.bin', fileBytes(200_000))],
    });
    expect(result).toMatchObject({ status: 'rejected', code: 'SEND_LIMIT' });
    const deletes = seen.filter((r) => r.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.status).toBe(204);
    expect(await a.store.transaction((tx) => tx.select('files'))).toHaveLength(0);
    for (const line of a.lines) expect(line).not.toContain(ORIGIN);
  }, 60_000);
});
