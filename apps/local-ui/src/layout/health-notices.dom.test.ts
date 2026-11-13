// @vitest-environment jsdom
// N2: one health word, and the offline flow. The banner shows only after 5 s offline; "Back online"
// is one toast, raised only if the banner had shown; a short blip says nothing.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeToasts } from '../notices/index.js';
import { setConnectionState, type ConnectionState } from './connection.js';
import { BackOnlineToast, HealthBanner } from './health-notices.js';
import { HEALTH_WORDS, healthWord, isNetworkDown } from './health-word.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let toasts: string[];
let unsubscribe: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  setConnectionState('unknown');
  toasts = [];
  unsubscribe = subscribeToasts((t) => toasts.push(t.text));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(h('div', null, h(HealthBanner), h(BackOnlineToast), h('p', null, 'page'))));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  unsubscribe();
  act(() => setConnectionState('unknown'));
  vi.useRealTimers();
});

const set = (state: ConnectionState): void => act(() => setConnectionState(state));
const wait = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};
const banner = (): Element | null => host.querySelector('.al-banner');

describe('N2: one health word', () => {
  it('every connection state has one set of words, shared by every surface', () => {
    for (const state of Object.keys(HEALTH_WORDS) as ConnectionState[]) {
      const w = healthWord(state);
      expect(w.bar.length, state).toBeGreaterThan(0);
      expect(w.network.word.length, state).toBeGreaterThan(0);
      expect(w.strip.value.length, state).toBeGreaterThan(0);
    }
    expect(healthWord('connected').bar).toBe('Connected');
    expect(healthWord('connected').network.word).toBe('Connected');
    expect(healthWord('unreachable').network.word).toBe('Reconnecting…');
    expect(healthWord('offline').network.word).toBe('Offline');
    expect(healthWord('offline').chip.label).toBe('Not connected');
  });

  it('only offline and unreachable count as the network being down', () => {
    expect(isNetworkDown('offline')).toBe(true);
    expect(isNetworkDown('unreachable')).toBe(true);
    for (const state of ['unknown', 'checking', 'connected', 'paused', 'not_running'] as const) {
      expect(isNetworkDown(state), state).toBe(false);
    }
  });
});

describe('N2: the offline flow', () => {
  it('shows the banner only after 5 s offline', () => {
    set('connected');
    set('offline');
    expect(banner()).toBeNull();
    wait(4_900);
    expect(banner()).toBeNull();
    wait(200);
    expect(banner()?.textContent).toContain("Can't reach the message network");
    expect(banner()?.getAttribute('role')).toBe('status');
  });

  it('says "Back online" once, when the banner had shown, and the banner goes away', () => {
    set('connected');
    set('offline');
    wait(5_100);
    expect(banner()).not.toBeNull();
    set('unknown');
    expect(toasts).toEqual([]);
    set('connected');
    expect(banner()).toBeNull();
    expect(toasts).toEqual(['Back online.']);
    set('unreachable');
    set('connected');
    expect(toasts).toEqual(['Back online.']);
  });

  it('a short blip says nothing at all', () => {
    set('connected');
    set('unreachable');
    wait(2_000);
    set('connected');
    wait(10_000);
    expect(banner()).toBeNull();
    expect(toasts).toEqual([]);
  });

  it('unreachable shows the same banner after 5 s', () => {
    set('connected');
    set('unreachable');
    wait(5_100);
    expect(banner()).not.toBeNull();
  });
});
