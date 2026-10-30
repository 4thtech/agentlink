// W4-WIZARD (W4 UX v2 layer 1): Get started opens by itself only while setup is incomplete (no owner,
// no agent, or no AI app connected), decided from real state, never from a "seen" flag. Once set up,
// the app opens on Home. The check runs once, when the app opens on Home (main.tsx, behind
// StartGate so Home never flashes first); deep links such as `/approve/<id>` are never taken over.
//
// IR-W4-WIZARD-1: the app is entered through the session link, which lands on `/settings/home` (an
// old path the router maps to `/` only after the first render), so the check resolves the router's
// redirects itself. "Skip to Home" and finishing Get started stay on Home: in the page (the
// once-per-life mark) and across the full load that "Go to Home" makes (a one-time mark in this
// tab's session storage). The next launch decides again from the state.
import { REDIRECTS } from '../../nav.js';
import { navigate } from '../../router.js';
import { readSetupState, setupIncomplete, type SetupState } from './setup-state.js';
import { markAutoShown, wasAutoShown } from './store.js';

export const START_FIRST_STEP = '/start/app';

/** Where the app may open Get started by itself: Home only (after the router's redirects). */
export const GUARDED_PATHS: readonly string[] = ['/'];

/** "Get started just ended on Home with a full load": used once by the next check. */
export const START_LEAVING_KEY = 'agentlink.start.leaving';

/** The path the router shows for `path` (an old path is redirected first). */
function shown(path: string): string {
  return REDIRECTS[path] ?? path;
}

/**
 * Whether a page opened at `path` should open Get started instead, for this state. A waiting
 * approval keeps Home, and so does an unanswered approvals read (it may hide one): approvals are
 * time-bound and never hidden behind Get started.
 */
export function shouldOpenStart(path: string, state: SetupState): boolean {
  return GUARDED_PATHS.includes(shown(path)) && setupIncomplete(state) && state.waiting === 0;
}

/** Get started ends on Home with a full load: the check of that load keeps Home. */
export function markLeavingStart(): void {
  try {
    sessionStorage.setItem(START_LEAVING_KEY, '1');
  } catch {
    // Not kept: the next load decides from the state (at worst Get started again).
  }
}

function takeLeavingMark(): boolean {
  try {
    const marked = sessionStorage.getItem(START_LEAVING_KEY) !== null;
    if (marked) sessionStorage.removeItem(START_LEAVING_KEY);
    return marked;
  } catch {
    return false;
  }
}

/** Whether the check may still take over this entry (Home, not decided yet in this page life). */
export function mayOpenStart(path: string = location.pathname): boolean {
  return !wasAutoShown() && GUARDED_PATHS.includes(shown(path));
}

export interface StartGuardOptions {
  readonly path?: () => string;
  readonly read?: () => Promise<SetupState>;
  readonly go?: (path: string) => void;
}

/**
 * When the app opens on Home, reads the real state once and opens Get started (replacing the history
 * entry) while setup is incomplete. Resolves whether it did. Never throws; an unanswered read, the
 * load that Get started itself ended, or the person having moved on meanwhile, stays where they are.
 */
export async function openStartIfIncomplete(options: StartGuardOptions = {}): Promise<boolean> {
  const {
    path = () => location.pathname,
    read = readSetupState,
    go = (to: string) => navigate(to, true),
  } = options;
  const at = shown(path());
  if (!mayOpenStart(at)) return false;
  if (takeLeavingMark()) {
    markAutoShown();
    return false;
  }
  let state: SetupState;
  try {
    state = await read();
  } catch {
    return false;
  }
  // Decided once per page life; the person may have gone elsewhere while the reads ran.
  if (wasAutoShown() || shown(path()) !== at) return false;
  markAutoShown();
  if (!shouldOpenStart(at, state)) return false;
  go(START_FIRST_STEP);
  return true;
}

/** "Skip to Home": Get started does not open by itself again in this page's life. */
export function skipToHome(go: (path: string) => void = (to) => navigate(to)): void {
  markAutoShown();
  go('/');
}
