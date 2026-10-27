// UI-REFRESH-a (S1): the refresh scaffold of plan §4. The stylesheets and stub modules exist and
// are exported once, so later cards never edit the same file; the app imports them in order.
import { describe, expect, it } from 'vitest';
import pkgRaw from '../package.json?raw';

const sheets = import.meta.glob('./components/{depth,progress,motion,hood,chrome}.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const modules = import.meta.glob('./components/{surface,progress,motion,hood}.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const indexRaw = Object.values(
  import.meta.glob('./components/index.ts', { query: '?raw', import: 'default', eager: true }),
)[0] as string;
const mainRaw = Object.values(
  import.meta.glob('../../../apps/local-ui/src/main.tsx', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
)[0] as string;

const NAMES = ['depth', 'progress', 'motion', 'hood', 'chrome'] as const;
const pkg = JSON.parse(pkgRaw) as { exports: Record<string, unknown>; files: string[] };

describe('refresh scaffold', () => {
  it('has the five new stylesheets', () => {
    expect(Object.keys(sheets).sort()).toEqual(NAMES.map((n) => `./components/${n}.css`).sort());
  });

  it('motion, depth, chrome and progress carry rules; the others are filled by their cards', () => {
    for (const n of NAMES) {
      const text = sheets[`./components/${n}.css`] as string;
      const rules = text.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (n === 'motion' || n === 'depth' || n === 'chrome' || n === 'progress') {
        expect(rules, n).toContain('{');
      } else expect(rules, n).toBe('');
    }
    const progress = (sheets['./components/progress.css'] as string).replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(progress).toContain('.al-pb');
  });

  it('exports each stylesheet and ships it in "files"', () => {
    for (const n of NAMES) {
      expect(pkg.exports[`./${n}.css`], n).toBe(`./src/components/${n}.css`);
      expect(pkg.files, n).toContain(`src/components/${n}.css`);
    }
  });

  it('has the four stub modules, exported from the components index', () => {
    expect(Object.keys(modules).sort()).toEqual(
      ['surface', 'progress', 'motion', 'hood'].map((n) => `./components/${n}.tsx`).sort(),
    );
    for (const n of ['surface', 'progress', 'motion', 'hood']) {
      expect(indexRaw).toContain(`export * from './${n}.js';`);
    }
  });

  it('the app imports the stylesheets once, after components.css and before app.css', () => {
    const order = [
      '@4thtech-io/ui/tokens.css',
      '@4thtech-io/ui/components.css',
      ...NAMES.map((n) => `@4thtech-io/ui/${n}.css`),
      './app.css',
    ];
    const at = order.map((s) => mainRaw.indexOf(`import '${s}';`));
    for (const [i, s] of order.entries()) {
      expect(at[i], s).toBeGreaterThanOrEqual(0);
      expect(mainRaw.split(`import '${s}';`).length, s).toBe(2);
    }
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('motion.css holds the one reduced-motion switch (system setting and data-motion)', () => {
    const text = (sheets['./components/motion.css'] as string).replace(/\s+/g, ' ');
    expect(text).toContain('@media (prefers-reduced-motion: reduce)');
    expect(text).toContain(":root[data-motion='reduced']");
    expect(text).toMatch(/animation: none !important/);
    expect(text).toMatch(/transition: none !important/);
  });
});
