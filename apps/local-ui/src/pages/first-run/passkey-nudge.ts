// F49: an owner with only the backup code, on a computer whose passkey gives AgentLink no PRF
// (Windows Hello on some Windows 11 machines, even in Chrome). After a switch attempt there fails for
// that reason, this browser stops pushing the switch: the shell's "Switch to …" banner leaves and the
// presence sheets offer the backup code alone. Kept in this browser's localStorage as one flag (no
// owner value, no code). It only decides what the page suggests; every approval is still checked by
// the server's owner gate, so this is never a security decision. Storage can be missing or blocked:
// every access is wrapped, and the page then remembers it only while it is open.
import { WORKING_BROWSER, type Platform } from './strings.js';

export const SWITCH_UNSUPPORTED_KEY = 'agentlink.passkey.switch-unsupported.v1';

/** Fired (no data) when a switch fails here, so the shell's "Switch to …" banner leaves at once. */
export const SWITCH_UNSUPPORTED_EVENT = 'agentlink:passkey-switch-unsupported';

let failedThisPage = false;

/** Whether a switch to a passkey already failed here for lack of PRF (UI nudging only). */
export function switchUnsupportedHere(): boolean {
  if (failedThisPage) return true;
  try {
    return localStorage.getItem(SWITCH_UNSUPPORTED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remember that this browser can't switch (the passkey gave no PRF). */
export function rememberSwitchUnsupported(): void {
  failedThisPage = true;
  try {
    localStorage.setItem(SWITCH_UNSUPPORTED_KEY, '1');
  } catch {
    // No storage: remembered only while this page is open.
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SWITCH_UNSUPPORTED_EVENT));
}

/** A registered passkey ends the nudge (it worked after all, e.g. after an OS update). */
export function forgetSwitchUnsupported(): void {
  failedThisPage = false;
  try {
    localStorage.removeItem(SWITCH_UNSUPPORTED_KEY);
  } catch {
    // Nothing to forget.
  }
}

export function resetSwitchUnsupportedForTests(): void {
  failedThisPage = false;
}

/**
 * Whether this page already runs in the browser the copy would recommend (WORKING_BROWSER), so the
 * copy never says "open this page in Chrome or Edge" to someone in Chrome.
 */
export function inWorkingBrowser(platform: Platform, userAgent?: string): boolean {
  const ua = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const chromium = /(Chrome|Chromium|CriOS|Edg|EdgA|EdgiOS)\//.test(ua);
  const firefox = /\b(Firefox|FxiOS)\//.test(ua);
  if (platform === 'mac') return /\bSafari\//.test(ua) && !chromium && !firefox;
  if (platform === 'windows') return chromium && !/\bOPR\//.test(ua);
  return /(Chrome|Chromium)\//.test(ua);
}

/** The browser to suggest, or undefined when this page already runs in it. */
export function otherBrowser(platform: Platform, userAgent?: string): string | undefined {
  return inWorkingBrowser(platform, userAgent) ? undefined : WORKING_BROWSER[platform];
}
