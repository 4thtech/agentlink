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

/** True while the owner put the kit off and hasn't saved it yet. */
export function recoveryKitPending(): boolean {
  try {
    const value = storage()?.getItem(RECOVERY_KIT_LATER_KEY);
    return value !== null && value !== undefined && /^[0-9]{1,16}$/.test(value);
  } catch {
    return false;
  }
}
