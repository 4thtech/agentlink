// M1-11b-2a: until M1-11b-2 moves Approvals into this app, the approval page of @4thtech-io/node
// draws this app's sidebar itself (owner feedback 2026-10-26: no menu to get back). That package
// does not depend on this one, so it copies the items by value; this test sits next to nav.ts so a
// change to the sidebar here also runs it: same labels, icons and paths, in the same order.
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from './nav.js';

// Read through Vite: a relative import would leave the app (boundaries rule).
const files = import.meta.glob(['../../../packages/node/src/approval-page.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

function pageSource(): string {
  const all = Object.values(files);
  expect(all).toHaveLength(1);
  const source = all[0];
  if (typeof source !== 'string' || source === '') throw new Error('approval-page.ts missing');
  return source;
}

describe('the approval page draws the same sidebar as this app (M1-11b-2a)', () => {
  it('has every item with the same label, icon and path, in the same order', () => {
    const source = pageSource();
    let last = -1;
    for (const item of NAV_ITEMS) {
      const entry = `{ label: '${item.label}', icon: '${item.icon}', path: '${item.path}' }`;
      const at = source.indexOf(entry);
      expect(at, `approval-page.ts APP_NAV is missing or out of order: ${entry}`).toBeGreaterThan(
        last,
      );
      last = at;
    }
    const entries = source.match(/\{ label: '[^']+', icon: '[^']+', path: '[^']+' \}/g) ?? [];
    expect(entries).toHaveLength(NAV_ITEMS.length);
  });
});
