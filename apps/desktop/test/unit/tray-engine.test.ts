// TRAY-ENGINE: the tray icon's pure state machine (src/main/tray-engine.ts). Injected timers only.
import { describe, expect, it } from 'vitest';
import {
  STATIC_FRAMES,
  TrayEngine,
  settleFrame,
  type TrayFrameRef,
  type TraySequences,
} from '../../src/main/tray-engine.js';
import { ManualClock } from './tray-clock.js';

const seq = (name: string, n: number, loop = false) => ({
  frames: Array.from({ length: n }, (_, i) => `${name}-${i}`),
  frameMs: 40,
  loop,
});

const SEQUENCES: TraySequences = {
  'msg-in': seq('msg-in', 8),
  'msg-out': seq('msg-out', 8),
  approval: seq('approval', 6),
  connecting: seq('connecting', 8, true),
};

function setup(
  options: {
    reducedMotion?: boolean;
    initial?: Partial<{
      state: 'connected' | 'connecting' | 'paused' | 'offline' | 'update';
      unread: boolean;
      approvals: boolean;
    }>;
  } = {},
) {
  const clock = new ManualClock();
  const frames: TrayFrameRef[] = [];
  const engine = new TrayEngine({
    sequences: SEQUENCES,
    timers: clock,
    render: (f) => frames.push(f),
    reducedMotion: options.reducedMotion ?? false,
    initial: options.initial ?? { state: 'connected' },
  });
  const ids = () => frames.map((f) => f.id);
  return { clock, frames, engine, ids };
}

describe('settleFrame (the static variant by priority)', () => {
  const s = (
    state: 'connected' | 'connecting' | 'paused' | 'offline' | 'update',
    unread = false,
    approvals = false,
  ) => settleFrame({ state, unread, approvals }, SEQUENCES);

  it('approvals > offline > paused > update > connecting > connected', () => {
    expect(s('offline', true, true)).toBe(STATIC_FRAMES.approvals);
    expect(s('connected', true, true)).toBe('tray-approvals');
    expect(s('offline', true)).toBe('tray-offline');
    expect(s('paused', true)).toBe('tray-paused');
    expect(s('update', true)).toBe('tray-update');
    expect(s('connecting', true)).toBe('connecting-0');
    expect(s('connected')).toBe('tray-connected');
  });

  it('the unread ring wins over plain connected only', () => {
    expect(s('connected', true)).toBe('tray-connected-unread');
    expect(s('update', true)).toBe('tray-update');
  });
});

describe('TrayEngine', () => {
  it('renders the settle frame at once and runs no timer when static', () => {
    const { ids, clock } = setup();
    expect(ids()).toEqual(['tray-connected']);
    expect(clock.pendingCount).toBe(0);
  });

  it('loops only while connecting, at about 40 ms per frame', () => {
    const { ids, clock, engine } = setup({ initial: { state: 'connecting' } });
    expect(ids()).toEqual(['connecting-0']);
    clock.advance(40 * 9);
    expect(ids()).toEqual([
      'connecting-0',
      'connecting-1',
      'connecting-2',
      'connecting-3',
      'connecting-4',
      'connecting-5',
      'connecting-6',
      'connecting-7',
      'connecting-0',
      'connecting-1',
    ]);
    engine.set({ state: 'connected' });
    expect(ids().at(-1)).toBe('tray-connected');
    expect(clock.pendingCount).toBe(0);
    const before = ids().length;
    clock.advance(1000);
    expect(ids().length).toBe(before);
  });

  it('plays a message-in pulse once, then settles on the unread ring', () => {
    const { ids, clock, engine, frames } = setup();
    engine.pulse('msg-in');
    expect(engine.animating).toBe('msg-in');
    clock.advance(40 * 8);
    expect(ids().slice(1)).toEqual([...SEQUENCES['msg-in'].frames, 'tray-connected-unread']);
    expect(frames.at(-2)?.settle).toBe('tray-connected-unread');
    expect(engine.animating).toBeNull();
    expect(engine.indicator.unread).toBe(true);
    expect(clock.pendingCount).toBe(0);
  });

  it('msg-out plays and settles back to the same static frame', () => {
    const { ids, clock, engine } = setup();
    engine.pulse('msg-out');
    clock.advance(40 * 8);
    expect(ids().slice(1)).toEqual([...SEQUENCES['msg-out'].frames, 'tray-connected']);
  });

  it('approval grows once, then shows the approvals variant (which wins over unread)', () => {
    const { ids, clock, engine } = setup({ initial: { state: 'connected', unread: true } });
    engine.pulse('approval');
    clock.advance(40 * 6);
    expect(ids().slice(1)).toEqual([...SEQUENCES.approval.frames, 'tray-approvals']);
    engine.set({ approvals: false });
    expect(ids().at(-1)).toBe('tray-connected-unread');
    engine.clearUnread();
    expect(ids().at(-1)).toBe('tray-connected');
  });

  it('a burst of the same pulse coalesces into one run', () => {
    const { ids, clock, engine } = setup();
    for (let i = 0; i < 5; i += 1) engine.pulse('msg-in');
    clock.advance(1000);
    expect(ids().filter((id) => id === 'msg-in-0')).toHaveLength(1);
  });

  it('never stacks: one running, at most one queued (the most important kind)', () => {
    const { ids, clock, engine } = setup();
    engine.pulse('msg-out');
    clock.advance(40);
    engine.pulse('msg-in');
    engine.pulse('approval');
    engine.pulse('msg-out');
    engine.pulse('msg-in');
    clock.advance(2000);
    const starts = ids().filter((id) => id.endsWith('-0') && !id.startsWith('connecting'));
    expect(starts).toEqual(['msg-out-0', 'approval-0']);
    expect(ids().at(-1)).toBe('tray-approvals');
    // The implications of every pulse still apply: the ring is set below the approvals variant.
    expect(engine.indicator.unread).toBe(true);
  });

  it('a pulse during connecting interrupts the loop, then the loop resumes', () => {
    const { ids, clock, engine } = setup({ initial: { state: 'connecting' } });
    clock.advance(80);
    engine.pulse('msg-out');
    clock.advance(40 * 8);
    expect(ids().slice(3, 3 + 9)).toEqual([...SEQUENCES['msg-out'].frames, 'connecting-0']);
    clock.advance(40);
    expect(ids().at(-1)).toBe('connecting-1');
  });

  it('state changes during a pulse do not cut it; it settles on the new state', () => {
    const { ids, clock, engine } = setup();
    engine.pulse('msg-out');
    clock.advance(80);
    engine.set({ state: 'offline' });
    expect(ids().at(-1)).toBe('msg-out-2');
    clock.advance(1000);
    expect(ids().at(-1)).toBe('tray-offline');
  });

  it('reduced motion: no frames, static only (pulses still set the ring)', () => {
    const { ids, clock, engine } = setup({ reducedMotion: true, initial: { state: 'connecting' } });
    expect(ids()).toEqual(['connecting-0']);
    expect(clock.pendingCount).toBe(0);
    engine.set({ state: 'connected' });
    engine.pulse('msg-in');
    expect(clock.pendingCount).toBe(0);
    expect(ids()).toEqual(['connecting-0', 'tray-connected', 'tray-connected-unread']);
  });

  it('turning reduced motion on mid-animation stops at the static frame; off restarts the loop', () => {
    const { ids, clock, engine } = setup();
    engine.pulse('msg-in');
    clock.advance(40);
    engine.setReducedMotion(true);
    expect(ids().at(-1)).toBe('tray-connected-unread');
    expect(clock.pendingCount).toBe(0);
    engine.set({ state: 'connecting' });
    expect(clock.pendingCount).toBe(0);
    engine.setReducedMotion(false);
    expect(clock.pendingCount).toBe(1);
    clock.advance(40);
    expect(ids().at(-1)).toBe('connecting-1');
  });

  it('does not render the same frame twice in a row', () => {
    const { ids, engine } = setup();
    engine.set({ state: 'connected' });
    engine.set({ unread: false, approvals: false });
    expect(ids()).toEqual(['tray-connected']);
  });

  it('dispose clears timers and silences the engine', () => {
    const { ids, clock, engine } = setup({ initial: { state: 'connecting' } });
    engine.pulse('msg-in');
    engine.dispose();
    expect(clock.pendingCount).toBe(0);
    const n = ids().length;
    engine.pulse('approval');
    engine.set({ state: 'offline' });
    engine.setReducedMotion(false);
    clock.advance(1000);
    expect(ids().length).toBe(n);
  });

  it('ignores unknown states and pulses (fail closed to the current frame)', () => {
    const { ids, clock, engine } = setup();
    engine.set({ state: 'hacked' as never });
    engine.pulse('boom' as never);
    clock.advance(1000);
    expect(ids()).toEqual(['tray-connected']);
    expect(engine.indicator.state).toBe('connected');
  });

  it('an empty sequence settles at once', () => {
    const clock = new ManualClock();
    const out: string[] = [];
    const engine = new TrayEngine({
      sequences: { ...SEQUENCES, 'msg-in': { frames: [], frameMs: 40, loop: false } },
      timers: clock,
      render: (f) => out.push(f.id),
      initial: { state: 'connected' },
    });
    engine.pulse('msg-in');
    expect(out).toEqual(['tray-connected', 'tray-connected-unread']);
    expect(clock.pendingCount).toBe(0);
  });
});

const fade = (name: string) => ({
  frames: [0, 1, 2].map((i) => `${name}-${i}`),
  frameMs: 40,
  loop: false,
});
const WITH_FADES: TraySequences = {
  ...SEQUENCES,
  fades: {
    'fade-connected-paused': fade('fade-connected-paused'),
    'fade-connected-unread-offline': fade('fade-connected-unread-offline'),
    'fade-paused-update': fade('fade-paused-update'),
  },
};

function fadeSetup(reducedMotion = false, render?: (f: TrayFrameRef) => void) {
  const clock = new ManualClock();
  const out: string[] = [];
  const engine = new TrayEngine({
    sequences: WITH_FADES,
    timers: clock,
    render: (f) => {
      render?.(f);
      out.push(f.id);
    },
    reducedMotion,
    initial: { state: 'connected' },
  });
  return { clock, out, engine };
}

describe('TrayEngine fades (M2)', () => {
  it('paused, offline and update cross-fade in from the static frame on screen', () => {
    const { clock, out, engine } = fadeSetup();
    engine.set({ state: 'paused' });
    expect(engine.animating).toBe('fade');
    clock.advance(40 * 3);
    expect(out).toEqual([
      'tray-connected',
      'fade-connected-paused-0',
      'fade-connected-paused-1',
      'fade-connected-paused-2',
      'tray-paused',
    ]);
    expect(clock.pendingCount).toBe(0);
    engine.set({ state: 'update' });
    clock.advance(200);
    expect(out.slice(5)).toEqual([
      'fade-paused-update-0',
      'fade-paused-update-1',
      'fade-paused-update-2',
      'tray-update',
    ]);
  });

  it('the unread ring fades from its own frame; a missing pair switches instantly', () => {
    const { clock, out, engine } = fadeSetup();
    engine.set({ unread: true });
    engine.set({ state: 'offline' });
    clock.advance(200);
    expect(out.at(-2)).toBe('fade-connected-unread-offline-2');
    expect(out.at(-1)).toBe('tray-offline');
    engine.set({ state: 'paused' }); // no fade-offline-paused in this set
    expect(out.at(-1)).toBe('tray-paused');
    engine.set({ state: 'connected', unread: false });
    expect(out.at(-1)).toBe('tray-connected'); // leaving is instant
  });

  it('from the connecting loop it fades from the connected mark', () => {
    const clock = new ManualClock();
    const out: string[] = [];
    const engine = new TrayEngine({
      sequences: WITH_FADES,
      timers: clock,
      render: (f) => out.push(f.id),
      initial: { state: 'connecting' },
    });
    clock.advance(80);
    engine.set({ state: 'paused' });
    clock.advance(200);
    expect(out.slice(3)).toEqual([
      'fade-connected-paused-0',
      'fade-connected-paused-1',
      'fade-connected-paused-2',
      'tray-paused',
    ]);
  });

  it('reduced motion: an instant switch, no timers', () => {
    const { clock, out, engine } = fadeSetup(true);
    engine.set({ state: 'paused' });
    expect(out).toEqual(['tray-connected', 'tray-paused']);
    expect(clock.pendingCount).toBe(0);
  });

  it('a pulse during a fade waits for it', () => {
    const { clock, out, engine } = fadeSetup();
    engine.set({ state: 'paused' });
    engine.pulse('msg-out');
    clock.advance(1000);
    expect(out.indexOf('msg-out-0')).toBeGreaterThan(out.indexOf('fade-connected-paused-2'));
    expect(out.at(-1)).toBe('tray-paused');
  });
});

describe('TrayEngine render failures (L4)', () => {
  it('a render that throws stops the animation and shows the settle frame; no throw from the timer', () => {
    let fail = false;
    const { clock, out, engine } = fadeSetup(false, (f) => {
      if (fail && f.id === 'msg-out-2') throw new Error('bad image');
    });
    fail = true;
    engine.pulse('msg-out');
    expect(() => clock.advance(40 * 2)).not.toThrow();
    expect(engine.animating).toBeNull();
    expect(clock.pendingCount).toBe(0);
    expect(out.at(-1)).toBe('tray-connected');
    // The engine keeps working afterwards.
    fail = false;
    engine.pulse('msg-in');
    clock.advance(1000);
    expect(out.at(-1)).toBe('tray-connected-unread');
  });

  it('when the settle frame itself throws, it stops quietly', () => {
    const clock = new ManualClock();
    const engine = new TrayEngine({
      sequences: SEQUENCES,
      timers: clock,
      render: () => {
        throw new Error('no images at all');
      },
      initial: { state: 'connecting' },
    });
    expect(() => clock.advance(500)).not.toThrow();
    expect(() => engine.pulse('approval')).not.toThrow();
    expect(clock.pendingCount).toBe(0);
  });
});
