// M1-35a: the design tokens module, the CSS and the shipped notices (S1). The sources of truth are
// the D1 files under docs/design/d1/ (read with Vite `?raw`: the ui zone allows no Node built-ins).
import { describe, expect, it } from 'vitest';
import css from './tokens.css?raw';
import {
  colorTokens,
  contrastRatio,
  cssVar,
  fontFamilies,
  fonts,
  scalarTokens,
  shadowTokens,
  themes,
  typeStyles,
  type ThemeId,
} from './index.js';

// The D1 files, read through Vite: a relative import would leave the package (boundaries rule).
const d1 = import.meta.glob(
  [
    '../../../../docs/design/d1/tokens/*.{json,css}',
    '../../../../docs/design/d1/design-system/contrast.md',
  ],
  { query: '?raw', import: 'default', eager: true },
);
function d1File(name: string): string {
  const text = d1[`../../../../docs/design/d1/${name}`];
  if (text === undefined || text === '') throw new Error(`D1 file missing or empty: ${name}`);
  return text;
}
const baseRaw = d1File('tokens/base.json');
const contrastMd = d1File('design-system/contrast.md');
const d1Css = d1File('tokens/tokens.css');
const sourceRaw = d1File('tokens/tokens.source.json');
const darkRaw = d1File('tokens/theme-dark.json');
const darkContrastRaw = d1File('tokens/theme-dark-contrast.json');
const lightRaw = d1File('tokens/theme-light.json');
const lightContrastRaw = d1File('tokens/theme-light-contrast.json');

interface SourceToken {
  name: string;
  value: string | Record<string, string>;
}
interface Source {
  color: { themes: { id: string }[]; tokens: SourceToken[] };
  type: {
    fonts: { family: string; file: string; weight: string; style: string }[];
    families: { sans: string; mono: string };
    groups: { styles: Record<string, string | number>[] }[];
  };
  shadow: { tokens: SourceToken[] };
  [group: string]: unknown;
}
const source = JSON.parse(sourceRaw) as Source;
const SCALAR_GROUPS = [
  'spacing',
  'radius',
  'size',
  'borderWidth',
  'fontWeight',
  'opacity',
  'zIndex',
  'duration',
  'easing',
  'layout',
] as const;

describe('tokens module matches the D1 token source', () => {
  it('lists the four themes in source order', () => {
    expect(themes).toEqual(source.color.themes.map((t) => t.id));
  });

  it('has every colour token with its four theme values, and no others', () => {
    expect(Object.keys(colorTokens)).toEqual(source.color.tokens.map((t) => t.name));
    for (const t of source.color.tokens) {
      expect(colorTokens[t.name as keyof typeof colorTokens], t.name).toEqual(t.value);
    }
  });

  it('has every scalar token (space, radius, size, border, weight, opacity, z, motion, layout)', () => {
    const expected: Record<string, string> = {};
    for (const group of SCALAR_GROUPS) {
      for (const t of (source[group] as { tokens: SourceToken[] }).tokens) {
        expected[t.name] = t.value as string;
      }
    }
    expect({ ...scalarTokens }).toEqual(expected);
  });

  it('has the shadows, type styles, fonts and families', () => {
    expect(Object.keys(shadowTokens)).toEqual(source.shadow.tokens.map((t) => t.name));
    for (const t of source.shadow.tokens) {
      const v = shadowTokens[t.name as keyof typeof shadowTokens];
      // A flat shadow ("none") applies to every theme.
      const want =
        typeof t.value === 'string'
          ? Object.fromEntries(themes.map((id) => [id, t.value]))
          : t.value;
      expect(v, t.name).toEqual(want);
    }
    const styles = source.type.groups.flatMap((g) => g.styles);
    expect(typeStyles.map((s) => s.name)).toEqual(styles.map((s) => s['name']));
    for (const s of styles) {
      expect(typeStyles.find((x) => x.name === s['name'])).toMatchObject({
        fontSize: s['fontSize'],
        lineHeight: s['lineHeight'],
        fontWeight: s['fontWeight'],
        letterSpacing: s['letterSpacing'],
      });
    }
    expect(fonts).toEqual(source.type.fonts);
    expect(fontFamilies).toEqual(source.type.families);
  });

  it('parses the DTCG files and agrees with the module for every theme colour', () => {
    const files: Record<ThemeId, string> = {
      dark: darkRaw,
      light: lightRaw,
      'dark-contrast': darkContrastRaw,
      'light-contrast': lightContrastRaw,
    };
    const leaves = (node: unknown, path: string[], out: Map<string, string>): void => {
      const n = node as Record<string, unknown>;
      if (typeof n['$value'] === 'string') {
        expect(n['$type'], path.join('.')).toBeTypeOf('string');
        out.set(`al-${path.join('-')}`, n['$value']);
        return;
      }
      for (const [k, v] of Object.entries(n)) {
        if (!k.startsWith('$')) leaves(v, [...path, k], out);
      }
    };
    expect(() => JSON.parse(baseRaw)).not.toThrow();
    for (const id of themes) {
      const colors = new Map<string, string>();
      const json = JSON.parse(files[id]) as { color: unknown };
      leaves(json.color, ['color'], colors);
      expect(colors.size, id).toBeGreaterThan(0);
      for (const [name, value] of colors) {
        expect(colorTokens[name as keyof typeof colorTokens][id], `${id} ${name}`).toBe(value);
      }
    }
  });
});

/** Prettier formats tokens.css (quotes, line breaks); everything is compared whitespace-free. */
const compact = (text: string): string => text.replace(/\s+/g, '').replaceAll("'", '"');
const css0 = compact(css);

/** The declarations of the first top-level rule with exactly this selector, whitespace-free. */
function block(selector: string): string {
  const open = `}${compact(selector)}{`;
  const start = css0.indexOf(open);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css0.slice(start, css0.indexOf('}', start + 1));
}
const decl = (name: string, value: string): string => compact(`--${name}:${value};`);

describe('tokens.css', () => {
  it('equals the D1 tokens.css except for the font paths', () => {
    expect(css0).toBe(compact(d1Css.replaceAll('url("fonts/', 'url("../../fonts/')));
  });

  it('declares every scalar token once at :root', () => {
    const root = block(':root');
    for (const [name, value] of Object.entries(scalarTokens)) {
      expect(root, name).toContain(decl(name, value));
    }
  });

  it('declares every colour and shadow token in the dark and light blocks', () => {
    const blocks = {
      dark: block(':root, [data-theme="dark"]'),
      light: block('[data-theme="light"]'),
    };
    for (const id of ['dark', 'light'] as const) {
      for (const [name, values] of Object.entries(colorTokens)) {
        expect(blocks[id], `${id} ${name}`).toContain(decl(name, values[id]));
      }
      for (const [name, values] of Object.entries(shadowTokens)) {
        expect(blocks[id], `${id} ${name}`).toContain(decl(name, values[id]));
      }
    }
  });

  it('declares the increased-contrast overrides in both contrast blocks', () => {
    const blocks = {
      'dark-contrast': block(
        ':root[data-contrast="more"]:not([data-theme="light"]), [data-theme="dark"][data-contrast="more"], [data-theme="dark-contrast"]',
      ),
      'light-contrast': block(
        '[data-theme="light"][data-contrast="more"], [data-theme="light-contrast"]',
      ),
    };
    for (const id of ['dark-contrast', 'light-contrast'] as const) {
      const base = id === 'dark-contrast' ? 'dark' : 'light';
      for (const [name, values] of Object.entries(colorTokens)) {
        // The contrast files hold overrides only: a value that differs from the base theme must be
        // declared in the block.
        if (values[id] !== values[base]) {
          expect(blocks[id], `${id} ${name}`).toContain(decl(name, values[id]));
        }
      }
    }
  });

  it('defines the two font faces from first-party woff2 files', () => {
    expect(css0).toContain('font-family:"Geist";');
    expect(css0).toContain('font-family:"GeistMono";');
    expect([...css0.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1])).toEqual([
      '../../fonts/Geist-Variable.woff2',
      '../../fonts/GeistMono-Variable.woff2',
    ]);
  });

  it('exposes cssVar() names that exist in the CSS', () => {
    expect(cssVar('al-space-5')).toBe('var(--al-space-5)');
    for (const name of [...Object.keys(colorTokens), ...Object.keys(scalarTokens)]) {
      expect(css0, name).toContain(`--${name}:`);
    }
  });
});

describe('contrast table', () => {
  const COLUMNS: ThemeId[] = ['dark', 'light', 'dark-contrast', 'light-contrast'];
  const rows = contrastMd
    .split('\n')
    .map((line) => line.match(/^\| `([^`]+)` \| `([^`]+)` \| (text|ui) \| (.+) \|$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({
      fg: m[1] as string,
      bg: m[2] as string,
      kind: m[3] as 'text' | 'ui',
      stated: (m[4] as string).split('|').map((c) => Number(c.trim())),
    }));

  it('parses every row of the table', () => {
    expect(rows.length).toBeGreaterThanOrEqual(60);
    for (const r of rows) {
      expect(r.stated, `${r.fg} on ${r.bg}`).toHaveLength(4);
    }
  });

  it('recomputes each stated ratio from the tokens', () => {
    for (const r of rows) {
      COLUMNS.forEach((theme, i) => {
        const fg = colorTokens[r.fg as keyof typeof colorTokens][theme];
        const bg = colorTokens[r.bg as keyof typeof colorTokens][theme];
        expect(contrastRatio(fg, bg), `${r.fg} on ${r.bg} (${theme})`).toBeCloseTo(
          r.stated[i] as number,
          1,
        );
      });
    }
  });

  it('meets the floors: text 4.5 (7 in increased contrast), UI marks 3', () => {
    for (const r of rows) {
      COLUMNS.forEach((theme) => {
        const fg = colorTokens[r.fg as keyof typeof colorTokens][theme];
        const bg = colorTokens[r.bg as keyof typeof colorTokens][theme];
        const floor = r.kind === 'ui' ? 3 : theme.endsWith('contrast') ? 7 : 4.5;
        expect(contrastRatio(fg, bg), `${r.fg} on ${r.bg} (${theme})`).toBeGreaterThanOrEqual(
          floor - 0.005,
        );
      });
    }
  });
});

describe('package contents', () => {
  const sources = import.meta.glob(
    ['./**/*.{ts,css}', '!./**/*.test.ts', '../index.ts', '../../package.json', '../../*.md'],
    { query: '?raw', import: 'default', eager: true },
  );
  // The OFL text is the licence as published, with its own reference to SIL's site in prose: shipped
  // unmodified, never loaded, so it is checked for content but not for URLs.
  const ofl = import.meta.glob('../../fonts/OFL.txt', {
    query: '?raw',
    import: 'default',
    eager: true,
  });
  const fontFiles = import.meta.glob('../../fonts/*.woff2', {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  it('references no external URL anywhere in the package', () => {
    const files = Object.entries(sources);
    expect(files.length).toBeGreaterThan(4);
    for (const [path, rawText] of files) {
      // package.json's repository field is metadata, never fetched by the package.
      const text = path.endsWith('package.json')
        ? JSON.stringify({ ...JSON.parse(rawText), repository: undefined })
        : rawText;
      // The notices quote licence text without links: the whole package is free of scheme URLs,
      // @import and CDN hosts.
      expect(
        text.match(/\b(?:https?|wss?|ftp):\/\/[^\s)"'`]+|@import|\/\/cdn\./g),
        path,
      ).toBeNull();
    }
  });

  it('ships both fonts as woff2 next to the OFL licence', () => {
    expect(Object.keys(fontFiles).sort()).toEqual([
      '../../fonts/Geist-Variable.woff2',
      '../../fonts/GeistMono-Variable.woff2',
    ]);
    for (const text of Object.values(fontFiles)) expect(text.startsWith('wOF2')).toBe(true);
    expect(ofl['../../fonts/OFL.txt']).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('ships the Lucide ISC and Geist OFL notices and lists them in "files"', () => {
    const notices = sources['../../THIRD-PARTY-NOTICES.md'] as string;
    expect(notices).toContain('Lucide');
    expect(notices).toContain('ISC License');
    expect(notices).toContain('Permission to use, copy, modify, and/or distribute this software');
    expect(notices).toContain('Cole Bemis');
    expect(notices).toContain('Geist');
    expect(notices).toContain('SIL Open Font License');
    const pkg = JSON.parse(sources['../../package.json'] as string) as {
      files: string[];
      sideEffects: unknown;
      exports: Record<string, unknown>;
    };
    // Bundlers must keep a bare `import '@4thtech-io/ui/tokens.css'`.
    expect(pkg.sideEffects).toEqual(['*.css']);
    for (const f of ['fonts', 'THIRD-PARTY-NOTICES.md', 'src/tokens/tokens.css']) {
      expect(pkg.files).toContain(f);
    }
    expect(Object.keys(pkg.exports)).toEqual(
      expect.arrayContaining(['.', './tokens.css', './fonts/*']),
    );
  });
});

// M1-PAY-CONFIRM-b: the motion additions approved in D-132 (b11 §14), in the D1 source, the
// module and both stylesheets.
describe('the D-132 motion tokens (b11 §14)', () => {
  const added = {
    'al-duration-moment': '480ms',
    'al-duration-ambient': '2000ms',
    'al-duration-ambient-sweep': '1400ms',
    'al-easing-emphasized': 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  } as const;
  it('are in the module and in tokens.css, as in the D1 files', () => {
    for (const [name, value] of Object.entries(added)) {
      expect((scalarTokens as Record<string, string>)[name], name).toBe(value);
      expect(css, name).toContain(`--${name}: ${value};`);
      expect(d1Css, name).toContain(`--${name}: ${value};`);
    }
  });
});
