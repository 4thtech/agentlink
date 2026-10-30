// The few line icons of the approved invite screens (prototype v23 A3, A5, A6) that the design
// system's icon set does not have yet: mail, share and the fingerprint. Decorative only
// (aria-hidden); the button's text is its name. Same 24-unit grid and 2 px stroke as the set.
import type { ReactElement, ReactNode } from 'react';

function Line({ size = 16, children }: { size?: number; children: ReactNode }): ReactElement {
  return (
    <svg
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
      {children}
    </svg>
  );
}

export function MailIcon(): ReactElement {
  return (
    <Line>
      <rect key="r" x="2" y="4" width="20" height="16" rx="2" />
      <path key="p" d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </Line>
  );
}

export function ShareIcon(): ReactElement {
  return (
    <Line>
      <path key="a" d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <path key="b" d="m16 6-4-4-4 4" />
      <path key="c" d="M12 2v13" />
    </Line>
  );
}

export function FingerprintIcon(): ReactElement {
  return (
    <Line size={20}>
      <path key="a" d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
      <path key="b" d="M14 13.12c0 2.38 0 6.38-1 8.88" />
      <path key="c" d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
      <path key="d" d="M2 12a10 10 0 0 1 18-6" />
      <path key="e" d="M2 16h.01" />
      <path key="f" d="M21.8 16c.2-2 .131-5.354 0-6" />
      <path key="g" d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
      <path key="h" d="M8.65 22c.21-.66.45-1.32.57-2" />
      <path key="i" d="M9 6.8a6 6 0 0 1 9 5.2v2" />
    </Line>
  );
}

/** The Copy button's mark, and the ✓ that pops in when the link is copied (U0 al-pop). */
export function CopyMark(): ReactElement {
  return (
    <Line>
      <rect key="r" x="9" y="9" width="13" height="13" rx="2" />
      <path key="p" d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Line>
  );
}

export function CheckMark({ size = 16 }: { size?: number }): ReactElement {
  return (
    <span className="inv-mark al-pop" aria-hidden="true">
      <Line size={size}>
        <path d="M20 6 9 17l-5-5" />
      </Line>
    </span>
  );
}
