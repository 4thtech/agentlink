// Structured logger (04 §8.4). Every record goes through redact() before a sink sees it, at every
// level, debug included (I-7). There is no option that turns redaction off.

import { consoleSink } from './console.js';
import { redact, redactString, type JsonValue } from './redact.js';

export const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type Level = (typeof LEVELS)[number];

/** Structured fields of one record. Sensitive keys and secret-shaped strings are redacted. */
export type Fields = Record<string, unknown>;

/** Receives each record as one redacted JSON line. A sink never sees the raw fields. */
export type Sink = (level: Level, line: string) => void;

export interface LoggerOptions {
  /** Lowest level that is written. Default: "info". */
  readonly level?: Level;
  /** Where lines go. Default: the runtime console (consoleSink()). */
  readonly sink?: Sink;
  /** Component name, written as "name" on every line (for example "transport-nostr"). */
  readonly name?: string;
  /** Fields added to every line. Redacted like any other field. */
  readonly bindings?: Fields;
  /** Clock, for tests. */
  readonly now?: () => Date;
}

export interface Logger {
  readonly level: Level;
  isEnabled(level: Level): boolean;
  /** Variable data belongs in `fields`, never in `msg`. An Error may be passed as `fields`. */
  debug(msg: string, fields?: Fields | Error): void;
  info(msg: string, fields?: Fields | Error): void;
  warn(msg: string, fields?: Fields | Error): void;
  error(msg: string, fields?: Fields | Error): void;
  /** A logger that adds `bindings` to every line. */
  child(bindings: Fields): Logger;
}

const RESERVED = new Set(['time', 'level', 'name', 'msg']);

function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}

/** Builds the redacted record and serializes it. Exported for the tests of the record shape. */
export function formatRecord(
  time: Date,
  level: Level,
  name: string | undefined,
  msg: unknown,
  bindings: Fields,
  fields: Fields | Error | undefined,
): string {
  const record: { [key: string]: JsonValue } = { time: time.toISOString(), level };
  if (name !== undefined) record.name = redactString(name);
  record.msg = redactString(typeof msg === 'string' ? msg : String(msg));
  const extra = fields instanceof Error ? { err: fields } : (fields ?? {});
  const merged = redact({ ...bindings, ...extra });
  if (merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
    for (const [key, value] of Object.entries(merged)) {
      record[RESERVED.has(key) ? `_${key}` : key] = value;
    }
  }
  return JSON.stringify(record);
}

/** Creates a logger. Runs in Node, browsers and Workers; has no dependencies. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  if (!isLevel(level)) throw new TypeError('createLogger: unknown level');
  const threshold = LEVELS.indexOf(level);
  const sink = options.sink ?? consoleSink();
  const now = options.now ?? (() => new Date());
  const bindings: Fields = { ...(options.bindings ?? {}) };

  const write = (at: Level, msg: string, fields: Fields | Error | undefined): void => {
    if (LEVELS.indexOf(at) < threshold) return;
    let line: string;
    try {
      line = formatRecord(now(), at, options.name, msg, bindings, fields);
    } catch {
      // Never fall back to the raw input.
      line = JSON.stringify({ time: now().toISOString(), level: at, msg: '[Unloggable record]' });
    }
    try {
      sink(at, line);
    } catch {
      // A failing sink must not break the caller.
    }
  };

  return {
    level,
    isEnabled: (at) => LEVELS.indexOf(at) >= threshold,
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (more) =>
      createLogger({
        ...options,
        level,
        sink,
        now,
        bindings: { ...bindings, ...more },
      }),
  };
}
