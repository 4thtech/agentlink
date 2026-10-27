// UI-REFRESH-n: the About page's own stylesheet uses tokens only and animates nothing (08 §4).
import { describe, expect, it } from 'vitest';
import css from './about.css?raw';

describe('about.css', () => {
  it('is loaded (the test config keeps the stylesheet text)', () => {
    expect(css.length).toBeGreaterThan(0);
  });
  it('uses tokens only: no literal colours or durations', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(css).not.toMatch(/\b\d+(\.\d+)?m?s\b/);
    expect(css).not.toMatch(/calc\((?![^)]*var\(--al-)/);
  });
  it('has no animation, transition or backdrop-filter', () => {
    expect(css).not.toMatch(/@keyframes|animation|transition|backdrop-filter/);
  });
});
