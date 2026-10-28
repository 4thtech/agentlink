// @vitest-environment jsdom
// UX2-b (S1; b11 §22.2, §22.4, §22.5): the control map, page by page. Switches stay on on/off
// settings, views and filters use the segmented control (tabs where they swap a panel), Rules shows
// "Unsaved" beside a switch that differs from the saved value, buttons stay buttons.
import axe from 'axe-core';
import { HoodProvider } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../api/client.js';
import { createApiClient } from '../api/client.js';
import { createPayConfirmClient } from '../pay-confirm/index.js';
import { ActivityPage } from './activity/index.js';
import { ACTIVITY_STRINGS as A } from './activity/strings.js';
import { AppearancePage } from './appearance/index.js';
import { APPEARANCE_STRINGS as P } from './appearance/strings.js';
import { FilesPage, type FilesPageProps } from './files/index.js';
import { MessagesPage } from './messages/index.js';
import { MESSAGES_STRINGS as M } from './messages/strings.js';
import { RulesPage, type RulesPageProps } from './rules/index.js';
import { createOwnerClient } from './rules/owner.js';
import { RULES_STRINGS as R } from './rules/strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const AXE = {
  runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  rules: { 'color-contrast': { enabled: false } },
};
const violations = async (): Promise<string[]> =>
  (await axe.run(host, AXE)).violations.map((v) => `${v.id}: ${v.help}`);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};
const click = async (el: Element | null | undefined): Promise<void> => {
  if (el === null || el === undefined) throw new Error('nothing to click');
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
};
const key = async (el: Element, k: string): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
};
const all = (sel: string): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(sel)];
const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });

// --- Messages: Inbox / Sent are tabs --------------------------------------------------------------

describe('Messages: Inbox / Sent', () => {
  const AT = 1_760_000_000;
  const client = (): ApiClient => {
    const get = vi.fn((path: string) => {
      if (path === '/api/ui/messages')
        return Promise.resolve(
          ok({
            conversations: [{ contactId: 'c-marko', name: 'Marko', lastAt: AT, lastInAt: AT }],
          }),
        );
      return Promise.resolve(ok({ items: [] }));
    });
    return { get, post: vi.fn(), owner: vi.fn() } as unknown as ApiClient;
  };
  const open = async (): Promise<void> => {
    await act(async () => {
      root.render(h(HoodProvider, { value: false }, h(MessagesPage, { api: client() })));
    });
    await click(all('button').find((b) => b.textContent?.includes('Marko')));
  };

  it('is a tablist in the segmented look, controlling a tabpanel that the selected tab labels', async () => {
    await open();
    const list = host.querySelector('[role="tablist"]');
    expect(list?.classList.contains('al-seg')).toBe(true);
    expect(list?.getAttribute('aria-label')).toBe(M.boxLabel);
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    const tabs = all('[role="tab"]');
    const panel = host.querySelector('[role="tabpanel"]');
    expect(panel).not.toBeNull();
    expect(tabs[0]?.getAttribute('aria-controls')).toBe(panel?.id);
    expect(panel?.getAttribute('aria-labelledby')).toBe(tabs[0]?.id);
  });

  it('arrow keys move and select, and the panel follows', async () => {
    await open();
    const tabs = all('[role="tab"]');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1]);
    await key(tabs[0]!, 'ArrowRight');
    await flush();
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[1]);
    expect(host.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(
      tabs[1]?.id,
    );
  });

  it('has no axe violation', async () => {
    await open();
    expect(await violations()).toEqual([]);
  });
});

// --- Files: Received / Sent / Send folders --------------------------------------------------------

describe('Files: Received / Sent / Send folders', () => {
  const fetchFn = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = url.includes('/received')
      ? { items: [] }
      : url.includes('/sent')
        ? { items: [] }
        : { items: [] };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  const mount = async (): Promise<void> => {
    await act(async () => {
      root.render(
        h<FilesPageProps>(FilesPage, { fetch: fetchFn, token: 'tok', initialTab: 'received' }),
      );
    });
    await flush();
  };

  it('uses the shared segmented control with tab semantics, not the old underline tabs', async () => {
    await mount();
    const list = host.querySelector('[role="tablist"]');
    expect(list?.classList.contains('al-seg')).toBe(true);
    expect(host.querySelector('.fl-tabs, .fl-tab')).toBeNull();
    const tabs = all('[role="tab"]');
    expect(tabs).toHaveLength(3);
    expect(tabs[0]?.id).toBe('fl-tab-received');
    expect(tabs[0]?.getAttribute('aria-controls')).toBe('fl-tabpanel');
    expect(host.querySelector('#fl-tabpanel')?.getAttribute('role')).toBe('tabpanel');
  });

  it('Home and End jump, arrows wrap', async () => {
    await mount();
    const tabs = all('[role="tab"]');
    await key(tabs[0]!, 'End');
    await flush();
    expect(all('[role="tab"]')[2]?.getAttribute('aria-selected')).toBe('true');
    await key(all('[role="tab"]')[2]!, 'ArrowRight');
    await flush();
    expect(all('[role="tab"]')[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('has no axe violation', async () => {
    await mount();
    expect(await violations()).toEqual([]);
  });
});

// --- Activity: the filter is a radiogroup ---------------------------------------------------------

describe('Activity: All / Approvals / Proofs / Other', () => {
  const AT = 1_760_000_000;
  const items = [
    { kind: 'approval_decided', at: AT, decision: 'approved' },
    { kind: 'proof', at: AT - 60, direction: 'sent', state: 'recorded' },
  ];
  const mount = async (): Promise<void> => {
    const api = { get: vi.fn(async () => ok({ items })), post: vi.fn() } as unknown as ApiClient;
    await act(async () => {
      root.render(h(HoodProvider, { value: false }, h(ActivityPage, { api })));
    });
  };

  it('is a segmented radiogroup of four with exactly one chosen, and no pressed chips', async () => {
    await mount();
    const group = host.querySelector(`[role="radiogroup"][aria-label="${A.filterLabel}"]`);
    expect(group?.classList.contains('al-seg')).toBe(true);
    const radios = all('[role="radio"]');
    expect(radios).toHaveLength(4);
    expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(host.querySelector('[aria-pressed], .al-activity-chip, .al-activity-chips')).toBeNull();
  });

  it('one tab stop; arrow keys move and select; the list follows', async () => {
    await mount();
    const radios = all('[role="radio"]');
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1, -1]);
    await key(radios[0]!, 'ArrowRight');
    expect(radios[1]?.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radios[1]);
    expect(host.querySelector('.al-activity-list')?.getAttribute('data-filter')).toBe('approvals');
  });

  it('has no axe violation', async () => {
    await mount();
    expect(await violations()).toEqual([]);
  });
});

// --- Appearance: values stay segmented, Under the hood stays a switch -----------------------------

describe('Appearance', () => {
  it('Theme, Motion and Transparency stay segmented radiogroups (Transparency never a switch)', async () => {
    act(() => root.render(h(HoodProvider, { value: false }, h(AppearancePage))));
    for (const g of [P.theme, P.motion, P.transparency]) {
      const group = host.querySelector(`[role="radiogroup"][aria-label="${g}"]`);
      expect(group?.classList.contains('al-seg'), g).toBe(true);
    }
    expect(
      all('[role="switch"]').map((s) => s.getAttribute('aria-labelledby')).length,
    ).toBeLessThanOrEqual(1);
    expect(host.querySelectorAll('[role="radiogroup"]')).toHaveLength(3);
  });
});

// --- Rules: Unsaved beside a switch that is not in force yet --------------------------------------

describe('Rules: "Unsaved" beside draft switches (b11 §22.5)', () => {
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
  const SELL_ON = {
    ...DEFAULTS,
    commitments: { ...DEFAULTS.commitments, autoAcceptDirection: 'sell', autoAcceptMinUSD: '50' },
  };
  const REVIEW_OK = {
    status: 'review',
    review: 'ab'.repeat(32),
    warnings: [],
    askKeepDeliveryReceipts: false,
  };
  const NO_PASSKEY = {
    passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' },
  };

  async function mount(rulesAfterSave?: unknown): Promise<void> {
    let saved = false;
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = (typeof input === 'string' ? input : input.toString()).split('?')[0] ?? '';
      const key = `${init?.method ?? 'GET'} ${url}`;
      let body: unknown;
      let status = 200;
      if (key === 'GET /api/ui/rules')
        body = { status: 'ok', version: saved ? 1 : 0, rules: saved ? rulesAfterSave : DEFAULTS };
      else if (key === 'GET /api/ui/rules/review') body = REVIEW_OK;
      else if (key === 'GET /api/owner/passkey') body = NO_PASSKEY;
      else if (key === 'POST /api/ui/rules') {
        saved = true;
        body = { status: 'saved', version: 1 };
      } else {
        body = {};
        status = 404;
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof fetch;
    const api = createApiClient({ fetch: fetchFn, token: 't' });
    const owner = createOwnerClient({ fetch: fetchFn, token: 't' });
    const payConfirm = createPayConfirmClient({ fetch: fetchFn, token: 't' });
    act(() => root.render(h<RulesPageProps>(RulesPage, { api, owner, payConfirm })));
    await flush();
    const more = host.querySelector<HTMLButtonElement>('button[aria-controls="rules-more"]');
    if (more?.getAttribute('aria-expanded') !== 'true') await click(more);
  }
  const sw = (label: string): HTMLButtonElement | undefined =>
    all('button[role="switch"]').find(
      (b) =>
        document.getElementById(b.getAttribute('aria-labelledby') ?? '')?.textContent === label,
    ) as HTMLButtonElement | undefined;
  const rowOf = (label: string): Element | null | undefined => sw(label)?.closest('.al-switch-row');
  const noteOf = (label: string): string | undefined =>
    rowOf(label)?.querySelector('.al-switch-note')?.textContent ?? undefined;
  const inputLabelled = (label: string): HTMLInputElement | null => {
    const l = all('label').find((x) => x.textContent === label);
    const id = l?.getAttribute('for');
    return id ? (document.getElementById(id) as HTMLInputElement | null) : null;
  };
  const typeInto = async (input: HTMLInputElement | null, value: string): Promise<void> => {
    if (input === null) throw new Error('no such input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
  };
  const byText = (t: string): HTMLButtonElement | undefined =>
    all('button').find((b) => b.textContent?.trim() === t) as HTMLButtonElement | undefined;

  it('has the new string, in plain words', () => {
    expect((R as { unsaved?: string }).unsaved).toBe('Unsaved');
  });

  it('shows no note while nothing differs from the saved rules', async () => {
    await mount();
    expect(host.querySelector('.al-switch-note')).toBeNull();
  });

  it('turning a switch on shows "Unsaved" beside that switch only, with the changes bar', async () => {
    await mount();
    await click(sw(R.sellTitle));
    expect(noteOf(R.sellTitle)).toBe('Unsaved');
    expect(noteOf(R.buyTitle)).toBeUndefined();
    expect(host.querySelector('.rl-unsaved')?.textContent).toContain(R.changes(1));
    const note = rowOf(R.sellTitle)?.querySelector('.al-switch-note');
    expect(sw(R.sellTitle)?.getAttribute('aria-describedby')).toContain(note?.id ?? 'x');
  });

  it('switching it back by hand removes the word', async () => {
    await mount();
    await click(sw(R.sellTitle));
    await click(sw(R.sellTitle));
    expect(host.querySelector('.al-switch-note')).toBeNull();
  });

  it('Discard puts the switch back and the word goes', async () => {
    await mount();
    await click(sw(R.sellTitle));
    await click(byText(R.discard));
    expect(sw(R.sellTitle)?.getAttribute('aria-checked')).toBe('false');
    expect(host.querySelector('.al-switch-note')).toBeNull();
  });

  it('a saved-on rule turned off in the draft shows the word until it is turned back', async () => {
    await mount(SELL_ON);
    await click(sw(R.sellTitle));
    expect(noteOf(R.sellTitle)).toBe('Unsaved'); // turned off in the draft; the saved rule is still on
    await click(sw(R.sellTitle));
    expect(noteOf(R.sellTitle)).toBeUndefined();
  });

  it('a draft that the owner has not saved yet keeps the word when they go back from the review', async () => {
    await mount();
    await click(sw(R.sellTitle));
    await typeInto(inputLabelled(R.sellMin), '50');
    await click(byText(R.reviewSave));
    await click(byText(R.back));
    if (!sw(R.sellTitle)) await click(host.querySelector('button[aria-controls="rules-more"]'));
    expect(noteOf(R.sellTitle)).toBe('Unsaved');
  });

  it('goes once the save has succeeded and the saved rules are in force', async () => {
    await mount(SELL_ON);
    await click(sw(R.sellTitle));
    await typeInto(inputLabelled(R.sellMin), '50');
    await click(byText(R.reviewSave));
    await typeInto(inputLabelled(R.codeLabel), 'ABCD-EFGH');
    await click(byText(R.saveCode));
    const more = host.querySelector<HTMLButtonElement>('button[aria-controls="rules-more"]');
    if (more?.getAttribute('aria-expanded') !== 'true') await click(more);
    expect(sw(R.sellTitle)?.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('.al-switch-note')).toBeNull();
    expect(host.querySelector('.rl-unsaved')).toBeNull();
  });

  it('a disabled switch with nothing changed carries no note, and Everyday choices have no switch', async () => {
    await mount();
    expect(
      host.querySelector('section[aria-labelledby="rules-everyday"] [role="switch"]'),
    ).toBeNull();
    expect(
      host.querySelectorAll('section[aria-labelledby="rules-everyday"] [role="radiogroup"]').length,
    ).toBeGreaterThan(0);
  });

  it('has no axe violation while a switch is unsaved', async () => {
    await mount();
    await click(sw(R.sellTitle));
    expect(await violations()).toEqual([]);
  });
});
