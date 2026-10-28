// @vitest-environment jsdom
// UI-REFRESH-u (S1): parts of the app load on first use. A fast load shows nothing extra, a slow one
// shows the skeleton, a failed one a plain retry message; the Under the hood panel is not fetched
// while the switch is off; a route change waits briefly for its page and still uses the view
// transition (and skips it with reduced motion).
import { createElement as h, act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lazyPart } from './index.js';
import { LAZY_STRINGS } from './strings.js';
import { PAGE_PARTS } from './pages.js';
import { navigate } from '../router.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Real({ name }: { name: string }): ReactElement {
  return h('p', { className: 'real' }, name);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('lazyPart', () => {
  it('shows nothing for a fast load, then the part', async () => {
    const d = deferred<typeof Real>();
    const part = lazyPart<{ name: string }>(() => d.promise);
    act(() => root.render(h(part.Part, { name: 'a' })));
    expect(host.querySelector('.real')).toBeNull();
    expect(host.querySelector('.al-skeleton')).toBeNull();
    await act(async () => {
      d.resolve(Real);
      await d.promise;
    });
    expect(host.querySelector('.real')?.textContent).toBe('a');
    expect(part.ready()).toBe(true);
  });

  it('shows the skeleton after a delay when the load is slow', async () => {
    const d = deferred<typeof Real>();
    const part = lazyPart<{ name: string }>(() => d.promise);
    act(() => root.render(h(part.Part, { name: 'a' })));
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(host.querySelector('.al-skeleton')).not.toBeNull();
    await act(async () => {
      d.resolve(Real);
      await d.promise;
      vi.advanceTimersByTime(600);
    });
    expect(host.querySelector('.real')).not.toBeNull();
  });

  it('renders at once on a second visit (no gap)', async () => {
    const part = lazyPart<{ name: string }>(() => Promise.resolve(Real));
    await part.load();
    act(() => root.render(h(part.Part, { name: 'b' })));
    expect(host.querySelector('.real')?.textContent).toBe('b');
  });

  it('shows a plain retry message when the chunk fails, and loads on retry', async () => {
    const importer = vi
      .fn<() => Promise<typeof Real>>()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValueOnce(Real);
    const part = lazyPart<{ name: string }>(importer);
    await act(async () => {
      root.render(h(part.Part, { name: 'c' }));
    });
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(LAZY_STRINGS.failed);
    // The message is plain words: no error text from the failure, no technical terms.
    expect(alert?.textContent).not.toMatch(/chunk|import|module|error/i);
    const button = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === LAZY_STRINGS.retry,
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    expect(importer).toHaveBeenCalledTimes(2);
    expect(host.querySelector('.real')?.textContent).toBe('c');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('prefetchPages', () => {
  it('fetches the pages one at a time, each in an idle moment, after the first screen', async () => {
    const { prefetchPages } = await import('./pages.js');
    const queue: Array<() => void> = [];
    prefetchPages((run) => queue.push(run));
    // Nothing runs until the browser is idle.
    expect(queue).toHaveLength(1);
    let rounds = 0;
    while (queue.length > 0 && rounds < 50) {
      (queue.shift() as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      rounds += 1;
    }
    expect(rounds).toBe(Object.keys(PAGE_PARTS).length + 1);
  });
});

describe('Under the hood is fetched on use', () => {
  it('does not load the panel while the switch is off, and shows it once on', async () => {
    vi.resetModules();
    const { UnderTheHood } = await import('./hood.js');
    const ui = await import('@4thtech-io/ui');
    const Provider = ui.HoodProvider;
    act(() => root.render(h(Provider, { value: false }, h(UnderTheHood, { fields: [] }))));
    expect(host.querySelector('.al-hood')).toBeNull();
    expect(host.querySelector('.al-hood-loading')).toBeNull();
    await act(async () => {
      root.render(h(Provider, { value: true }, h(UnderTheHood, { fields: [] })));
    });
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(host.querySelector('section.al-hood')).not.toBeNull();
  });
});

describe('route change to a page that is still loading', () => {
  it('moves the address at once, waits for the chunk, then uses the view transition', async () => {
    const original = PAGE_PARTS['/settings/about'];
    const d = deferred<typeof Real>();
    const stub = lazyPart<{ name: string }>(() => d.promise);
    (PAGE_PARTS as Record<string, unknown>)['/settings/about'] = stub;
    const start = vi.fn((update: () => void) => update());
    (document as unknown as { startViewTransition?: unknown }).startViewTransition = start;
    history.replaceState(null, '', '/settings/rules');
    const seen = vi.fn();
    window.addEventListener('agentlink:navigate', seen);
    try {
      navigate('/settings/about');
      expect(location.pathname).toBe('/settings/about');
      expect(seen).not.toHaveBeenCalled();
      await act(async () => {
        d.resolve(Real);
        await d.promise;
      });
      expect(seen).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      (PAGE_PARTS as Record<string, unknown>)['/settings/about'] = original;
      delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
      window.removeEventListener('agentlink:navigate', seen);
    }
  });

  it('does not wait longer than a moment, so a slow chunk shows the skeleton instead', async () => {
    const original = PAGE_PARTS['/settings/about'];
    const stub = lazyPart<{ name: string }>(() => new Promise(() => undefined));
    (PAGE_PARTS as Record<string, unknown>)['/settings/about'] = stub;
    history.replaceState(null, '', '/settings/rules');
    const seen = vi.fn();
    window.addEventListener('agentlink:navigate', seen);
    try {
      navigate('/settings/about');
      expect(seen).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      (PAGE_PARTS as Record<string, unknown>)['/settings/about'] = original;
      window.removeEventListener('agentlink:navigate', seen);
    }
  });

  it('skips the view transition with reduced motion', async () => {
    const original = PAGE_PARTS['/settings/about'];
    const d = deferred<typeof Real>();
    (PAGE_PARTS as Record<string, unknown>)['/settings/about'] = lazyPart<{ name: string }>(
      () => d.promise,
    );
    const start = vi.fn();
    (document as unknown as { startViewTransition?: unknown }).startViewTransition = start;
    document.documentElement.dataset['motion'] = 'reduced';
    history.replaceState(null, '', '/settings/rules');
    const seen = vi.fn();
    window.addEventListener('agentlink:navigate', seen);
    try {
      navigate('/settings/about');
      await act(async () => {
        d.resolve(Real);
        await d.promise;
      });
      expect(seen).toHaveBeenCalledTimes(1);
      expect(start).not.toHaveBeenCalled();
    } finally {
      (PAGE_PARTS as Record<string, unknown>)['/settings/about'] = original;
      delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
      delete document.documentElement.dataset['motion'];
      window.removeEventListener('agentlink:navigate', seen);
    }
  });
});
