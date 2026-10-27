// UI-REFRESH-d (S1): live state and moments (B-11 §5, §6 rows 1, 3, 4, 7 to 10 and 13, §14, §15.1).
// - LiveDot: the six state shapes, each with a word and a tone (never colour alone); one soft pulse
//   when it arrives at Connected; Checking fills once and gives up after 4 s.
// - SuccessMoment: the once-only signature moments (approved check, proof stamp, safety codes
//   merging, file drop). A text line is always there; motion only adds to it.
// - CountBadge: the number, "99+" above 99, with a tick when the shown value changes.
// - useRowPresence: a new row slides in with a 1.2 s highlight; a leaving row collapses.
// - nudge: the one 4 px error nudge. useReducedMotion, useVisibilityPause: the two switches.
// Only opacity, transform and stroke-dashoffset move (the row-leave height collapse is the one named
// exception). Sequences use the Web Animations API; at most two moves at once. Durations and easings
// are read from the --al-* tokens (the highlight has no token yet and is a constant here). Amounts,
// codes and fingerprints never animate: only aria-hidden art moves, never text.
// The paid-action sheet (pay-confirm.tsx) is not touched; SuccessMoment mirrors its timing.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react';
import { cx } from './util.js';

// ---------------------------------------------------------------- helpers

/** The reduced-motion switch: the system setting, or the app's own `data-motion="reduced"`. */
function readReduced(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduced') {
    return true;
  }
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** True when motion is reduced (system setting or Settings, Appearance). Follows changes live. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(readReduced);
  useEffect(() => {
    const update = (): void => setReduced(readReduced());
    update();
    const mql =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    mql?.addEventListener?.('change', update);
    let observer: MutationObserver | null = null;
    if (typeof MutationObserver === 'function') {
      observer = new MutationObserver(update);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-motion'],
      });
    }
    return () => {
      mql?.removeEventListener?.('change', update);
      observer?.disconnect();
    };
  }, []);
  return reduced;
}

/** True while the tab is hidden: loops and polling pause (B-11 §6, performance). */
export function useVisibilityPause(): boolean {
  const [hidden, setHidden] = useState<boolean>(
    () => typeof document !== 'undefined' && document.hidden === true,
  );
  useEffect(() => {
    const update = (): void => setHidden(document.hidden === true);
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return hidden;
}

function token(name: string): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return '';
  }
}
/** A duration token in ms ("480ms" or "2s"), or the fallback when it cannot be read. */
function tokenMs(name: string, fallback: number): number {
  const m = /^([\d.]+)(ms|s)$/.exec(token(name));
  return m === null ? fallback : Number(m[1]) * (m[2] === 's' ? 1000 : 1);
}
/** An easing token, or the fallback (WAAPI needs the value, not var()). */
function tokenEase(name: string, fallback: string): string {
  const v = token(name);
  return v === '' ? fallback : v;
}
const EASE_STANDARD = 'cubic-bezier(0.2, 0, 0, 1)';
const EASE_ENTER = 'cubic-bezier(0, 0, 0, 1)';
const EASE_EXIT = 'cubic-bezier(0.3, 0, 1, 1)';
const EASE_EMPHASIZED = 'cubic-bezier(0.05, 0.7, 0.1, 1)';
/** The soft highlight on a new row (B-11 §6 row 3). No token yet. */
const HIGHLIGHT_MS = 1200;
/** Checking gives up after this long with no answer (B-11 §5). */
const CHECKING_MS = 4000;

/** One Web Animations call; nothing when motion is reduced or the element cannot animate. */
function play(
  el: Element | null | undefined,
  frames: Keyframe[],
  options: KeyframeAnimationOptions,
  reduced: boolean,
): Animation | null {
  if (reduced || el === null || el === undefined || typeof el.animate !== 'function') return null;
  return el.animate(frames, { fill: 'both', ...options });
}

/** The error nudge: one 4 px move sideways (B-11 §6 row 13). Presence failures do not call it. */
export function nudge(el: HTMLElement | null, reduced: boolean): void {
  play(
    el,
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(4px)', offset: 0.5 },
      { transform: 'translateX(0)' },
    ],
    {
      duration: tokenMs('--al-duration-fast', 120),
      easing: tokenEase('--al-easing-standard', EASE_STANDARD),
    },
    reduced,
  );
}

// ---------------------------------------------------------------- LiveDot

export const LIVE_DOT_STATES = [
  'checking',
  'connected',
  'reconnecting',
  'paused',
  'not-running',
  'needs-setup',
] as const;
export type LiveDotState = (typeof LIVE_DOT_STATES)[number];

const LIVE_DOT: Readonly<
  Record<LiveDotState, readonly [tone: string, shape: string, word: string]>
> = {
  checking: ['neutral', 'ring', 'Checking…'],
  connected: ['success', 'dot', 'Connected'],
  reconnecting: ['warning', 'half-ring', 'Reconnecting…'],
  paused: ['neutral', 'bars', 'Paused'],
  'not-running': ['warning', 'slash', 'Not running'],
  'needs-setup': ['accent', 'mark', 'Needs setup'],
};

export interface LiveDotProps {
  state: LiveDotState;
  /** Replaces the default word (for example "Agent connected"). */
  label?: string;
  className?: string;
}

/** A state shape, a word and a tone, in a polite live region. Never colour alone. */
export function LiveDot({ state, label, className }: LiveDotProps): ReactElement {
  const reduced = useReducedMotion();
  const hidden = useVisibilityPause();
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (state !== 'checking') return undefined;
    const t = setTimeout(() => setTimedOut(true), CHECKING_MS);
    return () => clearTimeout(t);
  }, [state]);
  const shown: LiveDotState = state === 'checking' && timedOut ? 'not-running' : state;
  const [tone, shape, word] = LIVE_DOT[shown] ?? LIVE_DOT['not-running'];

  const pulseRef = useRef<SVGCircleElement | null>(null);
  const arcRef = useRef<SVGCircleElement | null>(null);
  const prev = useRef<LiveDotState | null>(null);
  useEffect(() => {
    const was = prev.current;
    prev.current = shown;
    if (shown === 'connected' && was !== null && was !== 'connected') {
      // One soft pulse ring on arrival, then still. It is left to finish if the state changes.
      play(
        pulseRef.current,
        [
          { transform: 'scale(1)', opacity: 0.5 },
          { transform: 'scale(2.2)', opacity: 0 },
        ],
        {
          duration: tokenMs('--al-duration-moment', 480),
          easing: tokenEase('--al-easing-enter', EASE_ENTER),
        },
        reduced,
      );
    }
    if (shown === 'checking' && was !== 'checking') {
      // The ring fills once over the four seconds it waits.
      play(
        arcRef.current,
        [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }],
        { duration: CHECKING_MS, easing: 'linear' },
        reduced,
      );
    }
    // The animations are not cancelled on a state change: they finish on their own.
  }, [shown, reduced]);

  return (
    <span
      className={cx('al-livedot', `al-tone-${tone}`, className)}
      data-state={shown}
      data-paused={hidden ? '' : undefined}
      role="status"
      aria-live="polite"
    >
      <svg
        className="al-ld-shape"
        data-shape={shape}
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
        focusable="false"
      >
        {shape === 'ring' ? (
          <>
            <circle cx="8" cy="8" r="5" opacity="0.4" />
            <circle
              ref={arcRef}
              className="al-ld-arc"
              cx="8"
              cy="8"
              r="5"
              pathLength={1}
              strokeDasharray="1"
              strokeDashoffset={reduced ? 0 : 1}
            />
          </>
        ) : null}
        {shape === 'dot' ? (
          <>
            <circle ref={pulseRef} className="al-ld-pulse" cx="8" cy="8" r="4" opacity="0" />
            <circle cx="8" cy="8" r="4" fill="currentColor" stroke="none" />
          </>
        ) : null}
        {shape === 'half-ring' ? (
          <g className="al-ld-spin">
            <path d="M8 3a5 5 0 0 1 0 10" strokeLinecap="round" />
          </g>
        ) : null}
        {shape === 'bars' ? (
          <>
            <rect x="4.75" y="4" width="2" height="8" rx="0.5" fill="currentColor" stroke="none" />
            <rect x="9.25" y="4" width="2" height="8" rx="0.5" fill="currentColor" stroke="none" />
          </>
        ) : null}
        {shape === 'slash' ? (
          <>
            <circle cx="8" cy="8" r="4.5" />
            <path d="M4.8 11.2L11.2 4.8" strokeLinecap="round" />
          </>
        ) : null}
        {shape === 'mark' ? (
          <>
            <circle cx="8" cy="8" r="5" />
            <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
          </>
        ) : null}
      </svg>
      <span className="al-ld-word al-text-label">{label ?? word}</span>
    </span>
  );
}

// ---------------------------------------------------------------- SuccessMoment

export type SuccessKind = 'approved' | 'proof' | 'codes' | 'file';

const MOMENT: Readonly<Record<SuccessKind, string>> = {
  approved: 'Approved',
  proof: 'Proof recorded',
  codes: 'Codes match',
  file: 'File received',
};

export interface SuccessMomentProps {
  kind: SuccessKind;
  /** Replaces the default text line. */
  label?: string;
  className?: string;
}

const CHECK_PATH = 'M3.5 8.5l3 3 6-7';

/** The end of something the person did or waited for: plays once, always with a text line. */
export function SuccessMoment({ kind, label, className }: SuccessMomentProps): ReactElement | null {
  const reduced = useReducedMotion();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const known = kind in MOMENT;
  useEffect(() => {
    const root = rootRef.current;
    if (root === null || !known) return;
    const part = (n: string): Element | null => root.querySelector(`[data-a="${n}"]`);
    const moment = tokenMs('--al-duration-moment', 480);
    const slow = tokenMs('--al-duration-slow', 320);
    const emphasized = tokenEase('--al-easing-emphasized', EASE_EMPHASIZED);
    const enter = tokenEase('--al-easing-enter', EASE_ENTER);
    const standard = tokenEase('--al-easing-standard', EASE_STANDARD);
    if (kind === 'approved') {
      // The check draws itself and the card settles 4 px: two moves.
      play(
        part('draw'),
        [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }],
        { duration: moment, easing: standard },
        reduced,
      );
      play(
        part('art'),
        [{ transform: 'translateY(-4px)' }, { transform: 'translateY(0)' }],
        { duration: moment, easing: standard },
        reduced,
      );
    } else if (kind === 'proof') {
      // The stamp starts 6% larger and settles while its ring fades in: two moves.
      play(
        part('art'),
        [{ transform: 'scale(1.06)' }, { transform: 'scale(1)' }],
        { duration: slow, easing: enter },
        reduced,
      );
      play(
        part('ring'),
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: slow, easing: enter },
        reduced,
      );
    } else if (kind === 'codes') {
      // The two code blocks slide together and give way to one check mark: two moves.
      const frames = (from: string): Keyframe[] => [
        { transform: `translateX(${from})`, opacity: 1 },
        { transform: 'translateX(0)', opacity: 1, offset: 0.7 },
        { transform: 'translateX(0)', opacity: 0 },
      ];
      play(part('left'), frames('-12px'), { duration: moment, easing: emphasized }, reduced);
      play(part('right'), frames('12px'), { duration: moment, easing: emphasized }, reduced);
    } else {
      // The file icon drops 6 px into the folder: one move.
      play(
        part('art'),
        [
          { transform: 'translateY(-6px)', opacity: 0 },
          { transform: 'translateY(0)', opacity: 1 },
        ],
        { duration: slow, easing: enter },
        reduced,
      );
    }
  }, [kind, known, reduced]);

  if (!known) return null;
  return (
    <span
      ref={rootRef}
      className={cx('al-moment', className)}
      data-kind={kind}
      data-motion={reduced ? 'reduced' : 'full'}
      role="status"
      aria-live="polite"
    >
      <span className="al-moment-art" aria-hidden="true">
        {kind === 'approved' ? (
          <svg
            data-a="art"
            width="20"
            height="20"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            focusable="false"
          >
            <path data-a="draw" d={CHECK_PATH} pathLength={1} strokeDasharray="1" />
          </svg>
        ) : null}
        {kind === 'proof' ? (
          <svg
            data-a="art"
            width="20"
            height="20"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            focusable="false"
          >
            <circle data-a="ring" cx="8" cy="8" r="6.5" />
            <path d={CHECK_PATH} />
          </svg>
        ) : null}
        {kind === 'codes' ? (
          <>
            <svg
              width="20"
              height="20"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              focusable="false"
            >
              <path d={CHECK_PATH} />
            </svg>
            <span className="al-moment-code al-moment-left" data-a="left" />
            <span className="al-moment-code al-moment-right" data-a="right" />
          </>
        ) : null}
        {kind === 'file' ? (
          <svg
            data-a="art"
            width="20"
            height="20"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            focusable="false"
          >
            <path d="M4 2.5h5l3 3v8H4z" />
            <path d="M9 2.5v3h3" />
          </svg>
        ) : null}
      </span>
      <span className="al-moment-text al-text-body-sm">{label ?? MOMENT[kind]}</span>
    </span>
  );
}

// ---------------------------------------------------------------- CountBadge

export interface CountBadgeProps {
  count: number;
  /** For screen readers, for example "new messages". The number is read first. */
  label?: string;
  className?: string;
}

/** The number in a badge; "99+" above 99; ticks (old slides up, new comes in) when it changes. */
export function CountBadge({ count, label, className }: CountBadgeProps): ReactElement | null {
  const reduced = useReducedMotion();
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const shown = n > 99 ? '99+' : String(n);
  const last = useRef(shown);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [prevShown, setPrevShown] = useState(shown);
  if (prevShown !== shown) {
    setPrevShown(shown);
    setLeaving(reduced || n === 0 ? null : last.current);
  }
  last.current = shown;
  const inRef = useRef<HTMLSpanElement | null>(null);
  const outRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (leaving === null) return;
    const duration = tokenMs('--al-duration-base', 200);
    play(
      inRef.current,
      [
        { transform: 'translateY(60%)', opacity: 0 },
        { transform: 'translateY(0)', opacity: 1 },
      ],
      { duration, easing: tokenEase('--al-easing-enter', EASE_ENTER) },
      reduced,
    );
    const out = play(
      outRef.current,
      [
        { transform: 'translateY(0)', opacity: 1 },
        { transform: 'translateY(-60%)', opacity: 0 },
      ],
      { duration, easing: tokenEase('--al-easing-exit', EASE_EXIT) },
      reduced,
    );
    if (out === null) {
      setLeaving(null);
      return;
    }
    out.onfinish = () => setLeaving(null);
  }, [leaving, reduced]);
  if (n === 0) return null;
  return (
    <span
      className={cx('al-count', className)}
      aria-label={label === undefined ? undefined : `${shown} ${label}`}
    >
      <span
        ref={inRef}
        className="al-count-in"
        aria-hidden={label === undefined ? undefined : 'true'}
      >
        {shown}
      </span>
      {leaving === null ? null : (
        <span ref={outRef} className="al-count-out" aria-hidden="true">
          {leaving}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- useRowPresence

export interface RowPresenceOptions {
  /** The row is a live insert: it enters (and is highlighted) when it first mounts. */
  isNew?: boolean | undefined;
  /** Called once the row has left. */
  onGone?: (() => void) | undefined;
}

export interface RowPresence<T extends HTMLElement> {
  ref: RefObject<T | null>;
  /** Render the row while this is true (it stays true during the leave motion). */
  mounted: boolean;
}

/**
 * A row that arrives (slides down 8 px, fades in, 1.2 s highlight) and leaves (fades, collapses its
 * height). Leaving then coming back reverses the motion from where it is.
 */
export function useRowPresence<T extends HTMLElement>(
  present: boolean,
  options: RowPresenceOptions = {},
): RowPresence<T> {
  const reduced = useReducedMotion();
  const ref = useRef<T | null>(null);
  const [prevPresent, setPrevPresent] = useState(present);
  const [leaving, setLeaving] = useState(false);
  if (prevPresent !== present) {
    setPrevPresent(present);
    if (!present && !reduced) setLeaving(true);
  }
  const first = useRef(true);
  const was = useRef(present);
  const leave = useRef<Animation | null>(null);
  const live = useRef({ present, onGone: options.onGone });
  live.current = { present, onGone: options.onGone };

  useLayoutEffect(() => {
    const isFirst = first.current;
    const before = was.current;
    first.current = false;
    was.current = present;
    const el = ref.current;
    if (present) {
      if (leave.current !== null) {
        leave.current.reverse(); // interrupted: continue from where it is, no restart
        return;
      }
      const entering = isFirst ? options.isNew === true : !before;
      if (!entering || el === null) return;
      el.classList.add('al-row-presence');
      play(
        el,
        [
          { opacity: 0, transform: 'translateY(-8px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        {
          duration: tokenMs('--al-duration-base', 200),
          easing: tokenEase('--al-easing-enter', EASE_ENTER),
        },
        reduced,
      );
      if (!reduced && typeof el.animate === 'function') {
        const hl = document.createElement('span');
        hl.className = 'al-row-hl';
        hl.setAttribute('aria-hidden', 'true');
        el.append(hl);
        const a = play(
          hl,
          [{ opacity: 0.7 }, { opacity: 0 }],
          { duration: HIGHLIGHT_MS, easing: 'linear' },
          reduced,
        );
        if (a === null) hl.remove();
        else a.onfinish = () => hl.remove();
      }
      return;
    }
    if (isFirst || !before) return;
    // The row has just left.
    if (reduced || el === null) {
      setLeaving(false);
      live.current.onGone?.();
      return;
    }
    const height = el.offsetHeight;
    el.style.overflow = 'hidden';
    const anim = play(
      el,
      [
        { height: `${height}px`, opacity: 1 },
        { height: '0px', opacity: 0 },
      ],
      {
        duration: tokenMs('--al-duration-base', 200),
        easing: tokenEase('--al-easing-exit', EASE_EXIT),
      },
      false,
    );
    if (anim === null) {
      setLeaving(false);
      live.current.onGone?.();
      return;
    }
    leave.current = anim;
    anim.onfinish = () => {
      leave.current = null;
      setLeaving(false);
      if (live.current.present) {
        anim.cancel(); // it came back: drop the held collapse
        el.style.overflow = '';
      } else {
        live.current.onGone?.();
      }
    };
  }, [present]);

  return { ref, mounted: present || leaving };
}
