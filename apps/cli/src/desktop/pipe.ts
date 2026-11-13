// WP-D3: the core's end of the private pipe (protocol.ts). The shell (apps/desktop, WP-D2) starts
// the core with a pipe or socket on fd 3; nothing else is accepted there: a missing fd, a file, a
// terminal or a character device means the host was not started by the app, and it refuses to run
// (host-main.ts prints its fixed line). Reading is bounded (MAX_PIPE_LINE_BYTES per line, strict
// UTF-8) and every line goes through parseShellMessage; a rejected line is dropped and counted,
// never echoed, logged or answered with its content.
import { fstatSync, type Stats } from 'node:fs';
import { Socket } from 'node:net';
import process from 'node:process';
import {
  MAX_PIPE_LINE_BYTES,
  encodeHostMessage,
  parseShellMessage,
  type HostMessage,
  type ShellMessage,
} from './protocol.js';

/** The fd the shell hands the core (stdio index 3). */
export const DESKTOP_PIPE_FD = 3;

/** What is on the fd: a pipe or socket (`ok`), nothing (`missing`), or something else (`refused`). */
export type PipeProbe = 'ok' | 'missing' | 'refused';

/** The file-type bits of `stats.mode` and the pipe type (literals: the same on every OS). */
const S_IFMT = 0o170000;
const S_IFIFO = 0o010000;

/** What fstat gives the probe: the POSIX type helpers and, where present, the raw mode. */
export type PipeStat = Pick<Stats, 'isFIFO' | 'isSocket'> & { readonly mode?: unknown };

/**
 * Looks at `fd` without reading or writing it.
 *
 * WIN-DESK-1: on Windows Node's `isFIFO()` and `isSocket()` always answer false, whatever the
 * handle is; libuv puts the handle type in `mode` instead (a pipe or socket S_IFIFO, a file S_IFREG,
 * a console S_IFCHR). So on win32 only a mode whose type is exactly S_IFIFO counts; a type-less,
 * unknown or missing mode is refused. Elsewhere the helpers decide, as before. `openDesktopPipe`
 * is the second, independent check (net.Socket accepts only a pipe or a socket).
 */
export function probePipeFd(
  fd: number,
  fstat: (fd: number) => PipeStat = fstatSync,
  platform: string = process.platform,
): PipeProbe {
  let info: PipeStat;
  try {
    info = fstat(fd);
  } catch {
    return 'missing';
  }
  // Only a pipe or a socket: never a file (the link would land on disk) or a terminal.
  if (platform === 'win32') {
    return typeof info.mode === 'number' && (info.mode & S_IFMT) === S_IFIFO ? 'ok' : 'refused';
  }
  return info.isFIFO() || info.isSocket() ? 'ok' : 'refused';
}

/** Splits bytes into lines; an over-long or non-UTF-8 line is dropped and reported. */
export function createLineReader(
  onLine: (line: string) => void,
  onReject: () => void,
  maxBytes: number = MAX_PIPE_LINE_BYTES,
): (chunk: Uint8Array) => void {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let parts: Uint8Array[] = [];
  let size = 0;
  let discarding = false;
  const finish = (): void => {
    const joined = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }
    parts = [];
    size = 0;
    let line: string;
    try {
      line = decoder.decode(joined);
    } catch {
      onReject();
      return;
    }
    onLine(line);
  };
  return (chunk) => {
    let start = 0;
    while (start <= chunk.length) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      const piece = chunk.subarray(start, end);
      if (!discarding) {
        if (size + piece.length > maxBytes) {
          // Too long: drop what we have and everything up to the next newline.
          parts = [];
          size = 0;
          discarding = true;
          onReject();
        } else if (piece.length > 0) {
          // Copy: the stream may reuse its buffer.
          parts.push(piece.slice());
          size += piece.length;
        }
      }
      if (nl === -1) return;
      if (discarding) discarding = false;
      else finish();
      start = nl + 1;
    }
  };
}

/** The core's view of the pipe (tests pass doubles). */
export interface DesktopPipe {
  /** Sends one message; false when it is not a valid message or the pipe is closed. */
  send(message: HostMessage): boolean;
  onMessage(listener: (message: ShellMessage) => void): void;
  /** A line that was not exactly one shell message (no content is passed). */
  onReject(listener: () => void): void;
  /** The shell closed its end (or the pipe broke). Called at most once. */
  onClose(listener: () => void): void;
  /** Flushes and closes the core's end. */
  close(): Promise<void>;
}

/** The minimal duplex the pipe needs (a net.Socket on fd 3; tests: a PassThrough pair). */
export interface PipeStream {
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'end' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  write(data: string): boolean;
  end(callback?: () => void): unknown;
  destroy(): unknown;
  readonly writable: boolean;
}

/** The pipe over a stream (strict parsing, bounded lines). */
export function desktopPipeOver(stream: PipeStream): DesktopPipe {
  const messageListeners: ((message: ShellMessage) => void)[] = [];
  const rejectListeners: (() => void)[] = [];
  const closeListeners: (() => void)[] = [];
  let closed = false;
  const reject = (): void => {
    for (const listener of rejectListeners) listener();
  };
  const read = createLineReader((line) => {
    const message = parseShellMessage(line);
    if (message === undefined) {
      reject();
      return;
    }
    for (const listener of messageListeners) listener(message);
  }, reject);
  const closedNow = (): void => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener();
  };
  stream.on('data', (chunk) => read(chunk));
  stream.on('end', closedNow);
  stream.on('close', closedNow);
  // An error is a broken pipe: the shell is gone. Nothing from the error is kept.
  stream.on('error', () => closedNow());
  return {
    send: (message) => {
      if (closed || !stream.writable) return false;
      const line = encodeHostMessage(message);
      if (line === undefined) return false;
      try {
        stream.write(line);
        return true;
      } catch {
        return false;
      }
    },
    onMessage: (listener) => void messageListeners.push(listener),
    onReject: (listener) => void rejectListeners.push(listener),
    onClose: (listener) => void closeListeners.push(listener),
    close: () =>
      new Promise<void>((resolve) => {
        const done = (): void => {
          stream.destroy();
          resolve();
        };
        if (!stream.writable) {
          done();
          return;
        }
        const timer = setTimeout(done, 2_000);
        timer.unref?.();
        try {
          stream.end(() => {
            clearTimeout(timer);
            done();
          });
        } catch {
          clearTimeout(timer);
          done();
        }
      }),
  };
}

/**
 * The real pipe on fd 3 (call probePipeFd first). Throws (ERR_INVALID_FD_TYPE) when libuv does not
 * see a pipe or a socket on the fd; host-main.ts turns that into its fixed line.
 */
export function openDesktopPipe(fd: number = DESKTOP_PIPE_FD): DesktopPipe {
  return desktopPipeOver(new Socket({ fd, readable: true, writable: true }));
}
