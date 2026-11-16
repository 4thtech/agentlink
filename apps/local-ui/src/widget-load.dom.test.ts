// @vitest-environment jsdom
// TRAY-WIDGET-UI: the popover cancels every request but a GET and reloads on any in-page navigation, so
// loading /settings/widget through the real entry point (main.tsx) must send only GETs and must not
// touch the history (no redirect, no pushState or replaceState).
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

describe('loading /settings/widget end to end', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('sends only GET requests and changes no history entry', async () => {
    history.replaceState(null, '', '/settings/widget');
    document.head.innerHTML = '<meta name="agentlink-csrf" content="t">';
    document.body.innerHTML = '<div id="root"></div>';
    const seen: string[] = [];
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      seen.push(`${method} ${String(input instanceof Request ? input.url : input)}`);
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    });
    vi.stubGlobal('fetch', fetchSpy);
    window.fetch = fetchSpy as unknown as typeof fetch;
    const push = vi.spyOn(history, 'pushState');
    const replace = vi.spyOn(history, 'replaceState');

    await import('./main.js');
    await new Promise((r) => setTimeout(r, 1_500));

    expect(location.pathname).toBe('/settings/widget');
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((s) => !/^(GET|HEAD) /.test(s))).toEqual([]);
    expect(document.querySelector('[data-block="status"]')).not.toBeNull();
  });
});
