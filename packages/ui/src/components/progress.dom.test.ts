// @vitest-environment jsdom
// UI-REFRESH-c (S1): the progress family of B-11 §15.1 to §15.3 and 11 §11. Every state has a word,
// an accessible name and the progressbar values; the indeterminate bar never shows a percentage;
// nothing shows under 400 ms and anything shown stays 500 ms (§15.2); no inline styles (08 §4).
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lintVocabulary } from '../strings/lint.js';
import componentsCss from './components.css?raw';
import progressCss from './progress.css?raw';
import {
  InlineError,
  PROGRESS_STRINGS,
  ProgressBar,
  RingMeter,
  Skeleton,
  useDelayedShow,
} from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const render = (el: Parameters<Root['render']>[0]): void => act(() => root.render(el));
const q = (sel: string): HTMLElement | null => host.querySelector<HTMLElement>(sel);
const states = (): (string | null)[] =>
  [...host.querySelectorAll('.al-pb-step')].map((i) => i.getAttribute('data-state'));
const advance = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

describe('ProgressBar, determinate', () => {
  const bar = (value: number, extra: Record<string, unknown> = {}) =>
    h(ProgressBar, { label: 'Sending report.pdf to Marko', value, max: 8, ...extra });

  it('start, middle and done carry the word, the name and the progressbar values', () => {
    for (const value of [0, 2.1, 8]) {
      render(bar(value, { amount: `${value} of 8 MB` }));
      const pb = q('[role="progressbar"]') as HTMLElement;
      expect(pb.getAttribute('aria-label')).toBe('Sending report.pdf to Marko');
      expect(pb.getAttribute('aria-valuemin')).toBe('0');
      expect(pb.getAttribute('aria-valuemax')).toBe('8');
      expect(pb.getAttribute('aria-valuenow')).toBe(String(value));
      expect(host.textContent).toContain('Sending report.pdf to Marko');
      expect(host.textContent).toContain(`${value} of 8 MB`);
    }
    expect(q('.al-pb')?.classList.contains('is-done')).toBe(true);
  });

  it('clamps the value into the range', () => {
    render(bar(99));
    expect(q('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('8');
    render(bar(-3));
    expect(q('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');
  });

  it('moves the fill by stroke-dashoffset (no inline style) and prints no percentage itself', () => {
    render(bar(4));
    expect(q('.al-pb-fill')?.getAttribute('stroke-dashoffset')).toBe('50');
    expect(host.querySelector('[style]')).toBeNull();
    expect(host.textContent).not.toMatch(/%/);
  });

  it('error: the same edge, an icon and one sentence that says what to do', () => {
    render(bar(3, { state: 'error', error: 'Couldn’t send. Your AI will try again in a minute.' }));
    expect(q('.al-pb')?.classList.contains('is-error')).toBe(true);
    const alert = q('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('Couldn’t send. Your AI will try again in a minute.');
    expect(alert.querySelector('svg')).not.toBeNull();
    expect(q('[role="progressbar"]')?.getAttribute('aria-invalid')).toBe('true');
  });

  it('announces the word in one polite live region', () => {
    render(bar(1));
    const live = q('[role="status"]') as HTMLElement;
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toContain('Sending report.pdf to Marko');
  });
});

describe('ProgressBar, indeterminate', () => {
  it('has no value and never shows a percentage; the word stays', () => {
    render(h(ProgressBar, { label: 'Recording proof…', indeterminate: true }));
    const pb = q('[role="progressbar"]') as HTMLElement;
    expect(pb.getAttribute('aria-label')).toBe('Recording proof…');
    expect(pb.hasAttribute('aria-valuenow')).toBe(false);
    expect(pb.getAttribute('aria-busy')).toBe('true');
    expect(q('.al-pb')?.classList.contains('is-indeterminate')).toBe(true);
    expect(host.textContent).toContain('Recording proof…');
    expect(host.textContent).not.toMatch(/\d\s*%/);
  });
});

describe('ProgressBar, stepped', () => {
  const steps = ['Preparing', 'Sending', 'Delivered'];
  it('names every step and marks done, current and waiting without colour alone', () => {
    render(h(ProgressBar, { label: 'Sending report.pdf', steps, current: 1 }));
    const items = [...host.querySelectorAll('.al-pb-step')];
    expect(items.map((i) => i.textContent)).toEqual(steps);
    expect(states()).toEqual(['done', 'current', 'todo']);
    expect(items[1]?.getAttribute('aria-current')).toBe('step');
    const pb = q('[role="progressbar"]') as HTMLElement;
    expect(pb.getAttribute('aria-valuemin')).toBe('1');
    expect(pb.getAttribute('aria-valuemax')).toBe('3');
    expect(pb.getAttribute('aria-valuenow')).toBe('2');
    expect(pb.getAttribute('aria-valuetext')).toBe('Step 2 of 3: Sending');
  });

  it('done marks every step done; an error stays on the current step', () => {
    render(h(ProgressBar, { label: 'Adding proof', steps, current: 3 }));
    expect(states()).toEqual(['done', 'done', 'done']);
    expect(q('.al-pb')?.classList.contains('is-done')).toBe(true);
    render(
      h(ProgressBar, {
        label: 'Adding proof',
        steps,
        current: 1,
        state: 'error',
        error: 'Try again.',
      }),
    );
    expect(states()).toEqual(['done', 'error', 'todo']);
  });

  it('accepts at most four steps', () => {
    render(h(ProgressBar, { label: 'x', steps: ['a', 'b', 'c', 'd', 'e'], current: 0 }));
    expect(host.querySelectorAll('.al-pb-step')).toHaveLength(4);
  });
});

describe('RingMeter', () => {
  it('a value against a limit with the name, the values and the text', () => {
    render(h(RingMeter, { label: 'Credits', value: 4.8, max: 10, text: '$4.80, about 48 proofs' }));
    const m = q('[role="meter"]') as HTMLElement;
    expect(m.getAttribute('aria-label')).toBe('Credits');
    expect(m.getAttribute('aria-valuemin')).toBe('0');
    expect(m.getAttribute('aria-valuemax')).toBe('10');
    expect(m.getAttribute('aria-valuenow')).toBe('4.8');
    expect(m.getAttribute('aria-valuetext')).toBe('$4.80, about 48 proofs');
    expect(host.textContent).toContain('$4.80, about 48 proofs');
    expect(q('.al-ring-fill')?.getAttribute('stroke-dashoffset')).toBe('52');
    expect(host.querySelector('[style]')).toBeNull();
  });

  it('countdown: the arc is the time left and turns urgent at a fifth', () => {
    const ring = (value: number, text: string) =>
      h(RingMeter, { label: 'Time left', value, max: 7, countdown: true, text });
    render(ring(3, '3 days left'));
    expect(q('.al-ring')?.classList.contains('is-countdown')).toBe(true);
    expect(q('.al-ring')?.classList.contains('is-low')).toBe(false);
    render(ring(1, '1 day left'));
    expect(q('.al-ring')?.classList.contains('is-low')).toBe(true);
    expect(host.textContent).toContain('1 day left');
  });

  it('shows the content in the middle', () => {
    render(h(RingMeter, { label: 'Credits', value: 1, max: 2, text: 'Half' }, '$1'));
    expect(q('.al-ring-center')?.textContent).toBe('$1');
  });
});

describe('InlineError', () => {
  it('a red edge, an icon, one sentence and one action', () => {
    render(h(InlineError, { action: h('button', null, 'Try again') }, 'Couldn’t send.'));
    const e = q('[role="alert"]') as HTMLElement;
    expect(e.classList.contains('al-inline-error')).toBe(true);
    expect(e.textContent).toContain('Couldn’t send.');
    expect(e.querySelector('svg')).not.toBeNull();
    expect(e.querySelector('button')?.textContent).toBe('Try again');
  });
});

describe('useDelayedShow (§15.2)', () => {
  function Probe({ active }: { active: boolean }) {
    const shown = useDelayedShow(active);
    return h('span', { id: 'probe' }, shown ? 'shown' : 'hidden');
  }
  const text = (): string | undefined => q('#probe')?.textContent ?? undefined;

  it('shows nothing under 400 ms and shows at 400 ms', () => {
    render(h(Probe, { active: true }));
    expect(text()).toBe('hidden');
    advance(399);
    expect(text()).toBe('hidden');
    advance(1);
    expect(text()).toBe('shown');
  });

  it('an indicator that finishes before 400 ms never appears', () => {
    render(h(Probe, { active: true }));
    advance(300);
    render(h(Probe, { active: false }));
    advance(2000);
    expect(text()).toBe('hidden');
  });

  it('once shown it stays at least 500 ms', () => {
    render(h(Probe, { active: true }));
    advance(400);
    advance(100);
    render(h(Probe, { active: false }));
    expect(text()).toBe('shown');
    advance(399);
    expect(text()).toBe('shown');
    advance(1);
    expect(text()).toBe('hidden');
  });

  it('coming back while waiting to hide keeps it shown', () => {
    render(h(Probe, { active: true }));
    advance(400);
    render(h(Probe, { active: false }));
    advance(100);
    render(h(Probe, { active: true }));
    advance(2000);
    expect(text()).toBe('shown');
  });

  it('ProgressBar with delayed shows nothing under 400 ms', () => {
    render(h(ProgressBar, { label: 'Checking the invite…', indeterminate: true, delayed: true }));
    expect(q('[role="progressbar"]')).toBeNull();
    advance(400);
    expect(q('[role="progressbar"]')).not.toBeNull();
  });
});

describe('Skeleton', () => {
  const sk = (loading: boolean) =>
    h(
      Skeleton,
      { loading, label: 'Loading your files', lines: 3 },
      h('p', { id: 'real' }, 'Content'),
    );

  it('renders nothing for 400 ms, then blocks with a word; content replaces it after 500 ms', () => {
    render(sk(true));
    expect(q('.al-skeleton')).toBeNull();
    expect(q('#real')).toBeNull();
    advance(400);
    const s = q('.al-skeleton') as HTMLElement;
    expect(s).not.toBeNull();
    expect(s.getAttribute('aria-busy')).toBe('true');
    expect(s.querySelectorAll('.al-skeleton-line')).toHaveLength(3);
    expect(q('.al-sr-only')?.textContent).toBe('Loading your files');
    render(sk(false));
    expect(q('.al-skeleton')).not.toBeNull();
    advance(500);
    expect(q('.al-skeleton')).toBeNull();
    expect(q('#real')?.parentElement?.classList.contains('al-skeleton-reveal')).toBe(true);
  });

  it('content that arrives in time shows at once, without a fade or a skeleton', () => {
    render(sk(true));
    advance(100);
    render(sk(false));
    expect(q('.al-skeleton')).toBeNull();
    expect(q('#real')).not.toBeNull();
    expect(q('.al-skeleton-reveal')).toBeNull();
  });
});

describe('words and styles', () => {
  it('the default words pass the vocabulary lint', () => {
    for (const v of Object.values(PROGRESS_STRINGS)) expect(lintVocabulary(v), v).toEqual([]);
  });

  it('progress.css animates by transform and opacity from tokens and pauses in a hidden tab', () => {
    expect(progressCss).not.toContain('background-position');
    expect(progressCss).toMatch(/@keyframes\s+al-pb-glide/);
    expect(progressCss).toMatch(/@keyframes\s+al-skeleton-sweep/);
    expect(progressCss).toContain('--al-duration-ambient');
    expect(progressCss).toContain('data-paused');
  });

  it('reduced motion: loops stop and the indeterminate bar is a still half-filled track', () => {
    expect(progressCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(progressCss).toContain(":root[data-motion='reduced']");
    expect(progressCss).toMatch(/is-indeterminate[^{]*\{[^}]*animation:\s*none/);
    expect(progressCss).toMatch(/al-skeleton[^{]*\{[^}]*animation:\s*none/);
  });

  it('the spinner is gone from components.css (replaced by the indeterminate bar)', () => {
    expect(componentsCss).not.toContain('al-spin');
  });
});
