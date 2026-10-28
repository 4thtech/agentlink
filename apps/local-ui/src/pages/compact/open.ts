// Opening the compact window, and sending a click from it to the main app (UX2-h; b11 §25.1; 08 §1).
// The window is a plain same-origin page of this app at a path the server already serves: no new
// route, no session token in the address, title or browser storage, no install. A browser cannot
// keep it on top of other windows (the M2 popover can).

/** Served as an app page by the existing server (`/settings/<name>`). */
export const COMPACT_PATH = '/settings/compact';
export const COMPACT_NAME = 'agentlink-compact';
export const COMPACT_FEATURES = 'popup=yes,width=380,height=600';
const MAIN_NAME = 'agentlink-main';
/** The router's own change event (router.tsx). */
const NAVIGATE_EVENT = 'agentlink:navigate';

/** Open the compact view as a small separate window; focuses it if it is already open. */
export function openCompactWindow(win: Window = window): void {
  const opened = win.open(COMPACT_PATH, COMPACT_NAME, COMPACT_FEATURES);
  try {
    opened?.focus();
  } catch {
    // A window that cannot be focused is still open.
  }
}

/**
 * Bring the main app to the front at `path`: the window that opened this one when it is still there
 * (same origin, so it changes page without a reload), else a named window. Never decides anything.
 */
export function openInMainApp(path: string, win: Window = window): void {
  const main = win.opener as Window | null;
  if (main !== null && !main.closed) {
    try {
      main.history.pushState(null, '', path);
      main.dispatchEvent(new Event(NAVIGATE_EVENT));
      main.focus();
      return;
    } catch {
      // Fall through to a named window.
    }
  }
  const opened = win.open(path, MAIN_NAME);
  try {
    opened?.focus();
  } catch {
    // Still open.
  }
}
