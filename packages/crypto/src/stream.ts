// ALF1 STREAM file encryption (04 §4, D-80; M1-1d). The object is
//   header = "ALF1" (4 B) ‖ version u8 = 0x01 ‖ chunkSize u32be ‖ noncePrefix (8 B)   (17 bytes)
// followed by AES-256-GCM chunks: chunk i seals the plaintext bytes [i·chunkSize, (i+1)·chunkSize)
// under nonce noncePrefix ‖ u32be(i) with AAD header ‖ u8(isFinal), so a changed header, a dropped,
// reordered, duplicated or appended chunk, or a missing final chunk fails decryption.
//
// Chunking (04 §4, proposed, owner confirms at merge): every chunk but the last holds exactly
// `chunkSize` bytes; the last, the only one with isFinal = 1, holds 1 to `chunkSize` bytes. An exact
// multiple of `chunkSize` ends with a full final chunk. An empty final chunk exists only for the
// empty file (17 + 16 = 33 bytes). The opener splits the body into pieces of chunkSize + 16 bytes;
// the last piece is the final chunk. Senders use 1 MiB; openers accept 1 ≤ chunkSize ≤ 16 MiB and
// version 0x01 only, and refuse anything else before decrypting. The u32 index bounds a file to
// 2^32 chunks.
//
// Memory is bounded by one chunk on each side (plus what the caller's stream buffers): the sealer
// and the opener are push-based (`update`, then `finish`), and the Web Streams transforms wrap
// them, so a file never has to be in memory whole (07 §5.2). Both sides hash the ciphertext (the
// whole object, header included) and the plaintext as they go (`ciphertextSha256`,
// `plaintextSha256`, 04 §4 Integrity).
//
// Opening releases each chunk's plaintext as soon as that chunk authenticates, before the final
// chunk is seen. Only a successful `finish` (or a transform that closes without error and whose
// `done` resolves) means the whole file is authentic: until then the caller keeps the output
// provisional (for example in a temporary file) and discards it on any error. The caller still
// checks `ciphertextSha256` from the envelope before decrypting (04 §4); `expectedCiphertextSha256`
// and `expectedPlaintextSha256` make the opener itself fail on a mismatch at the end.
//
// AES-256-GCM is WebCrypto through aes-gcm.ts, SHA-256 is @noble/hashes through hash.ts; nothing here
// implements a primitive (I-8). The file key is copied in, imported once into a non-extractable
// CryptoKey, and our copy is wiped then (or on finish, failure or abort).
// Errors never contain input (I-7): opening refuses with one code, `open_failed`.
import {
  aes256GcmOpenWithKey,
  aes256GcmSealWithKey,
  importAes256GcmKey,
  type Aes256GcmKey,
} from './aes-gcm.js';
import { assertBytes, concatBytes, equalBytes } from './bytes.js';
import { CryptoInputError } from './errors.js';
import { createSha256 } from './hash.js';
import { randomBytes } from './random.js';
import { wipe } from './wipe.js';

export const ALF1_HEADER_LENGTH = 17;
export const ALF1_TAG_LENGTH = 16;
export const ALF1_VERSION = 1;
export const ALF1_FILE_KEY_LENGTH = 32;
export const ALF1_NONCE_PREFIX_LENGTH = 8;
/** What senders use (04 §4). */
export const ALF1_DEFAULT_CHUNK_SIZE = 1_048_576;
/** Openers accept 1 ≤ chunkSize ≤ 16 MiB (04 §4, proposed). */
export const ALF1_MIN_CHUNK_SIZE = 1;
export const ALF1_MAX_CHUNK_SIZE = 16_777_216;
/** The chunk index is a u32 in the nonce, so a file has at most 2^32 chunks. */
export const ALF1_MAX_CHUNKS = 2 ** 32;

const MAGIC = Object.freeze([0x41, 0x4c, 0x46, 0x31]); // "ALF1"

/** The SHA-256 and byte length of the object and of the plaintext. */
export interface Alf1Digests {
  /** SHA-256 of the whole object, header included. */
  readonly ciphertextSha256: Uint8Array;
  readonly plaintextSha256: Uint8Array;
  readonly ciphertextLength: number;
  readonly plaintextLength: number;
}

/** What `finish` returns: the last output pieces and the digests. */
export interface Alf1Finished {
  readonly output: readonly Uint8Array[];
  readonly digests: Alf1Digests;
}

/**
 * A push-based sealer or opener. Call `update` with consecutive pieces of input, one call at a time,
 * then `finish` once. Each returns the output pieces it produced (fresh buffers, owned by the
 * caller). After an error, `finish` or `abort`, every call is refused.
 */
export interface Alf1Processor {
  update(input: Uint8Array): Promise<readonly Uint8Array[]>;
  finish(): Promise<Alf1Finished>;
  /** Wipes the key and buffers and closes the processor. */
  abort(): void;
}

/** Optional checks an opener makes at `finish`, failing with `open_failed` on a mismatch. */
export interface Alf1OpenOptions {
  readonly expectedCiphertextSha256?: Uint8Array;
  readonly expectedPlaintextSha256?: Uint8Array;
}

/** The part of a WHATWG ReadableStream<Uint8Array> used here (the package has no DOM typings). */
export interface Alf1Readable {
  getReader(): {
    read(): Promise<{ done: true; value?: undefined } | { done: false; value: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  };
}

/** The part of a WHATWG WritableStream<Uint8Array> used here. */
export interface Alf1Writable {
  getWriter(): {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
    releaseLock(): void;
    readonly ready: Promise<void>;
  };
}

/**
 * A real WHATWG TransformStream (typed by the members used here; with DOM typings, cast `readable`
 * and `writable` to ReadableStream<Uint8Array> and WritableStream<Uint8Array>, or pass the pair to
 * `pipeThrough`), plus `done`, which resolves with the digests when the stream closes and rejects
 * when it fails.
 */
export interface Alf1TransformStream {
  readonly readable: Alf1Readable;
  readonly writable: Alf1Writable;
  readonly done: Promise<Alf1Digests>;
}

/** The result of `sealAlf1`. */
export interface Alf1Sealed extends Alf1Digests {
  readonly ciphertext: Uint8Array;
}

/** The result of `openAlf1`. */
export interface Alf1Opened extends Alf1Digests {
  readonly plaintext: Uint8Array;
}

const argument = (message: string): CryptoInputError =>
  new CryptoInputError('invalid_argument', message);
const refused = (message: string): CryptoInputError => new CryptoInputError('open_failed', message);

const HASH_MISMATCH = 'alf1: the object does not match its expected hash';

/**
 * A format built on the STREAM body (04 §4): its header length and how a complete header gives the
 * chunk size and the 8-byte nonce prefix. ALF1 (04 §4) and the recovery kit ALKK (04 §2.3.3) share
 * every chunk rule; only the header differs, and the whole header is the AAD prefix of each chunk.
 * Internal to the package: recovery-kit.ts is the only other user.
 */
export interface StreamFormat {
  /** Prefix of every error message, for example `alf1`. */
  readonly name: string;
  readonly headerLength: number;
  /**
   * The chunk size and nonce prefix of a complete header, or `undefined` when the header is refused
   * (checked before anything is decrypted).
   */
  readHeader(header: Uint8Array): { chunkSize: number; noncePrefix: Uint8Array } | undefined;
}

/** A 32-byte AES-256-GCM key, imported on first use; `drop` wipes it and forgets the import. */
export interface StreamKey {
  get(): Promise<Aes256GcmKey>;
  drop(): void;
}

const messagesOf = (format: StreamFormat) => ({
  notOpen: `${format.name}: the object does not open`,
  badHeader: `${format.name}: the object header is not a valid ${format.name.toUpperCase()} v1 header`,
  tooManyOpen: `${format.name}: an object has at most 2^32 chunks`,
  tooManySeal: `${format.name}: a file has at most 2^32 chunks`,
  oneCall: `${format.name}: one call at a time`,
  closed: `${format.name}: the stream is finished, failed or aborted`,
});

/**
 * The key, copied in, imported into WebCrypto on first use (once per object, not per chunk) and
 * then wiped from our copy; `drop` wipes it and forgets the imported key.
 */
export function streamKeyOf(fileKey: unknown, what = 'alf1: fileKey'): StreamKey {
  assertBytes(fileKey, what);
  if (fileKey.length !== ALF1_FILE_KEY_LENGTH) {
    throw new CryptoInputError('invalid_length', `${what} must be 32 bytes`);
  }
  const bytes = fileKey.slice();
  let imported: Aes256GcmKey | undefined;
  return {
    async get() {
      if (imported === undefined) {
        imported = await importAes256GcmKey(bytes);
        wipe(bytes);
      }
      return imported;
    },
    drop() {
      wipe(bytes);
      imported = undefined;
    },
  };
}

/** 1 ≤ chunkSize ≤ 16 MiB, for ALF1 and ALKK alike (04 §4, §2.3.3). */
export const isStreamChunkSize = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= ALF1_MIN_CHUNK_SIZE &&
  value <= ALF1_MAX_CHUNK_SIZE;

function checkStartIndex(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > ALF1_MAX_CHUNKS) {
    throw argument('alf1: the start index must be an integer in [0, 2^32]');
  }
}

function encodeHeader(chunkSize: number, noncePrefix: Uint8Array): Uint8Array {
  const header = new Uint8Array(ALF1_HEADER_LENGTH);
  header.set(MAGIC, 0);
  header[4] = ALF1_VERSION;
  new DataView(header.buffer).setUint32(5, chunkSize);
  header.set(noncePrefix, 9);
  return header;
}

/** 04 §4: "ALF1" ‖ version 0x01 ‖ chunkSize u32be (1..16 MiB) ‖ noncePrefix (8 B). */
const ALF1_FORMAT: StreamFormat = Object.freeze({
  name: 'alf1',
  headerLength: ALF1_HEADER_LENGTH,
  readHeader(header: Uint8Array) {
    const chunkSize = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
      5,
    );
    if (
      MAGIC.some((byte, i) => header[i] !== byte) ||
      header[4] !== ALF1_VERSION ||
      !isStreamChunkSize(chunkSize)
    ) {
      return undefined;
    }
    return { chunkSize, noncePrefix: header.subarray(9, ALF1_HEADER_LENGTH) };
  },
});

/** AAD for one chunk: the whole header ‖ u8(isFinal) (D-80; 04 §2.3.3 for ALKK). */
function chunkAad(header: Uint8Array, isFinal: boolean): Uint8Array {
  const aad = new Uint8Array(header.length + 1);
  aad.set(header, 0);
  aad[header.length] = isFinal ? 1 : 0;
  return aad;
}

/** Nonce for chunk `index`: noncePrefix (8 B) ‖ u32be(index). `index` is below 2^32. */
function chunkNonce(noncePrefix: Uint8Array, index: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(noncePrefix, 0);
  new DataView(nonce.buffer).setUint32(8, index);
  return nonce;
}

type State = 'open' | 'busy' | 'closed';

/** Serialises calls and closes the processor on the first error, wiping through `cleanup`. */
function guarded(cleanup: () => void, messages: ReturnType<typeof messagesOf>) {
  let state: State = 'open';
  return {
    async run<T>(work: () => Promise<T>, closesAfter: boolean): Promise<T> {
      if (state === 'busy') throw argument(messages.oneCall);
      if (state === 'closed') throw argument(messages.closed);
      state = 'busy';
      try {
        const result = await work();
        // `abort` during the call closed the processor: its result is not handed out.
        if (state !== 'busy') throw argument(messages.closed);
        state = closesAfter ? 'closed' : 'open';
        if (closesAfter) cleanup();
        return result;
      } catch (error) {
        state = 'closed';
        cleanup();
        throw error;
      }
    },
    abort(): void {
      state = 'closed';
      cleanup();
    },
  };
}

/**
 * The sealer behind every public entry point. `startIndex` is the first chunk index (0 except in
 * tests, which start late to reach the 2^32 bound); not exported from the package.
 */
export function createAlf1SealerAt(
  fileKey: Uint8Array,
  noncePrefix: Uint8Array,
  chunkSize: number,
  startIndex: number,
): Alf1Processor {
  assertBytes(noncePrefix, 'alf1: noncePrefix');
  if (noncePrefix.length !== ALF1_NONCE_PREFIX_LENGTH) {
    throw new CryptoInputError('invalid_length', 'alf1: noncePrefix must be 8 bytes');
  }
  if (!isStreamChunkSize(chunkSize)) {
    throw argument('alf1: chunkSize must be an integer from 1 to 16 MiB');
  }
  checkStartIndex(startIndex);
  return createStreamSealerAt(
    ALF1_FORMAT,
    streamKeyOf(fileKey),
    encodeHeader(chunkSize, noncePrefix),
    startIndex,
  );
}

/**
 * The STREAM sealer of any format: `header` is emitted first and is the AAD prefix of every chunk.
 * The header must be valid for `format` (the caller built it). Takes ownership of `key`.
 */
export function createStreamSealerAt(
  format: StreamFormat,
  key: StreamKey,
  header: Uint8Array,
  startIndex: number,
): Alf1Processor {
  const messages = messagesOf(format);
  const layout = header.length === format.headerLength ? format.readHeader(header) : undefined;
  if (layout === undefined) {
    key.drop();
    throw argument(messages.badHeader);
  }
  const { chunkSize } = layout;
  const noncePrefix = layout.noncePrefix.slice();
  const aadMiddle = chunkAad(header, false);
  const aadFinal = chunkAad(header, true);
  const buffer = new Uint8Array(chunkSize);
  const ctHash = createSha256();
  const ptHash = createSha256();
  let filled = 0;
  let index = startIndex;
  let headerSent = false;
  let ciphertextLength = 0;
  let plaintextLength = 0;
  const guard = guarded(() => {
    key.drop();
    wipe(buffer);
  }, messages);

  const emitHeader = (out: Uint8Array[]): void => {
    if (headerSent) return;
    headerSent = true;
    ctHash.update(header);
    ciphertextLength += header.length;
    out.push(header.slice());
  };

  const sealChunk = async (plaintext: Uint8Array, isFinal: boolean): Promise<Uint8Array> => {
    if (index >= ALF1_MAX_CHUNKS) throw argument(messages.tooManySeal);
    const sealed = await aes256GcmSealWithKey(
      await key.get(),
      chunkNonce(noncePrefix, index),
      plaintext,
      isFinal ? aadFinal : aadMiddle,
    );
    index += 1;
    ctHash.update(sealed);
    ciphertextLength += sealed.length;
    return sealed;
  };

  return Object.freeze({
    update(plaintext: Uint8Array): Promise<readonly Uint8Array[]> {
      return guard.run(async () => {
        assertBytes(plaintext, `${format.name}: plaintext`);
        const out: Uint8Array[] = [];
        emitHeader(out);
        ptHash.update(plaintext);
        plaintextLength += plaintext.length;
        let at = 0;
        while (at < plaintext.length) {
          // A full buffer is sealed as a middle chunk only once more plaintext follows it.
          if (filled === chunkSize) {
            out.push(await sealChunk(buffer, false));
            filled = 0;
          }
          const n = Math.min(chunkSize - filled, plaintext.length - at);
          buffer.set(plaintext.subarray(at, at + n), filled);
          filled += n;
          at += n;
        }
        return out;
      }, false);
    },
    finish(): Promise<Alf1Finished> {
      return guard.run(async () => {
        const out: Uint8Array[] = [];
        emitHeader(out);
        // The final chunk: the rest of the plaintext, empty only for the empty file.
        out.push(await sealChunk(buffer.subarray(0, filled), true));
        return {
          output: out,
          digests: {
            ciphertextSha256: ctHash.digest(),
            plaintextSha256: ptHash.digest(),
            ciphertextLength,
            plaintextLength,
          },
        };
      }, true);
    },
    abort: guard.abort,
  });
}

/** The opener behind every public entry point; `startIndex` as for createAlf1SealerAt. */
export function createAlf1OpenerAt(
  fileKey: Uint8Array,
  startIndex: number,
  options: Alf1OpenOptions = {},
): Alf1Processor {
  checkStartIndex(startIndex);
  const expectedCt = expectedHash(options.expectedCiphertextSha256, 'expectedCiphertextSha256');
  const expectedPt = expectedHash(options.expectedPlaintextSha256, 'expectedPlaintextSha256');
  return createStreamOpenerAt(ALF1_FORMAT, streamKeyOf(fileKey), startIndex, (digests) =>
    (expectedCt !== undefined && !equalBytes(expectedCt, digests.ciphertextSha256)) ||
    (expectedPt !== undefined && !equalBytes(expectedPt, digests.plaintextSha256))
      ? HASH_MISMATCH
      : undefined,
  );
}

/**
 * The STREAM opener of any format. The input starts with the header, which `format.readHeader`
 * checks before anything is decrypted; it is the AAD prefix of every chunk. `checkDigests`, run at
 * `finish`, returns a refusal message or `undefined`. Takes ownership of `key`.
 */
export function createStreamOpenerAt(
  format: StreamFormat,
  key: StreamKey,
  startIndex: number,
  checkDigests: (digests: Alf1Digests) => string | undefined = () => undefined,
): Alf1Processor {
  const messages = messagesOf(format);
  const header = new Uint8Array(format.headerLength);
  let headerFilled = 0;
  let pieceSize = 0;
  let piece: Uint8Array = new Uint8Array(0);
  let filled = 0;
  let noncePrefix: Uint8Array = new Uint8Array(0);
  let aadMiddle: Uint8Array = new Uint8Array(0);
  let aadFinal: Uint8Array = new Uint8Array(0);
  let index = startIndex;
  let chunksOpened = 0;
  const ctHash = createSha256();
  const ptHash = createSha256();
  let ciphertextLength = 0;
  let plaintextLength = 0;
  const guard = guarded(() => {
    key.drop();
    wipe(piece);
  }, messages);

  /** Checks the header before anything is decrypted (for ALF1: magic, version 0x01, chunkSize). */
  const acceptHeader = (): void => {
    const layout = format.readHeader(header);
    if (layout === undefined) throw refused(messages.badHeader);
    pieceSize = layout.chunkSize + ALF1_TAG_LENGTH;
    piece = new Uint8Array(pieceSize);
    noncePrefix = layout.noncePrefix.slice();
    aadMiddle = chunkAad(header, false);
    aadFinal = chunkAad(header, true);
  };

  const openChunk = async (sealed: Uint8Array, isFinal: boolean): Promise<Uint8Array> => {
    if (index >= ALF1_MAX_CHUNKS) throw refused(messages.tooManyOpen);
    // Only the empty file has an empty (tag-only) final chunk, and it is the only chunk.
    if (sealed.length < ALF1_TAG_LENGTH) throw refused(messages.notOpen);
    if (sealed.length === ALF1_TAG_LENGTH && chunksOpened > 0) throw refused(messages.notOpen);
    const plaintext = await aes256GcmOpenWithKey(
      await key.get(),
      chunkNonce(noncePrefix, index),
      sealed,
      isFinal ? aadFinal : aadMiddle,
    );
    if (plaintext === undefined) throw refused(messages.notOpen);
    index += 1;
    chunksOpened += 1;
    ptHash.update(plaintext);
    plaintextLength += plaintext.length;
    return plaintext;
  };

  return Object.freeze({
    update(ciphertext: Uint8Array): Promise<readonly Uint8Array[]> {
      return guard.run(async () => {
        assertBytes(ciphertext, `${format.name}: ciphertext`);
        ctHash.update(ciphertext);
        ciphertextLength += ciphertext.length;
        const out: Uint8Array[] = [];
        let at = 0;
        if (headerFilled < format.headerLength) {
          const n = Math.min(format.headerLength - headerFilled, ciphertext.length);
          header.set(ciphertext.subarray(0, n), headerFilled);
          headerFilled += n;
          at = n;
          if (headerFilled === format.headerLength) acceptHeader();
        }
        while (at < ciphertext.length) {
          // A full piece is a middle chunk only once more bytes follow it; else it is the final one.
          if (filled === pieceSize) {
            out.push(await openChunk(piece, false));
            filled = 0;
          }
          const n = Math.min(pieceSize - filled, ciphertext.length - at);
          piece.set(ciphertext.subarray(at, at + n), filled);
          filled += n;
          at += n;
        }
        return out;
      }, false);
    },
    finish(): Promise<Alf1Finished> {
      return guard.run(async () => {
        if (headerFilled < format.headerLength) throw refused(messages.badHeader);
        // No piece after the header: the final chunk is missing.
        if (filled === 0) throw refused(messages.notOpen);
        const last = await openChunk(piece.subarray(0, filled), true);
        const digests: Alf1Digests = {
          ciphertextSha256: ctHash.digest(),
          plaintextSha256: ptHash.digest(),
          ciphertextLength,
          plaintextLength,
        };
        const mismatch = checkDigests(digests);
        if (mismatch !== undefined) {
          wipe(last);
          throw refused(mismatch);
        }
        return { output: [last], digests };
      }, true);
    },
    abort: guard.abort,
  });
}

function expectedHash(value: unknown, what: string): Uint8Array | undefined {
  if (value === undefined) return undefined;
  assertBytes(value, `alf1: ${what}`);
  if (value.length !== 32) {
    throw new CryptoInputError('invalid_length', `alf1: ${what} must be 32 bytes`);
  }
  return value.slice();
}

/** A sealer with a fresh random nonce prefix and the default 1 MiB chunk size (04 §4). */
export function createAlf1Sealer(fileKey: Uint8Array): Alf1Processor {
  return createAlf1SealerAt(
    fileKey,
    randomBytes(ALF1_NONCE_PREFIX_LENGTH),
    ALF1_DEFAULT_CHUNK_SIZE,
    0,
  );
}

/**
 * An opener. Plaintext pieces come out as their chunks authenticate, before the final chunk is
 * seen, so they are provisional: a truncated or extended object fails only at `finish`. Keep the
 * output provisional (for example in a temporary file) until `finish` resolves, and discard it on
 * any error. Only a successful `finish` proves the whole file.
 */
export function createAlf1Opener(fileKey: Uint8Array, options?: Alf1OpenOptions): Alf1Processor {
  return createAlf1OpenerAt(fileKey, 0, options);
}

/** The runtime's TransformStream, typed by the members used here. */
interface TransformStreamCtor {
  new (transformer: {
    transform(chunk: unknown, controller: { enqueue(chunk: Uint8Array): void }): Promise<void>;
    flush(controller: { enqueue(chunk: Uint8Array): void }): Promise<void>;
    cancel(reason: unknown): Promise<void>;
  }): { readonly readable: Alf1Readable; readonly writable: Alf1Writable };
}

function transformOf(processor: Alf1Processor): Alf1TransformStream {
  const Ctor = (globalThis as { TransformStream?: TransformStreamCtor }).TransformStream;
  if (Ctor === undefined) throw new Error('alf1: this runtime has no Web Streams TransformStream');
  let resolveDone: (digests: Alf1Digests) => void = () => undefined;
  let rejectDone: (error: unknown) => void = () => undefined;
  const done = new Promise<Alf1Digests>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // A caller that only reads the stream sees the error there; `done` must not be an unhandled rejection.
  done.catch(() => undefined);
  const fail = (error: unknown): void => {
    processor.abort();
    rejectDone(error);
  };
  const stream = new Ctor({
    async transform(chunk, controller) {
      try {
        for (const piece of await processor.update(chunk as Uint8Array)) controller.enqueue(piece);
      } catch (error) {
        fail(error);
        throw error;
      }
    },
    async flush(controller) {
      try {
        const { output, digests } = await processor.finish();
        for (const piece of output) controller.enqueue(piece);
        resolveDone(digests);
      } catch (error) {
        fail(error);
        throw error;
      }
    },
    cancel() {
      fail(argument('alf1: the stream was cancelled'));
      return Promise.resolve();
    },
  });
  return Object.freeze({ readable: stream.readable, writable: stream.writable, done });
}

/** A TransformStream that encrypts plaintext bytes into an ALF1 object (random nonce prefix, 1 MiB). */
export function alf1EncryptStream(fileKey: Uint8Array): Alf1TransformStream {
  return transformOf(createAlf1Sealer(fileKey));
}

/**
 * A TransformStream that decrypts an ALF1 object. Its output is provisional until the final chunk
 * verifies: pieces are released as their chunks authenticate, and a truncated or extended object
 * fails only at the end. The readable errors, and `done` rejects, on any refusal. Consumers keep the
 * output provisional (for example in a temporary file) until `done` resolves, and discard it on any
 * error.
 */
export function alf1DecryptStream(
  fileKey: Uint8Array,
  options?: Alf1OpenOptions,
): Alf1TransformStream {
  return transformOf(createAlf1Opener(fileKey, options));
}

async function runAll(
  processor: Alf1Processor,
  input: Uint8Array,
): Promise<{ pieces: Uint8Array[]; digests: Alf1Digests }> {
  const pieces: Uint8Array[] = [];
  try {
    pieces.push(...(await processor.update(input)));
    const { output, digests } = await processor.finish();
    pieces.push(...output);
    return { pieces, digests };
  } catch (error) {
    // Plaintext released before a later chunk failed is never handed out.
    wipe(...pieces);
    throw error;
  } finally {
    processor.abort();
  }
}

/** Seals a whole file held in memory (small files; large ones go through the stream). */
export async function sealAlf1(fileKey: Uint8Array, plaintext: Uint8Array): Promise<Alf1Sealed> {
  const { pieces, digests } = await runAll(createAlf1Sealer(fileKey), plaintext);
  return { ...digests, ciphertext: concatBytes(...pieces) };
}

/** Seals with a fixed nonce prefix and chunk size: the test seam's entry (testing.ts). */
export async function sealAlf1At(
  fileKey: Uint8Array,
  noncePrefix: Uint8Array,
  chunkSize: number,
  plaintext: Uint8Array,
): Promise<Alf1Sealed> {
  const { pieces, digests } = await runAll(
    createAlf1SealerAt(fileKey, noncePrefix, chunkSize, 0),
    plaintext,
  );
  return { ...digests, ciphertext: concatBytes(...pieces) };
}

/** Opens a whole ALF1 object held in memory; refuses with `open_failed`. */
export async function openAlf1(
  fileKey: Uint8Array,
  ciphertext: Uint8Array,
  options?: Alf1OpenOptions,
): Promise<Alf1Opened> {
  const { pieces, digests } = await runAll(createAlf1Opener(fileKey, options), ciphertext);
  try {
    return { ...digests, plaintext: concatBytes(...pieces) };
  } finally {
    wipe(...pieces);
  }
}
