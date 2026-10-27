// UI-REFRESH-b (S1): the depth and chrome stylesheets (B-11 §13.1, §13.2). Surface rises through a
// pseudo-element's opacity only; every level has a 1 px border in increased contrast and forced
// colours; chrome is translucent only on macOS with blur support and every fallback is solid.
import { describe, expect, it } from 'vitest';
import depth from './depth.css?raw';
import chrome from './chrome.css?raw';
import tokens from '../tokens/tokens.css?raw';

interface Node {
  prelude: string;
  decls: Record<string, string>;
  children: Node[];
}
function parse(css: string): Node {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const root: Node = { prelude: '', decls: {}, children: [] };
  const stack = [root];
  let buf = '';
  let paren = 0;
  const flush = (): void => {
    const s = buf.trim();
    buf = '';
    const i = s.indexOf(':');
    if (s !== '' && i > 0) {
      (stack[stack.length - 1] as Node).decls[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    }
  };
  for (const ch of text) {
    if (ch === '(') paren += 1;
    if (ch === ')') paren -= 1;
    if (paren === 0 && ch === '{') {
      const n: Node = { prelude: buf.trim().replace(/\s+/g, ' '), decls: {}, children: [] };
      (stack[stack.length - 1] as Node).children.push(n);
      stack.push(n);
      buf = '';
    } else if (paren === 0 && ch === ';') {
      flush();
    } else if (paren === 0 && ch === '}') {
      flush();
      if (stack.length > 1) stack.pop();
    } else {
      buf += ch;
    }
  }
  return root;
}
type Rule = { ctx: string; sel: string; decls: Record<string, string> };
/** Every rule with its enclosing at-rules. */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const walk = (n: Node, ctx: string): void => {
    for (const c of n.children) {
      if (c.prelude.startsWith('@')) walk(c, `${ctx}${ctx ? ' > ' : ''}${c.prelude}`);
      else out.push({ ctx, sel: c.prelude, decls: c.decls });
    }
  };
  walk(parse(css), '');
  return out;
}
const find = (list: Rule[], ctx: RegExp, sel: RegExp): Rule[] =>
  list.filter((r) => ctx.test(r.ctx) && sel.test(r.sel));

const d = rules(depth);
const c = rules(chrome);
const LEVELS = ['l0', 'l1', 'l2', 'l3', 'l4', 'recessed'];
const TOP = /^$/;

describe('depth.css', () => {
  it('gives every level a background and a shadow from the tokens', () => {
    const want: Record<string, [string, string]> = {
      l0: ['--al-color-bg-canvas', '--al-shadow-0'],
      l1: ['--al-color-bg-surface', '--al-shadow-1'],
      l2: ['--al-color-bg-raised', '--al-shadow-2'],
      l3: ['--al-color-bg-raised', '--al-shadow-3'],
      l4: ['--al-color-bg-raised', '--al-shadow-4'],
      recessed: ['--al-color-bg-sunken', '--al-shadow-0'],
    };
    for (const lv of LEVELS) {
      const r = find(d, TOP, new RegExp(`^\\.al-surface--${lv}$`));
      expect(r, lv).toHaveLength(1);
      const text = `${r[0]!.decls['background'] ?? ''} ${r[0]!.decls['box-shadow'] ?? ''}`;
      expect(text, lv).toContain(`var(${want[lv]![0]})`);
      expect(text, lv).toContain(`var(${want[lv]![1]}`);
    }
  });

  it('uses the top highlight tokens', () => {
    expect(depth).toContain('var(--al-highlight-top)');
    expect(depth).toContain('var(--al-highlight-top-raised)');
  });

  it('rises one level on hover and focus through the pseudo-element opacity, never two levels', () => {
    const next: Record<string, string> = { l0: '1', l1: '2', l2: '3', recessed: '1' };
    for (const [lv, n] of Object.entries(next)) {
      const r = find(
        d,
        TOP,
        new RegExp(`^\\.al-surface--${lv}\\.al-surface--interactive::before$`),
      );
      expect(r, lv).toHaveLength(1);
      expect(r[0]!.decls['box-shadow'], lv).toContain(`--al-shadow-${n}`);
    }
    const hover = d.filter(
      (r) => /:hover|:focus-within|:focus-visible/.test(r.sel) && /::before/.test(r.sel),
    );
    expect(hover.length).toBeGreaterThan(0);
    for (const r of hover) expect(r.decls['opacity']).toBe('1');
    const base = find(d, TOP, /^\.al-surface--interactive::before$/)[0]!;
    expect(base.decls['opacity']).toBe('0');
    expect(base.decls['pointer-events']).toBe('none');
  });

  it('animates only opacity and transform, with tokens', () => {
    const base = find(d, TOP, /^\.al-surface--interactive::before$/)[0]!;
    expect(base.decls['transition-property']).toMatch(/^opacity(, transform)?$/);
    expect(base.decls['transition-duration']).toBe('var(--al-duration-fast)');
  });

  it('every level keeps a 1 px border in increased contrast and forced colours', () => {
    for (const ctx of [/prefers-contrast: more/, /forced-colors: active/]) {
      const r = find(d, ctx, /\.al-surface\b/).filter((x) => x.decls['border-color'] !== undefined);
      expect(r.length, String(ctx)).toBeGreaterThan(0);
      expect(r[0]!.decls['border-color']).not.toMatch(/transparent/);
    }
    const attr = find(d, TOP, /\[data-contrast='more'\].*\.al-surface\b/);
    expect(attr.length).toBeGreaterThan(0);
    // The border is always 1 px wide (transparent at rest), so contrast mode never moves layout.
    expect(find(d, TOP, /^\.al-surface$/)[0]!.decls['border']).toMatch(/^1px solid/);
  });

  it('draws levels 3 and 4 with the hairline subtle border', () => {
    for (const lv of ['l3', 'l4']) {
      const r = find(d, TOP, new RegExp(`^\\.al-surface--${lv}$`));
      expect(r[0]!.decls['border-color'], lv).toBe('var(--al-color-border-subtle)');
    }
  });

  it('Sheet: right side sheet that becomes a full page at 360', () => {
    const base = find(d, TOP, /^\.al-sheet$/)[0]!;
    expect(base.decls['position']).toBe('fixed');
    expect(base.decls['z-index']).toBe('var(--al-z-overlay)');
    const small = find(d, /max-width: 360px/, /^\.al-sheet$/);
    expect(small).toHaveLength(1);
    expect(small[0]!.decls['inset']).toBe('0');
    expect(small[0]!.decls['width']).toBe('100%');
  });

  it('dialog overlay: overlay colour, light blur only where supported, solid when reduced', () => {
    const base = find(d, TOP, /^\.al-dialog-overlay$/)[0]!;
    expect(base.decls['background']).toBe('var(--al-color-bg-overlay)');
    expect(base.decls['z-index']).toBe('var(--al-z-modal)');
    expect(base.decls['backdrop-filter']).toBeUndefined();
    const blur = find(d, /@supports \(backdrop-filter: blur\(1px\)\)/, /^\.al-dialog-overlay$/);
    expect(blur[0]!.decls['backdrop-filter']).toBe('blur(8px)');
    for (const ctx of [
      /prefers-reduced-transparency: reduce/,
      /prefers-contrast: more/,
      /forced-colors: active/,
    ]) {
      const r = find(d, ctx, /\.al-dialog-overlay/);
      expect(r.length, String(ctx)).toBeGreaterThan(0);
      expect(r[0]!.decls['backdrop-filter'], String(ctx)).toBe('none');
    }
    expect(find(d, TOP, /data-transparency='reduced'.*\.al-dialog-overlay/)).not.toHaveLength(0);
  });

  it('uses only tokens that exist and no hard-coded colour', () => {
    const defined = new Set([...tokens.matchAll(/(--al-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    for (const css of [depth, chrome]) {
      const used = [...css.matchAll(/var\((--al-[a-z0-9-]+)/g)].map((m) => m[1]!);
      expect(used.filter((v) => !defined.has(v))).toEqual([]);
      expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(
        /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/,
      );
    }
  });
});

describe('chrome.css (the al-chrome material)', () => {
  it('is solid by default: surface colour, no blur', () => {
    const base = find(c, TOP, /^\.al-chrome$/)[0]!;
    expect(base.decls['background']).toBe('var(--al-color-bg-surface)');
    expect(base.decls['backdrop-filter']).toBeUndefined();
  });

  it('is translucent only on macOS, with blur support', () => {
    const t = c.filter(
      (r) => r.decls['backdrop-filter'] !== undefined && r.decls['backdrop-filter'] !== 'none',
    );
    expect(t.length).toBeGreaterThan(0);
    for (const r of t) {
      expect(r.ctx).toMatch(/@supports \(backdrop-filter: blur\(1px\)\)/);
      expect(r.sel).toContain(":root[data-os='macos']");
      expect(r.decls['backdrop-filter']).toBe('var(--al-material-blur)');
    }
    const bg = c.filter((r) => /--al-material-chrome-bg/.test(r.decls['background'] ?? ''));
    expect(bg.length).toBeGreaterThan(0);
    for (const r of bg) {
      expect(r.ctx).toMatch(/@supports \(backdrop-filter: blur\(1px\)\)/);
      expect(r.sel).toContain(":root[data-os='macos']");
    }
    expect(chrome).not.toMatch(/data-os='(windows|linux)'/);
  });

  it('has a solid override for reduced transparency, increased contrast and forced colours', () => {
    const cases: [RegExp, RegExp][] = [
      [/prefers-reduced-transparency: reduce/, /\.al-chrome/],
      [TOP, /data-transparency='reduced'.*\.al-chrome/],
      [/prefers-contrast: more/, /\.al-chrome/],
      [TOP, /data-contrast='more'.*\.al-chrome/],
      [/forced-colors: active/, /\.al-chrome/],
    ];
    for (const [ctx, sel] of cases) {
      const r = find(c, ctx, sel);
      expect(r.length, `${ctx} ${sel}`).toBeGreaterThan(0);
      expect(r[0]!.decls['backdrop-filter'], `${ctx}`).toBe('none');
      expect(r[0]!.decls['background'], `${ctx}`).toMatch(
        /^(var\(--al-color-bg-surface\)|Canvas)$/,
      );
    }
  });

  it('keeps a hairline border on the content side', () => {
    const base = find(c, TOP, /^\.al-chrome$/)[0]!;
    expect(base.decls['border-color']).toBe('var(--al-color-border-subtle)');
  });

  it('the solid overrides come after the translucent rule so they win', () => {
    const idx = (s: string): number => chrome.lastIndexOf(s);
    const first = chrome.indexOf('--al-material-chrome-bg');
    expect(idx('prefers-reduced-transparency')).toBeGreaterThan(first);
    expect(idx("data-transparency='reduced'")).toBeGreaterThan(first);
  });
});
