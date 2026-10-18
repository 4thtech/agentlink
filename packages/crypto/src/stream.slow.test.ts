// M1-1d acceptance, slow-tagged: 1 GiB through ALF1 encrypt and decrypt in Node (Web Streams, 1 MiB
// default chunks) with resident-set growth under 64 MiB, so a large file never fully loads into
// memory (07 §5.2). It runs only when AGENTLINK_SLOW_TESTS=1:
//   AGENTLINK_SLOW_TESTS=1 pnpm --filter @agentlink/crypto exec vitest run src/stream.slow.test.ts
//
// Baseline: the same pipeline first carries 256 MiB, and growth is measured from there. A fresh Node
// process grows its RSS by about 100-250 MiB on first use of WebCrypto AES-GCM at 1 MiB per call
// (allocator pools and JIT; measured on macOS with WebCrypto alone, no ALF1 code, and flat between a
// 1 GiB and a 3 GiB file), which says nothing about how much of the file is held. A failure reports
// both figures.
import { describe, expect, it } from 'vitest';
import {
  alf1DecryptStream,
  alf1EncryptStream,
  createSha256,
  equalBytes,
  type Alf1Digests,
} from './index.js';

interface NodeProcess {
  readonly env: Record<string, string | undefined>;
  memoryUsage: { rss(): number };
}
const nodeProcess = (globalThis as { process?: NodeProcess }).process;
const SLOW = nodeProcess?.env.AGENTLINK_SLOW_TESTS === '1';

const MIB = 1024 * 1024;
const WRITE = 64 * 1024;
const RSS_LIMIT = 64 * MIB;
const rss = (): number => nodeProcess?.memoryUsage.rss() ?? 0;

interface Run {
  readonly peakRss: number;
  readonly received: number;
  readonly sameBytes: boolean;
  readonly enc: Alf1Digests;
  readonly dec: Alf1Digests;
}

/** Writes `bytes` of varied plaintext through encrypt, then decrypt, sampling RSS as it goes. */
async function pipeline(bytes: number): Promise<Run> {
  const key = new Uint8Array(32).fill(9);
  const enc = alf1EncryptStream(key);
  const dec = alf1DecryptStream(key);
  const sentHash = createSha256();
  const gotHash = createSha256();
  const block = new Uint8Array(WRITE);
  let peakRss = rss();
  let received = 0;

  const writing = (async () => {
    const writer = enc.writable.getWriter();
    for (let i = 0; i < bytes / WRITE; i += 1) {
      // Different bytes per block, so a reordered or repeated chunk would change the hash.
      block.fill(i & 0xff);
      new DataView(block.buffer).setUint32(0, i);
      sentHash.update(block);
      await writer.write(block.slice());
      if ((i & 255) === 0) peakRss = Math.max(peakRss, rss());
    }
    await writer.close();
  })();
  const forwarding = (async () => {
    const reader = enc.readable.getReader();
    const writer = dec.writable.getWriter();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      await writer.write(r.value);
    }
    await writer.close();
  })();
  const reading = (async () => {
    const reader = dec.readable.getReader();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      gotHash.update(r.value);
      received += r.value.length;
    }
  })();
  await Promise.all([writing, forwarding, reading]);
  peakRss = Math.max(peakRss, rss());
  return {
    peakRss,
    received,
    sameBytes: equalBytes(sentHash.digest(), gotHash.digest()),
    enc: await enc.done,
    dec: await dec.done,
  };
}

describe.runIf(SLOW)('ALF1 1 GiB in bounded memory (slow)', () => {
  it('encrypts and decrypts 1 GiB with RSS growth under 64 MiB', async () => {
    const start = rss();
    await pipeline(256 * MIB);
    const baseline = rss();
    const run = await pipeline(1024 * MIB);
    const growth = run.peakRss - baseline;
    const figures = `warm-up growth ${Math.round((baseline - start) / MIB)} MiB, measured growth ${Math.round(growth / MIB)} MiB`;
    expect(run.received).toBe(1024 * MIB);
    expect(run.sameBytes).toBe(true);
    expect(run.enc.plaintextLength).toBe(1024 * MIB);
    expect(run.dec.ciphertextLength).toBe(run.enc.ciphertextLength);
    expect(equalBytes(run.enc.ciphertextSha256, run.dec.ciphertextSha256)).toBe(true);
    expect(growth, figures).toBeLessThan(RSS_LIMIT);
  }, 600_000);
});
