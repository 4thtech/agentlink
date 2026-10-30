// W4-MOTION-KIT (S0): skeletons in the shape of the real layouts (W4 UX v2, "Loading": nothing under
// ~300 ms, skeletons matching the real layout up to ~10 s; prototype v23 `.al-skel`). The shapes are
// the people row (40 px avatar, two lines), the agent card (44 px avatar, two lines and a pill), the
// bordered list and the pro table. Sizes come from classes and data attributes, never an inline style
// (08 §4 CSP). The shimmer is opacity only and holds still under reduced motion (motion.css). The
// older single-block `Skeleton` of progress.tsx (B-11 §15.1) stays for its current callers.
import { useRef, type ReactElement, type ReactNode } from 'react';
import { PROGRESS_MIN_SHOWN_MS, PROGRESS_STRINGS, useDelayedShow } from './progress.js';
import { cx } from './util.js';

/** Nothing for this long; then the skeleton (W4 UX v2). */
export const SKELETON_DELAY_MS = 300;

/** Line widths, as a share of the row, or a fixed width for a label, a heading or a button. */
export type SkeletonWidth = 30 | 40 | 55 | 65 | 70 | 100 | 'label' | 'heading' | 'button';
/** Line heights: caption 12, body 14, pill 24, title 30, control 44 px. */
export type SkeletonSize = 'caption' | 'body' | 'pill' | 'title' | 'control';

export interface SkeletonLineProps {
  width?: SkeletonWidth;
  size?: SkeletonSize;
  className?: string;
}

/** One grey line. */
export function SkeletonLine({
  width = 100,
  size = 'body',
  className,
}: SkeletonLineProps): ReactElement {
  return (
    <span
      className={cx('al-skel', 'al-skel-line', className)}
      data-w={String(width)}
      data-size={size}
      aria-hidden="true"
    />
  );
}

/** A round avatar placeholder. */
export function SkeletonAvatar({ size = 40 }: { size?: 40 | 44 }): ReactElement {
  return <span className="al-skel al-skel-avatar" data-size={String(size)} aria-hidden="true" />;
}

/** A person or conversation row: avatar, name, one line of detail. */
export function SkeletonRow({ className }: { className?: string }): ReactElement {
  return (
    <div className={cx('al-skel-row', className)} aria-hidden="true">
      <SkeletonAvatar size={40} />
      <span className="al-skel-col">
        <SkeletonLine width={40} size="body" />
        <SkeletonLine width={65} size="caption" />
      </span>
    </div>
  );
}

/** An agent card: avatar, name, state, and the action pill. */
export function SkeletonCard({ className }: { className?: string }): ReactElement {
  return (
    <div className={cx('al-skel-card', className)} aria-hidden="true">
      <SkeletonAvatar size={44} />
      <span className="al-skel-col">
        <SkeletonLine width={30} size="body" />
        <SkeletonLine width={55} size="caption" />
        <SkeletonLine width={70} size="pill" />
      </span>
    </div>
  );
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Number.isFinite(n) ? Math.floor(n) : lo));

/** A bordered list of rows (Home, People, Activity). */
export function SkeletonList({
  rows = 3,
  className,
}: {
  rows?: number;
  className?: string;
}): ReactElement {
  return (
    <div className={cx('al-skel-list', className)} aria-hidden="true">
      {Array.from({ length: clamp(rows, 1, 12) }, (_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}

/** A table (the pro views): a header row, then `rows` rows of `columns` cells (2 to 7). */
export function SkeletonTable({
  rows = 5,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}): ReactElement {
  const cols = clamp(columns, 2, 7);
  const line = (head: boolean, c: number): ReactElement => (
    <SkeletonLine key={c} width={head ? 55 : c === 0 ? 70 : 55} size="caption" />
  );
  return (
    <div className={cx('al-skel-table', className)} data-cols={String(cols)} aria-hidden="true">
      <div className="al-skel-trow al-skel-thead">
        {Array.from({ length: cols }, (_, c) => line(true, c))}
      </div>
      {Array.from({ length: clamp(rows, 1, 20) }, (_, r) => (
        <div key={r} className="al-skel-trow">
          {Array.from({ length: cols }, (_, c) => line(false, c))}
        </div>
      ))}
    </div>
  );
}

export interface SkeletonGateProps {
  loading: boolean;
  /** The skeleton in the shape of the coming content. */
  skeleton: ReactNode;
  /** Spoken while the skeleton shows. */
  label?: string;
  /** Wait this long before showing anything (default 300 ms). */
  delayMs?: number;
  children?: ReactNode;
}

/**
 * Nothing while loading is short; after `delayMs` the skeleton as a busy status (at least 500 ms once
 * shown); then the content, with a short fade only if a skeleton was on screen.
 */
export function SkeletonGate({
  loading,
  skeleton,
  label = PROGRESS_STRINGS.loading,
  delayMs = SKELETON_DELAY_MS,
  children,
}: SkeletonGateProps): ReactElement | null {
  const shown = useDelayedShow(loading, delayMs, PROGRESS_MIN_SHOWN_MS);
  const wasShown = useRef(false);
  if (shown) {
    wasShown.current = true;
    return (
      <div key="skeleton" className="al-skel-gate" role="status" aria-busy="true">
        {skeleton}
        <span className="al-visually-hidden">{label}</span>
      </div>
    );
  }
  if (loading) return null;
  if (!wasShown.current) return <>{children}</>;
  return (
    <div key="content" className="al-skel-reveal">
      {children}
    </div>
  );
}
