// @vitest-environment jsdom
// UX2-e1 (S1): the waiting mark and the one brand exception (B-11 §23.3, §23.4, owner decision 3.1).
// Only the diamond turns, about its own centre, with transform only; the brackets never move; at
// 24 px and up; still with reduced motion; used for no other loading state; no inline styles.
import axe from 'axe-core';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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

const repoRoot = join(__dirname, '..', '..', '..', '..');
const read = (p: string): string => readFileSync(join(repoRoot, p), 'utf8');

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
  it('rests (finishes its turn and stops) when not active', () => {
    render();
    expect(svg().getAttribute('class')).not.toContain('is-resting');
    render({ active: false });
    expect(svg().getAttribute('class')).toContain('is-resting');
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
  it('rests after one cycle when not active', () => {
    expect(rule('.al-waiting-mark.is-resting .al-waiting-diamond')).toMatch(
      /animation-iteration-count:\s*1/,
    );
  });
  it('is still under prefers-reduced-motion and the app reduced-motion switch', () => {
    const media = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?\n\})/.exec(css)?.[1] ?? '';
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
    expect(read('packages/ui/src/components/components.css')).toMatch(
      /\.al-mark-seal,[\s\S]*?fill:\s*CanvasText/,
    );
  });
});

describe('the waiting mark is used in no other loading state', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(tsx?|css)$/.test(name)) out.push(p);
    }
    return out;
  };
  it('appears only in its own component, styles, exports and tests', () => {
    const files = [...walk(join(repoRoot, 'packages')), ...walk(join(repoRoot, 'apps'))].filter(
      (f) => /WaitingMark|al-waiting/.test(readFileSync(f, 'utf8')),
    );
    const rels = files.map((f) => relative(repoRoot, f)).sort();
    const allowed = new Set([
      'packages/ui/src/components/waiting-mark.tsx',
      'packages/ui/src/components/progress.css',
      'packages/ui/src/components/index.ts',
      'packages/ui/src/components/waiting-mark.dom.test.ts',
    ]);
    expect(rels.filter((r) => !allowed.has(r))).toEqual([]);
  });
});

describe('brand guidelines carry the exception once, word for word', () => {
  const spec = read('docs/design/b11-local-app.md');
  const quote = /### 23\.4[\s\S]*?\n> (\*\*Exception: the waiting mark\*\*[^\n]*)\n/.exec(spec)?.[1];
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
