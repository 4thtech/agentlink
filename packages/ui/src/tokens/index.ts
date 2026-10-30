// Design tokens (M1-35a, 11 §11.7): typed values from the D1 drop and helpers. The same tokens ship
// as CSS custom properties in `@4thtech-io/ui/tokens.css` (prefix `--al-`), which is what
// components use; the typed values are for logic that needs a number or a name (for example a
// contrast check). No inline styles: the CSS file is the only way to apply a token (08 §4 CSP).
export * from './data.js';
import type { ColorTokenName, ScalarTokenName, ShadowTokenName } from './data.js';

/** `var(--al-…)` for a token name, to use in a stylesheet or a CSS-in-class definition. */
export function cssVar(name: ColorTokenName | ShadowTokenName | ScalarTokenName): string {
  return `var(--${name})`;
}

function channel(hex: string, from: number): number {
  const c = parseInt(hex.slice(from, from + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`contrastRatio needs #rrggbb, got ${hex}`);
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** WCAG 2 contrast ratio between two opaque `#rrggbb` colours (1 to 21). */
export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

import { scalarTokens } from './data.js';

/** The motion tokens alone (durations and easings), for logic that needs the values (W4-MOTION-KIT). */
export const motionTokens = Object.fromEntries(
  Object.entries(scalarTokens).filter(([name]) => /^al-(duration|easing)-/.test(name)),
) as {
  readonly [K in Extract<ScalarTokenName, `al-duration-${string}` | `al-easing-${string}`>]: (typeof scalarTokens)[K];
};
