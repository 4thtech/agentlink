// M1-35b: the component stylesheet (S1; 08 §4 CSP; 11 §11.7, §9). The classes the components render
// must exist in the CSS, the CSS may use only tokens that exist, and it loads nothing from outside.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import pkgText from '../../package.json?raw';
import tokens from '../tokens/tokens.css?raw';
import componentsCss from './components.css?raw';
import legacyShell from './legacy-shell.css?raw';

// W4-HOME: the legacy app shell's rules moved to legacy-shell.css (AppShell's own stylesheet, not
// imported by the app); the component stylesheet is both files.
const components = `${componentsCss}\n${legacyShell}`;
import { fixtures } from './components.fixture.js';
import * as ui from './index.js';

const pkg = JSON.parse(pkgText) as {
  exports: Record<string, string>;
  files: string[];
  sideEffects: string[];
};
const defined = new Set([...(components + tokens).matchAll(/\.(al-[a-z0-9-]+)/g)].map((m) => m[1]));
const varsDefined = new Set([...tokens.matchAll(/(--al-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

describe('components.css', () => {
  it('is shipped and exported by the package', () => {
    expect(pkg.exports['./components.css']).toBe('./src/components/components.css');
    expect(pkg.files).toContain('src/components/components.css');
    expect(pkg.sideEffects).toContain('*.css');
  });
  it('uses only tokens that tokens.css defines', () => {
    const used = new Set([...components.matchAll(/var\((--al-[a-z0-9-]+)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(20);
    expect([...used].filter((v) => !varsDefined.has(v!))).toEqual([]);
  });
  it('loads nothing from outside and declares no font or image of its own', () => {
    expect(components).not.toMatch(/@import|url\(|https?:\/\/|@font-face/i);
  });
  it('has no hard-coded colour: every colour is a token', () => {
    const stripped = components.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });
  it('respects reduced motion and forced colours', () => {
    expect(components).toContain('prefers-reduced-motion: reduce');
    expect(components).toContain('forced-colors: active');
  });
  it('has a rule for every class a component renders', () => {
    const used = new Set<string>();
    for (const make of Object.values(fixtures)) {
      for (const m of renderToStaticMarkup(make()).matchAll(/class="([^"]*)"/g)) {
        for (const c of m[1]!.split(/\s+/)) if (c.startsWith('al-')) used.add(c);
      }
    }
    expect([...used].filter((c) => !defined.has(c)).sort()).toEqual([]);
  });
  it('has a width class for every bar step the credits meter can draw', () => {
    for (let n = 0; n <= 100; n += 5) expect(defined.has(`al-pct-${n}`), `al-pct-${n}`).toBe(true);
  });
  it('renders the credits meter with one of those classes at any spend', () => {
    for (const spent of [0, 0.01, 2.49, 2.5, 4.99, 5, 9]) {
      const out = renderToStaticMarkup(
        h(ui.CreditsMeter, { balance: '$1', proofsLeft: 1, spentLast24h: spent, budget: 5 }),
      );
      const n = /al-pct-(\d+)/.exec(out)?.[1];
      expect(n, String(spent)).toBeDefined();
      expect(defined.has(`al-pct-${n}`)).toBe(true);
    }
  });
});
