// D-120 (2): the recovery kit can be put off at first run ("Later"). The choice is remembered in this
// browser so the reminder banner stays on every page until the kit is saved (M1-11b-3 clears it).
// It holds only a flag and a time, never a code or anything secret. Storage can be missing or refuse
// (private windows): then nothing is remembered and the banner simply isn't shown.
// UX1113-QA-HOST: the app keeps the flag too, so a relaunch (a new port) keeps it (prefs/app-kept.ts).
import { keepInApp } from '../prefs/app-kept.js';

export const RECOVERY_KIT_LATER_KEY = 'agentlink.recoveryKit.later';

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Records "Later" (`at`: milliseconds). */
export function rememberRecoveryKitLater(at: number = Date.now()): void {
  try {
    storage()?.setItem(RECOVERY_KIT_LATER_KEY, String(Math.floor(at)));
  } catch {
    // Not remembered; nothing else changes.
  }
  keepInApp(RECOVERY_KIT_LATER_KEY);
}

/** Forgets "Later" (the kit was saved). */
export function forgetRecoveryKitLater(): void {
  try {
    storage()?.removeItem(RECOVERY_KIT_LATER_KEY);
  } catch {
    // Nothing to do.
  }
  keepInApp(RECOVERY_KIT_LATER_KEY);
}

// WP-R4: the server's kit record is the truth (every browser agrees). The browser flag above is only
// the fallback while the record is unread or unreadable. Holds one word, never a code or a path.
// UX1113-QA2 N14: `unfinished` (saved, never checked) still asks for a kit, as `none` does.
export type KitRecordState = 'backed_up' | 'out_of_date' | 'unfinished' | 'none';
let serverState: KitRecordState | undefined;

/** Remembers what the server's record said (`undefined`: unread or unreadable). */
export function setKitRecordState(state: KitRecordState | undefined): void {
  serverState = state;
  if (state === 'backed_up' || state === 'out_of_date') forgetRecoveryKitLater();
}

/** The server's word on the kit, when this page load has one. */
export function kitRecordState(): KitRecordState | undefined {
  return serverState;
}

/** True while the owner has no kit on record; the browser flag decides only without a record. */
export function recoveryKitPending(): boolean {
  if (serverState !== undefined) return serverState === 'none' || serverState === 'unfinished';
  try {
    const value = storage()?.getItem(RECOVERY_KIT_LATER_KEY);
    return value !== null && value !== undefined && /^[0-9]{1,16}$/.test(value);
  } catch {
    return false;
  }
}
