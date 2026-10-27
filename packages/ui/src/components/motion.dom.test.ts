// @vitest-environment jsdom
// UI-REFRESH-d (S1): live state and moments (B-11 §5, §6 rows 1, 3, 4, 7 to 10 and 13, §14, §15.1).
// LiveDot (six states: shape, word, tone, live region), SuccessMoment, CountBadge, useRowPresence,
// nudge, useReducedMotion, useVisibilityPause. Reduced motion (the media query and the app's own
// data-motion setting) means no Element.animate call, an instant state and a text line. Interrupted
// motion continues. Amounts and codes never animate.
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CountBadge,
  LIVE_DOT_STATES,
  LiveDot,
  SuccessMoment,
  nudge,
  useReducedMotion,
  useRowPresence,
  useVisibilityPause,
  type LiveDotState,
} from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeAnim {
  onfinish: (() => void) | null;
  cancel: ReturnType<typeof vi.fn>;
  reverse: ReturnType<typeof vi.fn>;
  finish: () => void;
}
interface Call {
  target: Element;
  frames: Keyframe[];
  opts: KeyframeAnimationOptions;
  anim: FakeAnim;
}

let host: HTMLElement;
let root: Root;
let calls: Call[];
let reducedQuery = false;
let mqListeners: Array<() => void>;

function fakeAnim(): FakeAnim {
  const a: FakeAnim = {
    onfinish: null,
    cancel: vi.fn(),
    reverse: vi.fn(),
    finish: () => a.onfinish?.(),
  };
  return a;
}

beforeEach(() => {
  calls = [];
  reducedQuery = false;
  mqListeners = [];
  document.documentElement.removeAttribute('data-motion');
  (Element.prototype as unknown as { animate: unknown }).animate = function (
    this: Element,
    frames: Keyframe[],
    opts: KeyframeAnimationOptions,
  ) {
    const anim = fakeAnim();
    calls.push({ target: this, frames, opts, anim });
    return anim;
  };
  window.matchMedia = ((q: string) => ({
    matches: reducedQuery && q.includes('prefers-reduced-motion'),
    media: q,
    addEventListener: (_: string, fn: () => void) => mqListeners.push(fn),
    removeEventListener: (_: string, fn: () => void) => {
      mqListeners = mqListeners.filter((f) => f !== fn);
    },
  })) as unknown as typeof window.matchMedia;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const render = (el: ReactElement): void => {
  act(() => root.render(el));
};
const text = (): string => host.textContent ?? '';
const scale = (c: Call): string => JSON.stringify(c.frames);

const SPEC: Record<LiveDotState, { word: string; tone: string; shape: string }> = {
  checking: { word: 'Checking…', tone: 'neutral', shape: 'ring' },
  connected: { word: 'Connected', tone: 'success', shape: 'dot' },
  reconnecting: { word: 'Reconnecting…', tone: 'warning', shape: 'half-ring' },
  paused: { word: 'Paused', tone: 'neutral', shape: 'bars' },
  'not-running': { word: 'Not running', tone: 'warning', shape: 'slash' },
  'needs-setup': { word: 'Needs setup', tone: 'accent', shape: 'mark' },
};

describe('LiveDot (B-11 §5)', () => {
  it('lists the six states', () => {
    expect([...LIVE_DOT_STATES].sort()).toEqual(Object.keys(SPEC).sort());
  });

  for (const [state, want] of Object.entries(SPEC)) {
    it(`${state}: shape, word, tone and a polite live region`, () => {
      render(h(LiveDot, { state: state as LiveDotState }));
      const el = host.querySelector('.al-livedot') as HTMLElement;
      expect(el.getAttribute('data-state')).toBe(state);
      expect(el.classList.contains(`al-tone-${want.tone}`)).toBe(true);
      expect(el.getAttribute('role')).toBe('status');
      expect(el.getAttribute('aria-live') ?? 'polite').toBe('polite');
      expect(el.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(el.querySelector('svg')?.getAttribute('data-shape')).toBe(want.shape);
      expect(text()).toContain(want.word);
    });
  }

  it('Connected gives one soft pulse on arrival and then stays still', () => {
    render(h(LiveDot, { state: 'reconnecting' }));
    expect(calls).toHaveLength(0);
    render(h(LiveDot, { state: 'connected' }));
    const pulses = calls.filter((c) => scale(c).includes('scale(2.2)'));
    expect(pulses).toHaveLength(1);
    render(h(LiveDot, { state: 'connected' }));
    expect(calls.filter((c) => scale(c).includes('scale(2.2)'))).toHaveLength(1);
  });

  it('Checking fills once and becomes Not running after 4 s', () => {
    vi.useFakeTimers();
    render(h(LiveDot, { state: 'checking' }));
    expect(calls).toHaveLength(1);
    expect(text()).toContain('Checking…');
    act(() => {
      vi.advanceTimersByTime(3900);
    });
    expect(text()).toContain('Checking…');
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(text()).toContain('Not running');
    expect((host.querySelector('.al-livedot') as HTMLElement).getAttribute('data-state')).toBe(
      'not-running',
    );
  });

  it('Checking answered in time stays answered', () => {
    vi.useFakeTimers();
    render(h(LiveDot, { state: 'checking' }));
    render(h(LiveDot, { state: 'connected' }));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(text()).toContain('Connected');
  });

  it('a state change in the middle of the pulse does not cancel or restart it', () => {
    render(h(LiveDot, { state: 'reconnecting' }));
    render(h(LiveDot, { state: 'connected' }));
    const before = calls.length;
    render(h(LiveDot, { state: 'paused' }));
    expect(calls).toHaveLength(before);
    for (const c of calls) expect(c.anim.cancel).not.toHaveBeenCalled();
  });

  it('with reduced motion (media query) there is no animate call and the state is instant', () => {
    reducedQuery = true;
    render(h(LiveDot, { state: 'reconnecting' }));
    render(h(LiveDot, { state: 'connected' }));
    expect(calls).toHaveLength(0);
    expect(text()).toContain('Connected');
  });

  it('with reduced motion (the app setting) there is no animate call', () => {
    document.documentElement.setAttribute('data-motion', 'reduced');
    render(h(LiveDot, { state: 'checking' }));
    render(h(LiveDot, { state: 'connected' }));
    expect(calls).toHaveLength(0);
    expect(text()).toContain('Connected');
  });

  it('pauses its loop while the tab is hidden', () => {
    render(h(LiveDot, { state: 'reconnecting' }));
    const el = host.querySelector('.al-livedot') as HTMLElement;
    expect(el.hasAttribute('data-paused')).toBe(false);
    const spy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(el.hasAttribute('data-paused')).toBe(true);
    spy.mockRestore();
  });
});

describe('useReducedMotion and useVisibilityPause', () => {
  function Probe(): ReactElement {
    const r = useReducedMotion();
    const hid = useVisibilityPause();
    return h('p', { 'data-r': String(r), 'data-h': String(hid) });
  }
  const attr = (n: string): string | null =>
    (host.querySelector('p') as HTMLElement).getAttribute(n);

  it('follows the media query', () => {
    reducedQuery = true;
    render(h(Probe));
    expect(attr('data-r')).toBe('true');
  });

  it('follows the app setting live, in both directions', async () => {
    render(h(Probe));
    expect(attr('data-r')).toBe('false');
    await act(async () => {
      document.documentElement.setAttribute('data-motion', 'reduced');
      await Promise.resolve();
    });
    expect(attr('data-r')).toBe('true');
    await act(async () => {
      document.documentElement.setAttribute('data-motion', 'full');
      await Promise.resolve();
    });
    expect(attr('data-r')).toBe('false');
  });

  it('follows the tab being hidden', () => {
    render(h(Probe));
    expect(attr('data-h')).toBe('false');
    const spy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(attr('data-h')).toBe('true');
    spy.mockRestore();
  });
});

describe('SuccessMoment (B-11 §6 rows 7 to 10)', () => {
  const KINDS = [
    ['approved', 'Approved'],
    ['proof', 'Proof recorded'],
    ['codes', 'Codes match'],
    ['file', 'File received'],
  ] as const;

  for (const [kind, line] of KINDS) {
    it(`${kind}: a text line in a live region and a short sequence`, () => {
      render(h(SuccessMoment, { kind }));
      const el = host.querySelector('.al-moment') as HTMLElement;
      expect(el.getAttribute('data-kind')).toBe(kind);
      expect(el.getAttribute('role')).toBe('status');
      expect(text()).toContain(line);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.length).toBeLessThanOrEqual(2);
      for (const c of calls) expect(Number(c.opts.duration)).toBeLessThanOrEqual(480);
    });

    it(`${kind}: reduced motion is an instant state plus the text line`, () => {
      reducedQuery = true;
      render(h(SuccessMoment, { kind }));
      expect(calls).toHaveLength(0);
      expect(text()).toContain(line);
    });
  }

  it('the check draws with stroke-dashoffset and nothing else but transform and opacity moves', () => {
    render(h(SuccessMoment, { kind: 'approved' }));
    const props = new Set(calls.flatMap((c) => c.frames.flatMap((f) => Object.keys(f))));
    for (const p of props) {
      expect(['strokeDashoffset', 'transform', 'opacity', 'offset', 'easing']).toContain(p);
    }
    expect(props.has('strokeDashoffset')).toBe(true);
  });

  it('codes merge: the two blocks slide together', () => {
    render(h(SuccessMoment, { kind: 'codes' }));
    const slides = calls.filter((c) => scale(c).includes('translateX'));
    expect(slides).toHaveLength(2);
  });

  it('never animates text: amounts and codes stay still', () => {
    for (const [kind] of KINDS) {
      calls = [];
      render(h(SuccessMoment, { kind }));
      for (const c of calls) expect(c.target.textContent).toBe('');
    }
  });

  it('an unknown kind renders nothing', () => {
    render(h(SuccessMoment, { kind: 'bogus' as never }));
    expect(host.querySelector('.al-moment')).toBeNull();
  });
});

describe('CountBadge (B-11 §5 Counts, §6 row 3)', () => {
  it('shows the number, and 99+ above 99', () => {
    render(h(CountBadge, { count: 7 }));
    expect(text()).toBe('7');
    act(() => root.unmount());
    root = createRoot(host);
    render(h(CountBadge, { count: 99 }));
    expect(text()).toBe('99');
    act(() => root.unmount());
    root = createRoot(host);
    render(h(CountBadge, { count: 100 }));
    expect(text()).toBe('99+');
  });

  it('renders nothing for zero', () => {
    render(h(CountBadge, { count: 0 }));
    expect(host.querySelector('.al-count')).toBeNull();
  });

  it('ticks when the shown value changes: old slides up, new comes in', () => {
    render(h(CountBadge, { count: 3 }));
    expect(calls).toHaveLength(0);
    render(h(CountBadge, { count: 4 }));
    expect(calls).toHaveLength(2);
    expect(text()).toContain('3');
    expect(text()).toContain('4');
    act(() => {
      for (const c of calls) c.anim.finish();
    });
    expect(text()).toBe('4');
  });

  it('does not tick when the shown value is the same (101 to 102)', () => {
    render(h(CountBadge, { count: 101 }));
    render(h(CountBadge, { count: 102 }));
    expect(calls).toHaveLength(0);
  });

  it('with reduced motion the number just changes', () => {
    reducedQuery = true;
    render(h(CountBadge, { count: 3 }));
    render(h(CountBadge, { count: 4 }));
    expect(calls).toHaveLength(0);
    expect(text()).toBe('4');
  });
});

describe('useRowPresence (B-11 §6 rows 3 and 4)', () => {
  function Row(p: { present: boolean; isNew?: boolean; gone?: () => void }): ReactElement | null {
    const { ref, mounted } = useRowPresence<HTMLLIElement>(p.present, {
      isNew: p.isNew,
      onGone: p.gone,
    });
    return mounted ? h('li', { ref, 'data-row': '1' }, 'row') : null;
  }
  const row = (): HTMLElement | null => host.querySelector('[data-row]');

  it('a row that is already there does not animate', () => {
    render(h(Row, { present: true }));
    expect(calls).toHaveLength(0);
    expect(row()).not.toBeNull();
  });

  it('a new row slides down 8 px and fades in, with a 1.2 s highlight', () => {
    render(h(Row, { present: true, isNew: true }));
    const enter = calls.find((c) => scale(c).includes('-8px'));
    expect(enter).toBeDefined();
    expect(enter?.target).toBe(row());
    const hl = calls.find((c) => Number(c.opts.duration) === 1200);
    expect(hl).toBeDefined();
    expect(hl?.target.classList.contains('al-row-hl')).toBe(true);
    expect(calls).toHaveLength(2);
    act(() => hl?.anim.finish());
    expect(row()?.querySelector('.al-row-hl')).toBeNull();
  });

  it('a row coming back (false to true) enters', () => {
    render(h(Row, { present: false }));
    expect(row()).toBeNull();
    render(h(Row, { present: true }));
    expect(calls.some((c) => scale(c).includes('-8px'))).toBe(true);
  });

  it('a leaving row collapses its height and is removed when the motion ends', () => {
    const gone = vi.fn();
    render(h(Row, { present: true, gone }));
    render(h(Row, { present: false, gone }));
    expect(row()).not.toBeNull();
    const leave = calls.find((c) => scale(c).includes('height'));
    expect(leave).toBeDefined();
    expect(gone).not.toHaveBeenCalled();
    act(() => leave?.anim.finish());
    expect(row()).toBeNull();
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('leaving then coming back reverses the motion from where it is (no restart)', () => {
    render(h(Row, { present: true }));
    render(h(Row, { present: false }));
    const leave = calls.find((c) => scale(c).includes('height')) as Call;
    const n = calls.length;
    render(h(Row, { present: true }));
    expect(leave.anim.reverse).toHaveBeenCalledTimes(1);
    expect(leave.anim.cancel).not.toHaveBeenCalled();
    expect(calls).toHaveLength(n);
    act(() => leave.anim.finish());
    expect(row()).not.toBeNull();
  });

  it('with reduced motion rows come and go instantly', () => {
    reducedQuery = true;
    const gone = vi.fn();
    render(h(Row, { present: true, isNew: true, gone }));
    expect(row()).not.toBeNull();
    render(h(Row, { present: false, gone }));
    expect(row()).toBeNull();
    expect(calls).toHaveLength(0);
    expect(gone).toHaveBeenCalledTimes(1);
  });
});

describe('nudge (B-11 §6 row 13)', () => {
  it('moves 4 px sideways once', () => {
    const el = document.createElement('div');
    nudge(el, false);
    expect(calls).toHaveLength(1);
    expect(scale(calls[0] as Call)).toContain('4px');
    expect(Number(calls[0]?.opts.duration)).toBe(120);
    expect(calls[0]?.opts.iterations ?? 1).toBe(1);
  });

  it('does nothing with reduced motion or without an element', () => {
    nudge(document.createElement('div'), true);
    nudge(null, false);
    expect(calls).toHaveLength(0);
  });
});
