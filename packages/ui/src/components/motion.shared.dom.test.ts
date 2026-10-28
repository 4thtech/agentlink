// @vitest-environment jsdom
// UI-REFRESH-t (a): every row of a long list asks "is motion reduced?". Each ask used to start its own
// matchMedia listener and MutationObserver; 200 rows meant 200 of each on the first render of Activity.
// They now share one pair, which is removed when the last row goes. Behaviour is unchanged.
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useReducedMotion } from './motion.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Row(): ReactElement {
  return h('i', { 'data-reduced': String(useReducedMotion()) });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-motion');
});

describe('useReducedMotion shares its watchers', () => {
  it('starts one MutationObserver and one media listener for 200 rows, and stops them together', () => {
    const OriginalObserver = globalThis.MutationObserver;
    let observers = 0;
    let live = 0;
    class Counting extends OriginalObserver {
      constructor(cb: MutationCallback) {
        super(cb);
        observers += 1;
        live += 1;
      }
      override disconnect(): void {
        live -= 1;
        super.disconnect();
      }
    }
    vi.stubGlobal('MutationObserver', Counting);
    let adds = 0;
    let removes = 0;
    const mql = {
      matches: false,
      addEventListener: () => (adds += 1),
      removeEventListener: () => (removes += 1),
    };
    vi.stubGlobal('matchMedia', () => mql);
    window.matchMedia = (() => mql) as unknown as typeof window.matchMedia;

    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        h(
          'div',
          null,
          Array.from({ length: 200 }, (_, i) => h(Row, { key: i })),
        ),
      ),
    );
    expect(observers).toBe(1);
    expect(adds).toBe(1);

    act(() => document.documentElement.setAttribute('data-motion', 'reduced'));
    return Promise.resolve().then(() => {
      expect(host.querySelectorAll('[data-reduced="true"]').length).toBe(200);
      act(() => root.unmount());
      expect(live).toBe(0);
      expect(removes).toBe(1);
      host.remove();
    });
  });
});
