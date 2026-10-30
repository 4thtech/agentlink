// @vitest-environment jsdom
// W4-MOTION-KIT (S0): the same-document View Transition helper. Where the browser has no
// `document.startViewTransition`, or it throws, the update still runs exactly once and nothing waits.
// Where it has one: the update runs inside it, a running transition is skipped first (interruptible),
// the shared-element name sits on the source only for the old snapshot and on the target only for
// the new one, and rejected promises never leak. Reduced motion keeps the transition (a crossfade):
// the stylesheet turns the moves into fades, for the system setting and for the app's own setting.
import { act, createElement as h, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import motionCss from './motion.css?raw';
import {
  VT_CLASS,
  VT_SHARED_ATTR,
  startViewTransition,
  useViewTransition,
  viewTransitionsSupported,
} from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeTransition {
  finished: Promise<void>;
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
  skipTransition: ReturnType<typeof vi.fn>;
  resolve: () => void;
  reject: (e: unknown) => void;
}

// The DOM types already declare startViewTransition; the tests swap it for a fake or remove it.
const doc = (): { startViewTransition?: unknown } =>
  document as unknown as { startViewTransition?: unknown };

let started: FakeTransition[];
/** A fake API that runs the update at once (like Chromium does after the snapshot). */
function installFake(): void {
  started = [];
  doc().startViewTransition = vi.fn((cb: () => void) => {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const finished = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const t: FakeTransition = {
      finished,
      ready: Promise.resolve(),
      updateCallbackDone: Promise.resolve(),
      skipTransition: vi.fn(),
      resolve,
      reject,
    };
    started.push(t);
    // Like the browser: an update that throws never escapes startViewTransition itself.
    try {
      cb();
    } catch {
      // reported through updateCallbackDone in a real browser
    }
    return t;
  });
}

afterEach(() => {
  delete doc().startViewTransition;
  document.body.replaceChildren();
});

describe('startViewTransition without browser support', () => {
  it('reports no support, runs the update once and resolves at once', async () => {
    expect(viewTransitionsSupported()).toBe(false);
    const update = vi.fn();
    const run = startViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(run.supported).toBe(false);
    await expect(run.finished).resolves.toBeUndefined();
    expect(() => run.skip()).not.toThrow();
  });

  it('never leaves a shared name behind', () => {
    const from = document.body.appendChild(document.createElement('div'));
    const to = document.createElement('div');
    startViewTransition(() => document.body.appendChild(to), { from, to: () => to });
    expect(from.hasAttribute(VT_SHARED_ATTR)).toBe(false);
    expect(to.hasAttribute(VT_SHARED_ATTR)).toBe(false);
  });

  it('runs the update once when the browser call throws', () => {
    doc().startViewTransition = vi.fn(() => {
      throw new Error('InvalidStateError');
    });
    const update = vi.fn();
    const from = document.body.appendChild(document.createElement('div'));
    const run = startViewTransition(update, { from });
    expect(update).toHaveBeenCalledTimes(1);
    expect(run.supported).toBe(false);
    expect(from.hasAttribute(VT_SHARED_ATTR)).toBe(false);
  });
});

describe('startViewTransition with browser support', () => {
  beforeEach(installFake);

  it('runs the update inside the transition', () => {
    expect(viewTransitionsSupported()).toBe(true);
    const update = vi.fn();
    const run = startViewTransition(update);
    expect(doc().startViewTransition).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(run.supported).toBe(true);
  });

  it('skips a running transition before it starts the next one (interruptible)', () => {
    startViewTransition(() => {});
    startViewTransition(() => {});
    expect(started[0]?.skipTransition).toHaveBeenCalledTimes(1);
    expect(started[1]?.skipTransition).not.toHaveBeenCalled();
  });

  it('does not skip a transition that has finished', async () => {
    startViewTransition(() => {});
    started[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    startViewTransition(() => {});
    expect(started[0]?.skipTransition).not.toHaveBeenCalled();
  });

  it('moves the shared name from the source (old snapshot) to the target (new snapshot)', async () => {
    const from = document.body.appendChild(document.createElement('li'));
    const to = document.createElement('header');
    let seenOnFrom = false;
    let seenOnFromDuringUpdate = true;
    doc().startViewTransition = vi.fn((cb: () => void) => {
      seenOnFrom = from.hasAttribute(VT_SHARED_ATTR);
      cb();
      seenOnFromDuringUpdate = from.hasAttribute(VT_SHARED_ATTR);
      return {
        finished: Promise.resolve(),
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        skipTransition: vi.fn(),
      } as unknown as FakeTransition;
    });
    const run = startViewTransition(() => document.body.appendChild(to), {
      from,
      to: () => to,
    });
    expect(seenOnFrom).toBe(true);
    expect(seenOnFromDuringUpdate).toBe(false);
    expect(to.hasAttribute(VT_SHARED_ATTR)).toBe(true);
    await run.finished;
    expect(to.hasAttribute(VT_SHARED_ATTR)).toBe(false);
  });

  it('keeps one shared name on the page at a time', () => {
    const stale = document.body.appendChild(document.createElement('div'));
    stale.setAttribute(VT_SHARED_ATTR, '');
    const to = document.body.appendChild(document.createElement('div'));
    startViewTransition(() => {}, { to: () => to });
    expect(document.querySelectorAll(`[${VT_SHARED_ATTR}]`)).toHaveLength(1);
    expect(to.hasAttribute(VT_SHARED_ATTR)).toBe(true);
  });

  it('swallows a rejected transition (skipped or failed) and still cleans up', async () => {
    const to = document.createElement('div');
    const run = startViewTransition(() => document.body.appendChild(to), { to: () => to });
    started[0]?.reject(new DOMException('Skipped', 'AbortError'));
    await expect(run.finished).resolves.toBeUndefined();
    expect(to.hasAttribute(VT_SHARED_ATTR)).toBe(false);
  });

  it('an interrupted run never strips the shared name a newer run claimed', async () => {
    const to = document.body.appendChild(document.createElement('div'));
    startViewTransition(() => {}, { to: () => to });
    const second = startViewTransition(() => {}, { to: () => to });
    // The first, skipped run settles after the second one named the same element.
    started[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(to.hasAttribute(VT_SHARED_ATTR)).toBe(true);
    started[1]?.resolve();
    await second.finished;
    expect(to.hasAttribute(VT_SHARED_ATTR)).toBe(false);
  });

  it('an interrupted run never strips the name of a newer run that starts from its target', async () => {
    const row = document.body.appendChild(document.createElement('li'));
    let seen = false;
    startViewTransition(() => {}, { to: () => row });
    // The next run starts from the same element; the browser defers its update past a microtask.
    doc().startViewTransition = vi.fn((cb: () => void) => {
      const t = {
        finished: new Promise<void>(() => undefined),
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        skipTransition: vi.fn(),
      };
      void Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => {
          seen = row.hasAttribute(VT_SHARED_ATTR);
          cb();
        });
      return t;
    });
    startViewTransition(() => {}, { from: row });
    started[0]?.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toBe(true);
  });

  it('rethrows an update that throws inside the transition, like the direct path', () => {
    const boom = new Error('update failed');
    const from = document.body.appendChild(document.createElement('div'));
    expect(() =>
      startViewTransition(
        () => {
          throw boom;
        },
        { from },
      ),
    ).toThrow(boom);
    expect(from.hasAttribute(VT_SHARED_ATTR)).toBe(false);
    expect(started[0]?.skipTransition).toHaveBeenCalled();
  });

  it('skip() skips the transition it started', () => {
    const run = startViewTransition(() => {});
    run.skip();
    expect(started[0]?.skipTransition).toHaveBeenCalledTimes(1);
  });
});

describe('useViewTransition', () => {
  let host: HTMLElement;
  let root: Root;
  beforeEach(() => {
    installFake();
    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
  });

  it('commits a React state change synchronously inside the transition', () => {
    let start!: ReturnType<typeof useViewTransition>['start'];
    let committedInside = '';
    function Page(): ReactElement {
      const vt = useViewTransition();
      const [route, setRoute] = useState('home');
      start = (u, o) => vt.start(u, o);
      (globalThis as { go?: () => void }).go = () => setRoute('people');
      return h('main', { className: VT_CLASS.main }, route);
    }
    act(() => root.render(h(Page)));
    doc().startViewTransition = vi.fn((cb: () => void) => {
      cb();
      committedInside = host.textContent ?? '';
      return {
        finished: Promise.resolve(),
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        skipTransition: vi.fn(),
      } as unknown as FakeTransition;
    });
    act(() => {
      start(() => (globalThis as { go?: () => void }).go?.());
    });
    expect(committedInside).toBe('people');
  });

  it('reports support', () => {
    let supported: boolean | undefined;
    function Probe(): null {
      supported = useViewTransition().supported;
      return null;
    }
    act(() => root.render(h(Probe)));
    expect(supported).toBe(true);
  });
});

describe('the view-transition stylesheet', () => {
  const flat = motionCss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');

  it('names the fixed regions and the shared element by class and attribute, never inline', () => {
    for (const [region, cls] of Object.entries(VT_CLASS)) {
      expect(flat, region).toMatch(
        new RegExp(`\\.${cls} \\{ view-transition-name: al-${region}; \\}`),
      );
    }
    expect(flat).toContain(`[${VT_SHARED_ATTR}] { view-transition-name: al-shared; }`);
  });

  it('springs the page change with the tokens', () => {
    expect(flat).toMatch(/::view-transition-group\(al-main\) \{[^}]*var\(--al-duration-page\)/);
    expect(flat).toMatch(/::view-transition-group\(al-main\) \{[^}]*var\(--al-easing-spring\)/);
  });

  it('turns every move into a fade under reduced motion, for both switches', () => {
    for (const scope of [
      /@media \(prefers-reduced-motion: reduce\) \{[^@]*::view-transition-group\(\*\) \{ animation: none !important; \}/,
      /:root\[data-motion='reduced'\]::view-transition-group\(\*\) \{ animation: none !important; \}/,
    ]) {
      expect(flat).toMatch(scope);
    }
    expect(flat).toMatch(
      /:root\[data-motion='reduced'\]::view-transition-new\(\*\) \{ animation: al-fade-in var\(--al-duration-fade\)/,
    );
  });

  it('enters a route with a fade-up where the browser has no View Transitions', () => {
    expect(flat).toMatch(
      /@supports not \(view-transition-name: none\) \{ \.al-route \{ animation: al-enter/,
    );
  });
});
