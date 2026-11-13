// DESK051-C2 (owner feedback after testing Touch ID on a real Mac): the state machine of the desktop
// app's "Use Touch ID for approvals" switch, so the switch guides the owner one step at a time.
//
//   off ──click──▶ in-between (code step: the reason and the master code field)
//                    │ Cancel, or the switch again ─▶ back where it was
//                    └─ send (a code is typed) ─▶ in-between (sensor step: the OS prompt is up)
//                         ├─ registered ─▶ on
//                         ├─ wrong master code ─▶ code step again, with the message
//                         └─ anything else ─▶ back where it was, with a plain message
//
// Turning off and "Turn on again" (after a fingerprint change) use the same steps. Pure: no I/O, no
// code is kept here (the typed code lives only in the component's field until it is sent).
import type { NativeRegistration, NativeStatus } from './native-api.js';

export type NativeOp = 'on' | 'off' | 'again';
/** What this computer has stored: off, on, or on but needing to be turned on again. */
export type NativeStored = 'off' | 'on' | 'broken';
export type NativeStep = 'idle' | 'code' | 'sensor';
/** How the switch looks: off, the in-between state, or fully on. */
export type NativeSwitchLook = 'off' | 'pending' | 'on';

export interface NativeSwitchNote {
  readonly text: string;
  readonly tone: 'ok' | 'error';
}

export interface NativeSwitchState {
  readonly stored: NativeStored;
  readonly step: NativeStep;
  /** The operation under way (undefined when idle). */
  readonly op?: NativeOp;
  readonly note?: NativeSwitchNote;
}

export type NativeSwitchEvent =
  /** The status read (on visit and after every answer). */
  | { readonly type: 'status'; readonly status: NativeStatus }
  /** The switch was clicked. */
  | { readonly type: 'toggle' }
  /** "Turn on again" was clicked (a fingerprint or sign-in change). */
  | { readonly type: 'again' }
  /** Cancel in the code step. */
  | { readonly type: 'cancel' }
  /** The master code was sent; the OS prompt follows on the server's side. */
  | { readonly type: 'send' }
  /** The server's answer, with its one fixed message (strings.ts nativeOutcomeText). */
  | { readonly type: 'answer'; readonly outcome: NativeRegistration; readonly text: string };

export const NATIVE_SWITCH_START: NativeSwitchState = Object.freeze({
  stored: 'off',
  step: 'idle',
});

export function nativeStoredOf(status: NativeStatus): NativeStored {
  if (status.reason === 'reregister' || status.reason === 'damaged') return 'broken';
  return status.registered && status.reason === undefined ? 'on' : 'off';
}

const idle = (stored: NativeStored, note?: NativeSwitchNote): NativeSwitchState =>
  note === undefined ? { stored, step: 'idle' } : { stored, step: 'idle', note };

export function nativeSwitchStep(s: NativeSwitchState, e: NativeSwitchEvent): NativeSwitchState {
  switch (e.type) {
    case 'status': {
      const stored = nativeStoredOf(e.status);
      return stored === s.stored ? s : { ...s, stored };
    }
    case 'toggle':
      if (s.step === 'sensor' || s.stored === 'broken') return s;
      if (s.step === 'code') return idle(s.stored);
      return { stored: s.stored, step: 'code', op: s.stored === 'on' ? 'off' : 'on' };
    case 'again':
      if (s.step !== 'idle') return s;
      return { stored: s.stored, step: 'code', op: 'again' };
    case 'cancel':
      return s.step === 'code' ? idle(s.stored) : s;
    case 'send':
      return s.step === 'code' && s.op !== undefined
        ? { stored: s.stored, step: 'sensor', op: s.op }
        : s;
    case 'answer': {
      if (s.step !== 'sensor' || s.op === undefined) return s;
      const o = e.outcome;
      // A wrong master code keeps the in-between state and the field to try again.
      if (o.kind === 'rejected') {
        return { stored: s.stored, step: 'code', op: s.op, note: { text: e.text, tone: 'error' } };
      }
      if (o.kind === 'registered') return idle('on', { text: e.text, tone: 'ok' });
      if (o.kind === 'off') return idle('off', { text: e.text, tone: 'ok' });
      // On again that failed after the old one was removed: off now (the server said so).
      const stored = o.kind === 'native' && o.nowOff === true ? 'off' : s.stored;
      return idle(stored, { text: e.text, tone: 'error' });
    }
    default:
      return s;
  }
}

export function nativeSwitchLook(s: NativeSwitchState): NativeSwitchLook {
  if (s.op !== undefined) return 'pending';
  return s.stored === 'on' ? 'on' : 'off';
}

/** The sensor (or Turn off) button works only in the code step with a code typed. */
export function nativeSwitchCanSend(s: NativeSwitchState, code: string): boolean {
  return s.step === 'code' && s.op !== undefined && code.trim() !== '';
}
