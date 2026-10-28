// @vitest-environment jsdom
/// <reference types="vite/client" />
// UX2-c (S1): Files > Sent follows the real delivery. While a row is queued, or sent without a
// receipt and younger than a day, the first page is re-read every 5 s while the tab is visible,
// slower after 2 minutes and not at all after 30 minutes. A day without a receipt ends at
// "Sent · no receipt yet" (owner decision 6.1). Steps move only when the served state moves.
import axe from 'axe-core';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesPage } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RECEIVED = '/api/ui/files/received?limit=20';
const SENT = '/api/ui/files/sent?limit=20';
const AT = 1_792_000_100;
const DAY_MS = 86_400_000;
const NO_RECEIPT = 'Sent · no receipt yet';

let host: HTMLElement;
let root: Root;
let visible = true;
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(AT * 1000 + 3_600_000);
  visible = true;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const sent = (over: Record<string, unknown> = {}) => ({
  id: 'env2.00',
  to: 'Marko',
  at: AT,
  name: 'report.pdf',
  size: 1_200,
  status: 'sent',
  receipt: false,
  state: 'available',
  expiresAt: AT + 500_000,
  ...over,
});

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(items: unknown[]) {
  const routes: Record<string, unknown> = {
    [RECEIVED]: { items: [] },
    [SENT]: { items },
  };
  const calls: string[] = [];
  const fetchFn = (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    const body = routes[url];
    return Promise.resolve(
      body === undefined
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    );
  };
  await act(async () => {
    root.render(h(FilesPage, { fetch: fetchFn as typeof fetch, token: 'tok' }));
  });
  await tick(0);
  const tab = [...host.querySelectorAll<HTMLElement>('[role="tab"]')][1];
  await act(async () => tab?.click());
  await tick(0);
  return { routes, sentCalls: () => calls.filter((c) => c === SENT).length };
}

describe('Sent follows the real delivery', () => {
  it('a queued row moves to Sent without a reload', async () => {
    const s = await mount([sent({ status: 'queued' })]);
    expect(host.textContent).toContain('Waiting to send');
    s.routes[SENT] = { items: [sent({ status: 'sent' })] };
    await tick(5_000);
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('2');
    expect(host.querySelectorAll('.fl-chips')[0]?.textContent).toContain('Sent');
    expect(host.querySelectorAll('.fl-chips')[0]?.textContent).not.toContain('Waiting to send');
  });

  it('a sent row gets its receipt without a reload, and polling then stops', async () => {
    const s = await mount([sent()]);
    s.routes[SENT] = { items: [sent({ receipt: true })] };
    await tick(5_000);
    expect(host.querySelector('[data-receipt="true"]')).not.toBeNull();
    const n = s.sentCalls();
    await tick(60_000);
    expect(s.sentCalls()).toBe(n);
  });

  it('does not poll when nothing is in flight', async () => {
    const s = await mount([sent({ receipt: true }), sent({ id: 'b.00', status: 'not_delivered' })]);
    const n = s.sentCalls();
    await tick(120_000);
    expect(s.sentCalls()).toBe(n);
  });

  it('no step advances on a timer alone', async () => {
    const s = await mount([sent({ status: 'queued' })]);
    const before = host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow');
    await tick(20_000);
    expect(s.sentCalls()).toBeGreaterThan(1);
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(before);
  });

  it('does not poll while the page is hidden, and looks again when it comes back', async () => {
    const s = await mount([sent({ status: 'queued' })]);
    visible = false;
    const n = s.sentCalls();
    await tick(60_000);
    expect(s.sentCalls()).toBe(n);
    visible = true;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await tick(0);
    expect(s.sentCalls()).toBeGreaterThan(n);
  });

  it('backs off after 2 minutes and stops after 30 minutes', async () => {
    const s = await mount([sent({ status: 'queued' })]);
    let n = s.sentCalls();
    await tick(60_000);
    const early = s.sentCalls() - n;
    expect(early).toBeGreaterThanOrEqual(10);
    await tick(60_000);
    n = s.sentCalls();
    await tick(60_000);
    const late = s.sentCalls() - n;
    expect(late).toBeGreaterThan(0);
    expect(late).toBeLessThan(early / 2);
    await tick(30 * 60_000);
    n = s.sentCalls();
    await tick(10 * 60_000);
    expect(s.sentCalls()).toBe(n);
  });
});

describe('a day without a receipt', () => {
  it('ends at "Sent · no receipt yet": no progress bar, no more polling', async () => {
    vi.setSystemTime(AT * 1000 + DAY_MS + 60_000);
    const s = await mount([sent()]);
    expect(host.textContent).toContain(NO_RECEIPT);
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    const n = s.sentCalls();
    await tick(60_000);
    expect(s.sentCalls()).toBe(n);
  });

  it('a recent sent row still shows the progress and plain Sent', async () => {
    await mount([sent()]);
    expect(host.textContent).not.toContain(NO_RECEIPT);
    expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it('a confirmed old row says delivery confirmed, not the no-receipt wording', async () => {
    vi.setSystemTime(AT * 1000 + 3 * DAY_MS);
    await mount([sent({ receipt: true })]);
    expect(host.textContent).not.toContain(NO_RECEIPT);
    expect(host.querySelector('[data-receipt="true"]')).not.toBeNull();
  });
});

describe('coming back to a hidden tab', () => {
  it('restarts the polling window while a row is still in flight', async () => {
    const s = await mount([sent({ status: 'queued' })]);
    visible = false;
    await tick(31 * 60_000);
    visible = true;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await tick(0);
    const n = s.sentCalls();
    await tick(10_000);
    expect(s.sentCalls()).toBeGreaterThanOrEqual(n + 2);
  });
});

describe('reduced motion and accessibility', () => {
  afterEach(() => {
    delete (Element.prototype as { animate?: unknown }).animate;
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('with reduced motion the word changes and nothing is animated', async () => {
    const animate = vi.fn();
    (Element.prototype as { animate?: unknown }).animate = animate;
    window.matchMedia = ((q: string) => ({
      matches: q.includes('prefers-reduced-motion'),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    const s = await mount([sent({ status: 'queued' })]);
    const before = host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext');
    s.routes[SENT] = { items: [sent({ status: 'sent' })] };
    await tick(5_000);
    const after = host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext');
    expect(after).not.toBe(before);
    expect(animate).not.toHaveBeenCalled();
  });

  it('axe finds no violation with rows in flight, confirmed and giving up', async () => {
    vi.setSystemTime(AT * 1000 + DAY_MS + 60_000);
    await mount([
      sent({ id: 'a.00', status: 'queued', at: AT + DAY_MS / 1000 }),
      sent({ id: 'b.00', receipt: true }),
      sent({ id: 'c.00' }),
    ]);
    expect(host.textContent).toContain(NO_RECEIPT);
    vi.useRealTimers();
    const res = await axe.run(host, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });
});
