// DROP-OPEN-1 (D-129): the drop's own protections still hold for a fresh ID on the default policy,
// with no tester list: the per-file size cap and the weekly quota per drop key. Test limits
// (vitest.config.ts, project `drop-worker-limits`): 32 KiB per file, 64 KiB a week, so it stays fast.
import { SELF } from 'cloudflare:test';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import type { FetchLike } from '@4thtech-io/storage';
import { describe, expect, it } from 'vitest';
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
// The drop Worker checks request times against its own clock: the agents use the real one.
const clock = new FakeClock(Math.floor(Date.now() / 1000));

let ip = 0;
function dropFetch(): FetchLike {
  ip += 1;
  const addr = `203.0.113.${String(ip)}`;
  return async (request) => {
    const body = new Uint8Array(await request.clone().arrayBuffer());
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

/** A fresh sender and recipient (new seeds, so new drop keys), paired, both on the drop only. */
async function freshPair(n: number): Promise<{ sender: FileAgent; recipient: FileAgent }> {
  const open = (i: number, name: string): Promise<FileAgent> =>
    openFileAgent(
      clock,
      new MemoryKeyStore(seed(n + i)),
      new MemoryOwnerKeyStore(seed(n + 10 + i), passphrase()),
      name,
      {
        relays: i === 0 ? RELAYS_A : RELAYS_B,
        drop: { endpoint: ORIGIN, fetch: dropFetch() },
      },
    );
  const sender = await open(0, 'carol');
  const recipient = await open(1, 'dave');
  await pairForFiles(clock, sender, recipient);
  return { sender, recipient };
}

describe('the drop limits still hold for a fresh ID (DROP-OPEN-1, D-129)', () => {
  it('the per-file size cap still holds: a file over it is refused with needs_setup', async () => {
    const { sender, recipient } = await freshPair(280);
    const sent = await sender.client.sendMessage({
      to: recipient.id,
      text: 'too big',
      files: [outgoing('huge.bin', fileBytes(40_000))],
    });
    expect(sent).toEqual({ status: 'needs_setup', reason: 'size' });
  });

  it('the weekly quota per drop key still holds: the upload that would pass it is refused', async () => {
    const { sender, recipient } = await freshPair(260);
    for (let i = 0; i < 3; i += 1) {
      const ok = await sender.client.sendMessage({
        to: recipient.id,
        text: `part ${String(i)}`,
        files: [outgoing(`part${String(i)}.bin`, fileBytes(20_000))],
      });
      expect(ok).toMatchObject({ status: 'ok', files: [{ index: 0, delivery: 'drop' }] });
    }
    const over = await sender.client.sendMessage({
      to: recipient.id,
      text: 'over quota',
      files: [outgoing('part3.bin', fileBytes(20_000))],
    });
    expect(over).toEqual({ status: 'needs_setup', reason: 'quota' });
  });
});
