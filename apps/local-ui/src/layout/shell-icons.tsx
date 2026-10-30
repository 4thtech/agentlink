// W4-SHELL-V2: the shell's own icons, exactly the prototype v23 set (Lucide, ISC; see
// THIRD-PARTY-NOTICES.md). The design system's <Icon> lacks these shapes; they are kept here as data
// and rendered as React elements (no innerHTML, no inline style; 08 §4 CSP). Decorative: every icon
// stands next to its words or inside a named control.
import { createElement, type ReactElement } from 'react';

type Shape = readonly [tag: 'path' | 'circle' | 'rect', attrs: Readonly<Record<string, string>>];

const p = (d: string): Shape => ['path', { d }];
const c = (cx: string, cy: string, r: string): Shape => ['circle', { cx, cy, r }];

export const SHELL_ICONS = {
  home: [p('m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'), p('M9 22V12h6v10')],
  agents: [c('12', '8', '4'), p('M4 21a8 8 0 0 1 16 0')],
  activity: [p('M22 12h-4l-3 9L9 3l-3 9H2')],
  settings: [
    p(
      'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
    ),
    c('12', '12', '3'),
  ],
  stream: [p('M3 5h18'), p('M3 10h12'), p('M3 15h18'), p('M3 20h8')],
  rules: [p('M9 11l3 3L22 4'), p('M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11')],
  proofs: [p('M12 3 21 12 12 21 3 12Z')],
  relays: [
    c('12', '12', '2'),
    p('M16.24 7.76a6 6 0 0 1 0 8.49'),
    p('M7.76 16.24a6 6 0 0 1 0-8.49'),
    p('M19.07 4.93a10 10 0 0 1 0 14.14'),
    p('M4.93 19.07a10 10 0 0 1 0-14.14'),
  ],
  map: [
    p(
      'M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z',
    ),
    p('M15 5.764v15'),
    p('M9 3.236v15'),
  ],
  diag: [p('m4 17 6-6-6-6'), p('M12 19h8')],
  'chev-r': [p('m9 18 6-6-6-6')],
  'chev-d': [p('m6 9 6 6 6-6')],
  help: [c('12', '12', '10'), p('M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3'), p('M12 17h.01')],
  search: [c('11', '11', '7'), p('m21 21-4.3-4.3')],
  plus: [p('M12 5v14'), p('M5 12h14')],
  check: [p('M20 6 9 17l-5-5')],
  keyboard: [
    ['rect', { x: '2', y: '6', width: '20', height: '12', rx: '2' }],
    p('M6 10h.01'),
    p('M10 10h.01'),
    p('M14 10h.01'),
    p('M18 10h.01'),
    p('M7 14h10'),
  ],
  book: [p('M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20')],
  flag: [p('M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z'), p('M4 22v-7')],
  rocket: [
    p('M5 12l5 5'),
    p('M9 15c-2 0-4 1-5 5 4-1 5-3 5-5Z'),
    p('M14.5 4.5c3-1.5 5.5-1.5 5.5-1.5s0 2.5-1.5 5.5L12 15l-3-3Z'),
  ],
} as const satisfies Record<string, readonly Shape[]>;

export type ShellIconName = keyof typeof SHELL_ICONS;

export function ShellIcon({
  name,
  size = 20,
  className,
}: {
  readonly name: ShellIconName;
  readonly size?: number;
  readonly className?: string;
}): ReactElement {
  return (
    <svg
      className={className === undefined ? 'al-sicon' : `al-sicon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {SHELL_ICONS[name].map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}
