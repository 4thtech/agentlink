// Web-platform helpers for the codec tests (M1-7c). Not part of the build (tsconfig.json excludes
// src/testing). The core is compiled without DOM or Node typings, so the few globals the tests need
// are typed here, minimally.

export type CodecFormat = 'deflate-raw' | 'deflate' | 'gzip';

interface Reader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
}
interface Writer {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
export interface CodecPair {
  readonly readable: unknown;
  readonly writable: unknown;
}
type CodecCtor = new (format: CodecFormat) => CodecPair;

interface Controller {
  enqueue(chunk: Uint8Array): void;
  close(): void;
}

interface Globals {
  CompressionStream: CodecCtor;
  DecompressionStream: CodecCtor;
  ReadableStream: new (source: { pull(controller: Controller): Promise<void> }) => unknown;
  setTimeout(fn: () => void, ms: number): unknown;
  process: {
    on(event: 'unhandledRejection', fn: (reason: unknown) => void): void;
    off(event: 'unhandledRejection', fn: (reason: unknown) => void): void;
  };
}

const g = globalThis as unknown as Globals;

const readerOf = (pair: CodecPair): Reader =>
  (pair.readable as { getReader(): Reader }).getReader();
const writerOf = (pair: CodecPair): Writer =>
  (pair.writable as { getWriter(): Writer }).getWriter();

/** Compresses with the platform CompressionStream (raw DEFLATE by default). */
export async function compress(
  bytes: Uint8Array,
  format: CodecFormat = 'deflate-raw',
): Promise<Uint8Array> {
  const pair = new g.CompressionStream(format);
  const writer = writerOf(pair);
  const reader = readerOf(pair);
  const chunks: Uint8Array[] = [];
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) return;
      chunks.push(value);
    }
  })();
  await writer.write(bytes);
  await writer.close();
  await reading;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    g.setTimeout(resolve, ms);
  });

/** Records unhandled promise rejections until the returned function is called. */
export function watchUnhandled(): { readonly seen: unknown[]; stop(): void } {
  const seen: unknown[] = [];
  const fn = (reason: unknown) => {
    seen.push(reason);
  };
  g.process.on('unhandledRejection', fn);
  return { seen, stop: () => g.process.off('unhandledRejection', fn) };
}

/**
 * Replaces the global DecompressionStream for one test. `wrap` gets each real stream; the returned
 * function restores the original.
 */
export function patchDecompression(wrap: (real: CodecPair) => CodecPair): () => void {
  const real = g.DecompressionStream;
  g.DecompressionStream = class {
    readonly readable: unknown;
    readonly writable: unknown;
    constructor(format: CodecFormat) {
      const pair = wrap(new real(format));
      this.readable = pair.readable;
      this.writable = pair.writable;
    }
  } as unknown as CodecCtor;
  return () => {
    g.DecompressionStream = real;
  };
}

/** The same stream with a reader that waits `ms` before each chunk; counts what it delivers. */
export function slowReader(
  real: CodecPair,
  ms: number,
  onChunk: (bytes: number) => void,
): CodecPair {
  const reader = readerOf(real);
  const readable = new g.ReadableStream({
    async pull(controller) {
      await sleep(ms);
      const { done, value } = await reader.read();
      if (done || value === undefined) controller.close();
      else {
        onChunk(value.byteLength);
        controller.enqueue(value);
      }
    },
  });
  return { readable, writable: real.writable };
}
