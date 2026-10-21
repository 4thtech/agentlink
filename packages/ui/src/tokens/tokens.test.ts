// M1-35a: the design tokens module, the CSS and the shipped notices (S1). The sources of truth are
// the D1 files under docs/design/d1/ (read with Vite `?raw`: the ui zone allows no Node built-ins).
import { describe, expect, it } from 'vitest';
import baseRaw from '../../../../docs/design/d1/tokens/base.json?raw';
import contrastMd from '../../../../docs/design/d1/design-system/contrast.md?raw';
import d1Css from '../../../../docs/design/d1/tokens/tokens.css?raw';
import sourceRaw from '../../../../docs/design/d1/tokens/tokens.source.json?raw';
import darkRaw from '../../../../docs/design/d1/tokens/theme-dark.json?raw';
import darkContrastRaw from '../../../../docs/design/d1/tokens/theme-dark-contrast.json?raw';
import lightRaw from '../../../../docs/design/d1/tokens/theme-light.json?raw';
import lightContrastRaw from '../../../../docs/design/d1/tokens/theme-light-contrast.json?raw';
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

/** The body of the first rule whose selector line equals `selector`. */
function block(text: string, selector: string): string {
  const start = text.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return text.slice(start, text.indexOf('\n}', start));
}

describe('tokens.css', () => {
  it('equals the D1 tokens.css except for the font paths', () => {
    expect(css).toBe(d1Css.replaceAll('url("fonts/', 'url("../../fonts/'));
  });

  it('declares every scalar token once at :root', () => {
    const root = block(css, ':root');
    for (const [name, value] of Object.entries(scalarTokens)) {
      expect(root, name).toContain(`  --${name}: ${value};`);
    }
  });

  it('declares every colour and shadow token in the dark and light blocks', () => {
    const blocks = {
      dark: block(css, ':root, [data-theme="dark"]'),
      light: block(css, '[data-theme="light"]'),
    };
    for (const id of ['dark', 'light'] as const) {
      for (const [name, values] of Object.entries(colorTokens)) {
        expect(blocks[id], `${id} ${name}`).toContain(`--${name}: ${values[id]};`);
      }
      for (const [name, values] of Object.entries(shadowTokens)) {
        expect(blocks[id], `${id} ${name}`).toContain(`--${name}: ${values[id]};`);
      }
    }
  });

  it('declares the increased-contrast overrides in both contrast blocks', () => {
    const blocks = {
      'dark-contrast': block(
        css,
        ':root[data-contrast="more"]:not([data-theme="light"]), [data-theme="dark"][data-contrast="more"], [data-theme="dark-contrast"]',
      ),
      'light-contrast': block(
        css,
        '[data-theme="light"][data-contrast="more"], [data-theme="light-contrast"]',
      ),
    };
    for (const id of ['dark-contrast', 'light-contrast'] as const) {
      const base = id === 'dark-contrast' ? 'dark' : 'light';
      for (const [name, values] of Object.entries(colorTokens)) {
        // The contrast files hold overrides only: a value that differs from the base theme must be
        // declared in the block.
        if (values[id] !== values[base]) {
          expect(blocks[id], `${id} ${name}`).toContain(`--${name}: ${values[id]};`);
        }
      }
    }
  });

  it('defines the two font faces from first-party woff2 files', () => {
    expect(css).toContain('font-family: "Geist";');
    expect(css).toContain('font-family: "Geist Mono";');
    expect([...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1])).toEqual([
      '../../fonts/Geist-Variable.woff2',
      '../../fonts/GeistMono-Variable.woff2',
    ]);
  });

  it('exposes cssVar() names that exist in the CSS', () => {
    expect(cssVar('al-space-5')).toBe('var(--al-space-5)');
    for (const name of [...Object.keys(colorTokens), ...Object.keys(scalarTokens)]) {
      expect(css, name).toContain(`--${name}:`);
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
    [
      './**/*.{ts,css}',
      '!./**/*.test.ts',
      '../index.ts',
      '../../package.json',
      '../../*.md',
      '../../fonts/*.txt',
    ],
    { query: '?raw', import: 'default', eager: true },
  );
  const fontFiles = import.meta.glob('../../fonts/*.woff2', {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  it('references no external URL anywhere in the package', () => {
    const files = Object.entries(sources);
    expect(files.length).toBeGreaterThan(4);
    for (const [path, text] of files) {
      // The notices quote licence text without links: the whole package is free of scheme URLs,
      // @import and CDN hosts.
      expect(text.match(/\b(?:https?|wss?|ftp):\/\/[^\s)"'`]+|@import|\/\/cdn\./g), path).toBeNull();
    }
  });

  it('ships both fonts as woff2 next to the OFL licence', () => {
    expect(Object.keys(fontFiles).sort()).toEqual([
      '../../fonts/Geist-Variable.woff2',
      '../../fonts/GeistMono-Variable.woff2',
    ]);
    for (const text of Object.values(fontFiles)) expect(text.startsWith('wOF2')).toBe(true);
    const ofl = sources['../../fonts/OFL.txt'] as string;
    expect(ofl).toContain('SIL OPEN FONT LICENSE Version 1.1');
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
      exports: Record<string, unknown>;
    };
    for (const f of ['fonts', 'THIRD-PARTY-NOTICES.md', 'src/tokens/tokens.css']) {
      expect(pkg.files).toContain(f);
    }
    expect(Object.keys(pkg.exports)).toEqual(
      expect.arrayContaining(['.', './tokens.css', './fonts/*']),
    );
  });
});
