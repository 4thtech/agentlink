// W4-SETTINGS-ADVANCED: the four Settings icons the shell set lacks, exactly the prototype's shapes
// (Lucide, ISC; THIRD-PARTY-NOTICES.md). Data rendered as React elements: no innerHTML, no inline
// style (08 §4 CSP). Decorative: each stands next to its words.
import { createElement, type ReactElement } from 'react';

type Shape = readonly [tag: 'path' | 'circle', attrs: Readonly<Record<string, string>>];
const p = (d: string): Shape => ['path', { d }];

const ICONS = {
  backup: [
    p('M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4'),
    p('M14 13.12c0 2.38 0 6.38-1 8.88'),
    p('M17.29 21.02c.12-.6.43-2.3.5-3.02'),
    p('M2 12a10 10 0 0 1 18-6'),
    p('M2 16h.01'),
    p('M21.8 16c.2-2 .131-5.354 0-6'),
    p('M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2'),
    p('M8.65 22c.21-.66.45-1.32.57-2'),
    p('M9 6.8a6 6 0 0 1 9 5.2v2'),
  ],
  folder: [
    p(
      'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
    ),
  ],
  appearance: [['circle', { cx: '12', cy: '12', r: '10' }], p('M12 2a10 10 0 0 0 0 20Z')],
  bell: [p('M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9'), p('M10.3 21a1.94 1.94 0 0 0 3.4 0')],
} as const satisfies Record<string, readonly Shape[]>;

export type SettingsIconName = keyof typeof ICONS;

export function SettingsIcon({ name }: { readonly name: SettingsIconName }): ReactElement {
  return (
    <svg
      className="al-sicon"
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name].map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}
