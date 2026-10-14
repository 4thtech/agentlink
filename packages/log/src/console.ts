// The only module of @agentlink/log that touches the runtime console. eslint.config.mjs exempts
// exactly this file (and the CLI's user-output channel) from the repo-wide console ban.
// Shared packages compile without DOM or Node types, so the console is reached through globalThis.

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

/** The runtime's console, or undefined where there is none. */
export function runtimeConsole(): Partial<ConsoleLike> | undefined {
  return (globalThis as { console?: Partial<ConsoleLike> }).console;
}

/**
 * Test support for the canary helper: replaces every console method with one that hands its
 * arguments to `onOutput` (and prints nothing). Returns a function that restores the originals.
 */
export function captureConsole(onOutput: (method: string, data: unknown[]) => void): () => void {
  const target = runtimeConsole();
  if (target === undefined) return () => undefined;
  const originals = new Map<string, unknown>();
  const record = target as Record<string, unknown>;
  for (const method of CONSOLE_METHODS) {
    originals.set(method, record[method]);
    record[method] = (...data: unknown[]) => onOutput(method, data);
  }
  return () => {
    for (const [method, original] of originals) record[method] = original;
  };
}

export interface ConsoleSinkOptions {
  /**
   * Write every level to the error stream (console.error). Set this in a stdio MCP server, where
   * stdout carries the protocol and a log line there would corrupt it.
   */
  readonly stderr?: boolean;
}

/**
 * A sink that writes each already-redacted line to the console, using the method for its level.
 * The sink only ever receives the serialized, redacted line; it cannot see the raw fields.
 */
export function consoleSink(options: ConsoleSinkOptions = {}): Sink {
  return (level: Level, line: string) => {
    const target = runtimeConsole();
    if (target === undefined) return;
    const method = options.stderr === true ? target.error : target[level];
    (method ?? target.log)?.call(target, line);
  };
}
