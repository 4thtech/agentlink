// M1-11b-2a: the approval page of @4thtech-io/node draws the app sidebar until M1-11b-2 moves
// Approvals into the local app. That package does not depend on this one, so it copies the sidebar
// icons by value as SVG markup (D-116: nothing invented). This test sits next to icon-data.ts so an
// icon change also runs it: update NAV_ICONS in packages/node/src/approval-page.ts to match.
import { describe, expect, it } from 'vitest';
import { ICON_SHAPES } from './icon-data.js';

// Read through Vite: a relative import would leave the package (boundaries rule).
const files = import.meta.glob(['../../../../packages/node/src/approval-page.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

const SIDEBAR_ICONS = [
  'approval',
  'activity',
  'users',
  'folder',
  'proof-seal',
  'sliders-horizontal',
  'settings',
];

function render(name: string): string {
  const shapes = ICON_SHAPES[name];
  if (shapes === undefined) throw new Error(`no icon ${name}`);
  return shapes
    .map(([tag, attrs]) => {
      const list = Object.entries(attrs)
        .map(([k, v]) => ` ${k}="${v}"`)
        .join('');
      return `<${tag}${list}/>`;
    })
    .join('');
}

describe('the approval page sidebar icons equal these icons (M1-11b-2a, D-116)', () => {
  it('copies every sidebar icon shape by value', () => {
    const all = Object.values(files);
    expect(all).toHaveLength(1);
    const source = all[0];
    if (typeof source !== 'string' || source === '') throw new Error('approval-page.ts missing');
    for (const name of SIDEBAR_ICONS) {
      const key = /^[a-z]+$/.test(name) ? name : `'${name}'`;
      // Prettier may put a long value on the next line.
      const markup = render(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(source, `NAV_ICONS ${name}`).toMatch(new RegExp(`\\n  ${key}:\\s+'${markup}',\\n`));
    }
  });
});
