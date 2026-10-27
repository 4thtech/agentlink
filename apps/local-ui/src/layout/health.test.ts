// @vitest-environment jsdom
// M1-11s-a-d / M1-11s-a-c: the status bar reads the local server's health (08 §1; B-11 §5, §6, §14).
//
// - The answer sets the state: running → Connected, paused → Paused, not_running → Not running,
//   needs_setup → Needs setup. No answer (the server is gone) → Not running. Anything malformed is
//   never Connected.
// - "Checking…" lasts at most 4 s: with no answer by then it becomes Not running (B-11 §5).
// - Polling: every 5 s while healthy; after a failure it backs off (doubling, capped at 30 s); it
//   pauses while the tab is hidden (B-11 §6 performance) and stops on unmount; a late answer after
//   stop changes nothing.
// - The status line is a polite live region, announced only when the state changes; the version
//   shows on the right; nothing from the answer other than the fixed words and a plain version.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api/client.js';
import {
  FIRST_ANSWER_MS,
  HEALTH_MAX_BACKOFF_MS,
  HEALTH_POLL_MS,
  connectionFromHealth,
  parseHealth,
  startHealthPoller,
} from './health.js';
import { Layout, setConnectionState } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });
const body = (agent: string, version: string | null = '0.3.0'): ApiResult<unknown> =>
  ok({ agent, relays: null, lastSyncAt: null, version });

describe('health answer to connection state', () => {
  it('maps each agent state, and never Connected without a well-formed running answer', () => {
    expect(connectionFromHealth(body('running'))).toBe('connected');
    expect(connectionFromHealth(body('paused'))).toBe('paused');
    expect(connectionFromHealth(body('not_running'))).toBe('not_running');
    expect(connectionFromHealth(body('needs_setup'))).toBe('needs_setup');
    expect(connectionFromHealth({ kind: 'offline' })).toBe('not_running');
    expect(connectionFromHealth({ kind: 'error', status: 500 })).toBe('not_running');
    expect(connectionFromHealth({ kind: 'session_expired' })).toBe('not_running');
    expect(connectionFromHealth(ok({ agent: 'connected' }))).toBe('not_running');
    expect(connectionFromHealth(ok('running'))).toBe('not_running');
    expect(connectionFromHealth(ok(null))).toBe('not_running');
  });

  it('keeps only a plain version', () => {
    expect(parseHealth(body('running', '0.3.0'))?.version).toBe('0.3.0');
    expect(parseHealth(body('running', '0.3.0-next.1'))?.version).toBe('0.3.0-next.1');
    expect(parseHealth(body('running', 'wss://relay.example'))?.version).toBeUndefined();
    expect(parseHealth(body('running', '<b>1</b>'))?.version).toBeUndefined();
    expect(parseHealth(body('running', null))?.version).toBeUndefined();
  });
});

/** A manual timer set and a hidden flag, so the poller runs without real time. */
function harness(answers: Array<ApiResult<unknown> | 'hang'>) {
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let now = 0;
  let nextId = 1;
  let hidden = false;
  const visibility = new Set<() => void>();
  const reads: number[] = [];
  const states: string[] = [];
  const read = (): Promise<ApiResult<unknown>> => {
    reads.push(now);
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next === 'hang' || next === undefined) return new Promise(() => undefined);
    return Promise.resolve(next);
  };
  const stop = startHealthPoller({
    read,
    onState: (state) => states.push(state),
    timers: {
      set: (fn, ms) => {
        const id = nextId++;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clear: (id) => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    hidden: () => hidden,
    onVisibility: (fn) => {
      visibility.add(fn);
      return () => visibility.delete(fn);
    },
  });
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  const advance = async (ms: number): Promise<void> => {
    const until = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (t === undefined || t.at > until) break;
      timers.shift();
      now = t.at;
      t.fn();
      await flush();
    }
    now = until;
  };
  return {
    reads,
    states,
    stop,
    flush,
    advance,
    setHidden: (value: boolean) => {
      hidden = value;
      for (const fn of visibility) fn();
    },
    pending: () => timers.length,
  };
}

describe('the health poller', () => {
  it('reads at once and every 5 s while healthy, reporting only changes', async () => {
    const p = harness([body('running')]);
    await p.flush();
    expect(p.reads).toEqual([0]);
    expect(p.states).toEqual(['connected']);
    await p.advance(HEALTH_POLL_MS * 3);
    expect(p.reads).toEqual([0, HEALTH_POLL_MS, HEALTH_POLL_MS * 2, HEALTH_POLL_MS * 3]);
    expect(p.states).toEqual(['connected']);
    p.stop();
  });

  it('turns Checking into Not running after 4 s with no answer', async () => {
    const p = harness(['hang']);
    await p.flush();
    expect(p.states).toEqual([]);
    await p.advance(FIRST_ANSWER_MS - 1);
    expect(p.states).toEqual([]);
    await p.advance(1);
    expect(p.states).toEqual(['not_running']);
    p.stop();
  });

  it('backs off after failures, doubling up to the cap, and resets once healthy', async () => {
    const answers: Array<ApiResult<unknown>> = Array.from({ length: 8 }, () => ({
      kind: 'offline' as const,
    }));
    answers.push(body('running'));
    const p = harness(answers);
    await p.advance(400_000);
    const gaps = p.reads.slice(1).map((t, i) => t - (p.reads[i] as number));
    expect(gaps.slice(0, 4)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(HEALTH_MAX_BACKOFF_MS);
    expect(gaps).toContain(HEALTH_MAX_BACKOFF_MS);
    expect(p.states[0]).toBe('not_running');
    expect(p.states).toContain('connected');
    // Healthy again: back to the normal interval.
    const last = p.reads.length;
    await p.advance(HEALTH_POLL_MS);
    expect(p.reads.length).toBe(last + 1);
    p.stop();
  });

  it('pauses while the tab is hidden and reads again when it shows', async () => {
    const p = harness([body('running')]);
    await p.flush();
    p.setHidden(true);
    await p.advance(HEALTH_POLL_MS * 10);
    expect(p.reads).toEqual([0]);
    p.setHidden(false);
    await p.flush();
    expect(p.reads.length).toBe(2);
    p.stop();
  });

  it('stops on unmount: no timers left and a late answer changes nothing', async () => {
    let resolve: (r: ApiResult<unknown>) => void = () => undefined;
    const states: string[] = [];
    const stop = startHealthPoller({
      read: () => new Promise((r) => (resolve = r)),
      onState: (s) => states.push(s),
      timers: { set: () => 1, clear: () => undefined },
      hidden: () => false,
      onVisibility: () => () => undefined,
    });
    stop();
    resolve(body('running'));
    await Promise.resolve();
    await Promise.resolve();
    expect(states).toEqual([]);
  });
});

describe('the status bar (M1-11s-a-c)', () => {
  let host: HTMLElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    act(() => setConnectionState('unknown'));
    vi.useRealTimers();
  });

  const render = async (readHealth: () => Promise<ApiResult<unknown>>): Promise<void> => {
    await act(async () => {
      root.render(
        h(
          Layout,
          {
            path: '/settings/rules',
            nextStep: () => Promise.resolve(false),
            unseenMessages: () => Promise.resolve(0),
            readHealth,
          },
          'page',
        ),
      );
    });
  };
  const bar = (): HTMLElement | null => host.querySelector('footer.al-statusbar');

  it('shows Connected and the version when the server says running', async () => {
    await render(() => Promise.resolve(body('running', '0.3.0')));
    expect(bar()?.textContent).toContain('Connected');
    expect(bar()?.textContent).toContain('0.3.0');
  });

  it('shows Paused, Not running and Needs setup in plain words', async () => {
    await render(() => Promise.resolve(body('paused')));
    expect(bar()?.textContent).toContain('Paused');
    act(() => root.unmount());
    root = createRoot(host);
    await render(() => Promise.resolve({ kind: 'offline' }));
    expect(bar()?.textContent).toContain('Not running');
    expect(bar()?.textContent).not.toContain('Connected');
    act(() => root.unmount());
    root = createRoot(host);
    await render(() => Promise.resolve(body('needs_setup')));
    expect(bar()?.textContent).toContain('Needs setup');
  });

  it('puts the state in one polite live region with a shape and a word', async () => {
    await render(() => Promise.resolve(body('running')));
    const live = bar()?.querySelectorAll('[aria-live]') ?? [];
    expect(live).toHaveLength(1);
    const region = live[0] as HTMLElement;
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.textContent).toBe('Connected');
    expect(region.querySelector('.al-dot.is-connected')).not.toBeNull();
    // The version is outside the live region: it is not announced on every change.
    expect(region.textContent).not.toContain('0.3.0');
  });

  it('keeps the live region text unchanged while the state stays the same', async () => {
    vi.useFakeTimers();
    let calls = 0;
    await render(() => {
      calls += 1;
      return Promise.resolve(body('running'));
    });
    const region = bar()?.querySelector('[aria-live]');
    const node = region?.firstElementChild;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTH_POLL_MS * 3);
    });
    expect(calls).toBeGreaterThanOrEqual(3);
    // Same state: the same element (no re-announcement, no replayed motion).
    expect(bar()?.querySelector('[aria-live]')?.firstElementChild).toBe(node);
  });

  it('never shows a relay address, key or path from a leaky answer', async () => {
    await render(() =>
      Promise.resolve(
        ok({
          agent: 'running',
          relays: { connected: 1, total: 2 },
          version: '0.3.0',
          url: 'wss://relay.example',
          key: 'nsec1abc',
        }),
      ),
    );
    const text = bar()?.textContent ?? '';
    expect(text).not.toMatch(/wss:|nsec|relay/i);
  });
});
