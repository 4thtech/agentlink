// DESK051-C2 (owner feedback after testing Touch ID on a real Mac): the desktop app's Touch ID switch
// guides the owner. A click puts the switch in an in-between state (its own look) with the master
// code field and the reason; the sensor button only works once a code is typed; after the OS prompt
// succeeds the switch is fully on. Errors and Cancel go back cleanly to where it was, with a message.
import { describe, expect, it } from 'vitest';
import {
  NATIVE_SWITCH_START,
  nativeSwitchLook,
  nativeSwitchStep,
  nativeSwitchCanSend,
  type NativeSwitchEvent,
  type NativeSwitchState,
} from './native-switch.js';

const run = (events: NativeSwitchEvent[], from: NativeSwitchState = NATIVE_SWITCH_START) =>
  events.reduce(nativeSwitchStep, from);
const OFF: NativeSwitchEvent = { type: 'status', status: { available: true, registered: false } };
const ON: NativeSwitchEvent = { type: 'status', status: { available: true, registered: true } };
const BROKEN: NativeSwitchEvent = {
  type: 'status',
  status: { available: true, registered: true, reason: 'reregister' },
};

describe('the native switch state machine', () => {
  it('starts off, and the stored status decides on, off or broken', () => {
    expect(nativeSwitchLook(NATIVE_SWITCH_START)).toBe('off');
    expect(nativeSwitchLook(run([ON]))).toBe('on');
    expect(nativeSwitchLook(run([OFF]))).toBe('off');
    expect(run([BROKEN]).stored).toBe('broken');
    expect(nativeSwitchLook(run([BROKEN]))).toBe('off');
  });

  it('turning on: click → in-between with the code step; send → sensor; registered → on', () => {
    const asking = run([OFF, { type: 'toggle' }]);
    expect(asking).toMatchObject({ op: 'on', step: 'code' });
    expect(nativeSwitchLook(asking)).toBe('pending');
    const sensing = nativeSwitchStep(asking, { type: 'send' });
    expect(sensing.step).toBe('sensor');
    expect(nativeSwitchLook(sensing)).toBe('pending');
    const done = nativeSwitchStep(sensing, {
      type: 'answer',
      outcome: { kind: 'registered' },
      text: 'on now',
    });
    expect(done).toMatchObject({ stored: 'on', step: 'idle', note: { tone: 'ok', text: 'on now' } });
    expect(done.op).toBeUndefined();
    expect(nativeSwitchLook(done)).toBe('on');
  });

  it('the sensor step is reached only with a typed code', () => {
    const asking = run([OFF, { type: 'toggle' }]);
    expect(nativeSwitchCanSend(asking, '')).toBe(false);
    expect(nativeSwitchCanSend(asking, '   ')).toBe(false);
    expect(nativeSwitchCanSend(asking, 'ABCD EFGH')).toBe(true);
    expect(nativeSwitchCanSend(NATIVE_SWITCH_START, 'ABCD EFGH')).toBe(false);
    expect(nativeSwitchCanSend(nativeSwitchStep(asking, { type: 'send' }), 'ABCD')).toBe(false);
  });

  it('Cancel, or clicking the switch again, during the code step returns cleanly to off', () => {
    const asking = run([OFF, { type: 'toggle' }]);
    for (const back of [
      nativeSwitchStep(asking, { type: 'cancel' }),
      nativeSwitchStep(asking, { type: 'toggle' }),
    ]) {
      expect(back).toEqual({ stored: 'off', step: 'idle' });
      expect(nativeSwitchLook(back)).toBe('off');
    }
  });

  it('a refused or failed gesture returns to off with a plain message', () => {
    const sensing = run([OFF, { type: 'toggle' }, { type: 'send' }]);
    for (const outcome of [
      { kind: 'native', state: 'cancelled' },
      { kind: 'native', state: 'failed' },
      { kind: 'timeout' },
      { kind: 'failed' },
      { kind: 'busy' },
    ] as const) {
      const back = nativeSwitchStep(sensing, { type: 'answer', outcome, text: 'why' });
      expect(back).toEqual({ stored: 'off', step: 'idle', note: { tone: 'error', text: 'why' } });
      expect(nativeSwitchLook(back)).toBe('off');
    }
  });

  it('a wrong master code keeps the in-between state and the code step to try again', () => {
    const sensing = run([OFF, { type: 'toggle' }, { type: 'send' }]);
    const again = nativeSwitchStep(sensing, {
      type: 'answer',
      outcome: { kind: 'rejected' },
      text: 'wrong',
    });
    expect(again).toMatchObject({ op: 'on', step: 'code', note: { tone: 'error', text: 'wrong' } });
    expect(nativeSwitchLook(again)).toBe('pending');
  });

  it('turning off: on → in-between → off', () => {
    const asking = run([ON, { type: 'toggle' }]);
    expect(asking).toMatchObject({ op: 'off', step: 'code' });
    expect(nativeSwitchLook(asking)).toBe('pending');
    const off = run([{ type: 'send' }, { type: 'answer', outcome: { kind: 'off' }, text: 'x' }], asking);
    expect(off.stored).toBe('off');
    expect(nativeSwitchLook(off)).toBe('off');
    // Cancel while turning off: back to on, unchanged.
    expect(nativeSwitchLook(nativeSwitchStep(asking, { type: 'cancel' }))).toBe('on');
  });

  it('on again that fails after removing the old one is off', () => {
    const sensing = run([BROKEN, { type: 'again' }, { type: 'send' }]);
    expect(sensing.op).toBe('again');
    const off = nativeSwitchStep(sensing, {
      type: 'answer',
      outcome: { kind: 'native', state: 'timeout', nowOff: true },
      text: 'now off',
    });
    expect(off.stored).toBe('off');
  });

  it('while the OS prompt is up, the switch, Cancel and a second send do nothing', () => {
    const sensing = run([OFF, { type: 'toggle' }, { type: 'send' }]);
    expect(nativeSwitchStep(sensing, { type: 'toggle' })).toBe(sensing);
    expect(nativeSwitchStep(sensing, { type: 'cancel' })).toBe(sensing);
    expect(nativeSwitchStep(sensing, { type: 'send' })).toBe(sensing);
  });

  it('a broken registration cannot be toggled; only Turn on again starts the code step', () => {
    const broken = run([BROKEN]);
    expect(nativeSwitchStep(broken, { type: 'toggle' })).toBe(broken);
    expect(nativeSwitchStep(broken, { type: 'again' })).toMatchObject({ op: 'again', step: 'code' });
  });

  it('an answer without a request in flight is ignored; a status read keeps the step', () => {
    expect(
      nativeSwitchStep(NATIVE_SWITCH_START, {
        type: 'answer',
        outcome: { kind: 'registered' },
        text: 'x',
      }),
    ).toBe(NATIVE_SWITCH_START);
    const asking = run([OFF, { type: 'toggle' }]);
    expect(nativeSwitchStep(asking, OFF)).toMatchObject({ op: 'on', step: 'code' });
  });
});
