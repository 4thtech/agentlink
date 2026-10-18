// M1-1d: ALF1 STREAM file encryption (04 §4, D-80). The independent vectors are the `stream` suite in
// test-vectors/; these tests cover the API, the streaming paths with odd write sizes, and the tamper
// cases of the card (dropped final chunk, reordered, duplicated and appended chunks, bit flips,
// header tampering) on objects of several shapes. The 1 GiB memory test is stream.slow.test.ts.
import { describe, expect, it } from 'vitest';
import {
  ALF1_DEFAULT_CHUNK_SIZE,
  ALF1_FILE_KEY_LENGTH,
  ALF1_HEADER_LENGTH,
  ALF1_MAX_CHUNKS,
  ALF1_MAX_CHUNK_SIZE,
  ALF1_NONCE_PREFIX_LENGTH,
  ALF1_TAG_LENGTH,
  ALF1_VERSION,
  CryptoInputError,
  alf1DecryptStream,
  alf1EncryptStream,
  concatBytes,
  createAlf1Opener,
  createAlf1Sealer,
  encodeHex,
  openAlf1,
  sealAlf1,
  sha256,
  type Alf1TransformStream,
} from './index.js';
import { createAlf1OpenerAt, createAlf1SealerAt } from './stream.js';
import { createAlf1SealerWithNoncePrefix, sealAlf1WithNoncePrefix } from './testing.js';

const KEY = new Uint8Array(32).map((_, i) => i + 1);
const OTHER_KEY = new Uint8Array(32).map((_, i) => 200 - i);
const PREFIX = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const bytes = (length: number, seed = 7): Uint8Array =>
  new Uint8Array(length).map((_, i) => (i * 31 + seed) & 0xff);

const expectRefused = async (run: () => Promise<unknown>): Promise<CryptoInputError> => {
  const error: unknown = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CryptoInputError);
  return error as CryptoInputError;
};

/** Writes `inputs` into the transform and reads everything out, concurrently (backpressure). */
async function pump(
  t: Alf1TransformStream,
  inputs: Iterable<Uint8Array>,
): Promise<{ output: Uint8Array; error?: unknown }> {
  const chunks: Uint8Array[] = [];
  const reader = t.readable.getReader();
  const reading = (async () => {
    for (;;) {
      const r = await reader.read();
      if (r.done) return;
      chunks.push(r.value);
    }
  })();
  const writing = (async () => {
    const writer = t.writable.getWriter();
    for (const input of inputs) await writer.write(input);
    await writer.close();
  })();
  const [w, r] = await Promise.allSettled([writing, reading]);
  const failed = [w, r].find((s) => s.status === 'rejected');
  const output = concatBytes(...chunks);
  return failed === undefined ? { output } : { output, error: failed.reason };
}

/** Splits an object into its header and its pieces of chunkSize + 16 bytes. */
function pieces(
  object: Uint8Array,
  chunkSize: number,
): { header: Uint8Array; parts: Uint8Array[] } {
  const header = object.subarray(0, ALF1_HEADER_LENGTH);
  const parts: Uint8Array[] = [];
  for (let at = ALF1_HEADER_LENGTH; at < object.length; at += chunkSize + ALF1_TAG_LENGTH) {
    parts.push(object.subarray(at, Math.min(at + chunkSize + ALF1_TAG_LENGTH, object.length)));
  }
  return { header, parts };
}

describe('ALF1 constants (04 §4)', () => {
  it('match the spec', () => {
    expect(ALF1_HEADER_LENGTH).toBe(17);
    expect(ALF1_TAG_LENGTH).toBe(16);
    expect(ALF1_VERSION).toBe(1);
    expect(ALF1_DEFAULT_CHUNK_SIZE).toBe(1_048_576);
    expect(ALF1_MAX_CHUNK_SIZE).toBe(16_777_216);
    expect(ALF1_MAX_CHUNKS).toBe(2 ** 32);
    expect(ALF1_FILE_KEY_LENGTH).toBe(32);
    expect(ALF1_NONCE_PREFIX_LENGTH).toBe(8);
  });
});

describe('sealAlf1 / openAlf1', () => {
  it('writes the header magic, version, default chunk size and a random nonce prefix', async () => {
    const a = await sealAlf1(KEY, bytes(10));
    const b = await sealAlf1(KEY, bytes(10));
    expect(encodeHex(a.ciphertext.subarray(0, 9))).toBe('414c46310100100000');
    expect(a.ciphertext.subarray(9, 17)).not.toEqual(b.ciphertext.subarray(9, 17));
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it.each([0, 1, 15, 16, 17, 32, 33, 100, 1000])(
    'round-trips %i bytes at chunk size 16 with the canonical length and hashes',
    async (n) => {
      const plaintext = bytes(n);
      const sealed = await sealAlf1WithNoncePrefix(KEY, PREFIX, 16, plaintext);
      const chunks = Math.max(1, Math.ceil(n / 16));
      expect(sealed.ciphertext.length).toBe(17 + n + 16 * chunks);
      expect(sealed.ciphertextLength).toBe(sealed.ciphertext.length);
      expect(sealed.plaintextLength).toBe(n);
      expect(sealed.ciphertextSha256).toEqual(sha256(sealed.ciphertext));
      expect(sealed.plaintextSha256).toEqual(sha256(plaintext));
      const opened = await openAlf1(KEY, sealed.ciphertext);
      expect(opened.plaintext).toEqual(plaintext);
      expect(opened.ciphertextSha256).toEqual(sealed.ciphertextSha256);
      expect(opened.plaintextSha256).toEqual(sealed.plaintextSha256);
    },
  );

  it('round-trips at the default chunk size across a chunk boundary', async () => {
    const plaintext = bytes(ALF1_DEFAULT_CHUNK_SIZE + 5);
    const sealed = await sealAlf1(KEY, plaintext);
    expect(sealed.ciphertext.length).toBe(17 + plaintext.length + 32);
    expect((await openAlf1(KEY, sealed.ciphertext)).plaintext).toEqual(plaintext);
  });

  it('checks the expected hashes when given', async () => {
    const sealed = await sealAlf1(KEY, bytes(40));
    const ok = await openAlf1(KEY, sealed.ciphertext, {
      expectedCiphertextSha256: sealed.ciphertextSha256,
      expectedPlaintextSha256: sealed.plaintextSha256,
    });
    expect(ok.plaintext).toEqual(bytes(40));
    const wrong = new Uint8Array(32);
    await expectRefused(() =>
      openAlf1(KEY, sealed.ciphertext, { expectedCiphertextSha256: wrong }),
    );
    await expectRefused(() => openAlf1(KEY, sealed.ciphertext, { expectedPlaintextSha256: wrong }));
    await expectRefused(() =>
      openAlf1(KEY, sealed.ciphertext, { expectedPlaintextSha256: new Uint8Array(31) }),
    );
  });

  it('refuses bad arguments', async () => {
    await expectRefused(() => sealAlf1(new Uint8Array(31), bytes(1)));
    await expectRefused(() => openAlf1(new Uint8Array(33), new Uint8Array(40)));
    await expectRefused(() => sealAlf1(KEY, 'text' as unknown as Uint8Array));
    await expectRefused(() => sealAlf1WithNoncePrefix(KEY, new Uint8Array(7), 16, bytes(1)));
    await expectRefused(() => sealAlf1WithNoncePrefix(KEY, PREFIX, 0, bytes(1)));
    await expectRefused(() =>
      sealAlf1WithNoncePrefix(KEY, PREFIX, ALF1_MAX_CHUNK_SIZE + 1, bytes(1)),
    );
    await expectRefused(() => sealAlf1WithNoncePrefix(KEY, PREFIX, 1.5, bytes(1)));
  });

  it('does not depend on the caller keeping the file key', async () => {
    const key = KEY.slice();
    const sealer = createAlf1SealerWithNoncePrefix(key, PREFIX, 16);
    key.fill(0);
    const out = [...(await sealer.update(bytes(20))), ...(await sealer.finish()).output];
    expect((await openAlf1(KEY, concatBytes(...out))).plaintext).toEqual(bytes(20));
  });
});

describe('tampering is refused (04 §4, D-80; M1-1d acceptance)', () => {
  // 50 bytes at chunk size 16: chunks of 16, 16, 16 and a final 2.
  const plaintext = bytes(50);
  const sealedP = sealAlf1WithNoncePrefix(KEY, PREFIX, 16, plaintext);
  const build = async (
    edit: (h: Uint8Array, p: Uint8Array[]) => Uint8Array[],
  ): Promise<Uint8Array> => {
    const { header, parts } = pieces((await sealedP).ciphertext, 16);
    return concatBytes(...edit(header, parts));
  };
  const cases: [string, (h: Uint8Array, p: Uint8Array[]) => Uint8Array[]][] = [
    ['the final chunk dropped', (h, p) => [h, ...p.slice(0, 3)]],
    ['a middle chunk dropped', (h, p) => [h, p[0]!, p[2]!, p[3]!]],
    ['the first chunk dropped', (h, p) => [h, ...p.slice(1)]],
    ['chunks 0 and 1 reordered', (h, p) => [h, p[1]!, p[0]!, p[2]!, p[3]!]],
    ['the final chunk moved forward', (h, p) => [h, p[0]!, p[1]!, p[3]!, p[2]!]],
    ['chunk 0 duplicated', (h, p) => [h, p[0]!, p[0]!, p[1]!, p[2]!, p[3]!]],
    ['chunk 0 in place of chunk 1', (h, p) => [h, p[0]!, p[0]!, p[2]!, p[3]!]],
    ['the final chunk duplicated', (h, p) => [h, ...p, p[3]!]],
    ['a chunk appended after the final one', (h, p) => [h, ...p, p[0]!]],
    ['one byte appended', (h, p) => [h, ...p, new Uint8Array(1)]],
    ['an empty final chunk appended', (h, p) => [h, ...p, new Uint8Array(16)]],
    ['the header alone', (h) => [h]],
    ['a short header', (h) => [h.subarray(0, 16)]],
    ['nothing', () => []],
    ['the final tag cut by one byte', (h, p) => [h, ...p.slice(0, 3), p[3]!.subarray(0, 17)]],
    ['the final chunk shorter than a tag', (h, p) => [h, ...p.slice(0, 3), p[3]!.subarray(0, 15)]],
  ];
  it.each(cases)('with %s', async (_why, edit) => {
    const error = await expectRefused(async () => openAlf1(KEY, await build(edit)));
    expect(error.code).toBe('open_failed');
  });

  it('with any single bit flipped anywhere in the object', async () => {
    const object = (await sealedP).ciphertext;
    for (let at = 0; at < object.length; at += 1) {
      for (const bit of at < ALF1_HEADER_LENGTH ? [0, 7] : [at % 8]) {
        const flipped = object.slice();
        flipped[at]! ^= 1 << bit;
        await expectRefused(() => openAlf1(KEY, flipped));
      }
    }
  });

  it.each([
    ['magic', 0, 0x42],
    ['version 0', 4, 0],
    ['version 2', 4, 2],
  ] as const)('with the header %s changed', async (_why, at, value) => {
    const object = (await sealedP).ciphertext.slice();
    object[at] = value;
    await expectRefused(() => openAlf1(KEY, object));
  });

  it.each([0, 15, 17, 32, ALF1_MAX_CHUNK_SIZE + 1, 0xffffffff])(
    'with the header chunkSize changed to %i',
    async (size) => {
      const object = (await sealedP).ciphertext.slice();
      new DataView(object.buffer).setUint32(5, size);
      await expectRefused(() => openAlf1(KEY, object));
    },
  );

  it('under another file key', async () => {
    await expectRefused(async () => openAlf1(OTHER_KEY, (await sealedP).ciphertext));
  });

  it('an exact multiple ends with a full final chunk; an empty piece after it is refused', async () => {
    // The sender side of the chunking rule; a sealed empty final chunk after full chunks is the
    // vector `reject-empty-final-after-full`.
    const sealer = createAlf1SealerWithNoncePrefix(KEY, PREFIX, 16);
    const canonical = concatBytes(
      ...(await sealer.update(bytes(32))),
      ...(await sealer.finish()).output,
    );
    expect(canonical.length).toBe(17 + 32 + 32);
    expect((await openAlf1(KEY, canonical)).plaintext).toEqual(bytes(32));
    await expectRefused(() => openAlf1(KEY, concatBytes(canonical, new Uint8Array(16))));
  });
});

describe('chunk count bound (2^32 chunks, u32 index)', () => {
  // The internal `At` variants start the chunk index late, so the bound is reachable in a test.
  const sealAt = async (start: number, n: number): Promise<Uint8Array> => {
    const sealer = createAlf1SealerAt(KEY, PREFIX, 1, start);
    return concatBytes(...(await sealer.update(bytes(n))), ...(await sealer.finish()).output);
  };
  const openAt = async (start: number, object: Uint8Array): Promise<Uint8Array> => {
    const opener = createAlf1OpenerAt(KEY, start);
    return concatBytes(...(await opener.update(object)), ...(await opener.finish()).output);
  };

  it('the sealer uses index 2^32 - 1 and refuses index 2^32', async () => {
    const object = await sealAt(ALF1_MAX_CHUNKS - 2, 2);
    expect(await openAt(ALF1_MAX_CHUNKS - 2, object)).toEqual(bytes(2));
    const error = await expectRefused(() => sealAt(ALF1_MAX_CHUNKS - 1, 2));
    expect(error.message).toMatch(/2\^32 chunks/);
  });

  it('the opener refuses index 2^32 before decrypting', async () => {
    const object = await sealAt(ALF1_MAX_CHUNKS - 1, 1);
    expect(await openAt(ALF1_MAX_CHUNKS - 1, object)).toEqual(bytes(1));
    const error = await expectRefused(() => openAt(ALF1_MAX_CHUNKS, object));
    expect(error.message).toMatch(/2\^32 chunks/);
  });
});

describe('sealer and opener', () => {
  it('give the same object whatever the write sizes', async () => {
    const plaintext = bytes(333);
    const reference = (await sealAlf1WithNoncePrefix(KEY, PREFIX, 16, plaintext)).ciphertext;
    for (const step of [1, 7, 16, 17, 64, 333]) {
      const sealer = createAlf1SealerWithNoncePrefix(KEY, PREFIX, 16);
      const out: Uint8Array[] = [];
      for (let at = 0; at < plaintext.length; at += step) {
        out.push(...(await sealer.update(plaintext.subarray(at, at + step))));
      }
      out.push(...(await sealer.finish()).output);
      expect(concatBytes(...out)).toEqual(reference);
      const opener = createAlf1Opener(KEY);
      const back: Uint8Array[] = [];
      for (let at = 0; at < reference.length; at += step) {
        back.push(...(await opener.update(reference.subarray(at, at + step))));
      }
      back.push(...(await opener.finish()).output);
      expect(concatBytes(...back)).toEqual(plaintext);
    }
  });

  it('refuse use after finish, overlapping calls and non-byte input', async () => {
    const sealer = createAlf1Sealer(KEY);
    await sealer.finish();
    await expectRefused(() => sealer.update(bytes(1)));
    await expectRefused(() => sealer.finish());
    const busy = createAlf1Sealer(KEY);
    const first = busy.update(bytes(10));
    await expectRefused(() => busy.update(bytes(1)));
    await first;
    const opener = createAlf1Opener(KEY);
    await expectRefused(() => opener.update([1, 2] as unknown as Uint8Array));
  });

  it('an opener that failed stays failed', async () => {
    const sealed = await sealAlf1WithNoncePrefix(KEY, PREFIX, 16, bytes(40));
    const object = sealed.ciphertext.slice();
    object[20]! ^= 1;
    const opener = createAlf1Opener(KEY);
    await expectRefused(() => opener.update(object));
    await expectRefused(() => opener.finish());
  });

  it('abort wipes and closes', async () => {
    const sealer = createAlf1Sealer(KEY);
    await sealer.update(bytes(5));
    sealer.abort();
    await expectRefused(() => sealer.finish());
  });
});

describe('Web Streams transforms', () => {
  it('encrypt and decrypt with backpressure and report the digests', async () => {
    const plaintext = bytes(5000);
    const enc = alf1EncryptStream(KEY);
    const inputs = [0, 1, 999, 1000, 4000].map((at, i, all) =>
      plaintext.subarray(at, all[i + 1] ?? plaintext.length),
    );
    const sealed = await pump(enc, inputs);
    expect(sealed.error).toBeUndefined();
    const encDigests = await enc.done;
    expect(encDigests.ciphertextSha256).toEqual(sha256(sealed.output));
    expect(encDigests.plaintextSha256).toEqual(sha256(plaintext));
    expect(encDigests.ciphertextLength).toBe(sealed.output.length);

    const dec = alf1DecryptStream(KEY, { expectedCiphertextSha256: encDigests.ciphertextSha256 });
    const opened = await pump(dec, [sealed.output.subarray(0, 3), sealed.output.subarray(3)]);
    expect(opened.error).toBeUndefined();
    expect(opened.output).toEqual(plaintext);
    expect((await dec.done).plaintextSha256).toEqual(sha256(plaintext));
  });

  it('decryption errors the stream and rejects done on tampering', async () => {
    const sealed = await sealAlf1WithNoncePrefix(KEY, PREFIX, 16, bytes(50));
    const truncated = sealed.ciphertext.subarray(0, sealed.ciphertext.length - 18);
    const dec = alf1DecryptStream(KEY);
    const result = await pump(dec, [truncated]);
    expect(result.error).toBeInstanceOf(CryptoInputError);
    await expectRefused(() => dec.done);
  });

  it('decryption errors the stream on an expected-hash mismatch', async () => {
    const sealed = await sealAlf1(KEY, bytes(50));
    const dec = alf1DecryptStream(KEY, { expectedPlaintextSha256: new Uint8Array(32) });
    const result = await pump(dec, [sealed.ciphertext]);
    expect(result.error).toBeInstanceOf(CryptoInputError);
    await expectRefused(() => dec.done);
  });

  it('refuses a chunk that is not a Uint8Array', async () => {
    const enc = alf1EncryptStream(KEY);
    const result = await pump(enc, ['text' as unknown as Uint8Array]);
    expect(result.error).toBeInstanceOf(CryptoInputError);
    await expectRefused(() => enc.done);
  });
});
