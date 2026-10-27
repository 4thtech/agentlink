// UI-REFRESH-g keeper: one health poller for the whole app. The shell (status bar) and Home both
// need the health answer; they share one poller, so the app reads /api/ui/health once per tick.
// The first subscriber's read is used; later subscribers get the latest state and answer at once.
// The poller stops with the last subscriber.
import type { ApiResult } from '../api/client.js';
import { startHealthPoller, type HealthState } from './health.js';

export interface HealthSubscriber {
  /** Called when the state (or the version) changes, as the poller reports it. */
  readonly onState?: (state: HealthState, version?: string) => void;
  /** Called with every raw answer (to be checked by the caller before use). */
  readonly onResult?: (result: ApiResult<unknown>) => void;
}

const subscribers = new Set<HealthSubscriber>();
let stop: (() => void) | undefined;
let lastState: { state: HealthState; version: string | undefined } | undefined;
let lastResult: ApiResult<unknown> | undefined;

function each(call: (s: HealthSubscriber) => void): void {
  for (const s of [...subscribers]) {
    try {
      call(s);
    } catch {
      // One subscriber failing must not stop the others or the poller.
    }
  }
}

/** For tests only: stop the poller and forget every subscriber and answer. */
export function resetHealthFeedForTests(): void {
  stop?.();
  stop = undefined;
  subscribers.clear();
  lastState = undefined;
  lastResult = undefined;
}

/** Follow the shared health poller (starting it if needed); returns the unsubscribe. */
export function subscribeHealth(
  read: () => Promise<ApiResult<unknown>>,
  subscriber: HealthSubscriber,
): () => void {
  subscribers.add(subscriber);
  if (stop === undefined) {
    stop = startHealthPoller({
      read: async () => {
        let result: ApiResult<unknown>;
        try {
          result = await read();
        } catch {
          result = { kind: 'offline' };
        }
        lastResult = result;
        each((s) => s.onResult?.(result));
        return result;
      },
      onState: (state, version) => {
        lastState = { state, version };
        each((s) => s.onState?.(state, version));
      },
    });
  } else {
    // A late subscriber starts from what the poller already knows.
    if (lastResult !== undefined) subscriber.onResult?.(lastResult);
    if (lastState !== undefined) subscriber.onState?.(lastState.state, lastState.version);
  }
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0 && stop !== undefined) {
      stop();
      stop = undefined;
      lastState = undefined;
      lastResult = undefined;
    }
  };
}
