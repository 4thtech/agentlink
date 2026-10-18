// M1-6b part 2: the streaming download with decryption and a byte cap (07 §5.2, 04 §4, D-80).
//
// - The ciphertext comes from a source the caller provides: a byte stream (a Response body in a
//   Worker), or a pull function given the byte cap, shaped for @agentlink/node's SSRF-safe fetch
//   (`(maxBytes, onChunk) => safeFetch(url, { maxBytes, onChunk })`). The download URL is the
//   caller's (it came in an envelope, I-5): the SSRF rules of 04 §4 (https, public addresses only,
//   redirects capped and re-checked) are the source's job, and nothing here sees or logs the URL.
// - The cap is exact: the ALF1 length of the declared plaintext size (the declared size plus
//   overhead, 04 §4). This side counts too, whatever the source does: one byte past the cap stops
//   the download (`too_large`); fewer bytes than the cap fail (`size_mismatch`).
// - Decryption goes through @agentlink/crypto's opener, which checks the header before decrypting
//   and both hashes at the end (04 §4 Integrity: `ciphertextSha256` and `plaintextSha256` are
//   mandatory here). Streaming reverses the order of 04 §4's "check `ciphertextSha256` before
//   decrypting" for the bytes, not for the result: plaintext reaches the sink only as provisional
//   output, and the sink commits only after the ciphertext hash, the final chunk and the plaintext
//   hash all verified. On any failure the sink is discarded (stream-sink.ts).
// - Memory: one ALF1 chunk plus what the source and the sink buffer.
// - Errors are fixed StorageErrors with no cause: a source's own error can carry the URL (I-7).
import {
  CryptoInputError,
  createAlf1Opener,
  decodeHex,
  encodeHex,
  wipe,
  ALF1_FILE_KEY_LENGTH,
  type Alf1Processor,
} from '@agentlink/crypto';
import { StorageError } from './errors.js';
import type { ProvisionalSink } from './stream-sink.js';
import { alf1CiphertextSize } from './stream-upload.js';

/**
 * Where the ciphertext comes from: a byte stream, or a function that delivers the object to
 * `onChunk` piece by piece, in order, and stops at `maxBytes` (it is told the cap; this side checks
 * it as well). A rejection of `onChunk` must end the download and be returned unchanged.
 */
export type CiphertextSource =
  | ReadableStream<Uint8Array>
  | ((maxBytes: number, onChunk: (chunk: Uint8Array) => Promise<void>) => Promise<unknown>);

/** The facts of one `files[]` entry of the payload (04 §3.4). */
export interface DecryptDownloadOptions {
  readonly fileKey: Uint8Array;
  /** The declared plaintext length; the byte cap follows from it. */
  readonly plaintextSize: number;
  /** Lowercase hex SHA-256 of the whole ALF1 object. */
  readonly ciphertextSha256: string;
  /** Lowercase hex SHA-256 of the plaintext. */
  readonly plaintextSha256: string;
  /** A policy limit: a larger declared size is refused before anything is fetched. */
  readonly maxPlaintextBytes?: number;
}

export interface DecryptedFile {
  readonly plaintextSize: number;
  readonly plaintextSha256: string;
  readonly ciphertextSha256: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

function invalid(message: string): StorageError {
  return new StorageError('invalid_argument', message);
}

function checked(opts: DecryptDownloadOptions): {
  cap: number;
  ct: Uint8Array;
  pt: Uint8Array;
} {
  if (opts === null || typeof opts !== 'object') throw invalid('missing download options');
  const { fileKey, plaintextSize, ciphertextSha256, plaintextSha256, maxPlaintextBytes } = opts;
  if (!(fileKey instanceof Uint8Array) || fileKey.length !== ALF1_FILE_KEY_LENGTH) {
    throw invalid('fileKey must be 32 bytes');
  }
  if (typeof ciphertextSha256 !== 'string' || !HEX64.test(ciphertextSha256)) {
    throw invalid('ciphertextSha256 must be 64 lowercase hex digits');
  }
  if (typeof plaintextSha256 !== 'string' || !HEX64.test(plaintextSha256)) {
    throw invalid('plaintextSha256 must be 64 lowercase hex digits');
  }
  const cap = alf1CiphertextSize(plaintextSize);
  if (maxPlaintextBytes !== undefined) {
    if (!Number.isSafeInteger(maxPlaintextBytes) || maxPlaintextBytes < 0) {
      throw invalid('maxPlaintextBytes must be a non-negative integer');
    }
    if (plaintextSize > maxPlaintextBytes) {
      throw new StorageError('too_large', 'the file is larger than allowed');
    }
  }
  return { cap, ct: decodeHex(ciphertextSha256), pt: decodeHex(plaintextSha256) };
}

const tooLarge = (): StorageError =>
  new StorageError('too_large', 'the download is larger than the declared size');
const notVerified = (): StorageError =>
  new StorageError('integrity_failed', 'the downloaded file did not verify');

/** Maps a failure to a fixed StorageError; anything foreign becomes `download_failed`, no cause. */
function fixed(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  if (error instanceof CryptoInputError && error.code === 'open_failed') return notVerified();
  return new StorageError('download_failed', 'the download failed');
}

/**
 * Downloads, decrypts and verifies one file into `sink`. The sink is committed only after the whole
 * object verified, and discarded on any failure (including invalid options). Resolves with the
 * verified size and hashes.
 */
export async function decryptDownload(
  source: CiphertextSource,
  sink: ProvisionalSink,
  opts: DecryptDownloadOptions,
): Promise<DecryptedFile> {
  let opener: Alf1Processor | undefined;
  try {
    if (sink === null || typeof sink !== 'object') throw invalid('missing sink');
    const { cap, ct, pt } = checked(opts);
    opener = createAlf1Opener(opts.fileKey, {
      expectedCiphertextSha256: ct,
      expectedPlaintextSha256: pt,
    });
    const open = opener;
    let received = 0;
    // One sink write at a time, in order; each plaintext piece is wiped once written.
    const deliver = async (pieces: readonly Uint8Array[]): Promise<void> => {
      for (let i = 0; i < pieces.length; i += 1) {
        try {
          await sink.write(pieces[i]!);
        } finally {
          wipe(pieces[i]!);
        }
      }
    };
    const onChunk = async (chunk: Uint8Array): Promise<void> => {
      if (!(chunk instanceof Uint8Array)) throw invalid('ciphertext source must yield bytes');
      received += chunk.length;
      if (received > cap) throw tooLarge();
      await deliver(await open.update(chunk));
    };

    if (source instanceof ReadableStream) {
      await readAll(source, onChunk);
    } else if (typeof source === 'function') {
      // A source that ignores a rejection of onChunk and keeps delivering is still stopped: the
      // first failure is kept and every later piece is refused.
      // Calls are also serialised, in call order: a source that does not await onChunk never runs
      // two decryptions or sink writes at once, and the download ends only after the last one.
      let failure: unknown;
      let queue: Promise<void> = Promise.resolve();
      const guarded = (chunk: Uint8Array): Promise<void> => {
        const run = queue.then(async () => {
          if (failure !== undefined) throw failure;
          try {
            await onChunk(chunk);
          } catch (error) {
            failure = error;
            throw error;
          }
        });
        queue = run.catch(() => undefined);
        return run;
      };
      try {
        await source(cap, guarded);
      } catch (error) {
        await queue;
        throw failure ?? error;
      }
      await queue;
      if (failure !== undefined) throw failure;
    } else {
      throw invalid('missing ciphertext source');
    }

    if (received !== cap) {
      throw new StorageError('size_mismatch', 'the download is shorter than the declared size');
    }
    const { output, digests } = await open.finish();
    await deliver(output);
    await sink.commit();
    return {
      plaintextSize: digests.plaintextLength,
      plaintextSha256: encodeHex(digests.plaintextSha256),
      ciphertextSha256: encodeHex(digests.ciphertextSha256),
    };
  } catch (error) {
    opener?.abort();
    if (source instanceof ReadableStream && !source.locked) {
      await source.cancel().catch(() => undefined);
    }
    if (sink !== null && typeof sink === 'object' && typeof sink.discard === 'function') {
      await sink.discard().catch(() => undefined);
    }
    throw fixed(error);
  }
}

/** Reads the stream to its end through `onChunk`; cancels it on any failure. */
async function readAll(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  const reader = stream.getReader();
  let done = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        return;
      }
      await onChunk(next.value);
    }
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
