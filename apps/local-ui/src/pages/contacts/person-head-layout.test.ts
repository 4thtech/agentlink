// R1-UI-05 (S0): the person's sheet head keeps the ⋯ button pinned top right, however long the name,
// so its menu (right-aligned to the button) opens inside the sheet and is never a blank strip.
import { describe, expect, it } from 'vitest';
import css from './contacts.css?raw';
import inviteCss from '../invite/invite.css?raw';

function rule(source: string, selector: string): string {
  const at = source.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return source.slice(at, source.indexOf('}', at));
}

describe('person sheet head', () => {
  it('does not wrap, so a long name cannot push the ⋯ button to the next line', () => {
    expect(rule(css, '.ct-detail-head')).toContain('flex-wrap: nowrap');
    expect(rule(css, '.ct-detail-head')).toContain('align-items: flex-start');
  });

  it('lets the name shrink and wrap, and keeps the button at its own size', () => {
    const h2 = rule(css, '.ct-detail-head h2');
    expect(h2).toContain('min-inline-size: 0');
    expect(h2).toContain('overflow-wrap: anywhere');
    expect(rule(css, '.ct-detail-head .inv-menu-wrap')).toContain('flex: none');
  });

  it('shows the whole name in the sheet (no ellipsis)', () => {
    const name = rule(css, '.ct-detail-head .al-cname-text');
    expect(name).toContain('max-width: none');
    expect(name).toContain('white-space: normal');
  });

  it('keeps the menu no wider than the screen', () => {
    expect(rule(inviteCss, '.inv-menu')).toContain('min(220px, calc(100vw');
  });
});
