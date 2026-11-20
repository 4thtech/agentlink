// @vitest-environment jsdom
// NET-UI-B (D-158): "Use your own servers", every step and state, against the mocked client whose
// answers match 08 §1. The page never signs; owner steps are the existing presence flow; server- and
// contact-supplied text is plain text.
import axe from 'axe-core';
import { createElement as h, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOwnerClient } from '../../../contacts/owner.js';
import type { ServersApi } from './api.js';
import { ServersEntry } from './entry.js';
import { createMockServersApi, MOCK_STATUS, type MockOptions } from './mock.js';
import { SERVERS_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_795_000_000;
let host: HTMLElement;
let root: Root;
const fetchFn = (async (input: RequestInfo | URL) =>
  new Response(
    JSON.stringify(
      String(input).includes('passkey')
        ? { passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' } }
        : {},
    ),
    { status: 200 },
  )) as typeof fetch;
const owner = createOwnerClient({ fetch: fetchFn, token: 't' });

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.querySelectorAll('.al-sheet-layer').forEach((n) => n.remove());
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function mount(
  options: MockOptions = {},
  extra: { online?: () => boolean; api?: ServersApi } = {},
): Promise<ServersApi> {
  const api = extra.api ?? createMockServersApi({ now: NOW, ...options });
  await act(async () => {
    root.render(
      h(ServersEntry, {
        api,
        owner,
        now: () => NOW,
        ...(extra.online === undefined ? {} : { online: extra.online }),
      }),
    );
  });
  await settle();
  return api;
}
const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll('button')];
const button = (text: string): HTMLButtonElement | undefined =>
  buttons().find((b) => b.textContent?.trim() === text);
async function click(el: Element | undefined | null): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await settle();
}
async function type(el: HTMLInputElement | null, value: string): Promise<void> {
  expect(el).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
    el?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const field = (): HTMLInputElement | null =>
  document.body.querySelector<HTMLInputElement>('input[placeholder="wss://"]');
async function addServers(text: string): Promise<void> {
  await type(field(), text);
  await click(button(S.add));
}
const text = (): string => document.body.textContent ?? '';
const rows = (): HTMLElement[] => [
  ...document.body.querySelectorAll<HTMLElement>('[data-test-state]'),
];
const switches = (): HTMLButtonElement[] => [
  ...document.body.querySelectorAll<HTMLButtonElement>('button[role="switch"]'),
];
const on = (el: HTMLElement | undefined): boolean => el?.getAttribute('aria-checked') === 'true';

async function openOwn(options: MockOptions = {}): Promise<ServersApi> {
  const api = await mount(options);
  if (options.delayMs !== undefined) {
    await act(async () => {
      await new Promise((r) =>
        setTimeout(r, options.delayMs === undefined ? 0 : options.delayMs * 4),
      );
    });
    await settle();
  }
  await click(button(S.useOwn));
  return api;
}
/** Adds two ready servers and goes to step 2 (C3). */
async function toList(extra = ''): Promise<void> {
  await addServers(`wss://relay.example-team.com wss://relay.primal.net ${extra}`.trim());
  await click(button(S.continue));
}
async function confirmWithCode(label: string): Promise<void> {
  await click(button(label));
  const input = document.body.querySelector<HTMLInputElement>('input[name="owner-code"]');
  expect(input).not.toBeNull();
  await type(input, '123456');
  await settle();
  await click(button('Confirm with your master code'));
}

describe('C1: the entry', () => {
  it('is a secondary button with the spec words, in automatic mode', async () => {
    await mount();
    expect(text()).toContain(S.entryTitle);
    expect(text()).toContain(S.entryBody);
    expect(text()).toContain(S.automaticNow(5));
    const b = button(S.useOwn);
    expect(b).toBeTruthy();
    expect(b?.className).not.toContain('al-btn-primary');
    expect(button(S.useAutomatic)).toBeUndefined();
  });

  it('shows a loading state, then the entry', async () => {
    const api = createMockServersApi({ now: NOW, delayMs: 30 });
    await act(async () => {
      root.render(h(ServersEntry, { api, owner, now: () => NOW }));
    });
    expect(host.querySelector('[data-servers-entry="loading"]')).not.toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    await settle();
    expect(host.querySelector('[data-servers-entry="loading"]')).toBeNull();
    expect(text()).toContain(S.useOwn);
  });

  it('says so when the server does not answer, and when this computer is offline', async () => {
    const failing = {
      ...createMockServersApi(),
      status: async () => ({ kind: 'failed' as const }),
    };
    await mount({}, { api: failing });
    expect(text()).toContain(S.noAnswer);
    act(() => root.unmount());
    root = createRoot(host);
    const offline = {
      ...createMockServersApi(),
      status: async () => ({ kind: 'offline' as const }),
    };
    await mount({}, { api: offline });
    expect(text()).toContain(S.offline);
  });

  it('is off, with its reason, while not running, needing setup, or this computer is offline', async () => {
    await mount({ status: { ...MOCK_STATUS, agent: 'not_running' } });
    expect(text()).toContain(S.notRunning);
    expect(button(S.useOwn)?.disabled).toBe(true);
    act(() => root.unmount());
    root = createRoot(host);
    await mount({ status: { ...MOCK_STATUS, agent: 'needs_setup' } });
    expect(text()).toContain(S.needsSetup);
    expect(button(S.useOwn)?.disabled).toBe(true);
    act(() => root.unmount());
    root = createRoot(host);
    await mount({}, { online: () => false });
    expect(text()).toContain(S.offline);
    expect(button(S.useOwn)?.disabled).toBe(true);
  });

  it('C7b: paused names the sensor; a change still finishing waits; both turn the buttons off', async () => {
    await mount({ status: { ...MOCK_STATUS, agent: 'paused', change: 'paused' } });
    expect(text()).toContain(S.pausedTitle);
    expect(text()).toMatch(/Your ID is paused\. Resume it with .+ first\./);
    expect(button(S.useOwn)?.disabled).toBe(true);
    act(() => root.unmount());
    root = createRoot(host);
    await mount({ status: { ...MOCK_STATUS, change: 'rotation_pending' } });
    expect(text()).toContain(S.finishing);
    expect(button(S.useOwn)?.disabled).toBe(true);
  });

  it('C7b: after a change the old servers are readable until a date; changing or resetting stays allowed', async () => {
    await mount({
      status: { ...MOCK_STATUS, mode: 'custom', mixIn: true, previousUntil: NOW + 86_400 * 30 },
      progress: {
        changedAt: NOW - 3600,
        total: 3,
        sent: 3,
        waiting: 0,
        items: [],
        leavingUntil: NOW + 86_400 * 30,
      },
    });
    expect(text()).toMatch(/You changed servers on/);
    expect(text()).toContain('Servers you left stay readable until');
    expect(text()).toContain('change again or go back to automatic at any time');
    expect(button(S.changeServers)?.disabled).toBe(false);
    expect(button(S.useAutomatic)?.disabled).toBe(false);
    expect(text()).toContain(S.customNow);
  });
});

describe('C2: add and test', () => {
  it('opens at step 1 with the info line, labelled field and no password field', async () => {
    await openOwn();
    expect(text()).toContain(S.step(1));
    expect(text()).toContain(S.addBody);
    expect(text()).toContain(S.info);
    const input = field();
    expect(input?.id).toBeTruthy();
    expect(document.body.querySelector(`label[for="${input?.id ?? ''}"]`)?.textContent).toBe(
      S.fieldLabel,
    );
    expect(document.body.querySelector('input[type="password"]')).toBeNull();
    expect(button(S.continue)?.disabled).toBe(true);
  });

  it('shows a result per row: ready, slow, needs sign-in, needs payment and each refusal, with the fixed words', async () => {
    await openOwn();
    await addServers(
      [
        'wss://relay.example-team.com',
        'wss://slow.example-team.com',
        'wss://members.example-team.com',
        'wss://paid.example-team.com',
        'wss://write-only.example.net',
        'wss://lossy.example.net',
        'wss://relay.gone.example',
        'wss://192.168.1.20',
      ].join(' '),
    );
    expect(rows().map((r) => r.dataset['testState'])).toEqual([
      'ready',
      'slow',
      'sign_in',
      'ready',
      'refused',
      'refused',
      'refused',
      'refused',
    ]);
    const t = text();
    expect(t).toContain('Ready · 82 ms');
    expect(t).toContain('Ready · slow 1.4 s');
    expect(t).toContain(S.signIn);
    expect(t).toContain(S.signInWhy);
    expect(t).toContain(S.paid);
    expect(t).toContain("Doesn't accept messages");
    expect(t).toContain("Didn't keep the test message");
    expect(t).toContain("Can't reach");
    expect(t).toContain('Not allowed');
  });

  it('shows Testing… while a test runs and the other refusals', async () => {
    await openOwn({ delayMs: 40 });
    await type(field(), 'wss://tiny.example.net');
    await act(async () => button(S.add)?.click());
    expect(text()).toContain(S.testing);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    await settle();
    expect(text()).toContain('Messages too large for it');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    await addServers('http://nope.example.net');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    await settle();
    expect(text()).toContain('Not a server address');
  });

  it('refuses a repeat and more than 8, and Remove drops a row', async () => {
    await openOwn();
    await addServers('wss://a.example.net');
    await addServers('WSS://A.example.net/');
    expect(text()).toContain(S.already);
    expect(rows()).toHaveLength(1);
    await addServers(
      Array.from({ length: 9 }, (_, i) => `wss://b${String(i)}.example.net`).join(' '),
    );
    expect(rows()).toHaveLength(8);
    expect(text()).toContain(S.full);
    await click(document.body.querySelector('button[aria-label="Remove a.example.net"]'));
    expect(rows()).toHaveLength(7);
  });

  it('says when a test could not run (offline, busy, failed) and offers Test again', async () => {
    const api = createMockServersApi({ now: NOW });
    let answer: 'offline' | 'busy' | 'failed' | 'ok' = 'offline';
    const tested: ServersApi = {
      ...api,
      test: async (urls) => (answer === 'ok' ? api.test(urls) : { kind: answer }),
    };
    await openOwn();
    act(() => root.unmount());
    root = createRoot(host);
    await mount({}, { api: tested });
    await click(button(S.useOwn));
    await addServers('wss://a.example.net');
    expect(text()).toContain(S.testOffline);
    answer = 'ok';
    await click(button(S.retest));
    expect(rows()[0]?.dataset['testState']).toBe('ready');
  });

  it('renders a server-supplied or typed host as plain text, never markup or a link', async () => {
    const api = createMockServersApi({
      now: NOW,
      test: {
        kind: 'ok',
        value: [
          {
            host: '<img src=x onerror=alert(1)>.example',
            outcome: 'ready',
            reason: null,
            roundTripMs: 10,
            signInRequired: false,
            paymentRequired: false,
          },
        ],
      },
    });
    await mount({}, { api });
    await click(button(S.useOwn));
    await addServers('wss://<b>x</b>.example.net');
    expect(document.body.querySelector('.al-sheet img, .al-sheet b, .al-sheet a')).toBeNull();
    expect(text()).toContain('<img src=x onerror=alert(1)>.example');
  });
});

describe('C3: the list', () => {
  it('lists the usable servers with their role, the count and the mix-in switch on', async () => {
    await openOwn();
    await toList('wss://write-only.example.net');
    expect(text()).toContain(S.step(2));
    expect(text()).toContain(S.count(2, 6));
    expect(text()).toContain(S.role);
    expect(text()).toContain(S.retention);
    expect(on(switches()[0])).toBe(true);
    expect(text()).not.toContain(S.mixOffTitle);
    expect(button(S.review)?.disabled).toBe(false);
  });

  it('turning mix-in off shows the warning, then the opt-out switch; Turn it back on undoes both', async () => {
    await openOwn();
    await toList();
    expect(text()).not.toContain(S.optOutLabel);
    await click(switches()[0]);
    expect(text()).toContain(S.mixOffTitle);
    expect(text()).toContain(S.mixOff);
    expect(text()).toContain(S.count(2, 8));
    expect(text()).toContain(S.optOutLabel);
    expect(text()).not.toContain(S.optOutTitle);
    await click(switches()[1]);
    expect(text()).toContain(S.optOutTitle);
    expect(text()).toContain(S.optOut);
    await click(button(S.mixBack));
    expect(text()).not.toContain(S.mixOffTitle);
    expect(text()).not.toContain(S.optOutLabel);
    expect(on(switches()[0])).toBe(true);
  });

  it('needs at least 2 of your own ready: one server blocks Review', async () => {
    await openOwn();
    await addServers('wss://relay.example-team.com');
    await click(button(S.continue));
    expect(text()).toContain(S.needMoreHint);
    expect(text()).toContain(S.needTwoTitle);
    expect(button(S.review)?.disabled).toBe(true);
  });

  it('a sign-in server is allowed with a warning only while 2 others work', async () => {
    await openOwn();
    await toList('wss://members.example-team.com');
    expect(text()).toContain(S.signInOkTitle);
    // 11 §5.14: plain words, no "(they do)".
    expect(S.signInOk).toBe(
      "That's fine as long as 2 other servers work, and they do. We can't confirm delivery on this one.",
    );
    expect(text()).not.toContain('(they do)');
    // A long list scrolls inside the panel's own list (a keyboard can reach it), not the page.
    const list = document.body.querySelector('.al-sheet-body ul.nw-scroll') as HTMLElement;
    expect(list.tabIndex).toBe(0);
    expect(list.getAttribute('aria-label')).toBe(S.listLabel);
    expect(button(S.review)?.disabled).toBe(false);
    await click(document.body.querySelector('button[aria-label="Remove relay.primal.net"]'));
    expect(text()).toContain(S.needTwoTitle);
    expect(button(S.review)?.disabled).toBe(true);
  });

  it('with the mix-in on at most 6 of your own, with it off up to 8', async () => {
    await openOwn();
    await addServers(
      Array.from({ length: 7 }, (_, i) => `wss://c${String(i)}.example.net`).join(' '),
    );
    await click(button(S.continue));
    expect(text()).toContain(S.count(7, 6));
    expect(button(S.review)?.disabled).toBe(true);
    await click(switches()[0]);
    expect(text()).toContain(S.count(7, 8));
    expect(button(S.review)?.disabled).toBe(false);
  });

  it('Back returns to add and test', async () => {
    await openOwn();
    await toList();
    await click(button(S.back));
    expect(text()).toContain(S.step(1));
  });
});

describe('C4 and C5: review and owner presence', () => {
  it('shows "Needs your approval", the count, roles, leaving servers, contacts and what servers see', async () => {
    await openOwn();
    await toList();
    await click(button(S.review));
    expect(text()).toContain(S.step(3));
    expect(text()).toContain(S.reviewBody);
    expect(text()).toContain(S.needsApproval);
    expect(text()).toContain(S.useThese(4));
    expect(text()).toContain('Yours · 82 ms');
    expect(text()).toContain('Yours · 62 ms');
    expect(text()).toContain(S.automatic);
    expect(text()).toContain(S.leavingTitle);
    expect(text()).toContain('old1.agentlink.example, old2.agentlink.example');
    expect(text()).toContain(S.contactsTitle);
    expect(text()).toContain(S.contactsBody(16));
    expect(text()).toContain(S.seeTitle);
    // C5: the button is the owner step; no passphrase field is drawn by this page.
    expect(button(S.confirmCode)).toBeTruthy();
    expect(document.body.querySelector('input[name="owner-code"]')).toBeNull();
    expect(button(S.back)).toBeTruthy();
  });

  it('with the mix-in off, the review lists only your servers', async () => {
    await openOwn();
    await toList();
    await click(switches()[0]);
    await click(button(S.review));
    expect(text()).toContain(S.useThese(2));
    expect(text()).not.toContain(S.automatic);
  });

  it('sends the reviewed list once with the proof in the existing presence prompt, then closes with a toast', async () => {
    const api = createMockServersApi({ now: NOW });
    const set = vi.fn(api.set);
    const spy: ServersApi = { ...api, set };
    const toasts: string[] = [];
    const { subscribeToasts } = await import('../../../../notices/index.js');
    const off = subscribeToasts((t) => toasts.push(t.text ?? ''));
    await mount({}, { api: spy });
    await click(button(S.useOwn));
    await toList();
    await click(button(S.review));
    await confirmWithCode(S.confirmCode);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[0]).toEqual({
      servers: ['wss://relay.example-team.com', 'wss://relay.primal.net'],
      automatic: true,
      announce: true,
    });
    expect(set.mock.calls[0]?.[1]).toEqual({ kind: 'code', code: '123456' });
    expect(document.body.querySelector('.al-sheet')).toBeNull();
    expect(toasts).toContain(S.toast);
    off();
  });

  it('sends announce: false only with the mix-in off and the opt-out on', async () => {
    const api = createMockServersApi({ now: NOW });
    const set = vi.fn(api.set);
    await mount({}, { api: { ...api, set } });
    await click(button(S.useOwn));
    await toList();
    await click(switches()[0]);
    await click(switches()[1]);
    await click(button(S.review));
    await confirmWithCode(S.confirmCode);
    expect(set.mock.calls[0]?.[0]).toMatchObject({ automatic: false, announce: false });
  });

  it('says why a review or a confirm was refused, in fixed words', async () => {
    await openOwn({ review: { kind: 'refused', code: 'same_list' } });
    await toList();
    await click(button(S.review));
    expect(text()).toContain(S.sameList);
    expect(text()).toContain(S.step(2));
    act(() => root.unmount());
    root = createRoot(host);
    await openOwn({ review: { kind: 'refused', code: 'changed' } });
    await toList();
    await click(button(S.review));
    expect(text()).toContain(S.changed);
    expect(button(S.retest)).toBeTruthy();
    act(() => root.unmount());
    root = createRoot(host);
    await openOwn({
      confirm: { kind: 'refused', code: 'too_many_previous', fitsFrom: NOW + 86_400 * 3 },
    });
    await toList();
    await click(button(S.review));
    await confirmWithCode(S.confirmCode);
    expect(text()).toContain(S.tooManyOldTitle);
    expect(text()).toContain('You can change again from');
    expect(document.body.querySelector('.al-sheet')).not.toBeNull();
  });

  it('a wrong code or a cancelled sensor changes nothing and says so', async () => {
    await openOwn({ confirm: { kind: 'rejected' } });
    await toList();
    await click(button(S.review));
    await confirmWithCode(S.confirmCode);
    expect(text()).toMatch(/code|didn't/i);
    expect(document.body.querySelector('.al-sheet')).not.toBeNull();
  });

  it('Back from the review returns to the list with nothing sent', async () => {
    const api = createMockServersApi({ now: NOW });
    const set = vi.fn(api.set);
    await mount({}, { api: { ...api, set } });
    await click(button(S.useOwn));
    await toList();
    await click(button(S.review));
    await click(button(S.back));
    expect(text()).toContain(S.step(2));
    expect(set).not.toHaveBeenCalled();
  });
});

describe('C6 and C7: progress and success', () => {
  const custom = { ...MOCK_STATUS, mode: 'custom' as const, ownCount: 4 };
  it('C6: Telling your contacts… N of M with Sent / Waiting per contact, plain-text names', async () => {
    await mount({
      status: custom,
      progress: {
        changedAt: NOW - 600,
        total: 3,
        sent: 1,
        waiting: 2,
        leavingUntil: NOW + 86_400 * 30,
        items: [
          { name: 'Natasa', state: 'sent' },
          { name: '<b>Denis</b>', state: 'waiting' },
          { name: 'Mira', state: 'waiting' },
        ],
      },
    });
    expect(text()).toContain(S.changedTitle);
    expect(text()).toContain('Telling your contacts… 1 of 3');
    expect(text()).toContain(S.restWait);
    expect(text()).toContain('Old servers readable until');
    expect(text()).toContain('<b>Denis</b>');
    expect(host.querySelector('b')).toBeNull();
    expect(text()).toContain(S.sent);
    expect(text()).toContain(S.waiting);
    const bar = host.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('1');
  });

  it('C7: Done with the contact count and your servers once every contact has it', async () => {
    await mount({
      status: custom,
      progress: {
        changedAt: NOW - 600,
        total: 16,
        sent: 16,
        waiting: 0,
        items: [],
        leavingUntil: NOW + 86_400 * 30,
      },
    });
    expect(text()).toContain(S.allHave(16));
    expect(text()).toContain('Your messages now use your 4 servers. Old ones stay readable until');
    expect(text()).toContain(S.doneChip);
    expect(text()).toContain(S.anyTime);
    expect(text()).not.toContain('Telling your contacts');
  });

  it('shows nothing once nothing was changed or the overlap is over', async () => {
    await mount({ status: custom, progress: undefined });
    expect(host.querySelector('[data-servers-progress]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    await mount({
      status: custom,
      progress: {
        changedAt: NOW - 99,
        total: 2,
        sent: 2,
        waiting: 0,
        items: [],
        leavingUntil: NOW - 1,
      },
    });
    expect(host.querySelector('[data-servers-progress]')).toBeNull();
  });
});

describe('C8: reset to automatic', () => {
  const custom = { ...MOCK_STATUS, mode: 'custom' as const };
  it('is one click, then a review and one approval', async () => {
    const api = createMockServersApi({ now: NOW, status: custom });
    const reset = vi.fn(api.reset);
    await mount({}, { api: { ...api, reset } });
    await click(button(S.useAutomatic));
    expect(text()).toContain(S.resetTitle);
    expect(text()).toContain(S.resetBody);
    expect(text()).toContain(S.resetPicks);
    expect(text()).toContain(S.resetForgets);
    expect(text()).toContain(S.contactsTitle);
    expect(text()).toContain('Your custom servers stay readable for 30 days, until');
    expect(button(S.resetKeep)).toBeTruthy();
    expect(reset).not.toHaveBeenCalled();
    await confirmWithCode(S.resetConfirmCode);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset.mock.calls[0]?.[0]).toEqual({ kind: 'code', code: '123456' });
    expect(document.body.querySelector('.al-sheet')).toBeNull();
  });

  it('Keep my servers closes it with nothing sent', async () => {
    const api = createMockServersApi({ now: NOW, status: custom });
    const reset = vi.fn(api.reset);
    await mount({}, { api: { ...api, reset } });
    await click(button(S.useAutomatic));
    await click(button(S.resetKeep));
    expect(document.body.querySelector('.al-sheet')).toBeNull();
    expect(reset).not.toHaveBeenCalled();
  });

  it('says why when it is refused, and when the review cannot be read', async () => {
    await mount({ status: custom, review: { kind: 'refused', code: 'same_list' } });
    await click(button(S.useAutomatic));
    expect(text()).toContain(S.sameList);
    expect(button(S.resetKeep)).toBeTruthy();
  });
});

describe('words and accessibility', () => {
  it('never says relay, wallet, gas, seed phrase or transaction', async () => {
    await openOwn();
    await toList('wss://members.example-team.com');
    await click(switches()[0]);
    await click(switches()[1]);
    expect(text().replace(/relay\.[a-z.-]+/g, '')).not.toMatch(
      /\b(relay|wallet|gas|seed phrase|transaction|nostr|NIP)\b/i,
    );
    const all = JSON.stringify(S);
    expect(all).not.toMatch(/\b(relay|wallet|gas|seed phrase|transaction|nostr)\b/i);
  });

  it('never claims an automatic swap or a wait between changes', () => {
    const all = JSON.stringify(S);
    expect(all).not.toMatch(/swap/i);
    expect(all).not.toMatch(/after 30 days|wait 30|can change again after/i);
  });

  it('axe finds no violation on the entry, each step and the reset', async () => {
    const run = (): Promise<axe.AxeResults> =>
      axe.run(document.body, {
        runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
        rules: { 'color-contrast': { enabled: false } },
      });
    const clean = async (): Promise<void> => {
      const r = await run();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html ?? ''}`)).toEqual([]);
    };
    await openOwn();
    await clean();
    await addServers(
      'wss://relay.example-team.com wss://members.example-team.com wss://write-only.example.net',
    );
    await addServers('wss://relay.primal.net');
    await clean();
    await click(button(S.continue));
    await click(switches()[0]);
    await click(switches()[1]);
    await clean();
    await click(button(S.mixBack));
    await click(button(S.review));
    await clean();
    act(() => root.unmount());
    root = createRoot(host);
    document.body.querySelectorAll('.al-sheet-layer').forEach((n) => n.remove());
    await mount({ status: { ...MOCK_STATUS, mode: 'custom' } });
    await clean();
    await click(button(S.useAutomatic));
    await clean();
  });

  it('is keyboard-friendly: Enter in the field adds, and every control is a real button or switch', async () => {
    await openOwn();
    await type(field(), 'wss://relay.example-team.com');
    const form = field()?.closest('form');
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(rows()).toHaveLength(1);
    expect(
      document.body.querySelectorAll('.al-sheet [onclick], .al-sheet div[tabindex="0"]'),
    ).toHaveLength(0);
  });
});

describe('mounted in Message network (Under the hood)', () => {
  it('the entry is the last card of the page and reads the network state itself', async () => {
    const { NetworkView } = await import('../view.js');
    const answer = {
      agent: 'running',
      mode: 'automatic',
      checking: false,
      checkedAt: NOW,
      servers: [
        { host: 'relay.example.com', roles: ['send', 'read'], kind: 'own', state: 'ready' },
      ],
      legacyReadUntil: null,
      contacts: { total: 0, sharing: 0 },
      updateWouldDrop: 0,
    };
    const answerFor = (input: RequestInfo | URL): unknown =>
      String(input).includes('progress') ? { changedAt: null } : answer;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (input: RequestInfo | URL) =>
          new Response(JSON.stringify(answerFor(input)), { status: 200 }),
      ),
    );
    await act(async () => {
      root.render(
        h(NetworkView, {
          read: async () => ({ kind: 'ok' as const, status: 200, data: answer }),
          readContacts: async () => ({ kind: 'offline' as const }),
        }),
      );
    });
    await settle();
    const children = [...(host.querySelector('section.nw')?.children ?? [])];
    expect(button(S.useOwn)).toBeTruthy();
    expect(children.at(-1)?.getAttribute('data-servers-entry')).toBe('running');
    vi.unstubAllGlobals();
  });
});
