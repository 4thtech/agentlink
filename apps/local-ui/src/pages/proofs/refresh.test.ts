// @vitest-environment jsdom
// UI-REFRESH-l (S1): the Proofs & credits refresh (B-11 §16, §15.3, §19.4; plan §6-§9).
//
// - Credits sit on a level-2 card as a ring meter that fills on load; the words stay, the amounts
//   never count up and there are no charts.
// - Skeletons on first load (no "Loading…" paragraph); an in-flight proof that finishes gets the
//   proof success moment; after adding credits, the Add credits tracker (UX2-e2, B-11 §23).
// - Under the hood (shared panel): only fields the page already receives; no address, key, code,
//   token, session, drop or presigned link; no record link (not served yet).
// - Reduced motion: the attribute and the media query reach the success moment; the page CSS has
//   no motion of its own.
import { HoodProvider } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../api/client.js';
import proofsCss from './proofs.css?raw';
import { ProofsPage, type ProofsPageProps } from './index.js';
import { PROOFS_STRINGS, priceLine } from './strings.js';

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
  delete document.documentElement.dataset['motion'];
});

type Routes = Record<string, unknown>;
const LIST = '/api/ui/proofs?limit=20';
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
const AGENT = '0x71c4000000000000000000000000000000009a2e';
const GNOSIS = {
  network: 'gnosis-test',
  method: 'address',
  available: true,
  address: AGENT,
  received: '$5.00',
  addable: { usd: '$4.99', amount: '4990000000000000000' },
  credits: { usd: '$2.00', amount: '2000000000000000000' },
};
const T1 = Date.UTC(2026, 9, 12, 14, 2) / 1000;
const EMPTY: Routes = { [LIST]: { status: 'ok', items: [] }, [CREDITS]: OK_CREDITS, [TOP_UP]: {} };
const one = (state: string): unknown => ({
  status: 'ok',
  items: [{ direction: 'sent', state, createdAt: T1 }],
});

/** Answers are read from `routes` at call time, so a test can change what the next read returns. */
function server(routes: Routes, hang = false): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (hang) return new Promise<Response>(() => undefined);
    const url = typeof input === 'string' ? input : input.toString();
    const key = (init?.method ?? 'GET') === 'GET' ? url : `${init?.method ?? ''} ${url}`;
    const body = routes[key];
    if (body === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

async function mount(routes: Routes, opts: { hood?: boolean; hang?: boolean } = {}): Promise<void> {
  const api = createApiClient({ fetch: server(routes, opts.hang === true), token: 't' });
  const page = h<ProofsPageProps>(ProofsPage, { api });
  await act(async () => {
    root.render(opts.hood === true ? h(HoodProvider, { value: true }, page) : page);
    await vi.advanceTimersByTimeAsync(0);
  });
}
const tick = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const card = (): Element | null => host.querySelector('section[aria-label="Credits"]');
const meter = (): string | null | undefined =>
  card()?.querySelector('[role="meter"]')?.getAttribute('aria-valuenow');
const button = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);

describe('credits card', () => {
  it('sits on a level-2 surface with a ring meter, and keeps the words', async () => {
    await mount(EMPTY);
    await tick(100);
    const c = card();
    expect(c?.classList.contains('al-surface--l2')).toBe(true);
    expect(c?.getAttribute('data-level')).toBe('2');
    const ring = c?.querySelector('[role="meter"]');
    expect(ring?.getAttribute('aria-label')).toBe('Credits');
    expect(ring?.getAttribute('aria-valuenow')).toBe('48');
    expect(ring?.getAttribute('aria-valuetext')).toContain('$4.80');
    expect(c?.querySelector('.al-credits-bal')?.textContent).toBe('48 proofs left');
    expect(c?.textContent).toContain('Your credits stay yours; 4thTech never holds them.');
    expect(host.textContent).toContain(priceLine('$0.25'));
  });

  it('fills on load: the ring is empty first, then holds the proofs left', async () => {
    const api = createApiClient({ fetch: server(EMPTY), token: 't' });
    const seen: string[] = [];
    const obs = new MutationObserver(() => {
      const v = meter();
      if (v !== null && v !== undefined && seen[seen.length - 1] !== v) seen.push(v);
    });
    obs.observe(host, { subtree: true, attributes: true, childList: true });
    await act(async () => {
      root.render(h<ProofsPageProps>(ProofsPage, { api }));
      await vi.advanceTimersByTimeAsync(0);
    });
    await tick(50);
    obs.disconnect();
    expect(seen[0]).toBe('0');
    expect(seen[seen.length - 1]).toBe('48');
  });

  it('amounts never animate: no number in the ring, no bar, no chart', async () => {
    await mount(EMPTY);
    const c = card();
    expect(c?.querySelector('.al-ring-center')).toBeNull();
    expect(c?.querySelector('.al-credits-bar')).toBeNull();
    expect(host.querySelector('canvas')).toBeNull();
    expect(proofsCss).not.toMatch(/@keyframes/);
  });

  it('an empty balance keeps the empty ring and the first-proof line', async () => {
    await mount({
      ...EMPTY,
      [CREDITS]: { ...OK_CREDITS, proofsLeft: 0, balance: '$0.00' },
    });
    expect(meter()).toBe('0');
    expect(card()?.textContent).toContain(PROOFS_STRINGS.firstProofFree);
  });
});

describe('first load and errors', () => {
  it('shows skeletons (not a Loading… paragraph) for the list and the credits', async () => {
    await mount({}, { hang: true });
    await tick(600);
    expect(host.querySelectorAll('.al-skeleton').length).toBeGreaterThanOrEqual(2);
    expect(host.querySelector('p[aria-busy="true"]')).toBeNull();
    expect(host.querySelector('p.al-muted')?.textContent ?? '').not.toBe('Loading…');
  });

  it('a failed re-read keeps the old values', async () => {
    const routes: Routes = { ...EMPTY, [LIST]: one('submitted') };
    await mount(routes);
    delete routes[LIST];
    delete routes[CREDITS];
    await tick(11_000);
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(card()?.querySelector('.al-credits-bal')?.textContent).toBe('48 proofs left');
  });
});

describe('new proofs and waiting for credits', () => {
  it('an in-flight proof that is recorded gets the proof success moment', async () => {
    const routes: Routes = { ...EMPTY, [LIST]: one('submitted') };
    await mount(routes);
    expect(host.querySelector('.al-moment')).toBeNull();
    routes[LIST] = one('recorded');
    await tick(11_000);
    expect(host.querySelector('tbody .al-moment')?.getAttribute('data-kind')).toBe('proof');
  });

  it('a proof that was already recorded on load shows no success moment', async () => {
    await mount({ ...EMPTY, [LIST]: one('recorded') });
    await tick(11_000);
    expect(host.querySelector('.al-moment')).toBeNull();
  });

  it('after adding credits: "Adding to your credits…" until the credits arrive (UX2-e2, B-11 §23)', async () => {
    const routes: Routes = { ...EMPTY, [TOP_UP]: { status: 'ok', networks: [GNOSIS] } };
    const api = createApiClient({ fetch: server(routes), token: 't' });
    const owner = vi
      .spyOn(api, 'owner')
      .mockResolvedValue({ kind: 'ok', status: 202, data: {} } as never);
    await act(async () => {
      root.render(h<ProofsPageProps>(ProofsPage, { api }));
      await vi.advanceTimersByTimeAsync(0);
    });
    // B-11 §23 replaces §15.3's "Waiting for your credits…" bar inside Add credits.
    expect(host.textContent).not.toContain('Waiting for your credits…');
    expect(host.textContent).not.toContain('Adding to your credits…');
    const press = (label: string) =>
      act(async () => {
        button(label)?.click();
        await vi.advanceTimersByTimeAsync(0);
      });
    await press(PROOFS_STRINGS.addCredits);
    await press('Add $4.99 to your credits');
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="password"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(input, '7K2M-9QXA');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    await press(PROOFS_STRINGS.confirm);
    expect(owner).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Adding to your credits…');
    expect(host.textContent).not.toContain('Waiting for your credits…');
    routes[CREDITS] = { ...OK_CREDITS, proofsLeft: 68, balance: '$6.80' };
    await tick(11_000);
    await tick(100);
    expect(host.textContent).not.toContain('Adding to your credits…');
    expect(host.textContent).toContain('Added to credits · $6.80 now');
    expect(meter()).toBe('68');
  });
});

describe('Under the hood', () => {
  const routes: Routes = {
    [LIST]: {
      status: 'ok',
      items: [
        { direction: 'sent', state: 'recorded', createdAt: T1 },
        { direction: 'received', state: 'recorded', createdAt: T1 - 60 },
      ],
    },
    [CREDITS]: OK_CREDITS,
    [TOP_UP]: { status: 'ok', networks: [GNOSIS] },
  };

  it('renders nothing while the switch is off', async () => {
    await mount(routes);
    expect(host.querySelector('.al-hood')).toBeNull();
  });

  it('shows what the page already receives, and no address, link, key or code', async () => {
    await mount(routes, { hood: true });
    const hood = host.querySelector('.al-hood');
    expect(hood).not.toBeNull();
    const rows = [...(hood?.querySelectorAll('.al-hood-row') ?? [])].map((r) => r.textContent);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(hood?.textContent).toContain('$0.25');
    expect(hood?.querySelector('a')).toBeNull();
    expect(hood?.textContent).not.toContain(AGENT);
    expect(hood?.textContent).not.toMatch(/0x[0-9a-f]{8}|https?:|key|code|token|session/i);
  });

  it('the default view has no record link', async () => {
    await mount(routes);
    expect(host.querySelector('a[href^="http"]')).toBeNull();
  });
});

describe('motion', () => {
  it('the page CSS has no literal durations or delays, and the DOM no inline styles', async () => {
    expect(proofsCss).not.toMatch(/\b\d+(\.\d+)?m?s\b/);
    await mount(EMPTY);
    expect(host.querySelector('[style]')).toBeNull();
  });

  it('reduced motion (attribute): the success moment is reduced', async () => {
    document.documentElement.dataset['motion'] = 'reduced';
    const routes: Routes = { ...EMPTY, [LIST]: one('submitted') };
    await mount(routes);
    routes[LIST] = one('recorded');
    await tick(11_000);
    expect(host.querySelector('tbody .al-moment')?.getAttribute('data-motion')).toBe('reduced');
    expect(meter()).toBe('48');
  });

  it('reduced motion (media query): the success moment is reduced too', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes('prefers-reduced-motion'),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const routes: Routes = { ...EMPTY, [LIST]: one('submitted') };
      await mount(routes);
      routes[LIST] = one('recorded');
      await tick(11_000);
      expect(host.querySelector('tbody .al-moment')?.getAttribute('data-motion')).toBe('reduced');
    } finally {
      window.matchMedia = original;
    }
  });
});
