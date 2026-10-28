// The activity pulse for list rows (UX2-f2; b11 §24; decision 4.1, D-137): a shaped marker and word
// (Active now, Today, Quiet) and a 47 x 16 px pulse of the last 24 hours. Counts and times only; the
// page never shows a message here. Active now is a static filled dot; when a row becomes Active now
// its dot plays one ring at the moment duration, once, and never under reduced motion.
import { Segmented, useReducedMotion } from '@4thtech-io/ui';
import { useEffect, useId, useRef, type ReactElement } from 'react';
import { setPref, usePrefs, type ActivitySortPref } from '../../prefs/index.js';
import { BUCKETS, barHeights, pulseSummary, totalOf, type Activity, type Pulse } from './data.js';
import './pulse.css';
import { PULSE_STRINGS as S } from './strings.js';

export { usePulse, type PulseState } from './use-pulse.js';
export * from './data.js';
export { PULSE_STRINGS } from './strings.js';

const WORD: Readonly<Record<Activity, string>> = {
  active_now: S.activeNow,
  today: S.today,
  quiet: S.quiet,
};
const FLAT: readonly number[] = Array.from({ length: BUCKETS }, () => 0);

/**
 * What to show for one contact. A contact the answer does not list is Quiet with a flat pulse, unless
 * the answer is partial (then it is unknown: no word). No answer at all: no word, a flat pulse.
 */
export function activityOf(pulse: Pulse | undefined, id: string): Activity | undefined {
  if (pulse === undefined) return undefined;
  const found = pulse.contacts.get(id);
  if (found !== undefined) return found.activity;
  return pulse.partial ? undefined : 'quiet';
}

/** The sort key for "Most active": a contact without a read counts zero, with its own last time. */
export function sortKey(
  pulse: Pulse | undefined,
  id: string,
  fallbackAt: number,
): { total: number; lastAt: number } {
  const found = pulse?.contacts.get(id);
  return found === undefined
    ? { total: 0, lastAt: fallbackAt }
    : { total: totalOf(found.counts), lastAt: found.lastAt };
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const SHORT_DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

/** The last-message time (b11 §24.2 fallback): the clock time today, the short date otherwise. */
function timeText(at: number): string {
  const d = new Date(at * 1000);
  return d.toDateString() === new Date().toDateString() ? TIME.format(d) : SHORT_DAY.format(d);
}

function tokenMs(name: string, fallback: number): number {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const m = /^([\d.]+)(ms|s)$/.exec(raw);
    return m === null ? fallback : Number(m[1]) * (m[2] === 's' ? 1000 : 1);
  } catch {
    return fallback;
  }
}
function tokenEase(name: string, fallback: string): string {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return raw === '' ? fallback : raw;
  } catch {
    return fallback;
  }
}

function Marker({ activity, arrival }: { activity: Activity; arrival: number }): ReactElement {
  const reduced = useReducedMotion();
  const ring = useRef<SVGCircleElement | null>(null);
  const reducedNow = useRef(reduced);
  reducedNow.current = reduced;
  useEffect(() => {
    if (arrival === 0 || reducedNow.current) return;
    const el = ring.current;
    if (el === null || typeof el.animate !== 'function') return;
    // One ring grows from 1x to 2x and fades. A single run: no iterations, no loop.
    el.animate(
      [
        { transform: 'scale(1)', opacity: 0.5 },
        { transform: 'scale(2)', opacity: 0 },
      ],
      {
        duration: tokenMs('--al-duration-moment', 480),
        easing: tokenEase('--al-easing-enter', 'cubic-bezier(0, 0, 0, 1)'),
        fill: 'both',
      },
    );
  }, [arrival]);
  const shape = activity === 'active_now' ? 'dot' : activity === 'today' ? 'ring' : 'none';
  return (
    <svg
      className="act-marker"
      data-shape={shape}
      width="8"
      height="8"
      viewBox="0 0 8 8"
      aria-hidden="true"
      focusable="false"
    >
      {shape === 'dot' ? (
        <>
          <circle ref={ring} className="act-ring-pulse" cx="4" cy="4" r="3" />
          <circle className="act-dot" cx="4" cy="4" r="4" />
        </>
      ) : null}
      {shape === 'ring' ? <circle className="act-ring" cx="4" cy="4" r="3.25" /> : null}
    </svg>
  );
}

/** The 12 bars, one image named by the count in words (b11 §24.2). */
export function Spark({ counts }: { counts: readonly number[] }): ReactElement {
  const heights = barHeights(counts);
  return (
    <svg
      className="act-spark"
      role="img"
      aria-label={pulseSummary(counts)}
      width="47"
      height="16"
      viewBox="0 0 47 16"
    >
      {heights.map((h, i) => (
        <rect
          key={i}
          className={`act-bar${(counts[i] ?? 0) === 0 ? ' is-empty' : ''}${i === BUCKETS - 1 ? ' is-now' : ''}`}
          x={i * 4}
          y={16 - h}
          width="3"
          height={h}
        />
      ))}
    </svg>
  );
}

export interface ActivityCellProps {
  readonly pulse: Pulse | undefined;
  readonly contactId: string;
  /** Non-zero when this row just became Active now (the read's number). */
  readonly arrival: number;
  /** The last-message time (unix seconds) the list already has; shown when the read gives no word. */
  readonly fallbackAt?: number;
}

/** `marker · word · pulse` for one row. */
export function ActivityCell({
  pulse,
  contactId,
  arrival,
  fallbackAt,
}: ActivityCellProps): ReactElement {
  const activity = activityOf(pulse, contactId);
  const counts = pulse?.contacts.get(contactId)?.counts ?? FLAT;
  return (
    <span className="act-cell">
      {activity === undefined ? (
        <span className="act-status">
          {fallbackAt === undefined || fallbackAt <= 0 ? null : (
            <span className="act-time al-text-body-sm">{timeText(fallbackAt)}</span>
          )}
        </span>
      ) : (
        <span className="act-status" data-activity={activity}>
          <Marker activity={activity} arrival={arrival} />
          <span className="act-word al-text-body-sm">{WORD[activity]}</span>
        </span>
      )}
      <Spark counts={counts} />
    </span>
  );
}

/** Recent (the default) or Most active, remembered in this browser. */
export function ActivitySort(): ReactElement {
  const { activitySort } = usePrefs();
  const labelId = useId();
  return (
    <div className="act-sort">
      <span id={labelId} className="al-text-body-sm al-muted">
        {S.sortLabel}
      </span>
      <Segmented
        label={S.sortLabel}
        labelledBy={labelId}
        value={activitySort}
        onChange={(v) =>
          setPref('activitySort', (v === 'active' ? 'active' : 'recent') as ActivitySortPref)
        }
        options={[
          { value: 'recent', label: S.recent },
          { value: 'active', label: S.mostActive },
        ]}
      />
    </div>
  );
}
