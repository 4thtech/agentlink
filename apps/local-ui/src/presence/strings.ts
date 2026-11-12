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
  | 'not_registered'
  | 'damaged'
  | 'keychain'
  | 'error';

export const NATIVE_STATES: readonly NativeState[] = Object.freeze([
  'cancelled',
  'failed',
  'lockout',
  'reregister',
  'unavailable',
  'retry_later',
  'not_registered',
  'damaged',
  'keychain',
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
  confirmCode: 'Confirm with your master code',
  codeLabel: 'Master code',
  cancel: 'Cancel',
  turnedOff: (platform: DesktopPlatform): string =>
    `${nativeSensor(platform)} is off for approvals on this computer.`,
  wrongCode: 'That master code did not work. Nothing was changed.',
  working: 'Waiting for you…',
  state: Object.freeze({
    cancelled: 'Cancelled. Nothing was changed. Try again, or use your master code.',
    failed: 'Not recognised. Nothing was changed. Try again, or use your master code.',
    lockout: 'Too many tries. Use your master code this time.',
    reregister:
      'Your fingerprints or sign-in changed, so this computer needs it turned on again. Use your master code, then turn it on again.',
    unavailable: 'Not available on this computer. Use your master code.',
    retry_later:
      'This computer could not finish that yet. Try again later, or use your master code.',
    not_registered: 'Not turned on for approvals on this computer yet. Use your master code.',
    damaged:
      'This computer needs it turned on again before it can be used. Use your master code, then turn it on again.',
    keychain: 'The system keychain did not answer. Unlock your computer and try again.',
    error: 'That did not work. Nothing was changed. Use your master code.',
  } satisfies Record<NativeState, string>),
});
