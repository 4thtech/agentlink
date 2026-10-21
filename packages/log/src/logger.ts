// Structured logger (04 §8 rule 4). Every record goes through redact() before a sink sees it, at
// every level, debug included (I-7). There is no option that turns redaction off.

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
  /** Where lines go. Default: the runtime console (consoleSink(); stderr only in Node). */
  readonly sink?: Sink;
  /** Component name, written as "name" on every line (for example "transport-nostr"). */
  readonly name?: string;
  /** Fields added to every line. Redacted like any other field. */
  readonly bindings?: Fields;
  /** Clock, for tests. */
  readonly now?: () => Date;
  /**
   * Fixed codes that may be written in the top-level `code` field (M1-7g-d, I-7). A `code` whose
   * value is a listed string is written as is; any other value gets the `code` key rule (only HTTP
   * status and system error codes are kept, the rest is redacted). Each listed code is a snake-case
   * identifier (all lower or all upper case, at most 64 characters) that redaction leaves unchanged;
   * anything else throws a TypeError. Default: none.
   */
  readonly codes?: Iterable<string>;
}

export interface Logger {
  readonly level: Level;
  isEnabled(level: Level): boolean;
  /**
   * Variable data belongs in `fields`, never in `msg`. A plain object is logged field by field; an
   * Error is logged as `err`; anything else (a thrown string, a number, an array) as `value`.
   */
  debug(msg: string, fields?: Fields | Error): void;
  info(msg: string, fields?: Fields | Error): void;
  warn(msg: string, fields?: Fields | Error): void;
  error(msg: string, fields?: Fields | Error): void;
  /** A logger that adds `bindings` to every line. */
  child(bindings: Fields): Logger;
  /** A logger that also lists `codes` (see LoggerOptions.codes); this one is unchanged. */
  withCodes(codes: Iterable<string>): Logger;
}

const RESERVED = new Set(['time', 'level', 'name', 'msg']);
const EPOCH = new Date(0);
const MAX_CODE_LENGTH = 64;
const FIXED_CODE = /^(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)*|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)$/;

/** The listed codes, each checked: a fixed identifier that redaction would not change. */
function toCodes(codes: Iterable<string> | undefined, into: Set<string> = new Set()): Set<string> {
  if (codes === undefined) return into;
  for (const code of codes) {
    if (
      typeof code !== 'string' ||
      code.length > MAX_CODE_LENGTH ||
      !FIXED_CODE.test(code) ||
      redactString(code) !== code
    ) {
      throw new TypeError('createLogger: a listed code is not a fixed identifier');
    }
    into.add(code);
  }
  return into;
}

function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}

/**
 * Normalizes what callers pass as fields or bindings. Only a plain object is spread into fields;
 * everything else is wrapped, so a string is never spread into one-character fields (where no
 * value pattern could match it). The caller's `catch (e) { log.error('x', e as Error) }` is safe
 * whatever was thrown.
 */
export function toFields(value: unknown): Fields {
  if (value === undefined) return {};
  if (value instanceof Error) return { err: value };
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) return { ...(value as Fields) };
  }
  return { value };
}

/** Bindings for createLogger and child: a binding that cannot be read never throws to the caller. */
function toBindings(value: unknown): Fields {
  try {
    return toFields(value);
  } catch {
    return { bindings: '[Unserializable]' };
  }
}

/** Builds the redacted record and serializes it. Exported for the tests of the record shape. */
export function formatRecord(
  time: Date,
  level: Level,
  name: string | undefined,
  msg: unknown,
  bindings: Fields,
  fields: unknown,
  codes: ReadonlySet<string> = new Set(),
): string {
  const record: { [key: string]: JsonValue } = { time: time.toISOString(), level };
  if (name !== undefined) record.name = redactString(name);
  record.msg = redactString(typeof msg === 'string' ? msg : String(msg));
  const raw = { ...bindings, ...toFields(fields) };
  const merged = redact(raw);
  if (merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
    for (const [key, value] of Object.entries(merged)) {
      record[RESERVED.has(key) ? `_${key}` : key] = value;
    }
  }
  // A listed fixed code, and only the exact top-level `code` field holding that string (M1-7g-d).
  const code: unknown = Object.prototype.hasOwnProperty.call(raw, 'code') ? raw.code : undefined;
  if (typeof code === 'string' && codes.has(code)) record.code = code;
  return JSON.stringify(record);
}

/** Creates a logger. Runs in Node, browsers and Workers; has no dependencies. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  if (!isLevel(level)) throw new TypeError('createLogger: unknown level');
  const threshold = LEVELS.indexOf(level);
  const sink = options.sink ?? consoleSink();
  const now = options.now ?? (() => new Date());
  const bindings = toBindings(options.bindings);
  const codes = toCodes(options.codes);

  const clock = (): Date => {
    try {
      const time = now();
      return time instanceof Date && !Number.isNaN(time.getTime()) ? time : EPOCH;
    } catch {
      return EPOCH;
    }
  };

  const write = (at: Level, msg: string, fields: unknown): void => {
    if (LEVELS.indexOf(at) < threshold) return;
    const time = clock();
    let line: string;
    try {
      line = formatRecord(time, at, options.name, msg, bindings, fields, codes);
    } catch {
      // Never fall back to the raw input.
      line = JSON.stringify({ time: time.toISOString(), level: at, msg: '[Unloggable record]' });
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
        codes,
        bindings: { ...bindings, ...toBindings(more) },
      }),
    withCodes: (more) =>
      createLogger({
        ...options,
        level,
        sink,
        now,
        bindings,
        codes: toCodes(more, new Set(codes)),
      }),
  };
}
