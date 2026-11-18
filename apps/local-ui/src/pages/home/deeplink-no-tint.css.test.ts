// OWNER-FB-0512: the owner saw a large peach (accent) or yellow (warning) panel under the row when a
// widget or notification opened a conversation. Cause (0.5.10): `.hm-open::after` painted
// `--al-color-accent-subtle` over the whole opened conversation (inset: 0) while it loaded. No
// conversation, file or skeleton rule of the Home screen may paint such a full-area tint again.
import { describe, expect, it } from 'vitest';
import peopleCss from './people.css?raw';
import homeCss from './home.css?raw';
import fileReaderCss from './file-reader.css?raw';
import attachCss from './attach-composer.css?raw';

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');

/** Pseudo-element rules that cover their whole box (inset: 0) and paint an accent or warning tint. */
function tintedOverlays(css: string): string[] {
  const out: string[] = [];
  for (const m of strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] ?? '').trim();
    const body = m[2] ?? '';
    const covers = /inset:\s*0\b/.test(body);
    const paints = /background(-color)?:\s*var\(--al-color-(accent|status-warning)[a-z-]*/.test(
      body,
    );
    if (/::(after|before)/.test(selector) && covers && paints) out.push(selector);
  }
  return out;
}

describe('opened conversation: no full-area tint', () => {
  it('the detector finds the 0.5.10 overlay in the rule it came from', () => {
    const old = `.hm-open { position: relative; }
      .hm-open::after { content: ''; position: absolute; inset: 0; pointer-events: none;
        background: var(--al-color-accent-subtle, rgba(127, 127, 127, 0.18)); opacity: 0; }`;
    expect(tintedOverlays(old)).toEqual(['.hm-open::after']);
  });

  it('the Home screen styles have none', () => {
    for (const css of [peopleCss, homeCss, fileReaderCss, attachCss]) {
      expect(css.length).toBeGreaterThan(0);
      expect(tintedOverlays(css)).toEqual([]);
    }
  });

  it('the opened conversation and its target mark paint no background of their own', () => {
    const css = strip(peopleCss);
    expect(css).not.toMatch(/\.hm-open(\.hm-target)?(\s*>\s*[.\w-]+)? \{[^}]*background/);
    expect(css).not.toMatch(/\.hm-target[^{]*\{[^}]*background/);
  });
});
