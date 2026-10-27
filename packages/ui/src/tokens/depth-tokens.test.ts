// UI-REFRESH-a (S1): the elevation highlight and chrome material tokens (B-11 §13.1, §13.2, §18
// decision 3) and the pinned motion tokens (§14). Exact values in every theme; both token copies.
import { describe, expect, it } from 'vitest';
import css from './tokens.css?raw';
import { depthTokens } from './index.js';

const d1 = import.meta.glob('../../../../docs/design/d1/tokens/{tokens.css,tokens.source.json}', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const d1Css = d1['../../../../docs/design/d1/tokens/tokens.css'] as string;
const sourceRaw = d1['../../../../docs/design/d1/tokens/tokens.source.json'] as string;

const compact = (text: string): string => text.replace(/\s+/g, '').replaceAll("'", '"');
const decl = (name: string, value: string): string => compact(`--${name}:${value};`);

const NAMES = [
  'al-highlight-top',
  'al-highlight-top-raised',
  'al-material-chrome-bg',
  'al-material-blur',
] as const;
const BLUR = 'blur(20px) saturate(1.4)';

type Row = Record<(typeof NAMES)[number], string>;
const DARK: Row = {
  'al-highlight-top': 'rgba(255, 255, 255, 0.05)',
  'al-highlight-top-raised': 'rgba(255, 255, 255, 0.07)',
  'al-material-chrome-bg': 'rgba(17, 19, 22, 0.72)',
  'al-material-blur': BLUR,
};
const LIGHT: Row = {
  'al-highlight-top': 'transparent',
  'al-highlight-top-raised': 'transparent',
  'al-material-chrome-bg': 'rgba(255, 255, 255, 0.72)',
  'al-material-blur': BLUR,
};
const DARK_CONTRAST: Row = {
  'al-highlight-top': 'transparent',
  'al-highlight-top-raised': 'transparent',
  'al-material-chrome-bg': '#060708',
  'al-material-blur': 'none',
};
const LIGHT_CONTRAST: Row = {
  'al-highlight-top': 'transparent',
  'al-highlight-top-raised': 'transparent',
  'al-material-chrome-bg': '#ffffff',
  'al-material-blur': 'none',
};

/** Declarations of the block that starts with exactly this opener (whitespace-free). */
function blockAt(css0: string, opener: string): string {
  const start = css0.indexOf(compact(opener));
  expect(start, opener).toBeGreaterThanOrEqual(0);
  return css0.slice(start, css0.indexOf('}', start));
}

const CASES: { name: string; opener: string; row: Row }[] = [
  { name: 'dark', opener: '}:root, [data-theme="dark"] {', row: DARK },
  { name: 'light', opener: '}[data-theme="light"] {', row: LIGHT },
  {
    name: 'dark-contrast',
    opener:
      '}:root[data-contrast="more"]:not([data-theme="light"]), [data-theme="dark"][data-contrast="more"], [data-theme="dark-contrast"] {',
    row: DARK_CONTRAST,
  },
  {
    name: 'light-contrast',
    opener: '}[data-theme="light"][data-contrast="more"], [data-theme="light-contrast"] {',
    row: LIGHT_CONTRAST,
  },
  {
    name: 'system light',
    opener: '@media (prefers-color-scheme: light) { :root:not([data-theme]) {',
    row: LIGHT,
  },
  {
    name: 'system dark contrast',
    opener: '@media (prefers-contrast: more) { :root:not([data-theme]):not([data-contrast]) {',
    row: DARK_CONTRAST,
  },
  {
    name: 'system light contrast',
    opener:
      '@media (prefers-contrast: more) and (prefers-color-scheme: light) { :root:not([data-theme]):not([data-contrast]) {',
    row: LIGHT_CONTRAST,
  },
];

describe('elevation highlight and chrome material tokens', () => {
  for (const [label, text] of [
    ['packages/ui copy', css],
    ['docs/design/d1 copy', d1Css],
  ] as const) {
    const css0 = compact(text);
    for (const c of CASES) {
      it(`${label}: exact values in the ${c.name} block`, () => {
        const body = blockAt(css0, c.opener);
        for (const n of NAMES) expect(body, `${c.name} ${n}`).toContain(decl(n, c.row[n]));
      });
    }
    it(`${label}: forced colours give a solid material and no highlight`, () => {
      const body = blockAt(css0, '@media (forced-colors: active) { :root {');
      expect(body).toContain(decl('al-highlight-top', 'transparent'));
      expect(body).toContain(decl('al-highlight-top-raised', 'transparent'));
      expect(body).toContain(decl('al-material-chrome-bg', 'Canvas'));
      expect(body).toContain(decl('al-material-blur', 'none'));
    });
  }

  it('the two token copies declare the same values (whitespace-free)', () => {
    for (const n of NAMES) {
      const re = new RegExp(`--${n}:[^;]+;`, 'g');
      const a = compact(css).match(re) ?? [];
      const b = compact(d1Css).match(re) ?? [];
      expect(a.length, n).toBe(8);
      expect(a, n).toEqual(b);
    }
  });

  it('exposes the typed values and the D1 source group, in step with the CSS', () => {
    expect(Object.keys(depthTokens)).toEqual([...NAMES]);
    const rows = {
      dark: DARK,
      light: LIGHT,
      'dark-contrast': DARK_CONTRAST,
      'light-contrast': LIGHT_CONTRAST,
    };
    for (const n of NAMES) {
      for (const [theme, row] of Object.entries(rows)) {
        expect(depthTokens[n][theme as keyof typeof rows], `${theme} ${n}`).toBe(row[n]);
      }
    }
    const source = JSON.parse(sourceRaw) as {
      depth: { tokens: { name: string; value: Record<string, string>; usage: string }[] };
    };
    expect(source.depth.tokens.map((t) => t.name)).toEqual([...NAMES]);
    for (const t of source.depth.tokens) {
      expect(t.value, t.name).toEqual(depthTokens[t.name as (typeof NAMES)[number]]);
    }
    // The raised highlight name is a proposal until the owner confirms it at merge.
    const raised = source.depth.tokens.find((t) => t.name === 'al-highlight-top-raised');
    expect(raised?.usage.toLowerCase()).toContain('proposed');
  });
});

describe('motion tokens (B-11 §14) are pinned', () => {
  const PINNED: Record<string, string> = {
    'al-duration-instant': '0ms',
    'al-duration-fast': '120ms',
    'al-duration-base': '200ms',
    'al-duration-slow': '320ms',
    'al-duration-moment': '480ms',
    'al-duration-ambient': '2000ms',
    'al-duration-ambient-sweep': '1400ms',
    'al-easing-standard': 'cubic-bezier(0.2, 0, 0, 1)',
    'al-easing-enter': 'cubic-bezier(0, 0, 0, 1)',
    'al-easing-exit': 'cubic-bezier(0.3, 0, 1, 1)',
    'al-easing-emphasized': 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  };
  for (const [label, text] of [
    ['packages/ui copy', css],
    ['docs/design/d1 copy', d1Css],
  ] as const) {
    it(`${label}: every duration and easing has the brief's value`, () => {
      const css0 = compact(text);
      for (const [name, value] of Object.entries(PINNED)) {
        expect(css0, name).toContain(decl(name, value));
      }
    });
  }
});
