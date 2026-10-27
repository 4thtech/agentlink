// UI-REFRESH-n: the About page's own stylesheet uses tokens only and animates nothing (08 §4).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./about.css', import.meta.url), 'utf8');

describe('about.css', () => {
  it('uses tokens only: no literal colours or durations', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(css).not.toMatch(/\b\d+(\.\d+)?m?s\b/);
    expect(css).not.toMatch(/calc\((?![^)]*var\(--al-)/);
  });
  it('has no animation, transition or backdrop-filter', () => {
    expect(css).not.toMatch(/@keyframes|animation|transition|backdrop-filter/);
  });
});
