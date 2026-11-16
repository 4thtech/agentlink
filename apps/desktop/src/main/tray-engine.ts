// TRAY-ENGINE (D-155, b11 §25.4): the menu-bar / tray icon as a pure state machine. No Electron, no
// file access: it takes the indicator (state, unread, approvals) and one-shot pulses, and renders
// frame ids (from assets/tray/manifest.json, src/main/tray-frames.ts) through a callback with
// injected timers. Shape carries the meaning, never colour (claude-design-handoff §4).
//
// Rules:
// - The settle (static) frame by priority: approvals > offline > paused > update > connecting >
//   connected; the hollow-ring unread mark replaces plain connected only.
// - Only `connecting` loops (it breathes while connecting, and stops when the state changes).
// - Pulses (msg-in, msg-out, approval) play once. At most one runs; at most one waits. A pulse of
//   the kind already running or waiting is absorbed (a burst coalesces); otherwise the waiting slot
//   keeps the more important kind (approval > msg-in > msg-out). msg-in sets the unread mark and
//   approval sets the approvals variant, so the icon settles on the right frame afterwards.
// - Reduced motion: no timers at all, the settle frame only.
// - dispose() clears the timer; the engine renders nothing after it.

export const TRAY_STATES = ['connected', 'connecting', 'paused', 'offline', 'update'] as const;
export type TrayState = (typeof TRAY_STATES)[number];

export const TRAY_PULSES = ['msg-in', 'msg-out', 'approval'] as const;
export type TrayPulse = (typeof TRAY_PULSES)[number];

/** The animated sequences the engine plays: the three pulses and the connecting loop. */
export type TrayAnimation = TrayPulse | 'connecting';

export interface TrayIndicator {
  readonly state: TrayState;
  readonly unread: boolean;
  readonly approvals: boolean;
}

export interface TraySequence {
  readonly frames: readonly string[];
  readonly frameMs: number;
  readonly loop: boolean;
}

export type TraySequences = Readonly<Record<TrayAnimation, TraySequence>>;

/** The static frame ids (manifest sequence `static`). Connecting settles on its first frame. */
export const STATIC_FRAMES = Object.freeze({
  connected: 'tray-connected',
  unread: 'tray-connected-unread',
  approvals: 'tray-approvals',
  paused: 'tray-paused',
  offline: 'tray-offline',
  update: 'tray-update',
});

/** What the engine renders: the frame, and the static frame it will settle on (the fallback). */
export interface TrayFrameRef {
  readonly id: string;
  readonly settle: string;
}

export interface TrayTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TrayEngineOptions {
  readonly sequences: TraySequences;
  readonly render: (frame: TrayFrameRef) => void;
  readonly timers?: TrayTimers;
  readonly reducedMotion?: boolean;
  readonly initial?: Partial<TrayIndicator>;
}

const PULSE_RANK: Record<TrayPulse, number> = { 'msg-out': 1, 'msg-in': 2, approval: 3 };
const MIN_FRAME_MS = 16;
const DEFAULT_FRAME_MS = 40;

const isState = (v: unknown): v is TrayState =>
  typeof v === 'string' && (TRAY_STATES as readonly string[]).includes(v);
const isPulse = (v: unknown): v is TrayPulse =>
  typeof v === 'string' && (TRAY_PULSES as readonly string[]).includes(v);

/** The static frame for an indicator (pure). */
export function settleFrame(indicator: TrayIndicator, sequences: TraySequences): string {
  if (indicator.approvals) return STATIC_FRAMES.approvals;
  switch (indicator.state) {
    case 'offline':
      return STATIC_FRAMES.offline;
    case 'paused':
      return STATIC_FRAMES.paused;
    case 'update':
      return STATIC_FRAMES.update;
    case 'connecting':
      return sequences.connecting.frames[0] ?? STATIC_FRAMES.connected;
    case 'connected':
      return indicator.unread ? STATIC_FRAMES.unread : STATIC_FRAMES.connected;
  }
}

const defaultTimers: TrayTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class TrayEngine {
  readonly #sequences: TraySequences;
  readonly #render: (frame: TrayFrameRef) => void;
  readonly #timers: TrayTimers;
  #indicator: TrayIndicator;
  #reduced: boolean;
  #disposed = false;
  #timer: unknown = null;
  /** The running animation and its next frame index. */
  #running: { readonly kind: TrayAnimation; next: number } | null = null;
  #queued: TrayPulse | null = null;
  #last: TrayFrameRef | null = null;

  constructor(options: TrayEngineOptions) {
    this.#sequences = options.sequences;
    this.#render = options.render;
    this.#timers = options.timers ?? defaultTimers;
    this.#reduced = options.reducedMotion === true;
    const init = options.initial ?? {};
    this.#indicator = {
      state: isState(init.state) ? init.state : 'connecting',
      unread: init.unread === true,
      approvals: init.approvals === true,
    };
    this.#settle();
  }

  get indicator(): TrayIndicator {
    return this.#indicator;
  }

  /** The last frame rendered (null only before the first render). */
  get frame(): TrayFrameRef | null {
    return this.#last;
  }

  /** The pulse or loop that is playing, or null when the icon is static. */
  get animating(): TrayAnimation | null {
    return this.#running?.kind ?? null;
  }

  /** Changes the indicator. A running pulse is not cut: it settles on the new state at its end. */
  set(next: Partial<TrayIndicator>): void {
    if (this.#disposed) return;
    const state = next.state === undefined ? this.#indicator.state : next.state;
    if (!isState(state)) return;
    this.#indicator = {
      state,
      unread: typeof next.unread === 'boolean' ? next.unread : this.#indicator.unread,
      approvals: typeof next.approvals === 'boolean' ? next.approvals : this.#indicator.approvals,
    };
    if (this.#running !== null && this.#running.kind !== 'connecting') return;
    this.#settle();
  }

  /** The popover was opened: the hollow ring goes. */
  clearUnread(): void {
    this.set({ unread: false });
  }

  /** A one-shot animation (coalesced, never stacked). */
  pulse(kind: TrayPulse): void {
    if (this.#disposed || !isPulse(kind)) return;
    if (kind === 'msg-in') this.#indicator = { ...this.#indicator, unread: true };
    if (kind === 'approval') this.#indicator = { ...this.#indicator, approvals: true };
    if (this.#reduced) {
      this.#settle();
      return;
    }
    const running = this.#running;
    if (running !== null && running.kind !== 'connecting') {
      if (running.kind === kind || this.#queued === kind) return;
      if (this.#queued === null || PULSE_RANK[kind] > PULSE_RANK[this.#queued]) this.#queued = kind;
      return;
    }
    this.#start(kind);
  }

  setReducedMotion(on: boolean): void {
    if (this.#disposed) return;
    const reduced = on === true;
    if (reduced === this.#reduced) return;
    this.#reduced = reduced;
    this.#stop();
    this.#queued = null;
    this.#settle();
  }

  dispose(): void {
    this.#disposed = true;
    this.#stop();
    this.#queued = null;
  }

  #stop(): void {
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
    this.#running = null;
  }

  /** Shows the static frame, or (re)starts the connecting loop when it should run. */
  #settle(): void {
    const loop = this.#indicator.state === 'connecting' && !this.#indicator.approvals;
    if (loop && !this.#reduced && this.#sequences.connecting.frames.length > 1) {
      if (this.#running?.kind !== 'connecting') this.#start('connecting');
      return;
    }
    this.#stop();
    this.#show(settleFrame(this.#indicator, this.#sequences));
  }

  #start(kind: TrayAnimation): void {
    this.#stop();
    this.#running = { kind, next: 0 };
    this.#tick();
  }

  #tick(): void {
    this.#timer = null;
    const running = this.#running;
    if (this.#disposed || running === null) return;
    const seq = this.#sequences[running.kind];
    if (running.next >= seq.frames.length) {
      if (seq.loop && seq.frames.length > 0) {
        running.next = 0;
      } else {
        this.#running = null;
        const queued = this.#queued;
        this.#queued = null;
        if (queued !== null) this.#start(queued);
        else this.#settle();
        return;
      }
    }
    this.#show(seq.frames[running.next] as string);
    running.next += 1;
    const ms = Number.isFinite(seq.frameMs)
      ? Math.max(MIN_FRAME_MS, seq.frameMs)
      : DEFAULT_FRAME_MS;
    this.#timer = this.#timers.setTimeout(() => this.#tick(), ms);
  }

  #show(id: string): void {
    const settle = settleFrame(this.#indicator, this.#sequences);
    if (this.#last !== null && this.#last.id === id && this.#last.settle === settle) return;
    this.#last = { id, settle };
    this.#render(this.#last);
  }
}
