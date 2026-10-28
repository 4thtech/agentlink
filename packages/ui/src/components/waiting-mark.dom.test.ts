// @vitest-environment jsdom
// UX2-e1 (S1): the waiting mark and the one brand exception (B-11 §23.3, §23.4, owner decision 3.1).
// Only the diamond turns, about its own centre, with transform only; the brackets never move; at
// 24 px and up; still with reduced motion; used for no other loading state; no inline styles.
import axe from 'axe-core';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import progressCss from './progress.css?raw';
import * as ui from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WaitingMark = (ui as Record<string, unknown>)['WaitingMark'] as (
  props: Record<string, unknown>,
) => unknown;
const MIN = (ui as Record<string, unknown>)['WAITING_MARK_MIN_SIZE'];

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
});
const render = (props: Record<string, unknown> = {}): void =>
  act(() => root.render(h(WaitingMark as never, props)));
const svg = (): SVGElement => host.querySelector('svg') as SVGElement;

// Repo files as text (the ui package may not import node built-ins). Keys are relative to this file.
const files = import.meta.glob(
  [
    './*.css',
    './*.ts',
    './*.tsx',
    '../../../../docs/design/b11-local-app.md',
    '../../../../docs/design/brand/brand-guidelines.md',
    '../../../../docs/design/d1/components/Mark.md',
    '../../../../apps/*/src/**/*.{ts,tsx,css}',
    '../../../*/src/**/*.{ts,tsx,css}',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;
const read = (p: string): string => {
  const hit = Object.entries(files).find(([k]) => k.endsWith('/' + p) || k === './' + p);
  if (hit === undefined) throw new Error(`not loaded: ${p}`);
  return hit[1];
};

describe('WaitingMark component', () => {
  it('is exported with a minimum size above 20 px', () => {
    expect(typeof WaitingMark).toBe('function');
    expect(MIN).toBeGreaterThan(20);
  });
  it('is 40 px by default and decorative (aria-hidden, no role, no name)', () => {
    render();
    expect(svg().getAttribute('height')).toBe('40');
    expect(svg().getAttribute('aria-hidden')).toBe('true');
    expect(svg().getAttribute('role')).toBeNull();
    expect(svg().getAttribute('aria-label')).toBeNull();
  });
  it('can carry an accessible name instead', () => {
    render({ label: 'Waiting for your funds' });
    expect(svg().getAttribute('role')).toBe('img');
    expect(svg().getAttribute('aria-label')).toBe('Waiting for your funds');
    expect(svg().getAttribute('aria-hidden')).toBeNull();
  });
  it('never renders at 20 px or below, and never uses the small drawing', () => {
    for (const size of [8, 16, 20]) {
      render({ size });
      expect(Number(svg().getAttribute('height'))).toBe(MIN);
      expect(svg().getAttribute('viewBox')).toBe('5 6 38 36');
    }
    render({ size: 56 });
    expect(svg().getAttribute('height')).toBe('56');
  });
  it('turns only the diamond: the brackets carry no turn class, the diamond carries it alone', () => {
    render();
    const ink = svg().querySelector('.al-mark-ink') as Element;
    const diamond = svg().querySelector('.al-waiting-diamond') as Element;
    expect(diamond).not.toBeNull();
    expect(diamond.tagName.toLowerCase()).toBe('path');
    expect(diamond.getAttribute('d')).toBe('M24 15L33 24L24 33L15 24Z');
    expect(ink.getAttribute('d')).toBe(
      'M5 6H15.5V11H10V37H15.5V42H5Z M43 6H32.5V11H38V37H32.5V42H43Z',
    );
    expect(ink.getAttribute('class') ?? '').not.toContain('waiting');
    expect(host.querySelectorAll('.al-waiting-diamond')).toHaveLength(1);
  });
  const diamond = (): Element => svg().querySelector('.al-waiting-diamond') as Element;
  const iterate = (): void =>
    act(() => {
      // jsdom has no AnimationEvent, so React listens to the prefixed name there; browsers fire the
      // unprefixed one. Dispatch both.
      for (const name of ['animationiteration', 'webkitAnimationIteration']) {
        diamond().dispatchEvent(new Event(name, { bubbles: true }));
      }
    });
  it('keeps turning after active goes false, and rests only at the next cycle boundary', () => {
    render();
    render({ active: false });
    expect(svg().getAttribute('class')).not.toContain('is-resting');
    iterate();
    expect(svg().getAttribute('class')).toContain('is-resting');
  });
  it('ignores cycle boundaries while still active', () => {
    render();
    iterate();
    iterate();
    expect(svg().getAttribute('class')).not.toContain('is-resting');
  });
  it('rests at once when mounted inactive, and when paused while inactive', () => {
    render({ active: false });
    expect(svg().getAttribute('class')).toContain('is-resting');
    render({ active: true });
    expect(svg().getAttribute('class')).not.toContain('is-resting');
    render({ active: false, paused: true });
    expect(svg().getAttribute('class')).toContain('is-resting');
  });
  it('rests at once under reduced motion when inactive', () => {
    document.documentElement.setAttribute('data-motion', 'reduced');
    try {
      render();
      render({ active: false });
      expect(svg().getAttribute('class')).toContain('is-resting');
    } finally {
      document.documentElement.removeAttribute('data-motion');
    }
  });
  it('turns again when active returns', () => {
    render({ active: false });
    render({ active: true });
    expect(svg().getAttribute('class')).not.toContain('is-resting');
  });
  it('has no inline style anywhere (08 §4)', () => {
    render();
    expect(host.querySelectorAll('[style]')).toHaveLength(0);
  });
  it('has zero axe violations, decorative and named', async () => {
    for (const props of [{}, { label: 'Waiting for your funds' }]) {
      render(props);
      const result = await axe.run(host, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(result.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    }
  });
});

describe('waiting mark styles (progress.css)', () => {
  const css = progressCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel: string): string => {
    const esc = sel.replace(/[.[\]']/g, '\\$&');
    const m = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, 'm').exec(css);
    return m?.[1] ?? '';
  };
  const keyframes = /@keyframes\s+al-waiting-turn\s*\{([\s\S]*?\}\s*)\}/.exec(css)?.[1] ?? '';

  it('turns the diamond about its own centre', () => {
    const r = rule('.al-waiting-diamond');
    expect(r).toMatch(/transform-box:\s*fill-box/);
    expect(r).toMatch(/transform-origin:\s*center/);
  });
  it('is one quarter turn per ambient cycle with the standard easing, then rests', () => {
    expect(rule('.al-waiting-diamond')).toMatch(
      /animation:\s*al-waiting-turn\s+var\(--al-duration-ambient\)\s+var\(--al-easing-standard\)\s+infinite/,
    );
    expect(keyframes).toContain('rotate(90deg)');
    expect(keyframes).toMatch(/50%/);
  });
  it('animates transform only: no opacity, filter, fill, scale or glow in the turn', () => {
    const props = [...keyframes.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(props.length).toBeGreaterThan(0);
    expect(new Set(props)).toEqual(new Set(['transform']));
    expect(keyframes).not.toMatch(/scale|filter|drop-shadow|blur/);
  });
  it('never animates, targets or styles the brackets', () => {
    const blocks = css.split('}').filter((b) => b.includes('al-waiting'));
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(b).not.toMatch(/al-mark-ink/);
  });
  it('stops the turn outright once resting (the cycle boundary is the rest pose)', () => {
    const r = rule('.al-waiting-mark.is-resting .al-waiting-diamond');
    expect(r).toMatch(/animation:\s*none/);
    expect(r).not.toMatch(/iteration-count/);
  });
  it('is still under prefers-reduced-motion and the app reduced-motion switch', () => {
    const media =
      /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?\n\})/.exec(css)?.[1] ?? '';
    expect(media).toMatch(/\.al-waiting-diamond[^{]*\{[^}]*animation:\s*none/);
    expect(css).toMatch(
      /:root\[data-motion='reduced'\]\s+\.al-waiting-diamond[^{]*\{[^}]*animation:\s*none/,
    );
  });
  it('pauses while the tab is hidden', () => {
    expect(css).toMatch(
      /\.al-waiting-mark\[data-paused='true'\]\s+\.al-waiting-diamond[^{]*\{[^}]*animation-play-state:\s*paused/,
    );
  });
  it('keeps the forced-colours ink from the shared mark rules', () => {
    expect(read('components.css')).toMatch(/\.al-mark-seal,[\s\S]*?fill:\s*CanvasText/);
  });
});

describe('the waiting mark is used in no other loading state', () => {
  it('appears only in its own component, styles, exports, tests and Add credits (UX2-e2)', () => {
    const hits = Object.entries(files)
      .filter(([k]) => /\.(tsx?|css)$/.test(k) && !k.includes('node_modules'))
      .filter(([, text]) => /WaitingMark|al-waiting/.test(text))
      .map(([k]) => k.split('/').pop() as string)
      .sort();
    expect(Object.keys(files).some((k) => k.includes('apps/local-ui'))).toBe(true);
    // B-11 §23.3: the one consumer is the Add credits tracker's "Waiting for your funds" step.
    expect(hits.filter((f) => !f.endsWith('.test.ts'))).toEqual([
      'progress.css',
      'top-up.tsx',
      'waiting-mark.tsx',
    ]);
  });
});

describe('brand guidelines carry the exception once, word for word', () => {
  const spec = read('docs/design/b11-local-app.md');
  const quote = /### 23\.4[\s\S]*?\n> (\*\*Exception: the waiting mark\*\*[^\n]*)\n/.exec(
    spec,
  )?.[1];
  const guidelines = read('docs/design/brand/brand-guidelines.md');
  it('finds the spec text', () => {
    expect(quote).toBeDefined();
  });
  it('copies it exactly once under Rules', () => {
    const rules = /## Rules([\s\S]*?)\n## /.exec(guidelines)?.[1] ?? '';
    expect(rules).toContain(quote);
    expect(guidelines.split(quote as string)).toHaveLength(2);
  });
  it('adds the pointer to the Mark component spec', () => {
    expect(read('docs/design/d1/components/Mark.md')).toContain(
      'except the waiting mark (see the brand guidelines)',
    );
  });
});
