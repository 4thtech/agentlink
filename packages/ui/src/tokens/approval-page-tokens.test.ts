// M1-11a-ux: the interim approval page of @4thtech-io/node (served at `/app.css`) copies these
// design tokens by value, because that package does not depend on this one (D-116: nothing
// invented). This test lives here, next to tokens.css, so that a token change also runs it: every
// colour the page sets must equal the token of the same name, in the dark and the light theme.
import { describe, expect, it } from 'vitest';
import css from './tokens.css?raw';

// Read through Vite: a relative import would leave the package (boundaries rule).
const files = import.meta.glob(['../../../../packages/node/src/approval-page.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The approval page's APP_CSS template, from its source (it has no `${…}` substitutions). */
function appCss(): string {
  // Vite shortens the key to the nearest relative form; the glob matches this one file.
  const all = Object.values(files);
  expect(all).toHaveLength(1);
  const source = all[0];
  if (typeof source !== 'string' || source === '') throw new Error('approval-page.ts missing');
  const start = source.indexOf('export const APP_CSS = `');
  expect(start).toBeGreaterThanOrEqual(0);
  const body = source.slice(start + 'export const APP_CSS = `'.length);
  const text = body.slice(0, body.indexOf('`;'));
  expect(text).not.toContain('${');
  return text;
}

/** `--al-*` custom properties set in one CSS block, by name. */
function vars(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--al-[a-z0-9-]+):\s*([^;]+);/g)) {
    out.set(m[1] ?? '', (m[2] ?? '').trim());
  }
  return out;
}

/** The body of the first `{…}` block after `marker` (a token block has no nested braces). */
function blockAfter(text: string, marker: string): string {
  const at = text.indexOf(marker);
  expect(at, marker).toBeGreaterThanOrEqual(0);
  const open = text.indexOf('{', at + marker.length - 1);
  return text.slice(open + 1, text.indexOf('}', open));
}

describe('the approval page stylesheet uses these tokens (M1-11a-ux, D-116)', () => {
  it('sets every colour to the token of the same name, dark and light', () => {
    const page = appCss();
    const uiDark = vars(blockAfter(css, ":root,\n[data-theme='dark'] {"));
    const uiLight = vars(blockAfter(css, "[data-theme='light'] {"));
    const dark = vars(blockAfter(page, ':root {'));
    const light = vars(blockAfter(page, '@media (prefers-color-scheme: light) {\n  :root {'));
    expect(dark.size).toBeGreaterThan(10);
    expect(light.size).toBeGreaterThan(10);
    for (const [name, value] of dark) expect(value, `dark ${name}`).toBe(uiDark.get(name));
    for (const [name, value] of light) expect(value, `light ${name}`).toBe(uiLight.get(name));
  });
});
