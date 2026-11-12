// WP-I1: five Lucide glyphs the kit's icon set does not have yet (id-card, bot, pencil, shield-check,
// plus), drawn inline so My IDs matches the mockup. WP-N1 adds `idcard` to layout/shell-icons.tsx; once
// both are on main this file can use it. Decorative (aria-hidden): the words are always beside them.
import type { ReactElement, ReactNode } from 'react';

function Glyph({ size, children }: { size: number; children: ReactNode }): ReactElement {
  return (
    <svg
      className="ag-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IdCardIcon = ({ size = 16 }: { size?: number }): ReactElement => (
  <Glyph size={size}>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <circle cx="9" cy="11" r="2" />
    <path d="M6.17 15a3 3 0 0 1 5.66 0" />
    <path d="M16 10h2" />
    <path d="M16 14h2" />
  </Glyph>
);
export const BotIcon = ({ size = 16 }: { size?: number }): ReactElement => (
  <Glyph size={size}>
    <path d="M12 8V4H8" />
    <rect x="4" y="8" width="16" height="12" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M15 13v2" />
    <path d="M9 13v2" />
  </Glyph>
);
export const PencilIcon = ({ size = 16 }: { size?: number }): ReactElement => (
  <Glyph size={size}>
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </Glyph>
);
export const ShieldCheckIcon = ({ size = 16 }: { size?: number }): ReactElement => (
  <Glyph size={size}>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    <path d="m9 12 2 2 4-4" />
  </Glyph>
);
export const PlusIcon = ({ size = 16 }: { size?: number }): ReactElement => (
  <Glyph size={size}>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </Glyph>
);
