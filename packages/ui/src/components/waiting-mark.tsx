// UX2-e1: the waiting mark (B-11 §23.3, brand exception of owner decision 3.1). The AgentLink mark
// where only the diamond turns, about its own centre, and only while waiting for funds. Never used
// for any other loading state. Pure SVG, no inline style; the turn is CSS (progress.css).
import type { ReactElement } from 'react';
import { cx } from './util.js';

/** Never at 20 px or below: the pixel-snapped small drawing never turns (§23.3). */
export const WAITING_MARK_MIN_SIZE = 24;

export interface WaitingMarkProps {
  /** Height in px; default 40. Anything under the minimum is raised to it. */
  size?: number;
  /** False lets the current turn finish and the mark rest in its normal pose (§23.3 Stops). */
  active?: boolean;
  /** True while the tab is hidden: the turn pauses. */
  paused?: boolean;
  /** An accessible name. Left out, the mark is decorative: the step row is the status. */
  label?: string;
  className?: string;
}

/** The colour mark whose diamond turns a quarter turn every ambient cycle. Still with reduced motion. */
export function WaitingMark({
  size = 40,
  active = true,
  paused = false,
  label,
  className,
}: WaitingMarkProps): ReactElement {
  const h = Math.max(size, WAITING_MARK_MIN_SIZE);
  const a11y =
    label === undefined || label === ''
      ? { 'aria-hidden': 'true' as const }
      : { role: 'img' as const, 'aria-label': label };
  return (
    <svg
      className={cx('al-mark al-waiting-mark', active ? undefined : 'is-resting', className)}
      width={(h * 38) / 36}
      height={h}
      viewBox="5 6 38 36"
      data-paused={paused ? 'true' : undefined}
      {...a11y}
    >
      <path
        className="al-mark-ink"
        d="M5 6H15.5V11H10V37H15.5V42H5Z M43 6H32.5V11H38V37H32.5V42H43Z"
      />
      <path className="al-mark-seal al-waiting-diamond" d="M24 15L33 24L24 33L15 24Z" />
    </svg>
  );
}
