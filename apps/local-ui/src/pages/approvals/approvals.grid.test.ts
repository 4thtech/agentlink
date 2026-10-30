// @vitest-environment jsdom
// UX2-a (S2, approval UI; B-11 §26, §22; UX-WAVE-2 §9.1; 08 §1; 04 §2.5; I-4, I-5): the Approvals
// grid and the Grid/List "Layout" control. Layout only: the routes, headers, bodies, presence, the
// review-together flow (approvals.test.ts), the refresh (approvals.refresh.test.ts) and the leave
// after a decision (approvals.followups.test.ts, #629/#639) stay as those files pin them.
//
// What these tests pin:
// - Grid is the default; the cards, and only the cards, sit in one grid; DOM order is the visual
//   order (soonest expiry first), so Tab and screen readers run row by row.
// - A radiogroup labelled "Layout" with Grid and List; arrow keys move and select, focus stays on
//   the control; the choice is remembered per browser in the prefs store, and a store that throws
//   still shows Grid and still switches for the visit.
// - Nothing autofocuses Approve, in either view; Deny stays before Approve; every fact the owner
//   confirms is in every card (WYSIWYS); at most one presence sheet at a time.
// - The stylesheet: auto-fill grid with min(360px, 100%) (no overflow at 360), no `order`, no
//   `dense`, nothing truncated or clamped, text wraps, the control hidden while one column fits,
//   the chosen option tinted orange, nothing about the layout animates.
// - axe finds no violation in Grid or List with the control shown.
import axe from 'axe-core';
import { HoodProvider } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPayConfirmClient } from '../../pay-confirm/index.js';
import { getPrefs, PREFS_KEY, resetPrefsForTests } from '../../prefs/index.js';
import { ApprovePage } from '../approve/index.js';
import pageCss from './approvals.css?raw';
import boardCss from './board.css?raw';

// W4-HOME: the list's own rules moved to board.css; the page's stylesheet is both files.
const approvalsCss = `${pageCss}\n${boardCss}`;
import { APPROVED_HOLD_MS } from './card.js';
import { createApprovalsClient } from './client.js';
import { ApprovalsBoard } from './board.js';
import type { ApprovalsPageProps } from './index.js';
import { APPROVAL_STRINGS as S, fmt } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_900_000_000_000; // ms
const NOW_S = NOW / 1000;

let host: HTMLElement;
let root: Root;
const animate = vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve(), onfinish: null }));
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  document.documentElement.removeAttribute('data-motion');
  window.localStorage.clear();
  resetPrefsForTests();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.textContent = '';
  document.documentElement.removeAttribute('data-motion');
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetPrefsForTests();
  delete (Element.prototype as { animate?: unknown }).animate;
});

type Answer = { status: number; body: unknown };
function server(answers: Record<string, Answer[]>) {
  const calls: string[] = [];
  const fetchFn = (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    const queue = answers[url] ?? [];
    const a = (queue.length > 1 ? queue.shift() : queue[0]) ?? { status: 404, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(a.body), {
        status: a.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { calls, fetch: fetchFn as typeof fetch };
}
const ok = (body: unknown): Answer => ({ status: 200, body });
const id = (c: string): string => `apr_${c.repeat(22)}`;
const CANARY = 'CANARY-FROM-AI';
function item(c: string, hours: number, over: Record<string, unknown> = {}) {
  return {
    approvalId: id(c),
    summary: `Send a message to Ana (${c})`,
    actionDigest: c.toLowerCase().repeat(64),
    expiresAt: NOW_S + hours * 3600,
    commitment: false,
    details: {
      headline: `Headline ${c}`,
      who: 'Ana (self-declared)',
      what: 'Send a message',
      cost: 'Free',
      expires: '12 Oct 2026 14:02 UTC',
      rule: 'Ask me',
      fromAi: [{ name: 'text', value: `${CANARY} ${c}` }],
      terms: [`Term line ${c}`],
    },
    ...over,
  };
}
const PASSKEY = '/api/owner/passkey';
const LIST = '/api/approvals';
const BEGIN = '/api/ui/pay-confirm/begin';
const PROOF_READY = {
  status: 'ready',
  ceremony: 'c'.repeat(22),
  statement: {
    v: 1,
    kind: 'proof',
    amountUsd: '0.1',
    purpose: 'proof',
    counterparty: 'Ana',
    changes: [],
  },
  expiresInMs: 120000,
  publicKey: {
    rpId: 'localhost',
    challenge: 'AQIDBA',
    allowCredentials: [],
    userVerification: 'required',
    timeoutMs: 120000,
    prfSalt: 'BQY',
  },
};

// Given out of order on purpose: the page sorts soonest expiry first (B, D, A, C, E).
const MIXED = [
  item('A', 3),
  item('C', 4, { paid: true }),
  item('B', 1),
  item('E', 5),
  item('D', 2, { commitment: true }),
];
const ORDER = ['B', 'D', 'A', 'C', 'E'];

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};
const buttonNamed = (name: string, scope: ParentNode = document): HTMLButtonElement | undefined =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
const click = async (el: Element | null | undefined): Promise<void> => {
  expect(el).toBeTruthy();
  act(() => (el as HTMLElement).click());
  await flush();
};
const setValue = (input: HTMLInputElement | null | undefined, value: string): void => {
  expect(input).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const cardOf = (c: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-approval="${id(c)}"]`);
const page = (): HTMLElement | null => host.querySelector<HTMLElement>('.al-approvals');
const grid = (): HTMLElement | null => host.querySelector<HTMLElement>('.ap-cards');
const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
};

/** The radiogroup whose accessible name is "Layout" (aria-label or aria-labelledby). */
function layoutGroup(): HTMLElement | undefined {
  return [...host.querySelectorAll<HTMLElement>('[role="radiogroup"]')].find((g) => {
    const named = g.getAttribute('aria-label');
    if (named !== null) return named === S.layout;
    const by = g.getAttribute('aria-labelledby');
    return by !== null && document.getElementById(by)?.textContent?.trim() === S.layout;
  });
}
const radio = (name: string): HTMLButtonElement | undefined =>
  [...(layoutGroup()?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])].find(
    (r) => r.textContent?.trim() === name,
  );

function pageProps(answers: Record<string, Answer[]>, over: Partial<ApprovalsPageProps> = {}) {
  const srv = server({ [PASSKEY]: [ok({ passkey: null })], ...answers });
  return {
    srv,
    props: {
      client: createApprovalsClient({ fetch: srv.fetch, token: 't0ken' }),
      payConfirm: createPayConfirmClient({ fetch: srv.fetch, token: 't0ken' }),
      canPasskey: false,
      platform: 'other',
      reducedMotion: true,
      ...over,
    } as ApprovalsPageProps,
  };
}
async function mount(answers: Record<string, Answer[]>, hood = false) {
  const { srv, props } = pageProps(answers);
  act(() =>
    root.render(h(HoodProvider, { value: hood }, h<ApprovalsPageProps>(ApprovalsBoard, props))),
  );
  await flush();
  return srv;
}
const mountMixed = () => mount({ [LIST]: [ok({ approvals: MIXED })] });

/** Every fact the owner confirms, for one card (WYSIWYS). */
function expectAllFacts(card: HTMLElement | null, c: string): void {
  expect(card).toBeTruthy();
  const text = card?.textContent ?? '';
  for (const fact of [
    `Headline ${c}`,
    'Ana (self-declared)',
    'Send a message',
    'Free',
    '12 Oct 2026 14:02 UTC',
    'Ask me',
    `Term line ${c}`,
    `${CANARY} ${c}`,
    S.cannotApprove,
  ]) {
    expect(text, fact).toContain(fact);
  }
}
const stored = (): unknown => {
  const raw = window.localStorage.getItem(PREFS_KEY);
  return raw === null ? undefined : (JSON.parse(raw) as Record<string, unknown>)['approvalsLayout'];
};

// ------------------------------------------------------------------------------------- words

describe('the new words (B-11 §22.4, §26.2; 11 §5)', () => {
  it('are "Layout", "Grid" and "List"', () => {
    expect(S.layout).toBe('Layout');
    expect(S.layoutGrid).toBe('Grid');
    expect(S.layoutList).toBe('List');
  });
});

// -------------------------------------------------------------------------------------- grid

describe('Grid is the default and holds only the cards (B-11 §26.1)', () => {
  it('starts in Grid with no stored choice', async () => {
    await mountMixed();
    expect(page()?.getAttribute('data-layout')).toBe('grid');
    expect(radio(S.layoutGrid)?.getAttribute('aria-checked')).toBe('true');
    expect(radio(S.layoutList)?.getAttribute('aria-checked')).toBe('false');
  });

  it('DOM order is the visual order: soonest expiry first, one grid item per card', async () => {
    await mountMixed();
    const cards = grid();
    expect(cards).not.toBeNull();
    expect(cards?.children.length).toBe(ORDER.length);
    const ids = [...(cards?.children ?? [])].map(
      (el) =>
        (el.matches('[data-approval]') ? el : el.querySelector('[data-approval]'))?.getAttribute(
          'data-approval',
        ) ?? null,
    );
    expect(ids).toEqual(ORDER.map(id));
    // The same order in List: switching never reorders anything.
    await click(radio(S.layoutList));
    expect(
      [...host.querySelectorAll('[data-approval]')].map((n) => n.getAttribute('data-approval')),
    ).toEqual(ORDER.map(id));
  });

  it('everything that is not a card stays outside the grid', async () => {
    await mountMixed();
    const cards = grid();
    expect(host.querySelector('.al-section-title')?.closest('.ap-cards')).toBeNull();
    expect(host.querySelector('.al-bar')?.closest('.ap-cards')).toBeNull();
    expect(host.querySelector('h1')?.closest('.ap-cards')).toBeNull();
    expect(layoutGroup()?.closest('.ap-cards')).toBeNull();
    for (const child of cards?.children ?? []) {
      expect(child.matches('.al-approval, .ap-leave')).toBe(true);
    }
  });

  it('"{n} more waiting" stays below the grid, outside it', async () => {
    const many = Array.from({ length: 22 }, (_, i) =>
      item(String.fromCharCode(97 + i), 1, {
        expiresAt: NOW_S + 3600 + i,
        actionDigest: i.toString(16).padStart(64, '0'),
      }),
    );
    await mount({ [LIST]: [ok({ approvals: many })] });
    expect(grid()?.children.length).toBe(20);
    const more = [...host.querySelectorAll('[role="status"]')].find(
      (n) => n.textContent === fmt(S.moreWaiting, { count: 2 }),
    );
    expect(more).toBeDefined();
    expect(more?.closest('.ap-cards')).toBeNull();
  });

  it('the /approve/<id> page has no Layout control', async () => {
    const { props } = pageProps({
      [`/api/approvals/${id('A')}`]: [ok(item('A', 3))],
      [LIST]: [ok({ approvals: [item('A', 3)] })],
    });
    act(() => root.render(h<ApprovalsPageProps>(ApprovePage, props)));
    await flush();
    expect(layoutGroup()).toBeUndefined();
  });

  it('/approve/<id>: a card with long unbroken text sits where the wrap rule applies', async () => {
    const LONG = 'x'.repeat(400);
    const long = item('A', 3, {
      summary: LONG,
      details: { ...item('A', 3).details, headline: LONG, who: LONG, what: LONG, terms: [LONG] },
    });
    history.replaceState(null, '', `/approve/${id('A')}`);
    try {
      const { props } = pageProps({ [`/api/approvals/${id('A')}`]: [ok({ approval: long })] });
      act(() => root.render(h<ApprovalsPageProps>(ApprovePage, props)));
      await flush();
      const card = cardOf('A');
      expect(card).not.toBeNull();
      // `.al-approvals .al-approval` carries min-width: 0 and overflow-wrap: anywhere (stylesheet
      // test below); the 360 px browser check is in the PR (jsdom has no layout).
      expect(card?.matches('.al-approvals .al-approval')).toBe(true);
      expect(card?.textContent).toContain(LONG);
    } finally {
      history.replaceState(null, '', '/');
    }
  });
});

// ------------------------------------------------------------------------------- the control

describe('the Layout control (B-11 §26.2, §22.4)', () => {
  it('is a radiogroup named "Layout" in the title row, with Grid then List', async () => {
    await mountMixed();
    const group = layoutGroup();
    expect(group).toBeDefined();
    expect(
      [...(group?.querySelectorAll('[role="radio"]') ?? [])].map((r) => r.textContent?.trim()),
    ).toEqual([S.layoutGrid, S.layoutList]);
    expect(group?.closest('.ap-title-row')?.querySelector('h1')?.textContent).toBe(S.appTitle);
    // One tab stop.
    expect(radio(S.layoutGrid)?.tabIndex).toBe(0);
    expect(radio(S.layoutList)?.tabIndex).toBe(-1);
  });

  it('List is today’s single column; the choice is remembered in the prefs store', async () => {
    await mountMixed();
    await click(radio(S.layoutList));
    expect(page()?.getAttribute('data-layout')).toBe('list');
    expect(radio(S.layoutList)?.getAttribute('aria-checked')).toBe('true');
    expect(getPrefs().approvalsLayout).toBe('list');
    expect(stored()).toBe('list');
    await click(radio(S.layoutGrid));
    expect(page()?.getAttribute('data-layout')).toBe('grid');
    expect(stored()).toBe('grid');
  });

  it('arrow keys move and select; focus stays on the control', async () => {
    await mountMixed();
    act(() => radio(S.layoutGrid)?.focus());
    act(() => {
      radio(S.layoutGrid)?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    await flush();
    expect(page()?.getAttribute('data-layout')).toBe('list');
    expect(document.activeElement).toBe(radio(S.layoutList));
    expect(layoutGroup()?.contains(document.activeElement)).toBe(true);
  });

  it('a stored List comes back on the next visit', async () => {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ approvalsLayout: 'list' }));
    resetPrefsForTests();
    await mountMixed();
    expect(page()?.getAttribute('data-layout')).toBe('list');
    expect(radio(S.layoutList)?.getAttribute('aria-checked')).toBe('true');
  });

  it('an unknown stored value is ignored: Grid', async () => {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ approvalsLayout: '<script>' }));
    resetPrefsForTests();
    await mountMixed();
    expect(page()?.getAttribute('data-layout')).toBe('grid');
  });

  it('storage that throws: the page shows Grid and the control still works for the visit', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    resetPrefsForTests();
    await mountMixed();
    expect(page()?.getAttribute('data-layout')).toBe('grid');
    await click(radio(S.layoutList));
    expect(page()?.getAttribute('data-layout')).toBe('list');
  });

  it('changing the view moves nothing (no animation, full motion or reduced)', async () => {
    (Element.prototype as { animate?: unknown }).animate = animate;
    animate.mockClear();
    await mountMixed();
    animate.mockClear();
    await click(radio(S.layoutList));
    await click(radio(S.layoutGrid));
    expect(animate).not.toHaveBeenCalled();
    document.documentElement.setAttribute('data-motion', 'reduced');
    await click(radio(S.layoutList));
    expect(animate).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------ what does not change

describe('what does not change (B-11 §26.3)', () => {
  for (const layout of ['grid', 'list'] as const) {
    describe(`in ${layout}`, () => {
      const setLayout = async (): Promise<void> => {
        await mountMixed();
        if (layout === 'list') await click(radio(S.layoutList));
        expect(page()?.getAttribute('data-layout')).toBe(layout);
      };

      it('every card shows every fact (WYSIWYS)', async () => {
        await setLayout();
        for (const c of ORDER) expectAllFacts(cardOf(c), c);
      });

      it('Deny comes before Approve on a card with its own buttons', async () => {
        await setLayout();
        for (const c of ['C', 'D']) {
          const names = [...(cardOf(c)?.querySelectorAll('.al-approval-actions button') ?? [])].map(
            (b) => b.textContent?.trim(),
          );
          expect(names).toEqual([S.deny, S.approve]);
        }
      });

      it('nothing autofocuses Approve (or any button)', async () => {
        await setLayout();
        expect(host.querySelector('[autofocus]')).toBeNull();
        const active = document.activeElement;
        if (layout === 'grid') expect(active === null || active === document.body).toBe(true);
        for (const b of host.querySelectorAll('button')) {
          if (b.textContent?.trim() === S.approve) expect(b).not.toBe(active);
        }
      });

      it('the card being decided rises one level; the decide call is unchanged', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        document.documentElement.setAttribute('data-motion', 'reduced');
        const approveUrl = `/api/approvals/${id('D')}/approve`;
        const { srv, props } = pageProps({
          [LIST]: [ok({ approvals: MIXED })],
          [approveUrl]: [ok({ status: 'applied', decision: 'approve' })],
        });
        if (layout === 'list') {
          window.localStorage.setItem(PREFS_KEY, JSON.stringify({ approvalsLayout: 'list' }));
          resetPrefsForTests();
        }
        act(() => root.render(h<ApprovalsPageProps>(ApprovalsBoard, props)));
        await flush();
        expect(page()?.getAttribute('data-layout')).toBe(layout);
        await click(buttonNamed(S.approve, cardOf('D') as ParentNode));
        expect(cardOf('D')?.className).toContain('al-surface--l2');
        setValue(
          cardOf('D')?.querySelector<HTMLInputElement>('input[type="password"]'),
          'owner-code',
        );
        await click(buttonNamed(S.confirmApproval, cardOf('D') as ParentNode));
        expect(srv.calls.filter((u) => u === approveUrl)).toHaveLength(1);
        // #629: held, then (reduced motion) gone at once; its line stays outside the grid.
        await advance(APPROVED_HOLD_MS + 10);
        expect(cardOf('D')).toBeNull();
        const result = host.querySelector('.ap-result');
        expect(result?.textContent).toBe(
          fmt(S.approvedLine, { summary: 'Send a message to Ana (D)' }),
        );
        expect(result?.closest('.ap-cards')).toBeNull();
        expect(grid()?.children.length).toBe(ORDER.length - 1);
      });

      it('at most one presence sheet at a time', async () => {
        const { props } = pageProps({
          [LIST]: [ok({ approvals: [item('C', 1, { paid: true }), item('F', 2, { paid: true })] })],
          [BEGIN]: [ok(PROOF_READY)],
        });
        if (layout === 'list') {
          window.localStorage.setItem(PREFS_KEY, JSON.stringify({ approvalsLayout: 'list' }));
          resetPrefsForTests();
        }
        act(() => root.render(h<ApprovalsPageProps>(ApprovalsBoard, props)));
        await flush();
        expect(page()?.getAttribute('data-layout')).toBe(layout);
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
        await click(buttonNamed(S.approve, cardOf('C') as ParentNode));
        const dialogs = document.querySelectorAll('[role="dialog"]');
        expect(dialogs).toHaveLength(1);
        expect(dialogs[0]?.getAttribute('aria-modal')).toBe('true');
      });
    });
  }
});

// -------------------------------------------------------------------------------- stylesheet

describe('the stylesheet (B-11 §26.1, §26.3, §22.3)', () => {
  const css = approvalsCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel = '', body = '']) => ({
    sel: sel.trim(),
    body,
  }));

  it('Grid: auto-fill columns of at least min(360px, 100%), the 16 px gap, rows aligned to the top', () => {
    const g = rules.find(
      (r) => r.sel.includes('.ap-cards') && /grid-template-columns/.test(r.body),
    );
    expect(g?.body).toMatch(
      /grid-template-columns\s*:\s*repeat\(\s*auto-fill\s*,\s*minmax\(\s*min\(\s*360px\s*,\s*100%\s*\)\s*,\s*1fr\s*\)\s*\)/,
    );
    expect(g?.body).toMatch(/gap\s*:\s*var\(--al-space-5\)/);
    expect(g?.body).toMatch(/align-items\s*:\s*start/);
    expect(css).toMatch(/max-width\s*:\s*var\(--al-layout-max-page\)/);
  });

  it('List keeps today’s 480 px single column', () => {
    const list = rules.find((r) => /data-layout='list'\]\s+\.ap-cards/.test(r.sel));
    expect(list?.body).toMatch(/max-width\s*:\s*480px/);
    expect(list?.body).toMatch(/grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/);
  });

  it('DOM order is the visual order: no `order`, no dense packing', () => {
    expect(css).not.toMatch(/(^|[;{\s])order\s*:/);
    expect(css).not.toMatch(/\bdense\b/);
  });

  it('nothing is truncated, ellipsized, clamped or hidden in a card; text wraps', () => {
    expect(css).not.toMatch(/text-overflow|line-clamp|white-space\s*:\s*nowrap/);
    const item = rules.find((r) => /\.ap-cards\s*>\s*\*/.test(r.sel));
    expect(item?.body).toMatch(/min-width\s*:\s*0/);
    expect(item?.body).toMatch(/overflow-wrap\s*:\s*anywhere/);
    // The same rule holds on every card, so /approve/<id> (no grid) wraps too (IR-UX2-a-1).
    expect(item?.sel.split(',').map((x) => x.trim())).toContain('.al-approvals .al-approval');
    for (const r of rules.filter((x) => x.sel.includes('.ap-cards'))) {
      expect(r.body, r.sel).not.toMatch(
        /overflow\s*:\s*hidden|max-height|display\s*:\s*none|visibility\s*:\s*hidden/,
      );
    }
  });

  it('what the AI wrote wraps, keeping every space and line break (found in the 360 px shots)', () => {
    const pre = rules.find((r) => /\.al-untrusted\s+pre/.test(r.sel));
    expect(pre?.body).toMatch(/white-space\s*:\s*pre-wrap/);
    expect(pre?.body).toMatch(/overflow-wrap\s*:\s*anywhere/);
  });

  it('the control is hidden while only one column fits (under 1008 px)', () => {
    const media = /@media\s*\(max-width:\s*1007px\)\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(media?.[1]).toMatch(/\.ap-layout\s*\{\s*display\s*:\s*none/);
  });

  it('the chosen option is tinted orange, with the check icon kept (never colour alone)', () => {
    const tint = rules.find((r) => /\.ap-layout\s+\.al-seg-opt\.is-on/.test(r.sel));
    expect(tint?.body).toMatch(/background\s*:\s*var\(--al-color-accent-subtle\)/);
  });

  it('nothing about the layout animates', () => {
    for (const r of rules.filter((x) => /ap-cards|ap-layout|ap-title-row/.test(x.sel))) {
      expect(r.body, r.sel).not.toMatch(/transition|animation/);
    }
  });
});

// ---------------------------------------------------------------------------------------- axe

describe('axe (WCAG 2.1 A/AA; colour contrast is a visual check, jsdom has no layout)', () => {
  const run = (): Promise<axe.AxeResults> =>
    axe.run(host, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      rules: { 'color-contrast': { enabled: false } },
    });

  it('finds no violation in Grid with the Layout control and Under the hood on', async () => {
    await mount({ [LIST]: [ok({ approvals: MIXED })] }, true);
    expect(layoutGroup()).toBeDefined();
    expect(page()?.getAttribute('data-layout')).toBe('grid');
    expect((await run()).violations.map((v) => v.id)).toEqual([]);
  });

  it('finds no violation in List', async () => {
    await mountMixed();
    await click(radio(S.layoutList));
    expect(page()?.getAttribute('data-layout')).toBe('list');
    expect((await run()).violations.map((v) => v.id)).toEqual([]);
  });
});
