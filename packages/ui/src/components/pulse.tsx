// W4-MOTION-KIT (S0): the live-dot pulse (W4 UX v2: "a status dot that pulses while Working";
// prototype v23 `.al-pulse`). A dot in a status tone, with a ring that grows out and fades
// (transform and opacity, motion.css). The ring is not drawn when the pulse is inactive or motion is
// reduced (system setting or the app's data-motion), and it pauses while the tab is hidden. The dot
// is decorative: the caller always says the state in words next to it (never colour alone).
import type { ReactElement } from 'react';
import { useReducedMotion, useVisibilityPause } from './motion.js';
import { cx } from './util.js';

export type PulseTone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral';

export interface PulseProps {
  /** The status tone of the dot (default success: working). */
  tone?: PulseTone;
  /** Pulse while true (default); a still dot when false. */
  active?: boolean;
  className?: string;
}

/** A status dot that pulses while something is live. Pair it with a word. */
export function Pulse({ tone = 'success', active = true, className }: PulseProps): ReactElement {
  const reduced = useReducedMotion();
  const hidden = useVisibilityPause();
  return (
    <span className={cx('al-pulse', className)} data-tone={tone} aria-hidden="true">
      <span className="al-pulse-dot" />
      {active && !reduced ? (
        <span className="al-pulse-ring" data-paused={hidden ? 'true' : undefined} />
      ) : null}
    </span>
  );
}
