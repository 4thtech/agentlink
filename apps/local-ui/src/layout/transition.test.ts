// @vitest-environment jsdom
// UI-REFRESH-f (S1): route changes use document.startViewTransition where it exists (B-11 §6 row 11,
// plan §5). It is never called with reduced motion (the system setting or the app's own), when the
// browser lacks it, for a replace (redirect) or a navigation to the same path; the address changes
// at once either way, so navigation is never delayed; a throwing API falls back to an instant change.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigate, AppRoutes } from '../router.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Doc = { startViewTransition?: unknown };
let host: HTMLElement;
let root: Root;
let svt: ReturnType<typeof vi.fn>;
const realMatchMedia = window.matchMedia;

function mediaReduce(reduce: boolean): void {
  window.matchMedia = ((q: string) => ({
    matches: reduce && q.includes('prefers-reduced-motion'),
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  svt = vi.fn((cb: () => void) => {
    cb();
    return {
      finished: Promise.resolve(),
      ready: Promise.resolve(),
      skipTransition: () => undefined,
    };
  });
  (document as unknown as Doc).startViewTransition = svt;
  mediaReduce(false);
  history.replaceState(null, '', '/settings/rules');
  act(() => root.render(h(AppRoutes)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (document as unknown as Doc).startViewTransition;
  document.documentElement.removeAttribute('data-motion');
  window.matchMedia = realMatchMedia;
});

const title = (): string | null | undefined => host.querySelector('main h1')?.textContent;

describe('route transitions', () => {
  it('wraps a navigation to another page in startViewTransition, and the page changes', () => {
    act(() => navigate('/settings/files'));
    expect(svt).toHaveBeenCalledTimes(1);
    expect(location.pathname).toBe('/settings/files');
    expect(title()).toBe('Files');
  });

  it('changes the address before the callback runs (navigation is never delayed)', () => {
    let seen = '';
    svt.mockImplementation((cb: () => void) => {
      seen = location.pathname;
      cb();
      return { finished: Promise.resolve() };
    });
    act(() => navigate('/settings/files'));
    expect(seen).toBe('/settings/files');
  });

  it('also covers a click on a nav link', () => {
    const link = host.querySelector<HTMLAnchorElement>('nav a[href="/settings/files"]');
    act(() => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(svt).toHaveBeenCalledTimes(1);
    expect(title()).toBe('Files');
  });

  it('is not called when the browser has no startViewTransition (instant change)', () => {
    delete (document as unknown as Doc).startViewTransition;
    act(() => navigate('/settings/files'));
    expect(title()).toBe('Files');
  });

  it('is not called with the app setting Reduce motion on', () => {
    document.documentElement.setAttribute('data-motion', 'reduced');
    act(() => navigate('/settings/files'));
    expect(svt).not.toHaveBeenCalled();
    expect(title()).toBe('Files');
  });

  it('is not called when the system asks for reduced motion', () => {
    mediaReduce(true);
    act(() => navigate('/settings/files'));
    expect(svt).not.toHaveBeenCalled();
    expect(title()).toBe('Files');
  });

  it('is not called for a replace (redirects) or for the same path', () => {
    act(() => navigate('/settings/files', true));
    expect(svt).not.toHaveBeenCalled();
    act(() => navigate('/settings/files'));
    expect(svt).not.toHaveBeenCalled();
  });

  it('is not called for the /settings redirect', () => {
    act(() => navigate('/settings'));
    expect(location.pathname).toBe('/settings/backup');
    expect(title()).toBe('Backup');
    // At most the one call for the click itself; the redirect (a replace) adds none.
    expect(svt.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('falls back to an instant change if the API throws', () => {
    svt.mockImplementation(() => {
      throw new Error('not allowed now');
    });
    act(() => navigate('/settings/files'));
    expect(title()).toBe('Files');
  });

  it('follows the browser back button without a transition (the browser animates that itself)', () => {
    act(() => {
      history.pushState(null, '', '/settings/backup');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(svt).not.toHaveBeenCalled();
    expect(title()).toBe('Backup');
  });
});
