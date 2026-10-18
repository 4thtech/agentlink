// M1-1d acceptance, slow-tagged: 1 GiB through ALF1 encrypt and decrypt in Node (Web Streams, 1 MiB
// default chunks) in bounded memory, so a large file never fully loads into memory (07 §5.2). It
// runs only when AGENTLINK_SLOW_TESTS=1:
//   AGENTLINK_SLOW_TESTS=1 pnpm --filter @agentlink/crypto exec vitest run src/stream.slow.test.ts
//
// Gates (IR-M1-1d-1 M-1; proposed wording for the card, owner confirms at merge):
// - after a 256 MiB warm-up, the peak of JS heap in use plus ArrayBuffer memory stays under 64 MiB
//   while 1 GiB goes through: what the process holds of the file;
// - the peak RSS of a 3 GiB run stays within 64 MiB of the peak RSS of the 1 GiB run: memory does
//   not grow with the file size.
// Raw RSS growth is not gated: a fresh Node process grows its RSS by about 100-250 MiB on first use
// of WebCrypto AES-GCM at 1 MiB per call (allocator pools and JIT; seen with WebCrypto alone, no
// ALF1 code), and the figure after warm-up is noisy. A failure message reports every figure.
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
  memoryUsage: {
    (): { readonly heapUsed: number; readonly arrayBuffers: number };
    rss(): number;
  };
}
const nodeProcess = (globalThis as { process?: NodeProcess }).process;
const SLOW = nodeProcess?.env.AGENTLINK_SLOW_TESTS === '1';

const MIB = 1024 * 1024;
const WRITE = 64 * 1024;
const LIMIT = 64 * MIB;
const rss = (): number => nodeProcess?.memoryUsage.rss() ?? 0;
/** JS heap in use plus ArrayBuffer memory: the buffers the process actually holds. */
const held = (): number => {
  const m = nodeProcess?.memoryUsage();
  return m === undefined ? 0 : m.heapUsed + m.arrayBuffers;
};

interface Run {
  readonly peakRss: number;
  readonly peakHeld: number;
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
  let peakHeld = held();
  let received = 0;

  const writing = (async () => {
    const writer = enc.writable.getWriter();
    for (let i = 0; i < bytes / WRITE; i += 1) {
      // Different bytes per block, so a reordered or repeated chunk would change the hash.
      block.fill(i & 0xff);
      new DataView(block.buffer).setUint32(0, i);
      sentHash.update(block);
      await writer.write(block.slice());
      if ((i & 255) === 0) {
        peakRss = Math.max(peakRss, rss());
        peakHeld = Math.max(peakHeld, held());
      }
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
  peakHeld = Math.max(peakHeld, held());
  return {
    peakRss,
    peakHeld,
    received,
    sameBytes: equalBytes(sentHash.digest(), gotHash.digest()),
    enc: await enc.done,
    dec: await dec.done,
  };
}

const mib = (bytes: number): number => Math.round(bytes / MIB);

describe.runIf(SLOW)('ALF1 1 GiB in bounded memory (slow)', () => {
  it('holds under 64 MiB for 1 GiB, and its RSS does not grow with the file size', async () => {
    const start = rss();
    await pipeline(256 * MIB);
    const baseline = rss();
    const run = await pipeline(1024 * MIB);
    const big = await pipeline(3072 * MIB);
    const figures =
      `RSS: start ${mib(start)}, after warm-up ${mib(baseline)}, 1 GiB peak ${mib(run.peakRss)}, ` +
      `3 GiB peak ${mib(big.peakRss)} MiB; held peak: 1 GiB ${mib(run.peakHeld)}, ` +
      `3 GiB ${mib(big.peakHeld)} MiB`;
    expect(run.received).toBe(1024 * MIB);
    expect(run.sameBytes).toBe(true);
    expect(run.enc.plaintextLength).toBe(1024 * MIB);
    expect(run.dec.ciphertextLength).toBe(run.enc.ciphertextLength);
    expect(equalBytes(run.enc.ciphertextSha256, run.dec.ciphertextSha256)).toBe(true);
    expect(big.received).toBe(3072 * MIB);
    expect(big.sameBytes).toBe(true);
    expect(run.peakHeld, figures).toBeLessThan(LIMIT);
    expect(big.peakHeld, figures).toBeLessThan(LIMIT);
    expect(big.peakRss - run.peakRss, figures).toBeLessThan(LIMIT);
  }, 900_000);
});
