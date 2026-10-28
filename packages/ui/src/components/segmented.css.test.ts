// UX2-b (S1; b11 §22.3, §22.4): the segmented control takes the switch's language. Only `.al-seg`
// changes; tokens only; the thumb moves with transform; focus ring on the option; reduced motion and
// forced colours keep the choice readable (check icon, 1 px border).
import { describe, expect, it } from 'vitest';
import components from './components.css?raw';

const css = components.replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  if (m === null) throw new Error(`no rule for ${selector}`);
  return m[1]!;
};
const hasRule = (selector: string): boolean => {
  try {
    rule(selector);
    return true;
  } catch {
    return false;
  }
};

describe('.al-seg: the switch track', () => {
  it('is a recessed track like the switch: sunken, strong border, radius-sm, space-1 padding', () => {
    const r = rule('.al-seg');
    expect(r).toContain('var(--al-color-bg-sunken)');
    expect(r).toContain('var(--al-border-width-thin) solid var(--al-color-border-strong)');
    expect(r).toContain('var(--al-radius-sm)');
    expect(r).not.toContain('--al-radius-md');
    expect(r).toMatch(/padding:\s*var\(--al-space-1\)/);
  });
  it('has no dividers between options', () => {
    expect(rule('.al-seg-opt')).not.toMatch(/border-right|border-inline-end/);
    expect(hasRule('.al-seg-opt:last-child')).toBe(false);
  });
  it('options are 32 px high, 44 px at the phone breakpoint, muted', () => {
    const r = rule('.al-seg-opt');
    expect(r).toContain('var(--al-size-control-md)');
    expect(r).toContain('var(--al-color-fg-muted)');
    expect(css).toMatch(
      /@media \(max-width: 600px\)\s*\{[\s\S]*?\.al-seg-opt\s*\{[^}]*--al-size-control-lg/,
    );
  });
});

describe('.al-seg: the sliding thumb', () => {
  it('is accent-subtle, radius-xs, with a 2 px accent bottom edge, and the label turns default', () => {
    const thumb = rule('.al-seg::before');
    expect(thumb).toContain('var(--al-color-accent-subtle)');
    expect(thumb).toContain('var(--al-radius-xs)');
    expect(thumb).toMatch(/inset 0 -2px 0 var\(--al-color-accent-default\)/);
    expect(rule('.al-seg-opt.is-on')).toContain('var(--al-color-fg-default)');
  });
  it('moves with transform only, in the knob duration and easing', () => {
    const thumb = rule('.al-seg::before');
    expect(thumb).toMatch(
      /transition:\s*transform var\(--al-duration-fast\) var\(--al-easing-standard\)/,
    );
    expect(thumb).toMatch(/translateX\(/);
  });
  it('reads its place from data-count and data-index, for 2 to 4 options', () => {
    for (const n of [2, 3, 4]) expect(css).toContain(`.al-seg[data-count='${n}']`);
    for (const i of [0, 1, 2, 3]) expect(css).toContain(`.al-seg[data-index='${i}']`);
  });
});

describe('.al-seg: focus, reduced motion, forced colours', () => {
  it('rings the focused option, not the track', () => {
    const r = rule('.al-seg-opt:focus-visible');
    expect(r).toContain('var(--al-focus-ring-width)');
    expect(r).toContain('var(--al-color-focus-ring)');
    expect(hasRule('.al-seg:focus-visible')).toBe(false);
  });
  it('the thumb does not animate under reduced motion (media and attribute)', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.al-seg::before[\s\S]*?transition:\s*none/,
    );
    expect(css).toMatch(
      /:root\[data-motion='reduced'\] \.al-seg::before[^{]*\{[^}]*transition:\s*none/,
    );
  });
  it('keeps the 1 px CanvasText border on the track in forced colours; the thumb gets an edge', () => {
    expect(css).toMatch(
      /@media \(forced-colors: active\)\s*\{[\s\S]*?\.al-seg,[\s\S]*?border:\s*1px solid CanvasText/,
    );
    expect(css).toMatch(
      /@media \(forced-colors: active\)\s*\{[\s\S]*?\.al-seg::before\s*\{[^}]*border:\s*1px solid Highlight/,
    );
  });
  it('the switch is untouched', () => {
    expect(rule('.al-switch')).toContain('width: 64px');
    expect(rule('.al-switch.is-on .al-switch-knob')).toContain('translateX(40px)');
  });
  it('styles the Switch note quietly', () => {
    expect(hasRule('.al-switch-note')).toBe(true);
  });
});
