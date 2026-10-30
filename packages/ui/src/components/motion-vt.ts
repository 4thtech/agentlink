// W4-MOTION-KIT (S0): same-document View Transitions (W4 UX v2, "Motion and perceived speed";
// prototype v23). Page changes and the simple-to-pro morph run inside `document.startViewTransition`;
// the fixed regions carry their names by class (VT_CLASS) and one shared element at a time carries
// `data-vt-shared` (person row to conversation). Names are set by class and attribute only, never an
// inline style (08 §4 CSP). Interruptible: a new transition skips the running one. Graceful: without
// the API, or when it throws, the update runs at once and nothing waits; `.al-route` then enters with
// a CSS fade-up (motion.css, `@supports not`). Reduced motion keeps the transition and the stylesheet
// turns every move into a fade (both the system setting and the app's `data-motion`).
import { useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';

/** The fixed regions of the shell; each class sets `view-transition-name: al-<region>`. */
export const VT_CLASS = {
  main: 'al-vt-main',
  rail: 'al-vt-rail',
  top: 'al-vt-top',
  strip: 'al-vt-strip',
  chip: 'al-vt-chip',
  approval: 'al-vt-approval',
} as const;

/** The attribute that names the one shared element (`view-transition-name: al-shared`). */
export const VT_SHARED_ATTR = 'data-vt-shared';

export interface ViewTransitionOptions {
  /** The element the shared element starts from (named for the old snapshot only). */
  from?: Element | null;
  /** Returns the element it lands on, after the update (named for the new snapshot only). */
  to?: () => Element | null | undefined;
}

export interface ViewTransitionRun {
  /** Whether the browser ran a View Transition (false: the update ran directly). */
  readonly supported: boolean;
  /** Resolves when the transition is over, skipped or failed; never rejects. */
  readonly finished: Promise<void>;
  /** Skip to the end state now. */
  skip(): void;
}

interface BrowserTransition {
  finished: Promise<unknown>;
  ready: Promise<unknown>;
  updateCallbackDone: Promise<unknown>;
  skipTransition(): void;
}
type StartFn = (update: () => void) => BrowserTransition;

function api(): StartFn | null {
  if (typeof document === 'undefined') return null;
  const fn = (document as Document & { startViewTransition?: unknown }).startViewTransition;
  return typeof fn === 'function' ? (fn as StartFn).bind(document) : null;
}

/** Whether this browser has same-document View Transitions. */
export function viewTransitionsSupported(): boolean {
  return api() !== null;
}

let running: BrowserTransition | null = null;

const quiet = (p: Promise<unknown> | undefined): void => {
  p?.then(undefined, () => undefined);
};

/**
 * Run `update` inside a View Transition when the browser has one, else run it at once. The update
 * must change the DOM synchronously (React callers use `useViewTransition`, which flushes).
 */
export function startViewTransition(
  update: () => void,
  options: ViewTransitionOptions = {},
): ViewTransitionRun {
  const { from = null, to } = options;
  let target: Element | null = null;
  const apply = (): void => {
    from?.removeAttribute(VT_SHARED_ATTR);
    update();
    const next = to?.() ?? null;
    if (next !== null && typeof document !== 'undefined') {
      // One shared name on the page at a time, or the browser skips the whole transition.
      for (const el of document.querySelectorAll(`[${VT_SHARED_ATTR}]`)) {
        if (el !== next) el.removeAttribute(VT_SHARED_ATTR);
      }
      next.setAttribute(VT_SHARED_ATTR, '');
      target = next;
    }
  };
  const cleanup = (): void => {
    target?.removeAttribute(VT_SHARED_ATTR);
    target = null;
  };
  const direct = (): ViewTransitionRun => {
    from?.removeAttribute(VT_SHARED_ATTR);
    apply();
    cleanup();
    return { supported: false, finished: Promise.resolve(), skip: () => undefined };
  };

  const start = api();
  if (start === null) return direct();
  running?.skipTransition();
  running = null;
  from?.setAttribute(VT_SHARED_ATTR, '');
  let transition: BrowserTransition;
  let applied = false;
  try {
    transition = start(() => {
      applied = true;
      apply();
    });
  } catch {
    if (applied) {
      cleanup();
      return { supported: false, finished: Promise.resolve(), skip: () => undefined };
    }
    return direct();
  }
  running = transition;
  quiet(transition.ready);
  quiet(transition.updateCallbackDone);
  const done = (): void => {
    cleanup();
    if (running === transition) running = null;
  };
  const finished = Promise.resolve(transition.finished).then(done, done);
  return {
    supported: true,
    finished,
    skip: () => transition.skipTransition(),
  };
}

export interface ViewTransitionControls {
  /** Run a React state change inside a View Transition; it commits synchronously (flushSync). */
  start(update: () => void, options?: ViewTransitionOptions): ViewTransitionRun;
  /** Whether the browser has View Transitions. */
  supported: boolean;
}

/** The View Transition helper for React: page changes, the pro morph, the shared element. */
export function useViewTransition(): ViewTransitionControls {
  const start = useCallback(
    (update: () => void, options?: ViewTransitionOptions): ViewTransitionRun =>
      startViewTransition(() => flushSync(update), options),
    [],
  );
  const supported = viewTransitionsSupported();
  return useMemo(() => ({ start, supported }), [start, supported]);
}
