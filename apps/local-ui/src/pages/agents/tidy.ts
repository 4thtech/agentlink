// U3-h: the one-time "Tidy up" note (b11 §29.7). The spec stores "hide for good" with the agents on
// the computer; no route for that exists yet (U3-c lists, switches). Until one does, this keeps the
// two facts (dismissed, Agents page opened) in this browser only, in a try/catch, and the note then
// shows again in another browser. Nothing is removed or hidden automatically.
import { keepInApp } from '../../prefs/app-kept.js';

const DISMISSED = 'agentlink:tidy-dismissed';
const OPENED = 'agentlink:agents-opened';

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function write(key: string): void {
  try {
    localStorage.setItem(key, '1');
    keepInApp(key);
  } catch {
    /* no storage: the note simply shows again */
  }
}

export const tidyDismissed = (): boolean => read(DISMISSED);
export const dismissTidy = (): void => write(DISMISSED);
export const agentsOpened = (): boolean => read(OPENED);
export const markAgentsOpened = (): void => write(OPENED);

// R1-UI-09: "you can remove them" is only meaningful for an ID that has been around for a while. The
// agents list has no creation date, so each candidate is stamped the first time this browser sees it
// (a restore or a first run stamps it that day); the note waits until it is a few days old.
const FIRST_SEEN = 'agentlink:tidy-first-seen';
/** An ID counts as left over only after this long with no AI app and no people. */
export const TIDY_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

function readSeen(): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(FIRST_SEEN) ?? '{}');
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'number') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/**
 * Of the candidate ID names, those seen as candidates for at least `TIDY_AFTER_MS`. Stamps the new
 * ones now; forgets the ones that are no longer candidates (they got an app or a person).
 */
export function dueForTidy(names: readonly string[], now: number = Date.now()): string[] {
  const seen = readSeen();
  const next: Record<string, number> = {};
  for (const name of names) next[name] = seen[name] ?? now;
  try {
    localStorage.setItem(FIRST_SEEN, JSON.stringify(next));
    keepInApp(FIRST_SEEN);
  } catch {
    // Not stamped: nothing is due (the note stays hidden rather than showing too early).
    return [];
  }
  return names.filter((name) => now - (next[name] ?? now) >= TIDY_AFTER_MS);
}
