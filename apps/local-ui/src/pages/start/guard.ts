// W4-WIZARD (W4 UX v2 layer 1): Get started opens by itself only while setup is incomplete (no owner,
// no agent, or no AI app connected), decided from real state, never from a "seen" flag. Once set up,
// the app opens on Home. The check runs once, when the app opens on Home (main.tsx); deep links such
// as `/approve/<id>` are never taken over. "Skip to Home" and finishing Get started stay on Home for
// the life of the page; the next launch decides again from the state.
import { navigate } from '../../router.js';
import { readSetupState, setupIncomplete, type SetupState } from './setup-state.js';
import { markAutoShown, wasAutoShown } from './store.js';

export const START_FIRST_STEP = '/start/app';

/** Where the app may open Get started by itself: Home only. */
export const GUARDED_PATHS: readonly string[] = ['/'];

/** Whether a page opened at `path` should open Get started instead, for this state. */
export function shouldOpenStart(path: string, state: SetupState): boolean {
  return GUARDED_PATHS.includes(path) && setupIncomplete(state);
}

export interface StartGuardOptions {
  readonly path?: () => string;
  readonly read?: () => Promise<SetupState>;
  readonly go?: (path: string) => void;
}

/**
 * When the app opens on Home, reads the real state once and opens Get started (replacing the history
 * entry) while setup is incomplete. Resolves whether it did. Never throws; an unanswered read, or the
 * person having moved on meanwhile, stays where they are.
 */
export async function openStartIfIncomplete(options: StartGuardOptions = {}): Promise<boolean> {
  const {
    path = () => location.pathname,
    read = readSetupState,
    go = (to: string) => navigate(to, true),
  } = options;
  const at = path();
  if (wasAutoShown() || !GUARDED_PATHS.includes(at)) return false;
  let state: SetupState;
  try {
    state = await read();
  } catch {
    return false;
  }
  // Decided once per page life; the person may have gone elsewhere while the reads ran.
  if (wasAutoShown() || path() !== at) return false;
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
