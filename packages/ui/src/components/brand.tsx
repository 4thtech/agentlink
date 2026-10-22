// Brand and icons (M1-35b; d1/components/Mark, Wordmark, Lockup, Icon). Pure SVG as React
// elements: no innerHTML, no inline style.
import { createElement, type ReactElement } from 'react';
import { ICON_SHAPES } from './icon-data.js';
import { cx } from './util.js';
import { WORDMARK } from './wordmark-data.js';

export const iconNames: readonly string[] = Object.keys(ICON_SHAPES);

export interface IconProps {
  name: string;
  size?: number;
  strokeWidth?: number;
  /** Only when the icon stands alone; otherwise it is hidden from screen readers. */
  label?: string;
  className?: string;
}

/** Every UI icon (Lucide and AgentLink's own set) on a 24px grid, drawn in `currentColor`. */
export function Icon({
  name,
  size = 16,
  strokeWidth = 2,
  label,
  className,
}: IconProps): ReactElement {
  const shapes = ICON_SHAPES[name] ?? ICON_SHAPES['circle'] ?? [];
  return (
    <svg
      className={cx('al-icon', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label === undefined ? 'true' : undefined}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
    >
      {shapes.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}

export interface MarkProps {
  size?: number;
  mono?: boolean;
  /** Accessible name; an empty string makes the mark decorative. */
  title?: string;
  className?: string;
}

/** The bracket seal. At 20px and below it switches to the pixel-snapped 16-grid drawing. */
export function Mark({ size = 24, mono, title = 'AgentLink', className }: MarkProps): ReactElement {
  const small = size <= 20;
  const a11y =
    title === ''
      ? { 'aria-hidden': 'true' as const }
      : { role: 'img' as const, 'aria-label': title };
  const seal = mono === true ? 'al-mark-ink' : 'al-mark-seal';
  if (small) {
    return (
      <svg
        className={cx('al-mark', className)}
        width={size}
        height={size}
        viewBox="0 0 16 16"
        {...a11y}
      >
        <path
          className="al-mark-ink"
          d="M1 1.5H5V3.5H3V12.5H5V14.5H1Z M15 1.5H11V3.5H13V12.5H11V14.5H15Z"
        />
        <path className={seal} d="M8 4.5L11.5 8L8 11.5L4.5 8Z" />
      </svg>
    );
  }
  return (
    <svg
      className={cx('al-mark', className)}
      width={(size * 38) / 36}
      height={size}
      viewBox="5 6 38 36"
      {...a11y}
    >
      <path
        className="al-mark-ink"
        d="M5 6H15.5V11H10V37H15.5V42H5Z M43 6H32.5V11H38V37H32.5V42H43Z"
      />
      <path className={seal} d="M24 15L33 24L24 33L15 24Z" />
    </svg>
  );
}

export interface WordmarkProps {
  height?: number;
  /** The live product name (in running text write the string instead of using the logo). */
  productName?: string;
  /** Hide from assistive tech when the name is already spoken next to it. */
  decorative?: boolean;
  className?: string;
}

/** The AgentLink name drawn from Geist Mono SemiBold outlines. */
export function Wordmark({
  height = 20,
  productName = 'AgentLink',
  decorative,
  className,
}: WordmarkProps): ReactElement {
  const a11y =
    decorative === true
      ? { 'aria-hidden': 'true' as const }
      : { role: 'img' as const, 'aria-label': productName };
  return (
    <svg
      className={cx('al-wordmark', className)}
      height={height}
      width={(height * WORDMARK.width) / WORDMARK.height}
      viewBox={`0 0 ${WORDMARK.width} ${WORDMARK.height}`}
      {...a11y}
    >
      <path transform={`translate(0 ${WORDMARK.baseline})`} d={WORDMARK.path} />
    </svg>
  );
}

export interface LockupProps {
  size?: number;
  layout?: 'horizontal' | 'stacked';
  /** "by 4thTech": only on the surfaces listed in the brand rules (11 §2). */
  endorsed?: boolean;
  mono?: boolean;
  productName?: string;
  className?: string;
}

/** Mark plus wordmark, optionally with the "by 4thTech" endorsement. */
export function Lockup({
  size = 24,
  layout = 'horizontal',
  endorsed,
  mono,
  productName = 'AgentLink',
  className,
}: LockupProps): ReactElement {
  return (
    <span
      className={cx(
        'al-lockup',
        `al-lockup-${layout}`,
        mono === true && 'al-lockup-mono',
        className,
      )}
      role="img"
      aria-label={endorsed === true ? `${productName} by 4thTech` : productName}
    >
      <Mark
        size={layout === 'stacked' ? size * 2 : size}
        title=""
        {...(mono === undefined ? {} : { mono })}
      />
      <span className="al-lockup-words">
        <Wordmark height={size * 0.82} decorative />
        {endorsed === true ? (
          <span className="al-lockup-by al-text-caption">by 4thTech</span>
        ) : null}
      </span>
    </span>
  );
}
