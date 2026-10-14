// The only module of @agentlink/log that touches the runtime console and the process output
// streams. eslint.config.mjs exempts exactly this file (and the CLI's user-output channel) from the
// repo-wide console ban. Shared packages compile without DOM or Node types, so both are reached
// through globalThis.

import type { Level, Sink } from './logger.js';

/** The console methods the logger and the canary helper use. Present in Node, browsers and Workers. */
export interface ConsoleLike {
  log(...data: unknown[]): void;
  debug(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
  trace(...data: unknown[]): void;
}

/** Console method names, in the order the canary helper patches them. */
export const CONSOLE_METHODS = ['log', 'debug', 'info', 'warn', 'error', 'trace'] as const;

/** Node's output streams, which code could write to directly. */
const STREAMS = ['stdout', 'stderr'] as const;

interface WritableLike {
  write: (chunk: unknown, ...rest: unknown[]) => boolean;
}

interface ProcessLike {
  versions?: { node?: string };
  stdout?: WritableLike;
  stderr?: WritableLike;
}

/** The runtime's console, or undefined where there is none. */
export function runtimeConsole(): Partial<ConsoleLike> | undefined {
  return (globalThis as { console?: Partial<ConsoleLike> }).console;
}

function runtimeProcess(): ProcessLike | undefined {
  return (globalThis as { process?: ProcessLike }).process;
}

/** True in Node (not in browsers or Workers, even with Node compatibility shims for `process`). */
function isNode(): boolean {
  return typeof runtimeProcess()?.versions?.node === 'string';
}

function chunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) {
    const Decoder = (globalThis as { TextDecoder?: new () => { decode(b: Uint8Array): string } })
      .TextDecoder;
    if (Decoder !== undefined) return new Decoder().decode(chunk);
  }
  return String(chunk);
}

/**
 * Test support for the canary helper: replaces every console method, and in Node the
 * `process.stdout.write` and `process.stderr.write` methods, with one that hands its output to
 * `onOutput` (and prints nothing). Returns a function that restores the originals.
 */
export function captureConsole(onOutput: (method: string, data: unknown[]) => void): () => void {
  const restores: (() => void)[] = [];
  const target = runtimeConsole();
  if (target !== undefined) {
    const record = target as Record<string, unknown>;
    for (const method of CONSOLE_METHODS) {
      const original = record[method];
      record[method] = (...data: unknown[]) => onOutput(method, data);
      restores.push(() => {
        record[method] = original;
      });
    }
  }
  const proc = runtimeProcess();
  for (const name of STREAMS) {
    const stream = proc?.[name];
    if (stream === undefined || typeof stream.write !== 'function') continue;
    const original = stream.write;
    stream.write = (chunk: unknown, ...rest: unknown[]) => {
      onOutput(name, [chunkText(chunk)]);
      const callback = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined;
      callback?.();
      return true;
    };
    restores.push(() => {
      stream.write = original;
    });
  }
  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

export interface ConsoleSinkOptions {
  /**
   * Write every level to the error stream (console.error). Default: true in Node, where stdout may
   * carry a protocol (a stdio MCP server) that a log line would corrupt; false in browsers and
   * Workers, where each level goes to its own console method.
   */
  readonly stderr?: boolean;
}

/**
 * A sink that writes each already-redacted line to the console.
 * The sink only ever receives the serialized, redacted line; it cannot see the raw fields.
 */
export function consoleSink(options: ConsoleSinkOptions = {}): Sink {
  const stderr = options.stderr ?? isNode();
  return (level: Level, line: string) => {
    const target = runtimeConsole();
    if (target === undefined) return;
    const method = stderr ? target.error : target[level];
    (method ?? target.log)?.call(target, line);
  };
}
