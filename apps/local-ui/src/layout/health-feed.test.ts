// @vitest-environment jsdom
// UI-REFRESH-r (a): the shared health poller keeps module state; a test reset stops it and forgets
// every subscriber, so a subscriber left over from one test cannot decide the read of the next.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { resetHealthFeedForTests, subscribeHealth } from './health-feed.js';

afterEach(() => {
  resetHealthFeedForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const answer = (agent: string): ApiResult<unknown> => ({
  kind: 'ok',
  status: 200,
  data: { agent },
});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('resetHealthFeedForTests', () => {
  it('lets the next first subscriber supply the read after a leftover subscriber', async () => {
    const leftover = vi.fn(() => Promise.resolve(answer('running')));
    subscribeHealth(leftover, {});
    await flush();
    expect(leftover).toHaveBeenCalledTimes(1);

    resetHealthFeedForTests();

    const fresh = vi.fn(() => Promise.resolve(answer('paused')));
    const states: string[] = [];
    subscribeHealth(fresh, { onState: (s) => states.push(s) });
    await flush();
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['paused']);
  });

  it('stops the poller: nothing reads again after the reset', async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => Promise.resolve(answer('running')));
    subscribeHealth(read, {});
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    resetHealthFeedForTests();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
