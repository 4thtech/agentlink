// M1-1d acceptance, slow-tagged: 1 GiB through ALF1 encrypt and decrypt in Node (Web Streams, 1 MiB
// default chunks) with resident-set growth under 64 MiB, so a large file never fully loads into
// memory (07 §5.2). It runs only when AGENTLINK_SLOW_TESTS=1:
//   AGENTLINK_SLOW_TESTS=1 pnpm --filter @agentlink/crypto exec vitest run src/stream.slow.test.ts
import { describe, expect, it } from 'vitest';
import {
  alf1DecryptStream,
  alf1EncryptStream,
  createSha256,
  equalBytes,
  type Alf1TransformStream,
} from './index.js';

interface NodeProcess {
  readonly env: Record<string, string | undefined>;
  memoryUsage: { rss(): number };
}
const nodeProcess = (globalThis as { process?: NodeProcess }).process;
const SLOW = nodeProcess?.env.AGENTLINK_SLOW_TESTS === '1';

const GIB = 1024 * 1024 * 1024;
const WRITE = 64 * 1024;
const RSS_LIMIT = 64 * 1024 * 1024;

/** Reads `from` and writes every chunk into `to`, then closes it. */
async function forward(from: Alf1TransformStream, to: Alf1TransformStream): Promise<void> {
  const reader = from.readable.getReader();
  const writer = to.writable.getWriter();
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    await writer.write(r.value);
  }
  await writer.close();
}

describe.runIf(SLOW)('ALF1 1 GiB in bounded memory (slow)', () => {
  it('encrypts and decrypts 1 GiB with RSS growth under 64 MiB', async () => {
    const rss = (): number => nodeProcess?.memoryUsage.rss() ?? 0;
    const key = new Uint8Array(32).fill(9);
    const enc = alf1EncryptStream(key);
    const dec = alf1DecryptStream(key);
    const sentHash = createSha256();
    const gotHash = createSha256();
    const block = new Uint8Array(WRITE);
    const baseline = rss();
    let peak = baseline;
    let received = 0;

    const writing = (async () => {
      const writer = enc.writable.getWriter();
      for (let i = 0; i < GIB / WRITE; i += 1) {
        // Different bytes per block, so a reordered or repeated chunk would change the hash.
        block.fill(i & 0xff);
        new DataView(block.buffer).setUint32(0, i);
        sentHash.update(block);
        await writer.write(block.slice());
        if ((i & 255) === 0) peak = Math.max(peak, rss());
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
    await Promise.all([writing, forward(enc, dec), reading]);
    peak = Math.max(peak, rss());

    const encDigests = await enc.done;
    const decDigests = await dec.done;
    expect(received).toBe(GIB);
    expect(encDigests.plaintextLength).toBe(GIB);
    expect(decDigests.ciphertextLength).toBe(encDigests.ciphertextLength);
    expect(equalBytes(encDigests.ciphertextSha256, decDigests.ciphertextSha256)).toBe(true);
    expect(equalBytes(sentHash.digest(), gotHash.digest())).toBe(true);
    expect(peak - baseline).toBeLessThan(RSS_LIMIT);
  }, 600_000);
});
