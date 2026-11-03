// R1: process-level guards for the `ui` host. A stray background rejection or exception (a relay
// socket, a timer, a late callback) must not end a healthy app host: it is logged with a fixed code
// only (never the error's text, stack or any value, I-7) and the host keeps serving. The run ends,
// cleanly, only when the error is fatal to the server itself, or when strays pile up (a storm).
import process from 'node:process';

/** What ended the run. */
export type FatalReason = 'uncaught' | 'rejections';

/** The one logging method the guards use (the redacting logger has it). */
export interface GuardLog {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface GuardOptions {
  readonly proc?: Pick<NodeJS.Process, 'on' | 'off'>;
  readonly log: GuardLog;
  /** Called at most once. */
  readonly onFatal: (reason: FatalReason) => void;
  /** More strays than this within `windowMs` is a storm. Default 5. */
  readonly maxStray?: number;
  /** Default 60 s. */
  readonly windowMs?: number;
  /** Milliseconds; for tests. */
  readonly now?: () => number;
}

/** Codes of errors that mean the server itself can no longer serve. */
const SERVER_FATAL = new Set([
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'EACCES',
  'EMFILE',
  'ENFILE',
  'ERR_SERVER_NOT_RUNNING',
  'ERR_SERVER_ALREADY_LISTEN',
  'ERR_WORKER_OUT_OF_MEMORY',
]);

const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

/** The error's `code` when it is a plain upper-case code, else undefined. */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && CODE.test(code) ? code : undefined;
}

/** True when `error` is one of the server-level failures that cannot be served through. */
export function isServerFatal(error: unknown): boolean {
  const code = codeOf(error);
  return code !== undefined && SERVER_FATAL.has(code);
}

/** Installs the guards; returns the function that removes them. */
export function guardProcess(options: GuardOptions): () => void {
  const proc = options.proc ?? process;
  const max = options.maxStray ?? 5;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  let times: number[] = [];
  let ended = false;
  const end = (reason: FatalReason): void => {
    if (ended) return;
    ended = true;
    options.onFatal(reason);
  };
  const stray = (kind: FatalReason, error: unknown): void => {
    if (ended) return;
    // Fixed words and a plain code only.
    options.log.warn('background problem ignored', { kind, code: codeOf(error) ?? 'unknown' });
    const t = now();
    times = [...times.filter((at) => t - at < windowMs), t];
    if (times.length > max) end(kind);
  };
  const onRejection = (error: unknown): void => stray('rejections', error);
  const onException = (error: unknown): void => {
    if (isServerFatal(error)) {
      options.log.warn('server problem', { kind: 'uncaught', code: codeOf(error) ?? 'unknown' });
      end('uncaught');
      return;
    }
    stray('uncaught', error);
  };
  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);
  return () => {
    proc.off('unhandledRejection', onRejection);
    proc.off('uncaughtException', onException);
  };
}
