// @vitest-environment jsdom
// UI-REFRESH-r (e): Proofs lows. The polling merge after "Load more" keeps every row; two rows in the
// same second do not share a key (so one finishing does not give both the proof moment); the credits
// ring is hidden from screen readers until it has filled, so it never announces 0 first.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { ProofsPage, type ProofsPageProps } from './index.js';

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

type Routes = Record<string, unknown>;
const CREDITS = '/api/ui/proofs/credits';
const TOP_UP = '/api/ui/proofs/top-up';
const OK_CREDITS = {
  status: 'ok',
  proofsLeft: 48,
  balance: '$4.80',
  price: '$0.25',
  test: true,
  partial: false,
};
const T = Date.UTC(2026, 9, 12, 14, 2) / 1000;

function server(routes: Routes): typeof fetch {
  return ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = routes[url];
    if (body === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}
async function mount(routes: Routes): Promise<void> {
  const api = createApiClient({ fetch: server(routes), token: 't' });
  await act(async () => {
    root.render(h<ProofsPageProps>(ProofsPage, { api }));
    await vi.advanceTimersByTimeAsync(0);
  });
}
const tick = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const rows = (): number => host.querySelectorAll('tbody tr').length;
const row = (createdAt: number, state = 'recorded'): Record<string, unknown> => ({
  direction: 'sent',
  state,
  createdAt,
});

describe('Load more and the polling merge', () => {
  it('keeps every row when new rows arrive at the top of a list with a second page', async () => {
    const first = Array.from({ length: 20 }, (_, i) =>
      row(T - i * 10, i === 0 ? 'recording' : 'recorded'),
    );
    const older = row(T - 500);
    const routes: Routes = {
      '/api/ui/proofs?limit=20': { status: 'ok', items: first, nextCursor: 'c2' },
      [CREDITS]: OK_CREDITS,
      [TOP_UP]: {},
    };
    // The cursor query is built by the page; answer any path with the older page.
    const base = server(routes);
    const api = createApiClient({
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('cursor=') || url.includes('c2')) {
          return Promise.resolve(
            new Response(JSON.stringify({ status: 'ok', items: [older] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return base(input, init);
      }) as typeof fetch,
      token: 't',
    });
    await act(async () => {
      root.render(h<ProofsPageProps>(ProofsPage, { api }));
      await vi.advanceTimersByTimeAsync(0);
    });
    const more = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show more');
    await act(async () => {
      more?.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(rows()).toBe(21);
    // One proof arrives at the top; the poll returns the newest 20 (the first row finishes too).
    routes['/api/ui/proofs?limit=20'] = {
      status: 'ok',
      items: [row(T + 10), ...first.slice(0, 19)].map((r, i) => (i === 1 ? row(T, 'recorded') : r)),
      nextCursor: 'c2',
    };
    await tick(5_000);
    expect(rows()).toBe(22);
  });
});

describe('row keys', () => {
  it('two proofs in the same second are separate rows: one finishing gives one proof moment', async () => {
    const routes: Routes = {
      '/api/ui/proofs?limit=20': {
        status: 'ok',
        items: [row(T, 'recording'), row(T, 'recording')],
      },
      [CREDITS]: OK_CREDITS,
      [TOP_UP]: {},
    };
    await mount(routes);
    routes['/api/ui/proofs?limit=20'] = {
      status: 'ok',
      items: [row(T, 'recorded'), row(T, 'recording')],
    };
    await tick(5_000);
    expect(host.querySelectorAll('tbody .al-moment').length).toBe(1);
  });

  it('renders rows in one second without a duplicate-key warning', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await mount({
      '/api/ui/proofs?limit=20': { status: 'ok', items: [row(T), row(T), row(T)] },
      [CREDITS]: OK_CREDITS,
      [TOP_UP]: {},
    });
    expect(rows()).toBe(3);
    expect(err).not.toHaveBeenCalled();
  });
});

describe('the credits ring', () => {
  it('is hidden from screen readers until it has filled, then announced with its value', async () => {
    await mount({
      '/api/ui/proofs?limit=20': { status: 'ok', items: [] },
      [CREDITS]: OK_CREDITS,
      [TOP_UP]: {},
    });
    const meter = host.querySelector('[role="meter"]');
    expect(meter).not.toBeNull();
    expect(meter?.getAttribute('aria-valuenow')).toBe('0');
    expect(meter?.closest('[aria-hidden="true"]')).not.toBeNull();
    await tick(100);
    const filled = host.querySelector('[role="meter"]');
    expect(filled?.getAttribute('aria-valuenow')).toBe('48');
    expect(filled?.closest('[aria-hidden="true"]')).toBeNull();
  });
});
