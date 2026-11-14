// DESK-D12c: the fixed texts of native presence in the desktop app (11 §5 plain words; proposed,
// owner confirms at merge). Each helper state has one message; nothing from the server or the helper
// is ever shown.
import { nativeSensor, type DesktopPlatform } from './desktop.js';

export type NativeState =
  | 'cancelled'
  | 'failed'
  | 'lockout'
  | 'reregister'
  | 'unavailable'
  | 'retry_later'
  | 'timeout'
  | 'not_registered'
  | 'damaged'
  | 'keychain'
  /** DESK-TOUCHID-FIX review (Fable L-1): a keychain write that may still have landed. */
  | 'keychain_unsure'
  | 'error';

export const NATIVE_STATES: readonly NativeState[] = Object.freeze([
  'cancelled',
  'failed',
  'lockout',
  'reregister',
  'unavailable',
  'retry_later',
  'timeout',
  'not_registered',
  'damaged',
  'keychain',
  'keychain_unsure',
  'error',
]);

export const NATIVE_STRINGS = Object.freeze({
  setupIntro: (platform: DesktopPlatform): string =>
    `Approve with ${nativeSensor(platform)} instead of typing your master code. Keep your master code anyway: it still works.`,
  turnedOn: (platform: DesktopPlatform): string =>
    `${nativeSensor(platform)} is on for approvals on this computer.`,
  notNow: 'Not now',
  settingsTitle: (platform: DesktopPlatform): string =>
    `Use ${nativeSensor(platform)} for approvals`,
  settingsOn: (platform: DesktopPlatform): string =>
    `On: approve with ${nativeSensor(platform)} on this computer. Your master code still works.`,
  settingsOff: 'Off: approvals use your master code.',
  turnOnAgain: 'Turn on again',
  /**
   * APP-CONTINUITY (offer.ts): why a presence screen in the app asks for the master code. Never a
   * passkey or a security key: the app's window doesn't use them.
   */
  codeHelp: (platform: DesktopPlatform, available: boolean): string =>
    available
      ? `${nativeSensor(platform)} isn't turned on for approvals in this app yet, so this asks for your master code. You can turn it on in Settings › ${nativeSensor(platform)} & master code.`
      : `${nativeSensor(platform)} isn't available on this computer, so this asks for your master code.`,
  /**
   * DESK051-C2 (owner feedback): why the master code comes first, said once in the in-between step.
   * Adding a way to confirm is itself an owner action, so the master code proves it is the owner.
   */
  whyOn: (platform: DesktopPlatform): string =>
    `Confirm it's you once with your master code, so this computer can add ${nativeSensor(platform)}. Then ${
      platform === 'mac' ? 'touch the sensor' : 'follow the Windows Hello prompt'
    } to finish.`,
  whyOff: (platform: DesktopPlatform): string =>
    `Confirm with your master code to turn off ${nativeSensor(platform)} for approvals. Your master code keeps working.`,
  turnOff: 'Turn off',
  confirmCode: 'Confirm with your master code',
  codeLabel: 'Master code',
  cancel: 'Cancel',
  turnedOff: (platform: DesktopPlatform): string =>
    `${nativeSensor(platform)} is off for approvals on this computer.`,
  wrongCode: 'That master code did not work. Nothing was changed.',
  working: 'Waiting for you…',
  /**
   * DESK-NATIVE-DEBUG: shown while the OS prompt is up, so a waiting request is never silent.
   * DESK-TOUCHID-FIX: the Mac wording names the key to rest a finger on (with a Cancel beside it).
   */
  waiting: (platform: DesktopPlatform): string =>
    platform === 'mac'
      ? 'Rest your finger on the Touch ID key.'
      : 'Waiting for Windows Hello. Follow the Windows Hello prompt.',
  /** DESK-NATIVE-DEBUG: the page's own answers when the server did not finish. */
  busy: 'Another approval is in progress. Finish it, then try again.',
  wait: 'Too many tries with a wrong master code. Wait a moment, then try again.',
  needsSetup: 'Open your ID first, then try again.',
  pageTimeout: 'That took too long to answer. Check the switch above, then try again.',
  /**
   * DESK-TOUCHID-FIX review (Fable L-2): turning it on again removes the old one first; when the new
   * one then did not finish (cancelled, timed out, the keychain), it is off.
   */
  nowOff: (platform: DesktopPlatform): string =>
    `${nativeSensor(platform)} is now off for approvals on this computer: the old one was removed and the new one was not finished. Turn it on again, or use your master code.`,
  /**
   * WIN-HELLO-NATIVE: why Touch ID / Windows Hello can't be offered on this computer, and how to set
   * it up where that helps. Shown with the master code (offer.ts); never a security-key prompt.
   */
  setUp: (
    platform: DesktopPlatform,
    why: 'not_set_up' | 'no_secure_hardware' | 'unknown',
  ): string =>
    why === 'not_set_up'
      ? platform === 'mac'
        ? 'Touch ID has no fingerprint yet. To use it, open System Settings, then Touch ID & Password, and add a fingerprint. For now, use your master code.'
        : "Windows Hello isn't set up on this computer. To use it, open Settings, then Accounts, then Sign-in options, and set up a PIN (Windows Hello). Then come back here. For now, use your master code."
      : why === 'no_secure_hardware'
        ? platform === 'mac'
          ? "This Mac can't use Touch ID for approvals. Use your master code."
          : "This computer doesn't have the security chip Windows Hello needs for approvals. Use your master code."
        : platform === 'mac'
          ? "Touch ID isn't available right now. Use your master code."
          : "Windows Hello isn't available right now. Use your master code.",
  unavailableNow: (platform: DesktopPlatform): string =>
    platform === 'mac'
      ? "Touch ID isn't available right now (for example, the lid is closed). Use your master code."
      : "Windows Hello isn't available right now. Use your master code.",
  state: Object.freeze({
    cancelled: 'Cancelled. Nothing was changed. Try again, or use your master code.',
    failed: 'Not recognised. Nothing was changed. Try again, or use your master code.',
    lockout: 'Too many tries. Use your master code this time.',
    reregister:
      'Your fingerprints or sign-in changed, so this computer needs it turned on again. Use your master code, then turn it on again.',
    unavailable: "Touch ID or Windows Hello isn't available right now. Use your master code.",
    retry_later:
      'This computer could not finish that yet. Try again later, or use your master code.',
    timeout: 'The request timed out before you confirmed. Nothing was changed. Try again.',
    not_registered: 'Not turned on for approvals on this computer yet. Use your master code.',
    damaged:
      'This computer needs it turned on again before it can be used. Use your master code, then turn it on again.',
    keychain: 'The system keychain did not answer. Unlock your computer and try again.',
    keychain_unsure:
      'The system keychain did not answer in time, so it may have been turned on. Check the switch above, then try again if it is off.',
    error: 'That did not work. Nothing was changed. Use your master code.',
  } satisfies Record<NativeState, string>),
});

/** DESK-NATIVE-DEBUG: what the page learned from one native presence operation (native-api.ts). */
export type NativeOutcomeKind =
  | { readonly kind: 'registered' }
  | { readonly kind: 'off' }
  | { readonly kind: 'rejected' }
  | {
      readonly kind: 'native';
      readonly state: NativeState;
      /** DESK-TOUCHID-FIX review (Fable L-2): on again failed after the old one was removed. */
      readonly nowOff?: true;
    }
  | { readonly kind: 'busy' }
  | { readonly kind: 'wait' }
  | { readonly kind: 'needs_setup' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed' };

/** DESK-NATIVE-DEBUG: the one fixed message of every outcome, so none ends silently. */
export function nativeOutcomeText(outcome: NativeOutcomeKind, platform: DesktopPlatform): string {
  switch (outcome.kind) {
    case 'registered':
      return NATIVE_STRINGS.turnedOn(platform);
    case 'off':
      return NATIVE_STRINGS.turnedOff(platform);
    case 'rejected':
      return NATIVE_STRINGS.wrongCode;
    case 'native':
      if (outcome.nowOff === true) return NATIVE_STRINGS.nowOff(platform);
      return outcome.state === 'unavailable'
        ? NATIVE_STRINGS.unavailableNow(platform)
        : NATIVE_STRINGS.state[outcome.state];
    case 'busy':
      return NATIVE_STRINGS.busy;
    case 'wait':
      return NATIVE_STRINGS.wait;
    case 'needs_setup':
      return NATIVE_STRINGS.needsSetup;
    case 'timeout':
      return NATIVE_STRINGS.pageTimeout;
    default:
      return NATIVE_STRINGS.state.error;
  }
}
