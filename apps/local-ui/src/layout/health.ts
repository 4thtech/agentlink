// M1-11s-a-d / M1-11s-a-c: the status bar's health read (08 §1; B-11 §5, §6, §15).
//
// The app asks `GET /api/ui/health` (behind the session and CSRF checks) and turns the fixed answer
// into the status bar's state. Only the allowlisted words and a plain version are read from it;
// anything else in the body is ignored, so nothing else can reach the page.
//
// - running → Connected; paused → Paused; not_running → Not running; needs_setup → Needs setup.
//   No answer, an error or a malformed body → Not running: never Connected without a well-formed
//   running answer.
// - "Checking…" lasts at most FIRST_ANSWER_MS: with no answer by then the state is Not running.
// - Every HEALTH_POLL_MS while healthy; after a failure the next read waits 2 s, doubling up to
//   HEALTH_MAX_BACKOFF_MS, and a healthy answer resets it. The server caches its answer for 3 s, so
//   reads stay cheap. Paused while the tab is hidden (B-11 §6 performance), read again when shown.
// - States are reported only when they change, so the live region is not spammed.
import { createApiClient, type ApiResult } from '../api/client.js';

export const HEALTH_PATH = '/api/ui/health';
export const HEALTH_POLL_MS = 5_000;
export const HEALTH_FIRST_BACKOFF_MS = 2_000;
export const HEALTH_MAX_BACKOFF_MS = 30_000;
/** B-11 §5: Checking turns into Not running after 4 s with no answer. */
export const FIRST_ANSWER_MS = 4_000;
/** A single read that has not answered by then counts as no answer. */
export const READ_TIMEOUT_MS = 10_000;

/** The states the health read can set (the layout adds `unknown` and the browser's `offline`). */
export type HealthState = 'connected' | 'paused' | 'not_running' | 'needs_setup';

export interface HealthAnswer {
  readonly state: HealthState;
  /** A plain version (x.y.z[-pre]); undefined otherwise. */
  readonly version?: string;
}

const AGENT_STATE: Readonly<Record<string, HealthState>> = Object.freeze({
  running: 'connected',
  paused: 'paused',
  not_running: 'not_running',
  needs_setup: 'needs_setup',
});
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/;

/** The answer's state and version, or undefined when it is not a well-formed health answer. */
export function parseHealth(result: ApiResult<unknown>): HealthAnswer | undefined {
  if (result.kind !== 'ok') return undefined;
  const data = result.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const { agent, version } = data as { agent?: unknown; version?: unknown };
  if (typeof agent !== 'string' || !Object.hasOwn(AGENT_STATE, agent)) return undefined;
  const state = AGENT_STATE[agent] as HealthState;
  return typeof version === 'string' && VERSION.test(version) ? { state, version } : { state };
}

/** The status bar state for one health read. */
export function connectionFromHealth(result: ApiResult<unknown>): HealthState {
  return parseHealth(result)?.state ?? 'not_running';
}

export interface HealthTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface HealthPollerOptions {
  readonly read: () => Promise<ApiResult<unknown>>;
  /** Called when the state (or the version) changes. */
  readonly onState: (state: HealthState, version?: string) => void;
  readonly timers?: HealthTimers;
  /** Whether the tab is hidden (default: document.visibilityState). */
  readonly hidden?: () => boolean;
  /** Subscribes to visibility changes; returns the unsubscribe (default: visibilitychange). */
  readonly onVisibility?: (listener: () => void) => () => void;
}

const browserTimers: HealthTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const documentHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

const documentVisibility = (listener: () => void): (() => void) => {
  if (typeof document === 'undefined') return () => undefined;
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};

/** Starts polling (see the header); returns stop. A late answer after stop changes nothing. */
export function startHealthPoller(options: HealthPollerOptions): () => void {
  const timers = options.timers ?? browserTimers;
  const hidden = options.hidden ?? documentHidden;
  let stopped = false;
  let reading = false;
  let answered = false;
  let backoff = 0;
  let next: unknown;
  let last: { state: HealthState; version: string | undefined } | undefined;

  const report = (state: HealthState, version: string | undefined): void => {
    if (last !== undefined && last.state === state && last.version === version) return;
    last = { state, version };
    options.onState(state, version);
  };

  const schedule = (ms: number): void => {
    if (stopped) return;
    if (next !== undefined) timers.clear(next);
    next = timers.set(() => {
      next = undefined;
      void poll();
    }, ms);
  };

  const poll = async (): Promise<void> => {
    if (stopped || reading) return;
    // Hidden: no read and no timer; the visibility listener starts again.
    if (hidden()) return;
    reading = true;
    // A read that hangs counts as no answer after READ_TIMEOUT_MS, so polling never stalls.
    const result = await new Promise<ApiResult<unknown>>((resolve) => {
      const timeout = timers.set(() => resolve({ kind: 'offline' }), READ_TIMEOUT_MS);
      const done = (value: ApiResult<unknown>): void => {
        timers.clear(timeout);
        resolve(value);
      };
      try {
        options.read().then(done, () => done({ kind: 'offline' }));
      } catch {
        done({ kind: 'offline' });
      }
    });
    reading = false;
    if (stopped) return;
    answered = true;
    const answer = parseHealth(result);
    if (answer === undefined) {
      report('not_running', last?.version);
      backoff =
        backoff === 0 ? HEALTH_FIRST_BACKOFF_MS : Math.min(backoff * 2, HEALTH_MAX_BACKOFF_MS);
      schedule(backoff);
      return;
    }
    backoff = 0;
    report(answer.state, answer.version);
    schedule(HEALTH_POLL_MS);
  };

  const firstAnswer = timers.set(() => {
    if (!stopped && !answered) report('not_running', undefined);
  }, FIRST_ANSWER_MS);
  const unsubscribe = (options.onVisibility ?? documentVisibility)(() => {
    if (stopped || hidden()) return;
    if (next !== undefined) {
      timers.clear(next);
      next = undefined;
    }
    void poll();
  });
  void poll();

  return () => {
    stopped = true;
    timers.clear(firstAnswer);
    if (next !== undefined) timers.clear(next);
    next = undefined;
    unsubscribe();
  };
}

/** The production read: same-origin, with the page's CSRF token. */
export function readHealth(): Promise<ApiResult<unknown>> {
  return createApiClient().get(HEALTH_PATH);
}
