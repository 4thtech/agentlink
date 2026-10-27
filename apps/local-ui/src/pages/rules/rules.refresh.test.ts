// @vitest-environment jsdom
// UI-REFRESH-m (S1): the Rules page, visual refresh only (B-11 §16 Rules; §4/§8; §7). The signed
// summary sits in a recessed well, the card groups are Surface 1, the first load shows the shared
// Skeleton, "Saved" plays once as a SuccessMoment after the existing save step, and the optional
// Under the hood panel shows the rules version only. What a rule means, how an edit is saved and
// the presence step are untouched (I-4): the existing rules tests stay as they are.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoodProvider } from '@4thtech-io/ui';
import { createApiClient } from '../../api/client.js';
import { createPayConfirmClient } from '../../pay-confirm/index.js';
import rulesCss from './rules.css?raw';
import { RulesPage } from './index.js';
import { createOwnerClient } from './owner.js';
import { RULES_STRINGS as S } from './strings.js';

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
  document.documentElement.removeAttribute('data-motion');
  vi.useRealTimers();
});

const DEFAULTS = {
  proofs: {
    notarize: 'allow',
    dailyBudgetUSD: '5',
    perActionMaxUSD: '1',
    allowKeyDisclosure: 'approval',
  },
  contacts: { acceptInvites: 'approval', unknownSenders: 'queue', allowed: 'paired', listed: 0 },
  files: { maxSendSizeMB: 100, maxReceiveSizeMB: 200, allowedFolders: 0 },
  receipts: { autoDelivered: false },
  commitments: {
    accept: 'approval',
    autoAcceptDirection: 'buy',
    autoAcceptMaxUSD: '0',
    autoAcceptMinUSD: null,
    autoAcceptContacts: 2,
  },
  contactRules: 0,
};
const RULES = (version = 0) => ({ status: 'ok', version, rules: DEFAULTS });
const REVIEW_OK = {
  status: 'review',
  review: 'ab'.repeat(32),
  warnings: [],
  askKeepDeliveryReceipts: false,
};
const NO_PASSKEY = {
  passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' },
};

function fetchFor(routes: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0] ?? ''}`;
    const body = routes[key];
    if (body === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

async function mount(routes: Record<string, unknown>, hood = false): Promise<void> {
  const fetchFn = fetchFor(routes);
  const api = createApiClient({ fetch: fetchFn, token: 't0ken' });
  const owner = createOwnerClient({ fetch: fetchFn, token: 't0ken' });
  const payConfirm = createPayConfirmClient({ fetch: fetchFn, token: 't0ken' });
  const page = createElement(RulesPage, { api, owner, payConfirm });
  act(() => root.render(hood ? createElement(HoodProvider, { value: true }, page) : page));
  await flush();
}

const click = async (el: Element | null | undefined): Promise<void> => {
  expect(el).toBeTruthy();
  act(() => {
    (el as HTMLElement).click();
  });
  await flush();
};
const buttonByText = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const radio = (group: string, label: string): HTMLButtonElement | undefined => {
  const g = host.querySelector(`[role="radiogroup"][aria-label="${group}"]`);
  return [...(g?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])].find((b) =>
    b.textContent?.startsWith(label),
  );
};

describe('first load: Skeleton', () => {
  it('shows the shared Skeleton, not the loading sentence', async () => {
    vi.useFakeTimers();
    const never = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const api = createApiClient({ fetch: never, token: 't0ken' });
    act(() => root.render(createElement(RulesPage, { api })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(host.querySelector('.al-skeleton')).not.toBeNull();
    expect(host.textContent).not.toContain('Loading your rules…');
  });
});

describe('loaded page', () => {
  it('shows the signed summary in a recessed well and the groups on Surface 1', async () => {
    await mount({ 'GET /api/ui/rules': RULES() });
    const well = host.querySelector('.rl-summary');
    expect(well?.getAttribute('data-level')).toBe('recessed');
    expect(well?.textContent).toContain('Rules in force');
    const cards = host.querySelectorAll('.rl-card');
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(c.getAttribute('data-level')).toBe('1');
  });

  it('keeps the structure assistive technology needs (axe is not a dependency of this app)', async () => {
    await mount({ 'GET /api/ui/rules': RULES() });
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    const well = host.querySelector('.rl-summary');
    expect(well?.getAttribute('aria-labelledby')).toBeTruthy();
    const heading = host.querySelector(`#${well?.getAttribute('aria-labelledby')}`);
    expect(heading?.textContent).toBe('Rules in force');
    for (const b of host.querySelectorAll('button')) {
      expect((b.textContent ?? '').trim() !== '' || b.getAttribute('aria-label')).toBeTruthy();
    }
  });
});

describe('error and offline states keep the page honest', () => {
  it('an unavailable read shows the notice and no summary', async () => {
    await mount({});
    expect(host.textContent).toContain(S.unavailable);
    expect(host.querySelector('.rl-summary')).toBeNull();
  });
});

describe('Saved: a SuccessMoment after the existing save step', () => {
  const routes = {
    'GET /api/ui/rules': RULES(3),
    'GET /api/ui/rules/review': REVIEW_OK,
    'GET /api/owner/passkey': NO_PASSKEY,
    'POST /api/ui/rules': { status: 'saved', version: 4 },
  };
  async function save(): Promise<void> {
    await mount(routes);
    await click(radio(S.invitesTitle, S.allow));
    await click(buttonByText(S.reviewSave));
    const code = host.querySelector<HTMLInputElement>('input[type="password"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(code, 'ABCD-EFGH');
      code?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    await click(buttonByText(S.saveCode));
  }

  it('plays once, with the words, and nothing else appears', async () => {
    await save();
    const moment = host.querySelector('.al-moment');
    expect(moment?.getAttribute('data-kind')).toBe('approved');
    expect(host.textContent).toContain(S.saved);
    expect(host.querySelectorAll('.al-moment')).toHaveLength(1);
  });

  it('with reduced motion (the app setting) the moment is the still version', async () => {
    document.documentElement.setAttribute('data-motion', 'reduced');
    await save();
    expect(host.querySelector('.al-moment')?.getAttribute('data-motion')).toBe('reduced');
    expect(host.textContent).toContain(S.saved);
  });
});

describe('the stylesheet', () => {
  it('uses tokens only: no literal duration, no keyframes, no backdrop-filter', () => {
    expect(rulesCss).not.toMatch(/\b\d+(\.\d+)?m?s\b/);
    expect(rulesCss).not.toMatch(/backdrop-filter/);
    expect(rulesCss).not.toMatch(/@keyframes/);
  });
});

describe('Under the hood', () => {
  it('shows the rules version and nothing technical beyond it', async () => {
    await mount({ 'GET /api/ui/rules': RULES(7) }, true);
    const hood = host.querySelector('.al-hood');
    expect(hood).not.toBeNull();
    const rows = [...(hood?.querySelectorAll('.al-hood-row') ?? [])].map((r) => r.textContent);
    expect(rows).toEqual(['Rules version7']);
  });

  it('is absent while the switch is off', async () => {
    await mount({ 'GET /api/ui/rules': RULES(7) });
    expect(host.querySelector('.al-hood')).toBeNull();
  });
});
