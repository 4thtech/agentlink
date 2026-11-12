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
  | 'error';

export const NATIVE_STATES: readonly NativeState[] = Object.freeze([
  'cancelled',
  'failed',
  'lockout',
  'reregister',
  'unavailable',
  'retry_later',
  'not_registered',
  'error',
]);

export const NATIVE_STRINGS = Object.freeze({
  setupIntro: (platform: DesktopPlatform): string =>
    `Approve with ${nativeSensor(platform)} instead of typing your backup code. Keep your backup code anyway: it still works.`,
  turnedOn: (platform: DesktopPlatform): string =>
    `${nativeSensor(platform)} is on for approvals on this computer.`,
  notNow: 'Not now',
  working: 'Waiting for you…',
  state: Object.freeze({
    cancelled: 'Cancelled. Nothing was changed. Try again, or use your backup code.',
    failed: 'Not recognised. Nothing was changed. Try again, or use your backup code.',
    lockout: 'Too many tries. Use your backup code this time.',
    reregister:
      'Your fingerprints or sign-in changed, so this computer needs it turned on again. Use your backup code, then turn it on again.',
    unavailable: 'Not available on this computer. Use your backup code.',
    retry_later:
      'This computer could not finish that yet. Try again later, or use your backup code.',
    not_registered: 'Not turned on for approvals on this computer yet. Use your backup code.',
    error: 'That did not work. Nothing was changed. Use your backup code.',
  } satisfies Record<NativeState, string>),
});
