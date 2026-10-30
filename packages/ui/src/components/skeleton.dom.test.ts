// @vitest-environment jsdom
// W4-MOTION-KIT (S0): the skeleton family in the shape of the real layouts (prototype v23: the
// people row, the agent card, the bordered list, the pro table). Nothing for 300 ms; once shown a
// status with a spoken label and aria-busy; blocks are aria-hidden; sizes come from classes and data
// attributes, never an inline style (08 §4 CSP). The shimmer is opacity only and stops under reduced
// motion (both switches).
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import motionCss from './motion.css?raw';
import {
  SKELETON_DELAY_MS,
  SkeletonCard,
  SkeletonGate,
  SkeletonLine,
  SkeletonList,
  SkeletonRow,
  SkeletonTable,
} from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const noInlineStyle = (): void => {
  expect(host.querySelectorAll('[style]')).toHaveLength(0);
};

describe('skeleton shapes', () => {
  it('draws a line with a width and a size, hidden from screen readers', () => {
    act(() => root.render(h(SkeletonLine, { width: 40, size: 'title' })));
    const line = host.querySelector('.al-skel-line') as HTMLElement;
    expect(line.dataset.w).toBe('40');
    expect(line.dataset.size).toBe('title');
    expect(line.getAttribute('aria-hidden')).toBe('true');
    expect(line.classList.contains('al-skel')).toBe(true);
    noInlineStyle();
  });

  it('draws the people row: a 40 px avatar and two lines (40 % and 65 %)', () => {
    act(() => root.render(h(SkeletonRow)));
    const row = host.querySelector('.al-skel-row') as HTMLElement;
    expect(row.querySelector('.al-skel-avatar')?.getAttribute('data-size')).toBe('40');
    const lines = [...row.querySelectorAll<HTMLElement>('.al-skel-line')].map((l) => l.dataset.w);
    expect(lines).toEqual(['40', '65']);
    noInlineStyle();
  });

  it('draws the agent card: a 44 px avatar, two lines and a pill', () => {
    act(() => root.render(h(SkeletonCard)));
    const card = host.querySelector('.al-skel-card') as HTMLElement;
    expect(card.querySelector('.al-skel-avatar')?.getAttribute('data-size')).toBe('44');
    const lines = [...card.querySelectorAll<HTMLElement>('.al-skel-line')];
    expect(lines.map((l) => l.dataset.w)).toEqual(['30', '55', '70']);
    expect(lines[2]?.dataset.size).toBe('pill');
  });

  it('draws a bordered list of rows', () => {
    act(() => root.render(h(SkeletonList, { rows: 4 })));
    expect(host.querySelectorAll('.al-skel-list > .al-skel-row')).toHaveLength(4);
  });

  it('draws a table with a header and rows × columns, columns clamped to 2..7', () => {
    act(() => root.render(h(SkeletonTable, { rows: 3, columns: 5 })));
    const table = host.querySelector('.al-skel-table') as HTMLElement;
    expect(table.dataset.cols).toBe('5');
    const rows = table.querySelectorAll('.al-skel-trow');
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.querySelectorAll('.al-skel-line')).toHaveLength(5);
    expect(rows[0]?.classList.contains('al-skel-thead')).toBe(true);
    act(() => root.render(h(SkeletonTable, { rows: 1, columns: 40 })));
    expect((host.querySelector('.al-skel-table') as HTMLElement).dataset.cols).toBe('7');
    noInlineStyle();
  });
});

describe('SkeletonGate', () => {
  it(`shows nothing for ${SKELETON_DELAY_MS} ms, then the skeleton as a busy status`, () => {
    vi.useFakeTimers();
    act(() =>
      root.render(
        h(SkeletonGate, { loading: true, label: 'Loading people', skeleton: h(SkeletonList) }, 'x'),
      ),
    );
    expect(host.querySelector('.al-skel-gate')).toBeNull();
    expect(host.textContent).toBe('');
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS - 10));
    expect(host.querySelector('.al-skel-gate')).toBeNull();
    act(() => vi.advanceTimersByTime(20));
    const gate = host.querySelector('.al-skel-gate') as HTMLElement;
    expect(gate.getAttribute('role')).toBe('status');
    expect(gate.getAttribute('aria-busy')).toBe('true');
    expect(gate.textContent).toBe('Loading people');
    expect(gate.querySelectorAll('.al-skel-row').length).toBeGreaterThan(0);
  });

  it('shows the content at once when loading ends before the delay', () => {
    vi.useFakeTimers();
    act(() => root.render(h(SkeletonGate, { loading: true, skeleton: h(SkeletonRow) }, 'Ana')));
    act(() => vi.advanceTimersByTime(100));
    act(() => root.render(h(SkeletonGate, { loading: false, skeleton: h(SkeletonRow) }, 'Ana')));
    expect(host.querySelector('.al-skel-gate')).toBeNull();
    expect(host.textContent).toBe('Ana');
    expect(host.querySelector('.al-skel-reveal')).toBeNull();
  });

  it('fades the content in after a skeleton was shown', () => {
    vi.useFakeTimers();
    act(() => root.render(h(SkeletonGate, { loading: true, skeleton: h(SkeletonRow) }, 'Ana')));
    act(() => vi.advanceTimersByTime(1000));
    act(() => root.render(h(SkeletonGate, { loading: false, skeleton: h(SkeletonRow) }, 'Ana')));
    // The skeleton has been up past its 500 ms minimum: it leaves on the next tick.
    act(() => vi.advanceTimersByTime(1));
    expect(host.querySelector('.al-skel-reveal')?.textContent).toBe('Ana');
  });
});

describe('the skeleton stylesheet', () => {
  const flat = motionCss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');

  it('shimmers by opacity with the tokens, on the neutral background', () => {
    expect(flat).toMatch(/\.al-skel \{[^}]*background: var\(--al-color-status-neutral-bg\)/);
    expect(flat).toMatch(
      /\.al-skel \{[^}]*animation: al-skel-shimmer var\(--al-duration-shimmer\) var\(--al-easing-standard\) infinite/,
    );
    expect(flat).toMatch(
      /@keyframes al-skel-shimmer \{ 0%, 100% \{ opacity: 0\.45; \} 50% \{ opacity: 0\.9; \} \}/,
    );
  });

  it('holds still at 0.7 under reduced motion, for both switches', () => {
    expect(flat).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.al-skel \{ animation: none; opacity: 0\.7; \}/,
    );
    expect(flat).toMatch(
      /:root\[data-motion='reduced'\] \.al-skel \{ animation: none; opacity: 0\.7; \}/,
    );
  });
});
