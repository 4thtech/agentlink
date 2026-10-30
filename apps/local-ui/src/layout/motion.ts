// TODO(U0): the W4 motion kit (PR #724, @4thtech-io/ui) is not on wave-4 yet. This adapter has its
// exact names and signatures (startViewTransition(update, {from, to}), VT_CLASS), so the switch is
// one line once it merges:
//   export { startViewTransition, VT_CLASS } from '@4thtech-io/ui';
// Until then: the same-document View Transition where the browser has one (the update commits
// synchronously), else the update at once; reduced motion is the stylesheet's job (U0 motion.css).
// No keyframes or motion styles live here or in the app (W4 UI rules: motion only via U0).
import { flushSync } from 'react-dom';

/** The fixed regions of the shell; U0's motion.css names each `view-transition-name: al-<region>`. */
export const VT_CLASS = {
  main: 'al-vt-main',
  rail: 'al-vt-rail',
  top: 'al-vt-top',
  strip: 'al-vt-strip',
  chip: 'al-vt-chip',
  approval: 'al-vt-approval',
} as const;

export interface ViewTransitionOptions {
  from?: Element | null;
  to?: () => Element | null | undefined;
}

export interface ViewTransitionRun {
  readonly supported: boolean;
  readonly finished: Promise<void>;
  skip(): void;
}

type Start = (update: () => void) => { finished: Promise<unknown>; skipTransition(): void };

/** Runs a React state change inside a View Transition when the browser has one. */
export function startViewTransition(
  update: () => void,
  _options: ViewTransitionOptions = {},
): ViewTransitionRun {
  const start = (document as Document & { startViewTransition?: unknown }).startViewTransition;
  const direct = (): ViewTransitionRun => {
    flushSync(update);
    return { supported: false, finished: Promise.resolve(), skip: () => undefined };
  };
  if (typeof start !== 'function') return direct();
  try {
    const t = (start as Start).call(document, () => flushSync(update));
    const finished = Promise.resolve(t.finished).then(
      () => undefined,
      () => undefined,
    );
    return { supported: true, finished, skip: () => t.skipTransition() };
  } catch {
    return direct();
  }
}
