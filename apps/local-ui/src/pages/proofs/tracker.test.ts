// @vitest-environment jsdom
// UX2-e2 (S2, money path under owner presence): the Add credits three-step tracker (B-11 §23,
// D-137; 04 §2.5.1 `credits.deposit`; D-122, D-123).
//
// - Waiting for your funds → Arrived · $X → Added to credits. Steps move ONLY on server reads: no
//   timer advances a step, and no amount shows before the read that proves it.
// - Arrived: a top-up read returns `received` above the value it had when the panel opened (or the
//   panel opens on Arrived when `addable` is already above zero). The one button is "Add $X to your
//   credits" (`addable`), and it opens the existing confirm screen and backup code unchanged.
// - Submitted is not added: after the owner operation, "Adding to your credits…" until the credits
//   read shows a value above the one before; only then "Added to credits · $X now".
// - A failed read keeps the step with "Couldn't check. Trying again." and never goes back a step.
// - Checking: every 5 s, every 15 s after 2 minutes, stops after 30 minutes ("Stopped checking."
//   and Check again); a hidden tab reads nothing and reads once at once on return.
// - The waiting mark (UX2-e1) only on step 1, 40 px, decorative; still with reduced motion.
// - Words: funds, account, credits. Never "wallet", "deposit", "transaction" or "address".
import axe from 'axe-core';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, type ApiClient } from '../../api/client.js';
import proofsCss from './proofs.css?raw';
import { ProofsPage, type ProofsPageProps } from './index.js';
import { openTrack, track, type Track } from './top-up.js';
import type { AddressNetwork } from './top-up.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let hidden = false;
beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete document.documentElement.dataset['motion'];
});

type Routes = Record<string, unknown>;
const LIST = '/api/ui/proofs?limit=20';
const CREDITS = '/api/ui/proofs/credits';
const TOP_UP = '/api/ui/proofs/top-up';
const AGENT = '0x71c4000000000000000000000000000000009a2e';
const OK_CREDITS = {
  status: 'ok',
  proofsLeft: 48,
  balance: '$4.80',
  price: '$0.25',
  test: true,
  partial: false,
};
const NET0 = {
  network: 'gnosis-test',
  method: 'address',
  available: true,
  address: AGENT,
  received: '$0.00',
  addable: { usd: '$0.00', amount: '0' },
  credits: { usd: '$2.00', amount: '2000000000000000000' },
} as const;
const NET5 = {
  ...NET0,
  received: '$5.00',
  addable: { usd: '$4.99', amount: '4990000000000000000' },
} as const;
const topUp = (net: unknown): unknown => ({ status: 'ok', networks: [net] });
/** A failed read: the server answers 503 (any non-200 is a failed read). */
const FAIL = Symbol('fail');

function server(routes: Routes, calls: string[]): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    calls.push(method === 'GET' ? url : `${method} ${url}`);
    const body = routes[method === 'GET' ? url : `${method} ${url}`];
    if (body === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    if (body === FAIL) {
      return Promise.resolve(new Response('{"error":"unavailable"}', { status: 503 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

interface Mounted {
  readonly routes: Routes;
  readonly calls: string[];
  readonly api: ApiClient;
}

async function mount(extra: Routes = {}, fake = true): Promise<Mounted> {
  if (fake) vi.useFakeTimers();
  const routes: Routes = {
    [LIST]: { status: 'ok', items: [] },
    [CREDITS]: OK_CREDITS,
    [TOP_UP]: topUp(NET0),
    ...extra,
  };
  const calls: string[] = [];
  const api = createApiClient({ fetch: server(routes, calls), token: 't' });
  await act(async () => {
    root.render(h<ProofsPageProps>(ProofsPage, { api }));
    await settle(fake);
  });
  return { routes, calls, api };
}
async function settle(fake: boolean): Promise<void> {
  if (fake) await vi.advanceTimersByTimeAsync(0);
  else await new Promise((r) => setTimeout(r, 0));
}
const tick = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const button = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);
const press = (label: string, fake = true): Promise<void> =>
  act(async () => {
    const b = button(label);
    expect(b, label).toBeDefined();
    b?.click();
    await settle(fake);
  });
const tracker = (): HTMLElement | null => host.querySelector('.pf-track');
const steps = (): HTMLElement[] => [...(tracker()?.querySelectorAll('li') ?? [])] as HTMLElement[];
const states = (): string[] => steps().map((li) => li.dataset['state'] ?? '');
const reads = (calls: string[], path: string): number => calls.filter((c) => c === path).length;
const setHidden = (v: boolean): Promise<void> =>
  act(async () => {
    hidden = v;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
  });
const typeCode = (code: string): Promise<void> =>
  act(async () => {
    const input = host.querySelector<HTMLInputElement>('input[type="password"]');
    expect(input).not.toBeNull();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    set?.call(input, code);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
  });
const BANNED = /wallet|deposit|transaction|address|\bgas\b|seed phrase/i;

// ------------------------------------------------------------------ the state machine (pure)

describe('tracker state: steps move only on reads', () => {
  const net = (v: unknown): AddressNetwork => v as AddressNetwork;
  it('opens on Waiting when nothing is addable, on Arrived when funds are already there', () => {
    const w = openTrack(net(NET0), 1000);
    expect(w.step).toBe('waiting');
    expect(w.baseline).toBe('$0.00');
    const a = openTrack(net(NET5), 1000);
    expect(a.step).toBe('arrived');
    expect(a.arrived?.received).toBe('$5.00');
    expect(a.arrived?.addable.usd).toBe('$4.99');
  });
  it('an account that cannot be read opens on Waiting with the failed-read line, no baseline', () => {
    const s = openTrack(net({ ...NET0, available: false }), 1000);
    expect(s.step).toBe('waiting');
    expect(s.failed).toBe(true);
    expect(s.baseline).toBeUndefined();
  });
  it('the same received value keeps Waiting; a higher one is Arrived with that read', () => {
    let s: Track = openTrack(net({ ...NET0, received: '$1.00' }), 1000);
    s = track(s, { type: 'topup', net: net({ ...NET0, received: '$1.00' }), now: 2000 });
    expect(s.step).toBe('waiting');
    s = track(s, { type: 'topup', net: net(NET5), now: 3000 });
    expect(s.step).toBe('arrived');
    expect(s.arrived?.received).toBe('$5.00');
    expect(s.arrivedAt).toBe(3000);
  });
  it('a failed read keeps the step and never goes back', () => {
    let s: Track = openTrack(net(NET0), 1000);
    s = track(s, { type: 'topup', net: undefined, now: 2000 });
    expect(s.step).toBe('waiting');
    expect(s.failed).toBe(true);
    s = track(s, { type: 'topup', net: net(NET0), now: 3000 });
    expect(s.failed).toBe(false);
    s = track(s, { type: 'topup', net: net(NET5), now: 4000 });
    s = track(s, { type: 'topup', net: undefined, now: 5000 });
    s = track(s, { type: 'topup', net: net(NET0), now: 6000 });
    expect(s.step).toBe('arrived');
    expect(s.arrived?.received).toBe('$5.00');
  });
  it('submitted is not added: Added only when the credits read is above the value before', () => {
    let s: Track = openTrack(net(NET5), 1000);
    s = track(s, { type: 'armed', balance: '$4.80' });
    s = track(s, { type: 'credits', balance: '$9.79', now: 1500 });
    expect(s.step).toBe('arrived');
    s = track(s, { type: 'submitted', now: 2000 });
    expect(s.step).toBe('adding');
    s = track(s, { type: 'credits', balance: '$4.80', now: 3000 });
    expect(s.step).toBe('adding');
    s = track(s, { type: 'credits', balance: undefined, now: 4000 });
    expect(s.step).toBe('adding');
    expect(s.failed).toBe(true);
    s = track(s, { type: 'credits', balance: '$9.79', now: 5000 });
    expect(s.step).toBe('added');
    expect(s.added).toBe('$9.79');
    expect(s.addedAt).toBe(5000);
    s = track(s, { type: 'credits', balance: undefined, now: 6000 });
    expect(s.step).toBe('added');
  });
  it('without a credits value from before, Adding never turns into Added (never guesses)', () => {
    let s: Track = openTrack(net(NET5), 1000);
    s = track(s, { type: 'armed', balance: undefined });
    s = track(s, { type: 'submitted', now: 2000 });
    s = track(s, { type: 'credits', balance: '$99.00', now: 3000 });
    expect(s.step).toBe('adding');
  });
  it('a submitted event before Arrived changes nothing', () => {
    const s = track(openTrack(net(NET0), 1000), { type: 'submitted', now: 2000 });
    expect(s.step).toBe('waiting');
  });
});

// ------------------------------------------------------------------ the page

describe('step 1: Waiting for your funds', () => {
  it('shows three steps, the waiting mark at 40 px, the time hint and no amount', async () => {
    await mount();
    await press('Add credits');
    expect(steps()).toHaveLength(3);
    expect(states()).toEqual(['current', 'pending', 'pending']);
    const [one, two, three] = steps();
    expect(one?.textContent).toContain('Waiting for your funds');
    expect(one?.textContent).toContain('Usually takes about a minute.');
    expect(one?.getAttribute('aria-current')).toBe('step');
    expect(one?.textContent).toContain('step 1 of 3');
    expect(two?.textContent).toContain('Arrived');
    expect(three?.textContent).toContain('Added to credits');
    expect(tracker()?.textContent).not.toMatch(/\$/);
    const mark = tracker()?.querySelector('svg.al-waiting-mark');
    expect(mark?.getAttribute('height')).toBe('40');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    // The mark is only on step 1.
    expect(tracker()?.querySelectorAll('svg.al-waiting-mark')).toHaveLength(1);
    expect(one?.querySelector('svg.al-waiting-mark')).not.toBeNull();
    // No Add button before a read proves the funds.
    expect(
      [...host.querySelectorAll('button')].some((b) => /^Add \$/.test(b.textContent ?? '')),
    ).toBe(false);
    // The tracker sits under the QR code and account details.
    const qr = host.querySelector('section[aria-label="Add credits"] svg[aria-label]');
    expect(qr).not.toBeNull();
    expect(
      (qr as Element).compareDocumentPosition(tracker() as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('no timer advances a step: 30 minutes of unchanged reads stay on Waiting', async () => {
    const { calls } = await mount();
    await press('Add credits');
    await tick(31 * 60_000);
    expect(states()).toEqual(['current', 'pending', 'pending']);
    expect(tracker()?.textContent).not.toMatch(/\$/);
    expect(tracker()?.textContent).not.toContain('Arrived ·');
    expect(reads(calls, TOP_UP)).toBeGreaterThan(30);
  });

  it('after 10 minutes: "Still waiting…" with Show details again, which focuses the details', async () => {
    await mount();
    await press('Add credits');
    await tick(9 * 60_000);
    expect(tracker()?.textContent).toContain('Usually takes about a minute.');
    await tick(61_000);
    expect(tracker()?.textContent).toContain(
      'Still waiting. Check that you sent it to this account.',
    );
    expect(tracker()?.textContent).not.toContain('Usually takes about a minute.');
    // Nothing turns red: nothing failed.
    expect(tracker()?.querySelector('[role="alert"]')).toBeNull();
    await press('Show details again');
    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.closest('section[aria-label="Add credits"]')).not.toBeNull();
    expect(focused?.querySelector('svg[aria-label]')).not.toBeNull();
    expect(focused?.textContent).toContain(AGENT);
    expect(states()).toEqual(['current', 'pending', 'pending']);
  });

  it('a failed read keeps the step and says "Couldn\'t check. Trying again."', async () => {
    const { routes } = await mount();
    await press('Add credits');
    routes[TOP_UP] = FAIL;
    await tick(5_000);
    expect(states()).toEqual(['current', 'pending', 'pending']);
    expect(tracker()?.textContent).toContain("Couldn't check. Trying again.");
    routes[TOP_UP] = topUp(NET0);
    await tick(5_000);
    expect(tracker()?.textContent).not.toContain("Couldn't check.");
  });

  it('an unreadable account (available: false) is a failed read too, never an amount', async () => {
    const { routes } = await mount({
      [TOP_UP]: topUp({ ...NET0, available: false, received: undefined }),
    });
    await press('Add credits');
    expect(states()).toEqual(['current', 'pending', 'pending']);
    expect(tracker()?.textContent).toContain("Couldn't check. Trying again.");
    // The first readable answer sets the baseline: nothing new yet, so still Waiting.
    routes[TOP_UP] = topUp(NET0);
    await tick(5_000);
    expect(states()).toEqual(['current', 'pending', 'pending']);
    routes[TOP_UP] = topUp(NET5);
    await tick(5_000);
    expect(states()).toEqual(['done', 'current', 'pending']);
  });
});

describe('checking: polite polling', () => {
  it('reads once at once, every 5 s, every 15 s after 2 minutes, and stops after 30 minutes', async () => {
    const { calls } = await mount();
    const before = reads(calls, TOP_UP);
    await press('Add credits');
    expect(reads(calls, TOP_UP)).toBe(before + 1);
    await tick(50_000);
    expect(reads(calls, TOP_UP)).toBe(before + 11);
    await tick(130_000); // 3 minutes in
    const at3 = reads(calls, TOP_UP);
    await tick(60_000);
    expect(reads(calls, TOP_UP) - at3).toBe(4);
    await tick(27 * 60_000 + 1_000); // past 30 minutes
    expect(tracker()?.textContent).toContain('Stopped checking.');
    const stopped = reads(calls, TOP_UP);
    await tick(10 * 60_000);
    expect(reads(calls, TOP_UP)).toBe(stopped);
    // The mark rests when checking stops.
    expect(states()).toEqual(['current', 'pending', 'pending']);
    // Check again: one read at once, and checking starts over.
    await press('Check again');
    expect(reads(calls, TOP_UP)).toBe(stopped + 1);
    expect(tracker()?.textContent).not.toContain('Stopped checking.');
    await tick(5_000);
    expect(reads(calls, TOP_UP)).toBe(stopped + 2);
  });

  it('a hidden tab reads nothing and pauses the mark; on return, one read at once', async () => {
    const { calls } = await mount();
    await press('Add credits');
    await tick(1_000);
    await setHidden(true);
    const at = reads(calls, TOP_UP);
    expect(tracker()?.querySelector('svg.al-waiting-mark')?.getAttribute('data-paused')).toBe(
      'true',
    );
    await tick(5 * 60_000);
    expect(reads(calls, TOP_UP)).toBe(at);
    await setHidden(false);
    expect(reads(calls, TOP_UP)).toBe(at + 1);
    expect(tracker()?.querySelector('svg.al-waiting-mark')?.getAttribute('data-paused')).toBeNull();
  });

  it('closing the panel stops the reads', async () => {
    const { calls } = await mount({ [TOP_UP]: topUp({ ...NET0, credits: NET5.addable }) });
    await press('Add credits');
    await press('Advanced');
    await press('Withdraw credits');
    expect(tracker()).toBeNull();
    const at = reads(calls, TOP_UP);
    await tick(60_000);
    expect(reads(calls, TOP_UP)).toBe(at);
  });
});

describe('step 2: Arrived', () => {
  it('arrives only on the read whose received is above the opening value, with that amount', async () => {
    const { routes } = await mount();
    await press('Add credits');
    await tick(4_999);
    routes[TOP_UP] = topUp(NET5);
    // The answer has changed on the server, but nothing shows it until the next read lands.
    expect(states()).toEqual(['current', 'pending', 'pending']);
    expect(tracker()?.textContent).not.toContain('$5.00');
    await tick(1);
    expect(states()).toEqual(['done', 'current', 'pending']);
    const two = steps()[1];
    expect(two?.textContent).toContain('Arrived · $5.00');
    expect(two?.getAttribute('aria-current')).toBe('step');
    expect(button('Add $4.99 to your credits')).toBeDefined();
    expect(two?.textContent).toContain('A little stays with your agent to cover network costs.');
    // Arrived and done steps show the time they were reached.
    expect(steps()[0]?.querySelector('time')).not.toBeNull();
    expect(two?.querySelector('time')).not.toBeNull();
    // The step change is announced politely.
    await tick(0);
    const said = [...host.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? '');
    expect(said).toContain('Your funds arrived: $5.00');
  });

  it('opens on Arrived when funds were already there (addable above zero)', async () => {
    await mount({ [TOP_UP]: topUp(NET5) });
    await press('Add credits');
    expect(states()).toEqual(['done', 'current', 'pending']);
    expect(steps()[1]?.textContent).toContain('Arrived · $5.00');
    expect(button('Add $4.99 to your credits')).toBeDefined();
  });

  it('the waiting mark stops: step 1 gets its check, and the mark is gone', async () => {
    document.documentElement.dataset['motion'] = 'reduced';
    const { routes } = await mount();
    await press('Add credits');
    routes[TOP_UP] = topUp(NET5);
    await tick(5_000);
    await tick(100);
    expect(tracker()?.querySelector('svg.al-waiting-mark')).toBeNull();
    expect(steps()[0]?.querySelector('.pf-step-check')).not.toBeNull();
  });

  it('with full motion the diamond finishes its turn first, then step 1 draws its check', async () => {
    const { routes } = await mount();
    await press('Add credits');
    routes[TOP_UP] = topUp(NET5);
    await tick(5_000);
    // The step word has already moved on: that is the read's job, not the drawing's.
    expect(states()).toEqual(['done', 'current', 'pending']);
    await tick(2_100);
    expect(tracker()?.querySelector('svg.al-waiting-mark')).toBeNull();
    expect(steps()[0]?.querySelector('.pf-step-check')).not.toBeNull();
  });

  it('stops reading the account once funds arrived (the amount on the button stays put)', async () => {
    const { routes, calls } = await mount({ [TOP_UP]: topUp(NET5) });
    await press('Add credits');
    const at = reads(calls, TOP_UP);
    routes[TOP_UP] = topUp({
      ...NET5,
      received: '$9.00',
      addable: { usd: '$8.99', amount: '8990000000000000000' },
    });
    await tick(60_000);
    expect(reads(calls, TOP_UP)).toBe(at);
    expect(button('Add $4.99 to your credits')).toBeDefined();
  });
});

describe('step 3: Adding, then Added to credits', () => {
  async function toConfirm(m: Mounted, status = 202): Promise<void> {
    const owner = vi
      .spyOn(m.api, 'owner')
      .mockResolvedValue({ kind: 'ok', status, data: {} } as never);
    await press('Add credits');
    await press('Add $4.99 to your credits');
    // The existing confirm screen, same amount (what you see is what you sign).
    const confirm = host.querySelector('section[aria-label="Confirm"]');
    expect(confirm?.textContent).toContain('Add $4.99 to your credits');
    expect(confirm?.textContent).toContain('$4.99');
    expect(owner).not.toHaveBeenCalled();
    await typeCode('7K2M-9QXA');
    await press('Confirm');
    expect(owner).toHaveBeenCalledTimes(1);
    expect(owner.mock.calls[0]?.[0]).toBe(TOP_UP);
    expect(owner.mock.calls[0]?.[1]).toEqual({
      network: 'gnosis-test',
      amount: '4990000000000000000',
    });
    expect(owner.mock.calls[0]?.[2]).toBe('7K2M-9QXA');
  }

  it('after the owner operation: "Adding to your credits…" until the credits read shows more', async () => {
    const m = await mount({ [TOP_UP]: topUp(NET5) });
    await toConfirm(m);
    expect(states()).toEqual(['done', 'done', 'current']);
    const three = steps()[2];
    expect(three?.textContent).toContain('Adding to your credits…');
    expect(three?.textContent).not.toContain('Added to credits ·');
    // An indeterminate bar on step 3, not the waiting mark.
    expect(three?.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(tracker()?.querySelector('svg.al-waiting-mark')).toBeNull();
    // Unchanged credits: still adding, however long it takes.
    await tick(60_000);
    expect(states()).toEqual(['done', 'done', 'current']);
    // A failed credits read keeps the step.
    m.routes[CREDITS] = FAIL;
    await tick(15_000);
    expect(states()).toEqual(['done', 'done', 'current']);
    expect(three?.textContent).toContain("Couldn't check. Trying again.");
    m.routes[CREDITS] = { ...OK_CREDITS, proofsLeft: 98, balance: '$9.79' };
    await tick(15_000);
    expect(states()).toEqual(['done', 'done', 'done']);
    expect(steps()[2]?.textContent).toContain('Added to credits · $9.79 now');
    expect(steps()[2]?.querySelector('time')).not.toBeNull();
    // The credits card follows the same read.
    const ring = host.querySelector('section[aria-label="Credits"] [role="meter"]');
    await tick(100);
    expect(ring?.getAttribute('aria-valuenow')).toBe('98');
    const said = [...host.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? '');
    expect(said).toContain('Added to credits');
  });

  it('a 200 answer is still only submitted: no "Added" before the credits read proves it', async () => {
    const m = await mount({ [TOP_UP]: topUp(NET5) });
    await toConfirm(m, 200);
    expect(text()).not.toContain('Your credits are updated');
    expect(states()).toEqual(['done', 'done', 'current']);
    m.routes[CREDITS] = { ...OK_CREDITS, proofsLeft: 98, balance: '$9.79' };
    await tick(5_000);
    expect(states()).toEqual(['done', 'done', 'done']);
  });

  it('a wrong backup code or a refused move never shows Adding or Added', async () => {
    const m = await mount({ [TOP_UP]: topUp(NET5) });
    vi.spyOn(m.api, 'owner').mockResolvedValue({ kind: 'presence_rejected' } as never);
    await press('Add credits');
    await press('Add $4.99 to your credits');
    await typeCode('0000-0000');
    await press('Confirm');
    expect(text()).toContain("That backup code didn't work.");
    expect(text()).not.toContain('Adding to your credits');
    expect(text()).not.toContain('Added to credits ·');
  });

  it('an amount_changed answer closes the flow with its line, never Adding', async () => {
    const m = await mount({ [TOP_UP]: topUp(NET5) });
    vi.spyOn(m.api, 'owner').mockResolvedValue({
      kind: 'answer',
      status: 409,
      data: { error: 'amount_changed' },
    } as never);
    await press('Add credits');
    await press('Add $4.99 to your credits');
    await typeCode('7K2M-9QXA');
    await press('Confirm');
    expect(text()).toContain('The amount changed. Check again.');
    expect(text()).not.toContain('Adding to your credits');
  });
});

const text = (): string => host.textContent ?? '';

describe('words (11 §5)', () => {
  it('the steps never say wallet, deposit, transaction or address', async () => {
    const m = await mount();
    await press('Add credits');
    expect(tracker()?.textContent).not.toMatch(BANNED);
    await tick(11 * 60_000);
    expect(tracker()?.textContent).not.toMatch(BANNED);
    m.routes[TOP_UP] = topUp(NET5);
    await tick(15_000);
    expect(tracker()?.textContent).not.toMatch(BANNED);
    vi.spyOn(m.api, 'owner').mockResolvedValue({ kind: 'ok', status: 202, data: {} } as never);
    await press('Add $4.99 to your credits');
    await typeCode('7K2M-9QXA');
    await press('Confirm');
    expect(tracker()?.textContent).not.toMatch(BANNED);
    m.routes[CREDITS] = { ...OK_CREDITS, balance: '$9.79' };
    await tick(5_000);
    expect(tracker()?.textContent).not.toMatch(BANNED);
  });
});

describe('motion', () => {
  it('reduced motion: the mark is still the brand mark, and the step word carries the meaning', async () => {
    document.documentElement.dataset['motion'] = 'reduced';
    await mount();
    await press('Add credits');
    const mark = tracker()?.querySelector('svg.al-waiting-mark');
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute('style')).toBeNull();
    expect(steps()[0]?.textContent).toContain('Waiting for your funds');
  });

  it('the page CSS adds no keyframes and no literal durations, and turns the check draw off when reduced', () => {
    expect(proofsCss).not.toMatch(/@keyframes/);
    expect(proofsCss).not.toMatch(/\b\d+(\.\d+)?m?s\b/);
    expect(proofsCss).toMatch(/\.pf-step-check/);
    expect(proofsCss).toMatch(/\[data-motion='reduced'\][^{]*\.pf-step-check/);
    expect(proofsCss).toMatch(/prefers-reduced-motion/);
    expect(proofsCss).not.toMatch(/al-waiting/);
  });

  it('no inline styles anywhere in the tracker', async () => {
    await mount();
    await press('Add credits');
    expect(host.querySelector('[style]')).toBeNull();
  });
});

describe('axe', () => {
  const run = (): Promise<axe.AxeResults> =>
    axe.run(host, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
  it('finds no violation on Waiting', async () => {
    await mount({}, false);
    await press('Add credits', false);
    expect(states()).toEqual(['current', 'pending', 'pending']);
    expect((await run()).violations).toEqual([]);
  });
  it('finds no violation on Arrived', async () => {
    await mount({ [TOP_UP]: topUp(NET5) }, false);
    await press('Add credits', false);
    expect(states()).toEqual(['done', 'current', 'pending']);
    expect((await run()).violations).toEqual([]);
  });
  it('finds no violation on Adding', async () => {
    const m = await mount({ [TOP_UP]: topUp(NET5) }, false);
    await press('Add credits', false);
    expect(states()).toEqual(['done', 'current', 'pending']);
    vi.spyOn(m.api, 'owner').mockResolvedValue({ kind: 'ok', status: 202, data: {} } as never);
    await press('Add $4.99 to your credits', false);
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="password"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(input, '7K2M-9QXA');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await settle(false);
    });
    await press('Confirm', false);
    expect(states()).toEqual(['done', 'done', 'current']);
    expect((await run()).violations).toEqual([]);
  });
});

// ------------------------------------------------------------------ IR-UX2-e2 (Fable audit) fixes

const word = (i: number): string => {
  const el = steps()[i]?.querySelector('.pf-step-word');
  return el?.textContent?.replace(/, step \d of 3$/, '') ?? '';
};

describe('M-1: the tracker survives a failed account re-read after a successful add', () => {
  it('stays on "Adding…" with the panel open, then reaches Added on the credits read', async () => {
    const m = await mount({ [TOP_UP]: topUp(NET5) });
    vi.spyOn(m.api, 'owner').mockResolvedValue({ kind: 'ok', status: 202, data: {} } as never);
    await press('Add credits');
    await press('Add $4.99 to your credits');
    await typeCode('7K2M-9QXA');
    // From here every top-up read fails.
    m.routes[TOP_UP] = FAIL;
    await press('Confirm');
    await tick(0);
    expect(host.querySelector('section[aria-label="Add credits"]')).not.toBeNull();
    expect(states()).toEqual(['done', 'done', 'current']);
    expect(word(2)).toBe('Adding to your credits…');
    await tick(30_000);
    expect(host.querySelector('section[aria-label="Add credits"]')).not.toBeNull();
    expect(states()).toEqual(['done', 'done', 'current']);
    m.routes[CREDITS] = { ...OK_CREDITS, proofsLeft: 98, balance: '$9.79' };
    await tick(5_000);
    expect(states()).toEqual(['done', 'done', 'done']);
    expect(word(2)).toBe('Added to credits · $9.79 now');
  });
});

describe('L-1: the credits from before the add come from a fresh read, not the page load', () => {
  it('credits that rose during Waiting do not count as added', async () => {
    const m = await mount();
    await press('Add credits');
    // Free test credits arrive while waiting; the page still holds $4.80 from its load.
    m.routes[CREDITS] = { ...OK_CREDITS, proofsLeft: 60, balance: '$6.00' };
    m.routes[TOP_UP] = topUp(NET5);
    await tick(5_000);
    expect(states()).toEqual(['done', 'current', 'pending']);
    vi.spyOn(m.api, 'owner').mockResolvedValue({ kind: 'ok', status: 202, data: {} } as never);
    await press('Add $4.99 to your credits');
    await typeCode('7K2M-9QXA');
    await press('Confirm');
    await tick(60_000);
    expect(states()).toEqual(['done', 'done', 'current']);
    expect(text()).not.toContain('Added to credits ·');
    m.routes[CREDITS] = { ...OK_CREDITS, proofsLeft: 109, balance: '$10.99' };
    await tick(15_000);
    expect(word(2)).toBe('Added to credits · $10.99 now');
  });

  it('credits that fell during Waiting still let the add show once it lands', async () => {
    const m = await mount();
    await press('Add credits');
    m.routes[CREDITS] = { ...OK_CREDITS, proofsLeft: 0, balance: '$0.00' };
    m.routes[TOP_UP] = topUp(NET5);
    await tick(5_000);
    vi.spyOn(m.api, 'owner').mockResolvedValue({ kind: 'ok', status: 202, data: {} } as never);
    await press('Add $4.99 to your credits');
    await typeCode('7K2M-9QXA');
    await press('Confirm');
    m.routes[CREDITS] = { ...OK_CREDITS, proofsLeft: 40, balance: '$4.00' };
    await tick(5_000);
    expect(states()).toEqual(['done', 'done', 'done']);
    expect(word(2)).toBe('Added to credits · $4.00 now');
  });
});

describe('L-2: step 3 words (11 §5)', () => {
  it('pending "Added to credits", current "Adding to your credits…", done with the amount', async () => {
    const m = await mount({ [TOP_UP]: topUp(NET5) });
    await press('Add credits');
    expect(word(2)).toBe('Added to credits');
    vi.spyOn(m.api, 'owner').mockResolvedValue({ kind: 'ok', status: 202, data: {} } as never);
    await press('Add $4.99 to your credits');
    await typeCode('7K2M-9QXA');
    await press('Confirm');
    expect(word(2)).toBe('Adding to your credits…');
    expect(steps()[2]?.textContent).not.toMatch(/Added to credits/);
    // The bar keeps its accessible name; its own visible label is not shown a second time.
    expect(steps()[2]?.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe(
      'Adding to your credits…',
    );
    expect(proofsCss).toMatch(/\.pf-step \.al-pb-head\s*\{[^}]*clip/);
    m.routes[CREDITS] = { ...OK_CREDITS, proofsLeft: 98, balance: '$9.79' };
    await tick(5_000);
    expect(word(2)).toBe('Added to credits · $9.79 now');
  });
});

describe('L-3: phone width, 360 px (stylesheet)', () => {
  const css = proofsCss.replace(/\/\*[\s\S]*?\*\//g, '');
  it('the step columns can shrink: the text column is minmax(0, 1fr) and its body min 0', () => {
    expect(css).toMatch(/\.pf-step\s*\{[^}]*grid-template-columns:[^;]*minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.pf-step-body\s*\{[^}]*min-inline-size:\s*0/);
  });
  it('no tracker rule sets a fixed size wider than a phone', () => {
    for (const m of css.matchAll(/\.pf-(?:track|step|details)[^{]*\{([^}]*)\}/g)) {
      expect(m[1]).not.toMatch(/\b(?:[4-9]\d\d|\d{4,})px\b/);
    }
  });
  it('at phone width the Add button takes the full row and the step time wraps under', () => {
    expect(css).toMatch(
      /@media \(max-width: [^)]+\)\s*\{[\s\S]*\.pf-step-body \.al-btn[\s\S]*inline-size:\s*100%/,
    );
    expect(css).toMatch(/@media \(max-width: [^)]+\)\s*\{[\s\S]*\.pf-step-time[\s\S]*grid-column/);
  });
});
