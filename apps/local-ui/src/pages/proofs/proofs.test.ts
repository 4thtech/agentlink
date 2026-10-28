// @vitest-environment jsdom
// M1-11c-a4: the Proofs and credits page (d1 Local-proofs with DESIGN-ADJ-1 PR-1, X-4, X-6; 11 §5,
// §6.2; UX audit 5b).
//
// - Credits lead with "N proofs left"; the dollar balance is small; no Agent ID, QR code, address,
//   network or token anywhere in the default view (PR-1: they live in Advanced).
// - "Add credits" shows only where the agent can be paid (M1-11c-a4c: the Gnosis test network); the
//   address and QR code appear only after the owner opens it. Elsewhere the not-available line
//   stays; there is no free test credits button (D-120 (3)).
// - An empty list shows one next step: what to ask the AI.
// - Server values render as text; a row the page does not recognise is left out. Reads only: the
//   page never sends anything but GET.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { ProofsPage, type ProofsPageProps } from './index.js';
import { PROOFS_STRINGS, priceLine } from './strings.js';

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
  readonly headers: Headers;
  readonly body: unknown;
}

type Routes = Record<string, unknown>;

/** A non-200 answer (the shared route answers, route-types.ts). */
class Answer {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}
const NOT_SET_UP = new Answer(409, { error: 'not_set_up' });
const UNAVAILABLE = new Answer(503, { error: 'unavailable' });

function server(routes: Routes): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    const key = (init?.method ?? 'GET') === 'GET' ? url : `${init?.method ?? ''} ${url}`;
    const body = routes[key];
    if (body === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    if (body instanceof Error) return Promise.reject(body);
    const answer = body instanceof Answer ? body : new Answer(200, body);
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { calls, fetch: fetchFn as typeof fetch };
}

const LIST = '/api/ui/proofs?limit=20';
const CREDITS = '/api/ui/proofs/credits';
const TOP_UP = '/api/ui/proofs/top-up';
const NO_TOP_UP = { status: 'ok', networks: [{ network: 'base-test', method: 'coming_soon' }] };
const OK_CREDITS = {
  status: 'ok',
  proofsLeft: 48,
  balance: '$4.80',
  price: '$0.25',
  test: true,
  partial: false,
};
const T1 = Date.UTC(2026, 9, 12, 14, 2) / 1000;
const T2 = Date.UTC(2026, 9, 12, 9, 14) / 1000;

async function mount(routes: Routes): Promise<Call[]> {
  const s = server(routes);
  const api = createApiClient({ fetch: s.fetch, token: 't' });
  await act(async () => {
    root.render(h<ProofsPageProps>(ProofsPage, { api }));
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
    await mount({
      [LIST]: { status: 'ok', items: [] },
      [CREDITS]: OK_CREDITS,
      [TOP_UP]: NO_TOP_UP,
    });
    const card = host.querySelector('section[aria-label="Credits"]');
    expect(card).not.toBeNull();
    const big = card?.querySelector('.al-credits-bal');
    expect(big?.textContent).toBe('48 proofs left');
    expect(card?.textContent).toContain('$4.80');
    expect(card?.textContent).toContain(PROOFS_STRINGS.testCredits);
    // M1-PAY-CONFIRM-b (b11 §19.4): the trust line under the credits.
    expect(card?.textContent).toContain('Your credits stay yours; 4thTech never holds them.');
    expect(card?.textContent).toContain(PROOFS_STRINGS.addCreditsNotAvailable);
    // The price comes from the server (core's schedule), never a literal in the page.
    expect(text()).toContain(priceLine('$0.25'));
    expect(text()).not.toContain('$0.10');
  });

  it('UX-031-QUICKWINS: with 0 test credits, says free test credits arrive with the first proof', async () => {
    await mount({
      [LIST]: { status: 'ok', items: [] },
      [CREDITS]: { ...OK_CREDITS, proofsLeft: 0, balance: '$0.00' },
      [TOP_UP]: NO_TOP_UP,
    });
    const card = host.querySelector('section[aria-label="Credits"]');
    expect(card?.textContent).toContain(
      'Free test credits arrive automatically with your first proof.',
    );
  });

  it('UX-031-QUICKWINS: the first-proof line is absent once there are credits', async () => {
    await mount({
      [LIST]: { status: 'ok', items: [] },
      [CREDITS]: OK_CREDITS,
      [TOP_UP]: NO_TOP_UP,
    });
    expect(text()).not.toContain('arrive automatically');
  });

  it('says "1 proof left" for one', async () => {
    await mount({
      [LIST]: { status: 'ok', items: [] },
      [CREDITS]: { ...OK_CREDITS, proofsLeft: 1, balance: '$0.10' },
    });
    expect(host.querySelector('.al-credits-bal')?.textContent).toBe('1 proof left');
  });

  it('without a network to pay on: no Add credits, no free test credits button, no QR code', async () => {
    await mount({
      [LIST]: { status: 'ok', items: [] },
      [CREDITS]: OK_CREDITS,
      [TOP_UP]: NO_TOP_UP,
    });
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

  it('only reads on load', async () => {
    const calls = await mount({ [LIST]: { status: 'ok', items: [] }, [CREDITS]: OK_CREDITS });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET']);
    expect(calls.map((c) => c.url).sort()).toEqual([CREDITS, LIST, TOP_UP].sort());
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
      [CREDITS]: { ...OK_CREDITS, balance: '<img src=x onerror=alert(1)>', price: '<b>1</b>' },
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
      [CREDITS]: UNAVAILABLE,
    });
    expect(text()).toContain(PROOFS_STRINGS.creditsUnavailable);
    expect(text()).not.toContain('A proof costs');
    act(() => root.unmount());
    root = createRoot(host);
    await mount({
      [LIST]: { status: 'ok', items: [] },
      [CREDITS]: { ...OK_CREDITS, partial: true },
    });
    expect(text()).toContain(PROOFS_STRINGS.creditsPartial);
  });

  it('shows the not-set-up state when there is no agent yet', async () => {
    await mount({
      [LIST]: NOT_SET_UP,
      [CREDITS]: NOT_SET_UP,
    });
    expect(host.querySelector('.al-empty')?.textContent).toContain(PROOFS_STRINGS.notSetUp);
    expect(host.querySelector('section[aria-label="Credits"]')).toBeNull();
  });

  it('shows the not-set-up state from either read alone', async () => {
    await mount({ [LIST]: NOT_SET_UP, [CREDITS]: OK_CREDITS });
    expect(host.querySelector('.al-empty')?.textContent).toContain(PROOFS_STRINGS.notSetUp);
  });

  it('treats a malformed price as credits it cannot check', async () => {
    await mount({
      [LIST]: { status: 'ok', items: [] },
      [CREDITS]: { ...OK_CREDITS, price: '10c' },
    });
    expect(text()).toContain(PROOFS_STRINGS.creditsUnavailable);
    expect(host.querySelector('.al-credits-bal')).toBeNull();
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

// M1-11c-a4c: Add credits by QR (Chiado now) and Withdraw credits (D-122, D-123; 11 §5.6; 12 §4.4).
describe('Add credits and Withdraw credits (M1-11c-a4c)', () => {
  const AGENT = '0x71c4000000000000000000000000000000009a2e';
  const ADDABLE = '4990000000000000000';
  const CREDIT_UNITS = '2000000000000000000';
  const GNOSIS = {
    network: 'gnosis-test',
    method: 'address',
    available: true,
    address: AGENT,
    received: '$5.00',
    addable: { usd: '$4.99', amount: ADDABLE },
    credits: { usd: '$2.00', amount: CREDIT_UNITS },
  };
  const TOP = {
    status: 'ok',
    networks: [{ network: 'base-test', method: 'coming_soon' }, GNOSIS],
  };
  const base = (extra: Routes = {}): Routes => ({
    [LIST]: { status: 'ok', items: [] },
    [CREDITS]: OK_CREDITS,
    [TOP_UP]: TOP,
    ...extra,
  });
  const button = (label: string): HTMLButtonElement | undefined =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  const click = async (label: string): Promise<void> => {
    const b = button(label);
    expect(b, label).toBeDefined();
    await act(async () => {
      b?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  const typeCode = async (code: string): Promise<void> => {
    const input = host.querySelector<HTMLInputElement>('input[type="password"]');
    expect(input).not.toBeNull();
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(input, code);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
  };
  const decodeInput = (header: string | null): unknown => {
    const b64 = (header ?? '').replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
  };

  it('the default view stays plain: an Add credits button, no address, QR or network yet', async () => {
    await mount(base());
    expect(button(PROOFS_STRINGS.addCredits)).toBeDefined();
    // IR-M1-11c-a4c-1 L-1: Withdraw credits is under Advanced, not in the default view.
    expect(button(PROOFS_STRINGS.withdraw)).toBeUndefined();
    expect(button(PROOFS_STRINGS.advanced)?.getAttribute('aria-expanded')).toBe('false');
    expect(text()).not.toMatch(/wallet|\bgas\b|seed phrase|transaction|address|network|0x/i);
    expect(host.querySelector('svg[aria-label]')).toBeNull();
  });

  it('opens the QR code and copy button for the agent address, on the Gnosis test network', async () => {
    await mount(base());
    await click(PROOFS_STRINGS.addCredits);
    const panel = host.querySelector('section[aria-label="Add credits"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('Gnosis test network');
    expect(panel?.textContent).toContain(AGENT);
    const qr = panel?.querySelector('svg[aria-label]');
    expect(qr?.getAttribute('aria-label')).toBe(PROOFS_STRINGS.qrLabel);
    expect(qr?.getAttribute('data-value')).toBe(AGENT);
    expect(qr?.querySelectorAll('rect').length).toBeGreaterThan(50);
    // The 11 §5.6 privacy note, once for this method.
    expect(panel?.textContent).toContain(
      'The account you add credits from is publicly linked to your agent. For more privacy, use free test credits or a separate account only for AgentLink.',
    );
    expect(panel?.textContent).toContain('Base test network: coming soon');
  });

  it('copies the address', async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t: string) => (copied.push(t), Promise.resolve()) },
    });
    await mount(base());
    await click(PROOFS_STRINGS.addCredits);
    await click(PROOFS_STRINGS.copyAddress);
    expect(copied).toEqual([AGENT]);
    expect(text()).toContain(PROOFS_STRINGS.copied);
  });

  it('no QR without a way to turn funds into credits: only Base test network, coming soon', async () => {
    await mount(base({ [TOP_UP]: NO_TOP_UP }));
    expect(button(PROOFS_STRINGS.addCredits)).toBeUndefined();
    expect(host.querySelector('svg[aria-label]')).toBeNull();
    expect(text()).not.toContain(AGENT);
  });

  it('drops an unknown network and a malformed address', async () => {
    await mount(
      base({
        [TOP_UP]: {
          status: 'ok',
          networks: [
            { ...GNOSIS, network: 'gnosis' },
            { ...GNOSIS, address: '0xZZ' },
            { ...GNOSIS, address: `${AGENT}<b>` },
          ],
        },
      }),
    );
    expect(button(PROOFS_STRINGS.addCredits)).toBeUndefined();
  });

  it('turns received funds into credits after a confirm screen and the owner code', async () => {
    const calls = await mount(base({ [`POST ${TOP_UP}`]: { status: 'done' } }));
    await click(PROOFS_STRINGS.addCredits);
    expect(text()).toContain('$4.99');
    // UX2-e2 (B-11 §23.1): the Arrived step's one button names the amount.
    await click('Add $4.99 to your credits');
    const confirm = host.querySelector('section[aria-label="Confirm"]');
    expect(confirm?.textContent).toContain('$4.99');
    expect(confirm?.textContent).toContain('Gnosis test network');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await typeCode('7K2M-9QXA');
    await click(PROOFS_STRINGS.confirm);
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe(TOP_UP);
    expect(post?.headers.get('content-type')).toBe('application/octet-stream');
    expect(post?.headers.get('x-agentlink-csrf')).toBe('t');
    expect(decodeInput(post?.headers.get('x-agentlink-input') ?? null)).toEqual({
      network: 'gnosis-test',
      amount: ADDABLE,
    });
    // The owner code is the body only, never in the URL or the input header.
    expect(post?.body).toBe('7K2M-9QXA');
    expect(post?.url).not.toContain('7K2M');
    // UX2-e2 (B-11 §23.1): submitted is not added; the tracker waits for the credits read.
    expect(text()).toContain('Adding to your credits…');
    expect(text()).not.toContain(PROOFS_STRINGS.done);
  });

  it('withdraws credits to the agent own account after a confirm screen', async () => {
    const calls = await mount(base({ [`POST /api/ui/proofs/withdraw`]: { status: 'done' } }));
    await click(PROOFS_STRINGS.advanced);
    expect(button(PROOFS_STRINGS.advanced)?.getAttribute('aria-expanded')).toBe('true');
    await click(PROOFS_STRINGS.withdraw);
    const confirm = host.querySelector('section[aria-label="Confirm"]');
    expect(confirm?.textContent).toContain('$2.00');
    expect(confirm?.textContent).toContain("Your agent's own account");
    expect(confirm?.textContent).toContain(AGENT);
    await typeCode('7K2M-9QXA');
    await click(PROOFS_STRINGS.confirm);
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/ui/proofs/withdraw');
    expect(decodeInput(post?.headers.get('x-agentlink-input') ?? null)).toEqual({
      network: 'gnosis-test',
      amount: CREDIT_UNITS,
    });
  });

  it('cancel sends nothing; a wrong owner code says so', async () => {
    const calls = await mount(
      base({ [`POST ${TOP_UP}`]: new Answer(403, { status: 'presence_rejected' }) }),
    );
    await click(PROOFS_STRINGS.advanced);
    await click(PROOFS_STRINGS.withdraw);
    await click(PROOFS_STRINGS.cancel);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await click(PROOFS_STRINGS.addCredits);
    await click('Add $4.99 to your credits');
    await typeCode('0000-0000');
    await click(PROOFS_STRINGS.confirm);
    expect(text()).toContain(PROOFS_STRINGS.wrongCode);
  });

  it('nothing received yet: no button to add; the tracker waits for the funds (UX2-e2)', async () => {
    await mount(
      base({
        [TOP_UP]: {
          status: 'ok',
          networks: [{ ...GNOSIS, received: '$0.00', addable: { usd: '$0.00', amount: '0' } }],
        },
      }),
    );
    await click(PROOFS_STRINGS.addCredits);
    expect([...host.querySelectorAll('button')].some((b) => /^Add \$/.test(b.textContent ?? ''))).toBe(
      false,
    );
    expect(text()).toContain('Waiting for your funds');
  });
});
