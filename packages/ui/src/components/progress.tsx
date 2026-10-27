// UI-REFRESH-c (S1): the progress and state components of B-11 §15.1 to §15.3. ProgressBar
// (determinate, stepped, indeterminate), RingMeter, Skeleton, InlineError and the timing hook of
// §15.2. Every one has a word, an accessible name and no colour-only meaning. Fills move by
// `stroke-dashoffset` on SVG shapes, so there is no inline style (08 §4) and only a transform,
// opacity or dash offset ever animates (motion lint). Styles: `@4thtech-io/ui/progress.css`.
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Icon } from './brand.js';
import { cx } from './util.js';

/** Words the components say themselves; the caller supplies the job-specific words. */
export const PROGRESS_STRINGS = {
  loading: 'Loading…',
  done: 'Done',
  error: 'Something went wrong. Try again.',
} as const;

/** §15.2: nothing under 400 ms. */
export const PROGRESS_DELAY_MS = 400;
/** §15.2: once shown, an indicator stays at least 500 ms. */
export const PROGRESS_MIN_SHOWN_MS = 500;

/**
 * Whether to show an indicator for `active` work: false until `active` has lasted `delayMs`
 * (default 400), and once true it stays at least `minMs` (default 500) after it began.
 */
export function useDelayedShow(
  active: boolean,
  delayMs: number = PROGRESS_DELAY_MS,
  minMs: number = PROGRESS_MIN_SHOWN_MS,
): boolean {
  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    if (active && !shown) {
      const t = setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, delayMs);
      return () => clearTimeout(t);
    }
    if (!active && shown) {
      const left = Math.max(0, minMs - (Date.now() - shownAt.current));
      const t = setTimeout(() => setShown(false), left);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [active, shown, delayMs, minMs]);
  return shown;
}

/** True while the tab is hidden: loops pause then (`data-paused`, progress.css). */
function useTabHidden(): boolean {
  const read = (): boolean => typeof document !== 'undefined' && document.hidden;
  const [hidden, setHidden] = useState(read);
  useEffect(() => {
    const on = (): void => setHidden(read());
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return hidden;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
/** The dash offset that leaves `fraction` of a 100-long path drawn. */
const offset = (fraction: number): string =>
  String(Math.round((1 - clamp(fraction, 0, 1)) * 10000) / 100);

export interface InlineErrorProps {
  /** One action, for example a "Try again" button. */
  action?: ReactNode;
  /** One sentence that says what to do. */
  children?: ReactNode;
}

/** A red edge, an icon and one sentence (§15.1 Error). One 4 px nudge on arrival. */
export function InlineError({ action, children }: InlineErrorProps): ReactElement {
  return (
    <div className="al-inline-error" role="alert">
      <Icon name="circle-alert" size={16} />
      <span className="al-text-body">{children}</span>
      {action === undefined ? null : <span className="al-inline-error-act">{action}</span>}
    </div>
  );
}

/** One horizontal bar: the track is CSS, the fill is a dashed SVG line. */
function BarFill({ fraction }: { fraction: number }): ReactElement {
  return (
    <svg
      className="al-pb-svg"
      viewBox="0 0 100 4"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <line
        className="al-pb-fill"
        x1="0"
        y1="2"
        x2="100"
        y2="2"
        pathLength="100"
        strokeDasharray="100"
        strokeDashoffset={offset(fraction)}
      />
    </svg>
  );
}

export interface ProgressBarProps {
  /** The word: what is happening ("Sending report.pdf to Marko"). Also the accessible name. */
  label: string;
  /** The amount after the label ("2.1 of 8 MB · about 20 s"). Never invented. */
  amount?: string;
  /** Determinate: the amount done, from 0 to `max`. */
  value?: number;
  max?: number;
  /** Amount unknown: a soft segment glides. Never shows a percentage. */
  indeterminate?: boolean;
  /** Stepped: up to four named steps (the rest are dropped). */
  steps?: readonly string[];
  /** Stepped: the index of the current step; `steps.length` means all done. */
  current?: number;
  state?: 'active' | 'done' | 'error';
  /** With `state="error"`: one sentence that says what to do. */
  error?: ReactNode;
  /** Apply the 400 ms rule: render nothing until the bar has been wanted for 400 ms. */
  delayed?: boolean;
}

/** Determinate, stepped or indeterminate progress (§15.1) with its word and amount. */
export function ProgressBar({
  label,
  amount,
  value = 0,
  max = 100,
  indeterminate = false,
  steps,
  current = 0,
  state = 'active',
  error,
  delayed = false,
}: ProgressBarProps): ReactElement | null {
  const shown = useDelayedShow(delayed);
  const hidden = useTabHidden();
  if (delayed && !shown) return null;

  const stepList = steps === undefined ? undefined : steps.slice(0, 4);
  const stepped = stepList !== undefined && stepList.length > 0;
  const total = stepList?.length ?? 0;
  const at = clamp(Math.floor(current), 0, total);
  const safeMax = max > 0 ? max : 100;
  const now = clamp(value, 0, safeMax);
  const isError = state === 'error';
  const isDone = isError
    ? false
    : stepped
      ? state === 'done' || at >= total
      : state === 'done' || (!indeterminate && now >= safeMax);
  const kind = stepped ? 'stepped' : indeterminate ? 'indeterminate' : 'determinate';
  const fraction = isDone ? 1 : now / safeMax;

  const values: Record<string, string | number | boolean | undefined> = {};
  if (stepped) {
    values['aria-valuemin'] = 1;
    values['aria-valuemax'] = total;
    values['aria-valuenow'] = Math.min(at + 1, total);
    values['aria-valuetext'] = isDone
      ? PROGRESS_STRINGS.done
      : `Step ${Math.min(at + 1, total)} of ${total}: ${stepList[Math.min(at, total - 1)]}`;
  } else if (!indeterminate || isDone) {
    values['aria-valuemin'] = 0;
    values['aria-valuemax'] = safeMax;
    values['aria-valuenow'] = isDone ? safeMax : now;
  } else {
    values['aria-busy'] = true;
  }

  return (
    <div
      className={cx('al-pb', `is-${kind}`, isDone && 'is-done', isError && 'is-error')}
      data-paused={hidden ? 'true' : undefined}
    >
      <div className="al-pb-head" role="status" aria-live="polite">
        <span className="al-pb-label al-text-body">{label}</span>
        {isDone ? (
          <span className="al-pb-state">
            <Icon name="check" size={14} />
            {PROGRESS_STRINGS.done}
          </span>
        ) : null}
        {amount === undefined ? null : (
          <span className="al-pb-amount al-text-caption">{amount}</span>
        )}
      </div>
      <div
        className={cx('al-pb-track', stepped && 'is-stepped')}
        role="progressbar"
        aria-label={label}
        aria-invalid={isError ? true : undefined}
        {...values}
      >
        {stepped ? (
          <ol className="al-pb-steps">
            {stepList.map((name, i) => {
              const stepState =
                isError && i === at
                  ? 'error'
                  : i < at || isDone
                    ? 'done'
                    : i === at
                      ? 'current'
                      : 'todo';
              const own =
                stepState === 'current' && value > 0 ? now / safeMax : stepState === 'done' ? 1 : 0;
              return (
                <li
                  key={name}
                  className={cx(
                    'al-pb-step',
                    stepState === 'current' && value <= 0 && 'is-unknown',
                  )}
                  data-state={stepState}
                  aria-current={stepState === 'current' ? 'step' : undefined}
                >
                  <span className="al-pb-seg">
                    <BarFill fraction={own} />
                  </span>
                  {name}
                </li>
              );
            })}
          </ol>
        ) : indeterminate && !isDone ? (
          <span className="al-pb-seg-glide" />
        ) : (
          <BarFill fraction={fraction} />
        )}
      </div>
      {isError ? <InlineError>{error ?? PROGRESS_STRINGS.error}</InlineError> : null}
    </div>
  );
}

export interface RingMeterProps {
  /** The accessible name ("Credits", "Time left"). */
  label: string;
  value: number;
  max: number;
  /** The word beside the ring ("$4.80, about 48 proofs"); also the spoken value. */
  text: string;
  /** A countdown: the arc is what is left, and turns urgent at a fifth. */
  countdown?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** A number or icon in the middle. */
  children?: ReactNode;
}

/** A quantity against a limit, or a time left (§15.1 Ring meter). */
export function RingMeter({
  label,
  value,
  max,
  text,
  countdown = false,
  size = 'md',
  children,
}: RingMeterProps): ReactElement {
  const safeMax = max > 0 ? max : 1;
  const now = clamp(value, 0, safeMax);
  const fraction = now / safeMax;
  return (
    <div
      className={cx(
        'al-ring',
        `is-${size}`,
        countdown && 'is-countdown',
        countdown && fraction <= 0.2 && 'is-low',
      )}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={now}
      aria-valuetext={text}
    >
      <span className="al-ring-dial">
        <svg viewBox="0 0 36 36" aria-hidden="true" focusable="false">
          <circle className="al-ring-track" cx="18" cy="18" r="16" />
          <circle
            className="al-ring-fill"
            cx="18"
            cy="18"
            r="16"
            pathLength="100"
            strokeDasharray="100"
            strokeDashoffset={offset(fraction)}
          />
        </svg>
        {children === undefined ? null : <span className="al-ring-center">{children}</span>}
      </span>
      <span className="al-ring-text al-text-caption">{text}</span>
    </div>
  );
}

export interface SkeletonProps {
  loading: boolean;
  /** Spoken for screen readers while the blocks show. */
  label?: string;
  /** Text lines to draw. */
  lines?: number;
  className?: string;
  /** The real content, shown when loading ends. */
  children?: ReactNode;
}

/**
 * Grey blocks in the shape of the coming content (§15.1). Nothing for 400 ms; once shown at least
 * 500 ms; the content then replaces it with a 120 ms fade.
 */
export function Skeleton({
  loading,
  label = PROGRESS_STRINGS.loading,
  lines = 3,
  className,
  children,
}: SkeletonProps): ReactElement | null {
  const shown = useDelayedShow(loading);
  const hidden = useTabHidden();
  const wasShown = useRef(false);
  if (shown) wasShown.current = true;
  if (shown) {
    return (
      <div
        key="skeleton"
        className={cx('al-skeleton', className)}
        role="status"
        aria-busy="true"
        data-paused={hidden ? 'true' : undefined}
      >
        {Array.from({ length: clamp(Math.floor(lines), 1, 12) }, (_, i) => (
          <span key={i} className="al-skeleton-line" aria-hidden="true" />
        ))}
        <span className="al-sr-only">{label}</span>
      </div>
    );
  }
  if (loading) return null;
  return (
    <div
      key="content"
      className={cx('al-skeleton-content', wasShown.current && 'al-skeleton-reveal')}
    >
      {children}
    </div>
  );
}
