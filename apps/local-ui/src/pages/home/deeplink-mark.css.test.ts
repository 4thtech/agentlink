// WIDGET-POLISH-0511: the deep-link mark on an opened conversation is never an overlay over its
// content (0.5.10 showed a full-area accent box while the conversation loaded). Only a thin bar by
// the conversation's header row, opacity only, with no transition under reduced motion.
import { describe, expect, it } from 'vitest';
import peopleCss from './people.css?raw';

const css = peopleCss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');

describe('deep-link mark (people.css)', () => {
  it('has no pseudo-element overlay or background on the open conversation', () => {
    expect(css.length).toBeGreaterThan(0);
    expect(css).not.toMatch(/\.hm-open(\.hm-target)?::(after|before)/);
    expect(css).not.toMatch(/\.hm-open\.hm-target \{[^}]*(background|box-shadow)/);
  });

  it('marks with a 2 px bar by the header row that only fades', () => {
    expect(css).toMatch(/\.hm-open-head::before \{[^}]*width: 2px;/);
    expect(css).toMatch(
      /\.hm-open-head::before \{[^}]*transition: opacity var\(--al-duration-slow\)/,
    );
    expect(css).toMatch(/\.hm-open\.hm-target > \.hm-open-head::before \{ opacity: 1; \}/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{ \.hm-open-head::before \{ transition: none; \} \}/,
    );
  });
});
