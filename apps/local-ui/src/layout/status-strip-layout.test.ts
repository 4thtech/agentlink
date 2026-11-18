// OWNER-FB-0512: the Under the hood status strip never scrolls sideways. Its items wrap, a long value
// is cut with an ellipsis, the server facts sit at the right edge, and nothing animates.
import { describe, expect, it } from 'vitest';
import shellCss from './shell.css?raw';

const css = shellCss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
const rule = (selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
};

describe('status strip layout (shell.css)', () => {
  it('has no horizontal scrolling and no content wider than the window', () => {
    expect(rule('.al-strip')).not.toMatch(/overflow-x: (auto|scroll)/);
    expect(rule('.al-strip')).toMatch(/overflow-x: clip/);
    expect(rule('.al-strip-list')).not.toMatch(/width: max-content/);
    expect(rule('.al-strip-list')).not.toMatch(/white-space: nowrap/);
  });

  it('wraps onto a second line and keeps each item inside the line', () => {
    expect(rule('.al-strip-list')).toMatch(/flex-wrap: wrap/);
    expect(rule('.al-strip-item')).toMatch(/max-width: 100%/);
    expect(rule('.al-strip-item')).toMatch(/min-width: 0/);
  });

  it('cuts a long value with an ellipsis and pushes the server facts to the right', () => {
    expect(rule('.al-strip-value')).toMatch(/text-overflow: ellipsis/);
    expect(rule('.al-strip-value')).toMatch(/overflow: hidden/);
    expect(rule('.al-strip-item[data-fact-first]')).toMatch(/margin-inline-start: auto/);
  });

  it('adds no transition or animation to the strip', () => {
    for (const sel of ['.al-strip', '.al-strip-list', '.al-strip-item', '.al-strip-value']) {
      expect(rule(sel)).not.toMatch(/transition|animation/);
    }
  });
});
