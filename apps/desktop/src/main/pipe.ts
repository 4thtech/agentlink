// The strict pipe client: the shell's end of fd 3 (protocol spec in ../shared/protocol.ts).
//
// Bytes are buffered until "\n"; a line longer than MAX_LINE_BYTES is a violation as soon as the
// buffer passes the limit (before decoding or parsing). Each line is decoded as strict UTF-8 and
// parsed with parseCoreMessage. The first violation closes the pipe and reports a fixed code; nothing
// from the offending bytes is kept, logged or passed on. Outgoing messages are encoded (and
// re-validated) by encodeShellMessage.
import {
  MAX_LINE_BYTES,
  encodeShellMessage,
  parseCoreMessage,
  type CoreMessage,
  type ShellMessage,
} from '../shared/protocol.js';

/** The stream the pipe runs on (child.stdio[3], a net.Socket). */
export interface PipeStream {
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  write(data: string): unknown;
  destroy(): unknown;
}

/** Why the pipe was closed by the shell: fixed codes only. */
export type PipeViolation = 'oversize' | 'encoding' | 'message';

export interface PipeHandlers {
  readonly onMessage: (message: CoreMessage) => void;
  readonly onViolation: (violation: PipeViolation) => void;
  readonly onClose: () => void;
}

const NEWLINE = 0x0a;

export class PipeClient {
  readonly #stream: PipeStream;
  readonly #handlers: PipeHandlers;
  readonly #decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  #closed = false;

  constructor(stream: PipeStream, handlers: PipeHandlers) {
    this.#stream = stream;
    this.#handlers = handlers;
    stream.on('data', (chunk) => this.#onData(chunk));
    stream.on('error', () => this.#close());
    stream.on('close', () => this.#close());
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Sends one message; false when the pipe is closed. Throws only for an invalid message. */
  send(message: ShellMessage): boolean {
    const line = encodeShellMessage(message);
    if (this.#closed) return false;
    this.#stream.write(line);
    return true;
  }

  /** Closes the pipe (the shell's side). */
  close(): void {
    if (this.#closed) return;
    this.#close();
    this.#stream.destroy();
  }

  #onData(chunk: Uint8Array): void {
    if (this.#closed) return;
    let start = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      if (chunk[i] !== NEWLINE) continue;
      const piece = chunk.subarray(start, i);
      if (this.#buffered + piece.length > MAX_LINE_BYTES) return this.#violate('oversize');
      this.#chunks.push(piece);
      const line = this.#takeLine();
      start = i + 1;
      if (!this.#handleLine(line) || this.#closed) return;
    }
    const rest = chunk.subarray(start);
    if (this.#buffered + rest.length > MAX_LINE_BYTES) return this.#violate('oversize');
    if (rest.length > 0) {
      // Copy: the stream may reuse its buffer.
      this.#chunks.push(rest.slice());
      this.#buffered += rest.length;
    }
  }

  #takeLine(): Uint8Array {
    const total = this.#chunks.reduce((sum, part) => sum + part.length, 0);
    const line = new Uint8Array(total);
    let at = 0;
    for (const part of this.#chunks) {
      line.set(part, at);
      at += part.length;
    }
    this.#chunks = [];
    this.#buffered = 0;
    return line;
  }

  /** False after a violation. */
  #handleLine(bytes: Uint8Array): boolean {
    let text: string;
    try {
      text = this.#decoder.decode(bytes);
    } catch {
      this.#violate('encoding');
      return false;
    }
    const message = parseCoreMessage(text);
    if (message === undefined) {
      this.#violate('message');
      return false;
    }
    this.#handlers.onMessage(message);
    return true;
  }

  #violate(violation: PipeViolation): void {
    if (this.#closed) return;
    this.#chunks = [];
    this.#buffered = 0;
    this.#handlers.onViolation(violation);
    this.close();
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#chunks = [];
    this.#buffered = 0;
    this.#handlers.onClose();
  }
}
