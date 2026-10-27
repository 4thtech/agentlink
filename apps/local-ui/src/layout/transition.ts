// UI-REFRESH-f: route changes use the View Transitions API where it exists (B-11 §6 row 11, plan §5):
// the page fades in with a 4 px rise (chrome.css). Elsewhere, with reduced motion, or if the API
// refuses, the change is instant. Navigation is never delayed: the address changes first, and the
// transition only wraps the re-render.
import { flushSync } from 'react-dom';

type WithTransition = Document & { startViewTransition?: (update: () => void) => unknown };

/** True when motion is reduced: the system setting, or the app's own `data-motion="reduced"`. */
export function isMotionReduced(): boolean {
  if (document.documentElement.dataset['motion'] === 'reduced') return true;
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Runs `update` (the re-render) inside a view transition when one is available and allowed. */
export function withRouteTransition(update: () => void): void {
  const doc = document as WithTransition;
  if (typeof doc.startViewTransition !== 'function' || isMotionReduced()) {
    update();
    return;
  }
  try {
    doc.startViewTransition(() => {
      flushSync(update);
    });
  } catch {
    // The browser refused (for example a transition is already starting): change instantly.
    update();
  }
}
