// UI-REFRESH-f (S1): the shell stylesheets (B-11 §3, §13.2, §6 row 11; plan §5). The nav highlight
// is one slider that moves by transform only; the 360 px layout turns the sidebar into the bottom
// bar (it is no longer hidden); the Settings sub-navigation is sticky chrome; the route fade uses
// the View Transitions pseudo-elements with token durations; and the chrome text meets WCAG 2.1 AA
// over the worst content that can scroll under it (the material opacity is chosen from this).
import { describe, expect, it } from 'vitest';
import components from './components.css?raw';
import chrome from './chrome.css?raw';
import { colorTokens, contrastRatio, depthTokens } from '../tokens/index.js';

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const squash = (css: string): string => strip(css).replace(/\s+/g, ' ');

/** The declaration block of the first rule whose selector list contains `selector` exactly. */
function rule(css: string, selector: string, within = ''): string {
  const text = squash(css);
  const hay = within === '' ? text : text.slice(text.indexOf(within));
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(hay); m !== null; m = re.exec(hay)) {
    const sels = (m[1] as string)
      .split(',')
      .map((s) => s.trim().replace(/^@media[^{]*\{/, '').trim());
    if (sels.includes(selector)) return m[2] as string;
  }
  return '';
}
const all = `${components}\n${chrome}`;

describe('nav highlight', () => {
  it('has one slider that moves by transform only, over a token duration', () => {
    const r = rule(all, '.al-nav-slider');
    expect(r).toContain('position: absolute');
    expect(r).toMatch(/transition: transform var\(--al-duration-(fast|base)\)/);
    expect(r).not.toMatch(/transition:[^;]*(top|left|height|width|margin|all)/);
  });

  it('rests at each index with a translateY rule', () => {
    for (let i = 0; i <= 9; i++) {
      const r = rule(all, `.al-nav-wrap[data-active='${i}'] .al-nav-slider`);
      expect(r, String(i)).toContain('translateY(');
      expect(r, String(i)).toContain('opacity: 1');
    }
    expect(rule(all, '.al-nav-slider')).toContain('opacity: 0');
  });

  it('drops the old per-link bar, the slider carries it', () => {
    expect(squash(all)).not.toContain('.al-nav.is-active::before');
    expect(rule(all, '.al-nav.is-active')).not.toContain('background: var(--al-color-accent-subtle)');
  });

  it('stops sliding under reduced motion (system and app setting)', () => {
    const t = squash(all);
    expect(t).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*\.al-nav-slider/);
    expect(t).toContain(":root[data-motion='reduced'] .al-nav-slider");
  });
});

describe('top bar, status bar and sub-navigation', () => {
  it('top bar is one row at the control height and sticks to the top of the scrolling area', () => {
    const r = rule(all, '.al-topbar');
    expect(r).toContain('position: sticky');
    expect(r).toContain('top: 0');
    expect(r).toContain('display: flex');
    expect(r).toContain('height: var(--al-size-control-lg)');
  });

  it('chrome keeps its hairline on the content side (the material resets border shorthands)', () => {
    expect(rule(chrome, '.al-side.al-chrome')).toContain('border-right-width');
    expect(rule(chrome, '.al-topbar.al-chrome')).toContain('border-bottom-width');
    expect(rule(chrome, '.al-statusbar.al-chrome')).toContain('border-top-width');
  });

  it('the Settings sub-navigation is sticky below the top bar', () => {
    const r = rule(all, '.al-subnav');
    expect(r).toContain('position: sticky');
    expect(r).toContain('top: var(--al-size-control-lg)');
  });
});

describe('360 px: the sidebar becomes the bottom bar', () => {
  const small = (): string => {
    const t = squash(all);
    const at = t.lastIndexOf('@media (max-width: 600px)');
    return at < 0 ? '' : t.slice(at);
  };
  it('is no longer hidden', () => {
    expect(squash(components)).not.toMatch(/@media \(max-width: 600px\) \{ \.al-side \{ display: none/);
    expect(small()).not.toMatch(/\.al-side \{[^}]*display: none/);
  });
  it('lays out as a row under the content, with a hairline on top', () => {
    const t = small();
    expect(t).toMatch(/\.al-shell-main \{[^}]*flex-direction: column/);
    expect(t).toMatch(/\.al-side(\.al-chrome)? \{[^}]*flex-direction: row/);
    expect(t).toMatch(/\.al-side(\.al-chrome)? \{[^}]*order: 2/);
    expect(t).toMatch(/\.al-side(\.al-chrome)? \{[^}]*border-top-width/);
  });
  it('scrolls sideways instead of squeezing eight labels, and hides the brand', () => {
    const t = small();
    expect(t).toMatch(/overflow-x: auto/);
    expect(t).toMatch(/\.al-side-brand \{[^}]*display: none/);
  });
  it('shows the current page without the slider', () => {
    const t = small();
    expect(t).toMatch(/\.al-nav-slider \{[^}]*display: none/);
    expect(t).toMatch(/\.al-nav\.is-active \{[^}]*background: var\(--al-color-accent-subtle\)/);
  });
});

describe('route transition (View Transitions)', () => {
  it('fades the page in with a 4 px rise over --al-duration-fast, content only', () => {
    const t = squash(chrome);
    expect(t).toMatch(/\.al-shell-content \{[^}]*view-transition-name: al-page/);
    expect(t).toMatch(/::view-transition-new\(al-page\) \{[^}]*animation: [^;]*var\(--al-duration-fast\)/);
    const kf = /@keyframes al-page-in \{([\s\S]*?)\} \}/.exec(t);
    expect(kf, 'al-page-in keyframes').not.toBeNull();
    expect(kf?.[1]).toContain('translateY(4px)');
    expect(kf?.[1]).toContain('opacity: 0');
  });
  it('does not cross-fade the chrome (root snapshot is not animated)', () => {
    const t = squash(chrome);
    expect(t).toMatch(/::view-transition-(old|new)\(root\)[^{]*\{[^}]*animation: none/);
  });
  it('is switched off under reduced motion in both ways', () => {
    const t = squash(chrome);
    expect(t).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*::view-transition-new\(al-page\)/);
    expect(t).toContain(":root[data-motion='reduced']::view-transition-new(al-page)");
  });
});

describe('chrome text contrast (WCAG 2.1 AA, B-11 §13.2)', () => {
  // Worst case under the material: the page's brightest block in dark (pure white) and its darkest in
  // light (pure black). Real pages are calmer; this is the bound the owner's rule asks for.
  const hexOf = (v: string): string => v;
  const rgba = (v: string): [number, number, number, number] => {
    const m = /rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/.exec(v);
    expect(m, v).not.toBeNull();
    return [Number(m?.[1]), Number(m?.[2]), Number(m?.[3]), Number(m?.[4])];
  };
  const toHex = (c: number[]): string =>
    '#' + c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
  const over = (theme: 'dark' | 'light', under: [number, number, number]): string => {
    const [r, g, b, a] = rgba(depthTokens['al-material-chrome-bg'][theme]);
    return toHex([r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a)]);
  };
  const CASES = [
    ['dark', [255, 255, 255]],
    ['light', [0, 0, 0]],
  ] as const;
  for (const [theme, under] of CASES) {
    for (const name of ['al-color-fg-default', 'al-color-fg-muted'] as const) {
      it(`${name} on the ${theme} chrome over the worst content is at least 4.5:1`, () => {
        const bg = over(theme, [...under]);
        const fg = hexOf(colorTokens[name][theme]);
        expect(contrastRatio(fg, bg), `${theme} ${name} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  it('keeps the chrome translucent (below 0.95 alpha) so the material is still felt', () => {
    for (const theme of ['dark', 'light'] as const) {
      const a = rgba(depthTokens['al-material-chrome-bg'][theme])[3];
      expect(a).toBeLessThan(0.95);
      expect(a).toBeGreaterThanOrEqual(0.72);
    }
  });
});
