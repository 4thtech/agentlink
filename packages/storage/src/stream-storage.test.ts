// M1-6b part 2: STREAM (ALF1) encryption wired into multipart upload, and the streaming download with
// decryption, a byte cap and a provisional output (07 §5.2, 04 §4, D-80, I-2, I-7). Against the
// in-memory S3 of multipart.fixture.ts and the in-memory folder of stream-fs.fixture.ts; the 1 GiB
// memory gate runs against MinIO in integration.test.ts.
import { describe, expect, it } from 'vitest';
import {
  ALF1_DEFAULT_CHUNK_SIZE,
  ALF1_HEADER_LENGTH,
  ALF1_TAG_LENGTH,
  encodeHex,
  sha256,
} from '@4thtech-io/crypto';
import {
  StorageError,
  alf1CiphertextSize,
  createS3Multipart,
  createTempFileSink,
  removeStaleTempFiles,
  decryptDownload,
  putEncrypted,
  type CiphertextSource,
  type EncryptedObject,
  type EncryptedPutTarget,
  type ProvisionalSink,
} from './index.js';
import { BUCKET, DAY_MS, ENDPOINT, NOW, testPrefix } from './fake-s3.fixture.js';
import {
  chunked,
  failingStream,
  fakeMultipartS3,
  patternBytes,
  type FakeMultipartS3,
} from './multipart.fixture.js';
import { fakeFolder, hashingSink } from './stream-fs.fixture.js';

const MiB = 1024 * 1024;
const CHUNK = ALF1_DEFAULT_CHUNK_SIZE;
const inADay = new Date(NOW.getTime() + DAY_MS);
const hex = (b: Uint8Array): string => encodeHex(sha256(b));
const codeOf = (e: unknown): string | undefined => (e instanceof StorageError ? e.code : undefined);

function setup(fake: FakeMultipartS3 = fakeMultipartS3(BUCKET)) {
  const mp = createS3Multipart({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    storagePrefix: testPrefix(),
    credentials: async () => ({
      accessKeyId: 'AKIDSTREAMTESTONLY',
      secretAccessKey: 'stream-secret',
    }),
    fetch: fake.fetch,
    now: () => NOW,
  });
  // 5 MiB parts, so a few MiB of plaintext spans several parts.
  const target: EncryptedPutTarget = {
    put: (ciphertext, opts) => mp.put(ciphertext, { ...opts, partSize: 5 * MiB }),
  };
  return { mp, fake, target };
}

async function upload(
  plaintext: Uint8Array,
  piece = 64 * 1024,
): Promise<{ sealed: EncryptedObject; stored: Uint8Array; fake: FakeMultipartS3 }> {
  const { fake, target } = setup();
  const sealed = await putEncrypted(target, chunked(plaintext, piece), {
    plaintextSize: plaintext.length,
    expiresAt: inADay,
  });
  const stored = fake.objects.get(sealed.object.locator);
  if (stored === undefined) throw new Error('object missing');
  return { sealed, stored, fake };
}

const optsOf = (sealed: EncryptedObject) => ({
  fileKey: sealed.fileKey,
  plaintextSize: sealed.plaintextSize,
  ciphertextSha256: sealed.ciphertextSha256,
  plaintextSha256: sealed.plaintextSha256,
});

/** A sink that keeps every byte, for comparing the plaintext. */
function memorySink(): ProvisionalSink & { bytes: () => Uint8Array; state: () => string } {
  const parts: Uint8Array[] = [];
  let state = 'open';
  return {
    async write(chunk) {
      parts.push(chunk.slice());
    },
    async commit() {
      state = 'committed';
    },
    async discard() {
      state = 'discarded';
    },
    bytes: () => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    },
    state: () => state,
  };
}

describe('alf1CiphertextSize', () => {
  it('is the header, one tag per chunk and the plaintext; the empty file has one empty chunk', () => {
    expect(alf1CiphertextSize(0)).toBe(ALF1_HEADER_LENGTH + ALF1_TAG_LENGTH);
    expect(alf1CiphertextSize(1)).toBe(ALF1_HEADER_LENGTH + ALF1_TAG_LENGTH + 1);
    expect(alf1CiphertextSize(CHUNK)).toBe(ALF1_HEADER_LENGTH + ALF1_TAG_LENGTH + CHUNK);
    expect(alf1CiphertextSize(CHUNK + 1)).toBe(
      ALF1_HEADER_LENGTH + 2 * ALF1_TAG_LENGTH + CHUNK + 1,
    );
    expect(alf1CiphertextSize(3 * CHUNK)).toBe(
      ALF1_HEADER_LENGTH + 3 * ALF1_TAG_LENGTH + 3 * CHUNK,
    );
  });

  it('refuses a size that is not a non-negative safe integer', () => {
    for (const bad of [
      -1,
      1.5,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 1,
      '1' as unknown as number,
    ]) {
      expect(codeOf(catching(() => alf1CiphertextSize(bad)))).toBe('invalid_argument');
    }
  });
});

function catching(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('putEncrypted then decryptDownload: round trip', () => {
  for (const [name, size] of [
    ['several parts and a partial final chunk', 11 * MiB + 12_345],
    ['an exact multiple of the chunk size (full final chunk)', 6 * CHUNK],
    ['one byte', 1],
    ['the empty file', 0],
  ] as const) {
    it(`${name}`, async () => {
      const plaintext = patternBytes(size, size + 3);
      const { sealed, stored } = await upload(plaintext);
      expect(sealed.plaintextSize).toBe(size);
      expect(sealed.object.size).toBe(alf1CiphertextSize(size));
      expect(stored.length).toBe(alf1CiphertextSize(size));
      expect(sealed.ciphertextSha256).toBe(sealed.object.sha256);
      expect(sealed.ciphertextSha256).toBe(hex(stored));
      expect(sealed.plaintextSha256).toBe(hex(plaintext));
      expect(sealed.fileKey.length).toBe(32);
      // The object starts with an ALF1 v1 header with the default chunk size.
      expect([...stored.subarray(0, 5)]).toEqual([0x41, 0x4c, 0x46, 0x31, 0x01]);
      expect(new DataView(stored.buffer, stored.byteOffset).getUint32(5)).toBe(CHUNK);

      const sink = memorySink();
      const opened = await decryptDownload(chunked(stored, 300_001), sink, optsOf(sealed));
      expect(sink.state()).toBe('committed');
      expect(hex(sink.bytes())).toBe(hex(plaintext));
      expect(opened.plaintextSize).toBe(size);
      expect(opened.plaintextSha256).toBe(sealed.plaintextSha256);
      expect(opened.ciphertextSha256).toBe(sealed.ciphertextSha256);
    });
  }

  it('accepts the plaintext as bytes, and a pull-style source with the exact byte cap', async () => {
    const plaintext = patternBytes(3 * MiB + 5, 9);
    const { fake, target } = setup();
    const sealed = await putEncrypted(target, plaintext, {
      plaintextSize: plaintext.length,
      expiresAt: inADay,
    });
    const stored = fake.objects.get(sealed.object.locator)!;
    let capSeen = 0;
    const source: CiphertextSource = async (maxBytes, onChunk) => {
      capSeen = maxBytes;
      for (let at = 0; at < stored.length; at += 100_000) {
        await onChunk(stored.slice(at, at + 100_000));
      }
    };
    const sink = hashingSink();
    await decryptDownload(source, sink, optsOf(sealed));
    expect(capSeen).toBe(alf1CiphertextSize(plaintext.length));
    expect(sink.state()).toBe('committed');
    expect(sink.sha256()).toBe(hex(plaintext));
  });

  it('uses a fresh file key and nonce prefix for every file, even for the same plaintext', async () => {
    const plaintext = patternBytes(2 * MiB, 4);
    const a = await upload(plaintext);
    const b = await upload(plaintext);
    expect(hex(a.sealed.fileKey)).not.toBe(hex(b.sealed.fileKey));
    expect(hex(a.stored.subarray(9, 17))).not.toBe(hex(b.stored.subarray(9, 17)));
    expect(a.sealed.ciphertextSha256).not.toBe(b.sealed.ciphertextSha256);
  });

  it('writes through a temporary file and renames it only after the whole file verifies', async () => {
    const plaintext = patternBytes(4 * MiB + 77, 5);
    const { sealed, stored } = await upload(plaintext);
    const folder = fakeFolder();
    const sink = await createTempFileSink(folder.ops, 'report.pdf');
    // The temporary file exists before any byte is written, under another name than the final one.
    expect(folder.created.length).toBe(1);
    const temp = folder.created[0]!;
    expect(temp).not.toBe('report.pdf');
    expect(temp.startsWith('.')).toBe(true);
    await decryptDownload(chunked(stored, 1_000_000), sink, optsOf(sealed));
    expect([...folder.files.keys()]).toEqual(['report.pdf']);
    expect(hex(folder.read('report.pdf')!)).toBe(hex(plaintext));
  });
});

describe('decryptDownload: tamper is refused and no partial file is left', () => {
  const size = 5 * CHUNK + 1000;

  async function refusedWithFolder(
    mutate: (stored: Uint8Array) => Uint8Array,
    over: Partial<ReturnType<typeof optsOf>> = {},
  ): Promise<{ code: string | undefined; files: string[]; created: number; message: string }> {
    const { sealed, stored } = await upload(patternBytes(size, 11));
    const folder = fakeFolder();
    const sink = await createTempFileSink(folder.ops, 'out.bin');
    const error = await decryptDownload(chunked(mutate(stored.slice()), 70_000), sink, {
      ...optsOf(sealed),
      ...over,
    }).catch((e: unknown) => e);
    return {
      code: codeOf(error),
      files: [...folder.files.keys()],
      created: folder.created.length,
      message: error instanceof Error ? error.message : '',
    };
  }

  const flip = (s: Uint8Array, at: number, mask: number): Uint8Array => {
    s[at] = (s[at] ?? 0) ^ mask;
    return s;
  };
  const cases: Array<[string, (s: Uint8Array) => Uint8Array, string]> = [
    // Flipping a byte in the last chunk: four full chunks are already in the temporary file.
    ['a flipped byte in the final chunk', (s) => flip(s, s.length - 1, 1), 'integrity_failed'],
    [
      'a flipped byte in the first chunk',
      (s) => flip(s, ALF1_HEADER_LENGTH + 5, 0x80),
      'integrity_failed',
    ],
    ['a flipped header byte (chunk size)', (s) => flip(s, 8, 1), 'integrity_failed'],
    [
      'two chunks swapped',
      (s) => {
        const piece = CHUNK + ALF1_TAG_LENGTH;
        const a = s.slice(ALF1_HEADER_LENGTH, ALF1_HEADER_LENGTH + piece);
        s.copyWithin(
          ALF1_HEADER_LENGTH,
          ALF1_HEADER_LENGTH + piece,
          ALF1_HEADER_LENGTH + 2 * piece,
        );
        s.set(a, ALF1_HEADER_LENGTH + piece);
        return s;
      },
      'integrity_failed',
    ],
    [
      'the final chunk dropped',
      (s) => s.subarray(0, ALF1_HEADER_LENGTH + 5 * (CHUNK + 16)),
      'size_mismatch',
    ],
    ['truncated by one byte', (s) => s.subarray(0, s.length - 1), 'size_mismatch'],
  ];
  for (const [name, mutate, code] of cases) {
    it(`${name}: ${code}, temporary file removed, nothing committed`, async () => {
      const r = await refusedWithFolder(mutate);
      expect(r.code).toBe(code);
      expect(r.created).toBe(1);
      expect(r.files).toEqual([]);
    });
  }

  it('a valid object under a different ciphertextSha256 is refused, with no file left', async () => {
    const r = await refusedWithFolder((s) => s, { ciphertextSha256: '00'.repeat(32) });
    expect(r.code).toBe('integrity_failed');
    expect(r.files).toEqual([]);
  });

  it('a valid object under a different plaintextSha256 is refused, with no file left', async () => {
    const r = await refusedWithFolder((s) => s, { plaintextSha256: 'ab'.repeat(32) });
    expect(r.code).toBe('integrity_failed');
    expect(r.files).toEqual([]);
  });

  it('the wrong file key is refused, with no file left', async () => {
    const r = await refusedWithFolder((s) => s, { fileKey: new Uint8Array(32).fill(1) });
    expect(r.code).toBe('integrity_failed');
    expect(r.files).toEqual([]);
  });

  it('a failing write or rename removes the temporary file', async () => {
    const { sealed, stored } = await upload(patternBytes(3 * CHUNK, 2));
    for (const failure of ['write', 'rename'] as const) {
      const folder = fakeFolder();
      if (failure === 'write') folder.failWriteAt = 1;
      else folder.failRename = true;
      const sink = await createTempFileSink(folder.ops, 'x.bin');
      const error = await decryptDownload(chunked(stored, 50_000), sink, optsOf(sealed)).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect([...folder.files.keys()]).toEqual([]);
    }
  });

  it('a failing source is discarded, and its error text (which may hold the URL) is dropped', async () => {
    const { sealed, stored } = await upload(patternBytes(2 * CHUNK, 3));
    const secretUrl = 'https://bucket.example/agentlink/p/k?X-Amz-Signature=deadbeef';
    const source: CiphertextSource = async (_max, onChunk) => {
      await onChunk(stored.slice(0, CHUNK));
      throw new Error(`fetch failed for ${secretUrl}`);
    };
    const folder = fakeFolder();
    const sink = await createTempFileSink(folder.ops, 'y.bin');
    const error = await decryptDownload(source, sink, optsOf(sealed)).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('download_failed');
    expect(String((error as Error).message).includes('X-Amz')).toBe(false);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect([...folder.files.keys()]).toEqual([]);
  });

  it('discards the sink when the options are invalid, before reading anything', async () => {
    let pulled = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(10));
      },
    });
    const sink = hashingSink();
    for (const bad of [
      { plaintextSha256: 'XY'.repeat(32) },
      { ciphertextSha256: 'ab' },
      { fileKey: new Uint8Array(31) },
      { plaintextSize: -1 },
    ]) {
      const error = await decryptDownload(source, sink, {
        fileKey: new Uint8Array(32),
        plaintextSize: 10,
        ciphertextSha256: '00'.repeat(32),
        plaintextSha256: '00'.repeat(32),
        ...bad,
      }).catch((e: unknown) => e);
      expect(codeOf(error)).toBe('invalid_argument');
      expect(sink.state()).toBe('discarded');
    }
    expect(pulled).toBeLessThanOrEqual(1);
  });
});

describe('decryptDownload: size cap', () => {
  it('stops reading at the declared size plus ALF1 overhead (too_large), never buffering more', async () => {
    const { sealed, stored } = await upload(patternBytes(2 * CHUNK + 10, 6));
    const cap = alf1CiphertextSize(sealed.plaintextSize);
    let served = 0;
    // A hostile endpoint that serves the object and then keeps going without end.
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        const piece =
          served < stored.length ? stored.slice(served, served + 65_536) : new Uint8Array(65_536);
        served += piece.length;
        c.enqueue(piece);
      },
    });
    const sink = hashingSink();
    const error = await decryptDownload(endless, sink, optsOf(sealed)).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('too_large');
    expect(sink.state()).toBe('discarded');
    // The stream was cancelled at the cap (plus one read and the queue), not read to exhaustion.
    expect(served).toBeLessThan(cap + 4 * 65_536);
  });

  it('a pull-style source that ignores the cap is refused at the cap', async () => {
    const { sealed, stored } = await upload(patternBytes(CHUNK, 7));
    let delivered = 0;
    const source: CiphertextSource = async (_max, onChunk) => {
      await onChunk(stored);
      delivered += stored.length;
      await onChunk(new Uint8Array(1));
      delivered += 1;
    };
    const sink = hashingSink();
    const error = await decryptDownload(source, sink, optsOf(sealed)).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('too_large');
    expect(sink.state()).toBe('discarded');
    expect(delivered).toBe(stored.length);
  });

  it('refuses a declared size above maxPlaintextBytes before the source is called', async () => {
    let called = false;
    const source: CiphertextSource = async () => {
      called = true;
    };
    const sink = hashingSink();
    const error = await decryptDownload(source, sink, {
      fileKey: new Uint8Array(32),
      plaintextSize: 100 * MiB + 1,
      ciphertextSha256: '00'.repeat(32),
      plaintextSha256: '00'.repeat(32),
      maxPlaintextBytes: 100 * MiB,
    }).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('too_large');
    expect(called).toBe(false);
    expect(sink.state()).toBe('discarded');
  });
});

describe('putEncrypted: aborts on any error and leaves no open upload', () => {
  const opts = (plaintextSize: number) => ({ plaintextSize, expiresAt: inADay });

  it('a plaintext stream that fails after two parts', async () => {
    const { fake, target, mp } = setup();
    const error = await putEncrypted(target, failingStream(12 * MiB), opts(20 * MiB)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(fake.uploads.size).toBe(0);
    expect(fake.objects.size).toBe(0);
    expect(
      fake.requests.some((r) => r.method === 'DELETE' && r.url.searchParams.has('uploadId')),
    ).toBe(true);
    expect(await mp.openUploads()).toBe(0);
  });

  it('a plaintext longer than declared: size_mismatch, the source cancelled', async () => {
    const { fake, target } = setup();
    let cancelled = false;
    let sent = 0;
    const longer = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += MiB;
        c.enqueue(new Uint8Array(MiB).fill(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const error = await putEncrypted(target, longer, opts(6 * MiB)).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('size_mismatch');
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(16 * MiB);
    expect(fake.uploads.size).toBe(0);
    expect(fake.objects.size).toBe(0);
  });

  it('a plaintext shorter than declared: size_mismatch', async () => {
    const { fake, target } = setup();
    const error = await putEncrypted(
      target,
      chunked(patternBytes(6 * MiB), MiB),
      opts(7 * MiB),
    ).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('size_mismatch');
    expect(fake.uploads.size).toBe(0);
    expect(fake.objects.size).toBe(0);
  });

  it('bytes of the wrong length are refused before any request', async () => {
    const { fake, target } = setup();
    const error = await putEncrypted(target, new Uint8Array(10), opts(11)).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('size_mismatch');
    expect(fake.requests.length).toBe(0);
  });

  it('a failing part upload aborts the upload and cancels the plaintext source', async () => {
    const fake = fakeMultipartS3(BUCKET);
    let parts = 0;
    fake.override = (req) => {
      if (req.method === 'PUT' && req.url.searchParams.has('partNumber')) {
        parts += 1;
        if (parts === 2) return new Response(null, { status: 503 });
      }
      return undefined;
    };
    const { target } = setup(fake);
    let cancelled = false;
    let sent = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 30 * MiB) {
          c.close();
          return;
        }
        sent += MiB;
        c.enqueue(new Uint8Array(MiB).fill(2));
      },
      cancel() {
        cancelled = true;
      },
    });
    const error = await putEncrypted(target, source, opts(30 * MiB)).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('upload_failed');
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(30 * MiB);
    expect(fake.uploads.size).toBe(0);
    expect(fake.objects.size).toBe(0);
  });

  it('refuses invalid options before any request', async () => {
    const { fake, target } = setup();
    for (const bad of [
      { plaintextSize: -1, expiresAt: inADay },
      { plaintextSize: 1.5, expiresAt: inADay },
      { plaintextSize: 10, expiresAt: new Date(Number.NaN) },
    ]) {
      const error = await putEncrypted(target, new Uint8Array(10), bad).catch((e: unknown) => e);
      expect(codeOf(error)).toBe('invalid_argument');
    }
    expect(fake.requests.length).toBe(0);
  });
});

describe('review IR-M1-6b-2-1 lows', () => {
  it('L-1: removeStaleTempFiles removes only the temporary files this module makes', async () => {
    const folder = fakeFolder();
    const stale = await createTempFileSink(folder.ops, 'a.bin');
    await stale.write(new Uint8Array([1, 2, 3]));
    // A crash: neither commit nor discard ran. Other files in the folder must stay.
    const keep = [
      'report.pdf',
      '.agentlink-partial-notours',
      `.agentlink-partial-${'a'.repeat(32)}.pdf`,
    ];
    for (const name of keep) await (await folder.ops.create(name)).close();
    expect(await removeStaleTempFiles(folder.ops)).toBe(1);
    expect([...folder.files.keys()].sort()).toEqual([...keep].sort());
    expect(await removeStaleTempFiles(folder.ops)).toBe(0);
  });

  it('L-2: a pull source that does not await onChunk is serialised, in order', async () => {
    const plaintext = patternBytes(4 * CHUNK + 99, 12);
    const { sealed, stored } = await upload(plaintext);
    let active = 0;
    let maxActive = 0;
    const parts: Uint8Array[] = [];
    const sink: ProvisionalSink = {
      async write(chunk) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        parts.push(chunk.slice());
        active -= 1;
      },
      async commit() {},
      async discard() {},
    };
    // Fires every piece at once and returns without awaiting any of them.
    const source: CiphertextSource = async (_max, onChunk) => {
      for (let at = 0; at < stored.length; at += 300_000) {
        void onChunk(stored.slice(at, at + 300_000));
      }
    };
    await decryptDownload(source, sink, optsOf(sealed));
    expect(maxActive).toBe(1);
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      joined.set(p, at);
      at += p.length;
    }
    expect(hex(joined)).toBe(hex(plaintext));
  });
});
