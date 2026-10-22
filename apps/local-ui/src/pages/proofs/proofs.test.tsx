// @vitest-environment jsdom
// M1-11c-a4: the Proofs and credits page (d1 Local-proofs with DESIGN-ADJ-1 PR-1, X-4, X-6; 11 §5,
// §6.2; UX audit 5b).
//
// - Credits lead with "N proofs left"; the dollar balance is small; no Agent ID, QR code, address,
//   network or token anywhere in the default view (PR-1: they live in Advanced).
// - "Add credits" stays hidden while the pay page is off (X-6), with the not-available line; there is
//   no free test credits button (owner decision D2 pending).
// - An empty list shows one next step: what to ask the AI.
// - Server values render as text; a row the page does not recognise is left out. Reads only: the
//   page never sends anything but GET.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { ProofsPage } from './index.js';
import { PROOFS_STRINGS } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

interface Call {
  readonly url: string;
  readonly method: string;
}

type Routes = Record<string, unknown>;

function server(routes: Routes): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, method: init?.method ?? 'GET' });
    const body = routes[url];
    if (body === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    if (body instanceof Error) return Promise.reject(body);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { calls, fetch: fetchFn as typeof fetch };
}

const LIST = '/api/ui/proofs?limit=20';
const CREDITS = '/api/ui/proofs/credits';
const OK_CREDITS = { status: 'ok', proofsLeft: 48, balance: '$4.80', test: true, partial: false };
const T1 = Date.UTC(2026, 9, 12, 14, 2) / 1000;
const T2 = Date.UTC(2026, 9, 12, 9, 14) / 1000;

async function mount(routes: Routes): Promise<Call[]> {
  const s = server(routes);
  const api = createApiClient({ fetch: s.fetch, token: 't' });
  await act(async () => {
    root.render(h(ProofsPage, { api }));
    await Promise.resolve();
  });
  // Let both reads settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return s.calls;
}

const text = (): string => host.textContent ?? '';

describe('ProofsPage', () => {
  it('shows proofs left first, the balance small, and the beta line on test credits', async () => {
    await mount({ [LIST]: { status: 'ok', items: [] }, [CREDITS]: OK_CREDITS });
    const card = host.querySelector('section[aria-label="Credits"]');
    expect(card).not.toBeNull();
    const big = card?.querySelector('.al-credits-bal');
    expect(big?.textContent).toBe('48 proofs left');
    expect(card?.textContent).toContain('$4.80');
    expect(card?.textContent).toContain(PROOFS_STRINGS.testCredits);
    expect(card?.textContent).toContain(PROOFS_STRINGS.addCreditsNotAvailable);
    expect(text()).toContain(PROOFS_STRINGS.price);
  });

  it('says "1 proof left" for one', async () => {
    await mount({
      [LIST]: { status: 'ok', items: [] },
      [CREDITS]: { ...OK_CREDITS, proofsLeft: 1, balance: '$0.10' },
    });
    expect(host.querySelector('.al-credits-bal')?.textContent).toBe('1 proof left');
  });

  it('has no Add credits, no free test credits button, no Agent ID and no QR code', async () => {
    await mount({ [LIST]: { status: 'ok', items: [] }, [CREDITS]: OK_CREDITS });
    const buttons = [...host.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(buttons.some((b) => /add credits/i.test(b))).toBe(false);
    expect(buttons.some((b) => /free test credits/i.test(b))).toBe(false);
    expect(text()).not.toMatch(/agent id|qr/i);
    expect(host.querySelector('img, canvas, svg[aria-label*="QR" i]')).toBeNull();
  });

  it('keeps every web3 word out of the default view', async () => {
    await mount({
      [LIST]: {
        status: 'ok',
        items: [{ direction: 'sent', state: 'recorded', createdAt: T1 }],
      },
      [CREDITS]: { ...OK_CREDITS, partial: true },
    });
    expect(text()).not.toMatch(
      /wallet|\bgas\b|seed phrase|transaction|address|chain|network|token|usdc|faucet|deposit|0x/i,
    );
  });

  it('lists proofs with direction, state and time, as a table', async () => {
    await mount({
      [LIST]: {
        status: 'ok',
        items: [
          { direction: 'sent', state: 'recorded', createdAt: T1 },
          { direction: 'received', state: 'recorded', createdAt: T2 },
          { direction: 'sent', state: 'needs-credits', createdAt: T2 },
          { direction: 'sent', state: 'failed', createdAt: T2 },
        ],
      },
      [CREDITS]: OK_CREDITS,
    });
    const rows = [...host.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toContain(PROOFS_STRINGS.sent);
    expect(rows[0]?.textContent).toContain('Proof recorded');
    expect(rows[0]?.querySelector('time')?.getAttribute('datetime')).toBe(
      new Date(T1 * 1000).toISOString(),
    );
    expect(rows[1]?.textContent).toContain(PROOFS_STRINGS.received);
    expect(rows[2]?.textContent).toContain('Proof needs credits');
    expect(rows[3]?.textContent).toContain("Proof wasn't recorded");
    expect([...host.querySelectorAll('thead th')].map((t) => t.getAttribute('scope'))).toEqual([
      'col',
      'col',
      'col',
    ]);
  });

  it('shows the empty state with what to ask the AI', async () => {
    await mount({ [LIST]: { status: 'ok', items: [] }, [CREDITS]: OK_CREDITS });
    const empty = host.querySelector('.al-empty');
    expect(empty?.textContent).toContain(PROOFS_STRINGS.emptyTitle);
    expect(empty?.querySelector('.al-empty-try')?.textContent).toBe(
      `Try: ${PROOFS_STRINGS.emptyPrompt}`,
    );
    expect(host.querySelector('table')).toBeNull();
  });

  it('loads the next page with the cursor it was given, and appends it', async () => {
    const cursor = '10~0xab';
    const calls = await mount({
      [LIST]: {
        status: 'ok',
        items: [{ direction: 'sent', state: 'recorded', createdAt: T1 }],
        nextCursor: cursor,
      },
      [`${LIST}&cursor=${encodeURIComponent(cursor)}`]: {
        status: 'ok',
        items: [{ direction: 'received', state: 'recorded', createdAt: T2 }],
      },
      [CREDITS]: OK_CREDITS,
    });
    const more = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === PROOFS_STRINGS.loadMore,
    );
    expect(more).toBeDefined();
    await act(async () => {
      more?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(
      [...host.querySelectorAll('button')].some((b) => b.textContent === PROOFS_STRINGS.loadMore),
    ).toBe(false);
    expect(calls.map((c) => c.url)).toContain(`${LIST}&cursor=${encodeURIComponent(cursor)}`);
  });

  it('only ever reads', async () => {
    const calls = await mount({ [LIST]: { status: 'ok', items: [] }, [CREDITS]: OK_CREDITS });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
    expect(calls.map((c) => c.url).sort()).toEqual([CREDITS, LIST].sort());
  });

  it('leaves out rows it does not recognise and renders server text as text', async () => {
    await mount({
      [LIST]: {
        status: 'ok',
        items: [
          { direction: 'sent', state: '<img src=x onerror=alert(1)>', createdAt: T1 },
          { direction: '<b>x</b>', state: 'recorded', createdAt: T1 },
          { direction: 'sent', state: 'recorded', createdAt: 'soon' },
          { direction: 'sent', state: 'recorded', createdAt: T1 },
        ],
        nextCursor: 'bad cursor\n',
      },
      [CREDITS]: { ...OK_CREDITS, balance: '<img src=x onerror=alert(1)>', proofsLeft: -3 },
    });
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(host.querySelector('img')).toBeNull();
    expect(host.innerHTML).not.toContain('onerror');
    expect(
      [...host.querySelectorAll('button')].some((b) => b.textContent === PROOFS_STRINGS.loadMore),
    ).toBe(false);
    // A malformed credits answer is shown as "can't check right now", never its values.
    expect(text()).toContain(PROOFS_STRINGS.creditsUnavailable);
  });

  it('says when credits cannot be checked, and when only part could be', async () => {
    await mount({
      [LIST]: { status: 'ok', items: [] },
      [CREDITS]: { status: 'unavailable' },
    });
    expect(text()).toContain(PROOFS_STRINGS.creditsUnavailable);
    act(() => root.unmount());
    root = createRoot(host);
    await mount({ [LIST]: { status: 'ok', items: [] }, [CREDITS]: { ...OK_CREDITS, partial: true } });
    expect(text()).toContain(PROOFS_STRINGS.creditsPartial);
  });

  it('shows the not-set-up state when there is no agent yet', async () => {
    await mount({
      [LIST]: { status: 'not_set_up' },
      [CREDITS]: { status: 'not_set_up' },
    });
    expect(host.querySelector('.al-empty')?.textContent).toContain(PROOFS_STRINGS.notSetUp);
    expect(host.querySelector('section[aria-label="Credits"]')).toBeNull();
  });

  it('shows a calm error when the list cannot be loaded', async () => {
    await mount({ [LIST]: new Error('offline'), [CREDITS]: OK_CREDITS });
    expect(text()).toContain(PROOFS_STRINGS.listUnavailable);
    expect(host.querySelector('.al-credits-bal')?.textContent).toBe('48 proofs left');
  });

  it('keeps the page title', async () => {
    await mount({ [LIST]: { status: 'ok', items: [] }, [CREDITS]: OK_CREDITS });
    expect(host.querySelector('h1')?.textContent).toBe('Proofs & credits');
  });
});
