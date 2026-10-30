// @vitest-environment jsdom
// UI-REFRESH-o (S2): the Approvals page after the visual refresh (B-11 §16 Approvals row, §6 rows 4,
// 7 and 12, §7, §4/§8; 04 §2.5; I-4, I-5). Visual only: approvals.test.ts pins the routes, headers,
// bodies, presence and review-together flow unchanged; these tests pin what the refresh may not
// break: every fact the owner confirms stays visible (WYSIWYS), nothing from the agent moves or
// reaches the ring, the moment or Under the hood, and focus never lands on Approve.
//
// Cards sit on level 1; the card being decided rises to level 2; each card has a ring meter for the
// time left; an applied approval draws the check, a denial fades the decided card. Under the hood
// shows the approval ID (UI-REFRESH-o-b, through the shared panel's `id` kind), the kind and the
// exact expiry. The collapse after an approval is pinned in approvals.followups.test.ts.
import { HoodProvider, PAY_CONFIRM_STRINGS as P, lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPayConfirmClient } from '../../pay-confirm/index.js';
import { ApprovePage } from '../approve/index.js';
import pageCss from './approvals.css?raw';
import boardCss from './board.css?raw';

// W4-HOME: the list's own rules moved to board.css; the page's stylesheet is both files.
const approvalsCss = `${pageCss}\n${boardCss}`;
import { createApprovalsClient } from './client.js';
import { ApprovalsBoard } from './board.js';
import { APPROVAL_TTL, type ApprovalsPageProps } from './index.js';
import { APPROVAL_STRINGS as S } from './strings.js';

// Read through Vite (a relative import would leave the app): the server's approval lifetime, and
// the page's own stylesheet as text (vitest.config.ts includes approvals.css for `?raw`).
const sources = import.meta.glob(['../../../../../packages/types/src/constants.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_900_000_000_000; // ms
const NOW_S = NOW / 1000;

let host: HTMLElement;
let root: Root;
const animate = vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve(), onfinish: null }));
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  document.documentElement.removeAttribute('data-motion');
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
  vi.unstubAllGlobals();
  delete (Element.prototype as { animate?: unknown }).animate;
  delete (window as { matchMedia?: unknown }).matchMedia;
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
function item(c: string, over: Record<string, unknown> = {}) {
  return {
    approvalId: id(c),
    summary: `Send a message to Ana (${c})`,
    actionDigest: c.toLowerCase().repeat(64),
    expiresAt: NOW_S + 3 * 3600,
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
const REVIEW = '/api/approvals/review';
const BEGIN = '/api/ui/pay-confirm/begin';
const FINISH = '/api/ui/pay-confirm/finish';
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
const statuses = (): string[] =>
  [...document.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? '');

async function mount(
  answers: Record<string, Answer[]>,
  over: Partial<ApprovalsPageProps> = {},
  hood = false,
) {
  const srv = server({ [PASSKEY]: [ok({ passkey: null })], ...answers });
  const client = createApprovalsClient({ fetch: srv.fetch, token: 't0ken' });
  const payConfirm = createPayConfirmClient({ fetch: srv.fetch, token: 't0ken' });
  act(() =>
    root.render(
      h(
        HoodProvider,
        { value: hood },
        h<ApprovalsPageProps>(ApprovalsBoard, {
          client,
          payConfirm,
          canPasskey: false,
          platform: 'other',
          reducedMotion: true,
          ...over,
        }),
      ),
    ),
  );
  await flush();
  return srv;
}

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
    S.who,
    S.what,
    S.cost,
    S.expires,
    S.why,
    S.cannotApprove,
  ]) {
    expect(text, fact).toContain(fact);
  }
}

const level = (el: Element | null | undefined): string | null =>
  el?.closest('.al-surface')?.getAttribute('data-level') ?? null;

describe('depth: cards on level 1, the card being decided on level 2', () => {
  it('puts every card on a level 1 surface, with nothing frosted', async () => {
    await mount({
      [LIST]: [
        ok({ approvals: [item('A'), item('C', { paid: true }), item('D', { commitment: true })] }),
      ],
    });
    for (const c of ['A', 'C', 'D']) {
      const card = cardOf(c);
      expect(card?.classList.contains('al-surface'), c).toBe(true);
      expect(card?.getAttribute('data-level'), c).toBe('1');
    }
    expect(approvalsCss).not.toMatch(/backdrop-filter/);
  });

  it('a list card rises to level 2 once a choice is made; Later lowers it again', async () => {
    await mount({ [LIST]: [ok({ approvals: [item('A'), item('B')] })] });
    await click(cardOf('A')?.querySelector('input[value="approve"]'));
    expect(cardOf('A')?.getAttribute('data-level')).toBe('2');
    expect(cardOf('B')?.getAttribute('data-level')).toBe('1');
    await click(cardOf('A')?.querySelector('input[value="later"]'));
    expect(cardOf('A')?.getAttribute('data-level')).toBe('1');
  });

  it('a card with its own Approve rises to level 2 while its owner step is open', async () => {
    await mount({ [LIST]: [ok({ approvals: [item('D', { commitment: true })] })] });
    expect(cardOf('D')?.getAttribute('data-level')).toBe('1');
    await click(buttonNamed(S.approve, cardOf('D') as ParentNode));
    expect(cardOf('D')?.getAttribute('data-level')).toBe('2');
    expectAllFacts(cardOf('D'), 'D');
  });

  it('the review-together step sits on level 2 and the whole list stays visible', async () => {
    await mount({
      [LIST]: [
        ok({ approvals: [item('A'), item('B')] }),
        ok({ approvals: [item('A'), item('B')] }),
      ],
    });
    await click(cardOf('A')?.querySelector('input[value="approve"]'));
    await click(buttonNamed('Approve 1'));
    const step = host.querySelector('[role="group"][aria-label="Confirm"]');
    expect(level(step)).toBe('2');
    expectAllFacts(cardOf('A'), 'A');
    expectAllFacts(cardOf('B'), 'B');
  });
});

describe('time left: a ring meter on each card', () => {
  it('uses the server approval lifetime as the full ring', () => {
    const text = String(Object.values(sources)[0] ?? '');
    expect(text).toContain(
      `export const APPROVAL_TTL_SECONDS = ${APPROVAL_TTL.toLocaleString('en').replace(/,/g, '_')};`,
    );
  });

  it('shows the time left as a named meter, from the expiry only', async () => {
    await mount({
      [LIST]: [
        ok({
          approvals: [
            item('A', { expiresAt: NOW_S + 3 * 3600 }),
            item('B', { expiresAt: NOW_S + 10 * 60 }),
          ],
        }),
      ],
    });
    const a = cardOf('A')?.querySelector('[role="meter"]');
    expect(a?.getAttribute('aria-label')).toBe(S.timeLeft);
    expect(a?.getAttribute('aria-valuemax')).toBe(String(APPROVAL_TTL));
    expect(a?.getAttribute('aria-valuenow')).toBe(String(3 * 3600));
    expect(a?.getAttribute('aria-valuetext')).toBe('About 3 h left');
    const b = cardOf('B')?.querySelector('[role="meter"]');
    expect(b?.getAttribute('aria-valuetext')).toBe('10 min left');
    expect(b?.classList.contains('is-low')).toBe(true);
  });

  it('says Expired at zero and never shows anything from the agent', async () => {
    await mount({ [LIST]: [ok({ approvals: [item('A', { expiresAt: NOW_S - 5 })] })] });
    const ring = cardOf('A')?.querySelector('.al-ring');
    expect(ring?.getAttribute('aria-valuetext')).toBe(S.expired);
    expect(ring?.getAttribute('aria-valuenow')).toBe('0');
    expect(ring?.textContent).not.toContain(CANARY);
    expect(ring?.outerHTML).not.toContain('Ana');
  });
});

describe('done: an approval draws the check, a denial fades the card', () => {
  it('an applied approval keeps "Approved." and every fact, and shows the approved moment', async () => {
    await mount({
      [LIST]: [ok({ approvals: [item('D', { commitment: true })] })],
      [`/api/approvals/${id('D')}/approve`]: [ok({ status: 'applied', decision: 'approve' })],
    });
    await click(buttonNamed(S.approve, cardOf('D') as ParentNode));
    setValue(cardOf('D')?.querySelector<HTMLInputElement>('input[type="password"]'), 'owner-code');
    await click(buttonNamed(S.confirmApproval));
    expect(statuses()).toContain(S.approved);
    expect(cardOf('D')?.getAttribute('data-outcome')).toBe('approved');
    expect(cardOf('D')?.querySelector('.al-moment[data-kind="approved"]')).not.toBeNull();
    expectAllFacts(cardOf('D'), 'D');
  });

  it('an applied denial fades the card, keeps "Denied." and every fact, with no check', async () => {
    await mount({
      [LIST]: [ok({ approvals: [item('D', { commitment: true })] })],
      [`/api/approvals/${id('D')}/deny`]: [ok({ status: 'applied', decision: 'deny' })],
    });
    await click(buttonNamed(S.deny, cardOf('D') as ParentNode));
    setValue(cardOf('D')?.querySelector<HTMLInputElement>('input[type="password"]'), 'owner-code');
    await click(buttonNamed(S.confirmDenial));
    expect(statuses()).toContain(S.denied);
    expect(cardOf('D')?.getAttribute('data-outcome')).toBe('denied');
    expect(cardOf('D')?.querySelector('.al-moment')).toBeNull();
    expectAllFacts(cardOf('D'), 'D');
  });

  it('a refused attempt shows no moment and no outcome', async () => {
    await mount({
      [LIST]: [ok({ approvals: [item('D', { commitment: true })] })],
      [`/api/approvals/${id('D')}/approve`]: [
        { status: 403, body: { status: 'presence_rejected' } },
      ],
    });
    await click(buttonNamed(S.approve, cardOf('D') as ParentNode));
    setValue(cardOf('D')?.querySelector<HTMLInputElement>('input[type="password"]'), 'nope');
    await click(buttonNamed(S.confirmApproval));
    expect(statuses()).toContain(S.presenceRejected);
    expect(cardOf('D')?.hasAttribute('data-outcome')).toBe(false);
    expect(host.querySelector('.al-moment')).toBeNull();
  });

  it('a paid approval through the sheet ends with the approved moment', async () => {
    await mount({
      [LIST]: [ok({ approvals: [item('C', { paid: true })] })],
      [BEGIN]: [ok(PROOF_READY)],
      [FINISH]: [ok({ status: 'applied' })],
    });
    await click(buttonNamed(S.approve, cardOf('C') as ParentNode));
    setValue(
      document.querySelector<HTMLInputElement>('[role="dialog"] input[type="password"]'),
      'ABCD-EFGH',
    );
    await click(
      buttonNamed(P.confirmCode, document.querySelector('[role="dialog"]') as ParentNode),
    );
    await click(buttonNamed(P.close));
    expect(cardOf('C')?.getAttribute('data-outcome')).toBe('approved');
    expect(cardOf('C')?.querySelector('.al-moment[data-kind="approved"]')).not.toBeNull();
  });

  it('review together: the moment when something was approved, none for denials only', async () => {
    await mount({
      [LIST]: [
        ok({ approvals: [item('A'), item('B')] }),
        ok({ approvals: [item('A'), item('B')] }),
        ok({ approvals: [] }),
      ],
      [REVIEW]: [ok({ status: 'applied' })],
    });
    await click(cardOf('A')?.querySelector('input[value="approve"]'));
    await click(buttonNamed('Approve 1'));
    setValue(host.querySelector<HTMLInputElement>('input[type="password"]'), 'owner-code');
    await click(buttonNamed(S.confirm));
    expect(statuses()).toContain('Done: approved 1.');
    expect(host.querySelector('.al-notices .al-moment[data-kind="approved"]')).not.toBeNull();

    act(() => root.unmount());
    root = createRoot(host);
    await mount({
      [LIST]: [
        ok({ approvals: [item('A')] }),
        ok({ approvals: [item('A')] }),
        ok({ approvals: [] }),
      ],
      [REVIEW]: [ok({ status: 'applied' })],
    });
    await click(cardOf('A')?.querySelector('input[value="deny"]'));
    await click(buttonNamed('Deny 1'));
    setValue(host.querySelector<HTMLInputElement>('input[type="password"]'), 'owner-code');
    await click(buttonNamed(S.confirm));
    expect(statuses()).toContain('Done: denied 1.');
    expect(host.querySelector('.al-moment')).toBeNull();
  });
});

describe('reduced motion and what never moves', () => {
  const approveD = async (): Promise<void> => {
    await mount({
      [LIST]: [ok({ approvals: [item('D', { commitment: true })] })],
      [`/api/approvals/${id('D')}/approve`]: [ok({ status: 'applied', decision: 'approve' })],
    });
    await click(buttonNamed(S.approve, cardOf('D') as ParentNode));
    setValue(cardOf('D')?.querySelector<HTMLInputElement>('input[type="password"]'), 'owner-code');
    await click(buttonNamed(S.confirmApproval));
  };

  it('with full motion the check draws (Web Animations)', async () => {
    (Element.prototype as { animate?: unknown }).animate = animate;
    animate.mockClear();
    await approveD();
    expect(animate).toHaveBeenCalled();
    expect(cardOf('D')?.querySelector('.al-moment')?.getAttribute('data-motion')).toBe('full');
  });

  it('with reduced motion (the app setting) nothing animates; the word stays', async () => {
    document.documentElement.setAttribute('data-motion', 'reduced');
    (Element.prototype as { animate?: unknown }).animate = animate;
    animate.mockClear();
    await approveD();
    expect(animate).not.toHaveBeenCalled();
    expect(cardOf('D')?.querySelector('.al-moment')?.getAttribute('data-motion')).toBe('reduced');
    expect(statuses()).toContain(S.approved);
  });

  it('with reduced motion (the system setting) nothing animates', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (q: string) => ({
        matches: q.includes('prefers-reduced-motion: reduce'),
        media: q,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    (Element.prototype as { animate?: unknown }).animate = animate;
    animate.mockClear();
    await approveD();
    expect(animate).not.toHaveBeenCalled();
  });

  it('content from the agent sits in no moving, ring or hood element', async () => {
    (Element.prototype as { animate?: unknown }).animate = animate;
    await approveD();
    for (const el of host.querySelectorAll(
      '.al-moment, [data-a], .al-row-presence, .al-ring, .al-hood, .al-skeleton',
    )) {
      expect(el.textContent).not.toContain(CANARY);
      expect(el.textContent).not.toContain('Headline');
    }
    const untrusted = host.querySelector('.al-untrusted');
    expect(untrusted?.closest('[data-a], .al-moment, .al-row-presence')).toBeNull();
  });

  it('the stylesheet: tokens only, only opacity moves, both reduced-motion rules, no fact hidden', () => {
    expect(approvalsCss.length).toBeGreaterThan(100);
    expect(approvalsCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(approvalsCss).not.toMatch(/\b\d+(\.\d+)?m?s\b/);
    expect(approvalsCss).not.toMatch(/@keyframes|animation\s*:/);
    for (const m of approvalsCss.matchAll(/transition(-property)?\s*:\s*([^;]+);/g)) {
      expect(m[2]?.trim()).toMatch(/^(opacity|none)(\s|$)/);
    }
    expect(approvalsCss).toContain('prefers-reduced-motion: reduce');
    expect(approvalsCss).toContain("[data-motion='reduced']");
    // Nothing the owner confirms is ever hidden or faded to nothing by the page's own rules.
    const rules = [
      ...approvalsCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g),
    ];
    for (const [, selector = '', body = ''] of rules) {
      if (
        /al-approval-rows|al-arow|al-untrusted|al-terms|al-approval-foot|h2|al-approval-type/.test(
          selector,
        )
      ) {
        expect(body, selector).not.toMatch(
          /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\s|;|$)/,
        );
      }
    }
  });
});

describe('Under the hood', () => {
  it('is off until the global switch is on', async () => {
    await mount({ [LIST]: [ok({ approvals: [item('A')] })] });
    expect(host.querySelector('.al-hood')).toBeNull();
  });

  it('shows the approval ID, the kind and the exact expiry per card, and nothing the agent wrote', async () => {
    await mount(
      {
        [LIST]: [
          ok({
            approvals: [item('A'), item('C', { paid: true }), item('D', { commitment: true })],
          }),
        ],
      },
      {},
      true,
    );
    const rows = (c: string): (string | null | undefined)[][] =>
      [...(cardOf(c)?.querySelectorAll('.al-hood .al-hood-row') ?? [])].map((r) => [
        r.querySelector('dt')?.textContent,
        r.querySelector('dd')?.textContent,
      ]);
    const iso = new Date((NOW_S + 3 * 3600) * 1000).toISOString();
    expect(rows('A')).toEqual([
      [S.hoodId, id('A')],
      [S.hoodKind, S.kindRequest],
      [S.hoodExpiry, iso],
    ]);
    expect(rows('C')[1]).toEqual([S.hoodKind, S.kindPaid]);
    expect(rows('D')[1]).toEqual([S.hoodKind, S.kindTerms]);
    for (const panel of host.querySelectorAll('.al-hood')) {
      expect(panel.textContent).not.toContain(CANARY);
      expect(panel.textContent).not.toContain('Headline');
      expect(panel.textContent).not.toMatch(/[0-9a-f]{64}/);
      expect(panel.querySelector('a')).toBeNull();
    }
  });
});

describe('first load', () => {
  it('shows the shared Skeleton while the list loads, never "Loading…"', async () => {
    vi.useFakeTimers();
    const never = (): Promise<Response> => new Promise<Response>(() => undefined);
    const passkey = (): Promise<Response> =>
      Promise.resolve(new Response(JSON.stringify({ passkey: null }), { status: 200 }));
    const fetchFn = ((u: RequestInfo | URL) =>
      String(u) === PASSKEY ? passkey() : never()) as typeof fetch;
    await act(async () => {
      root.render(
        h<ApprovalsPageProps>(ApprovalsBoard, {
          client: createApprovalsClient({ fetch: fetchFn, token: 't' }),
          canPasskey: false,
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(450);
    });
    const sk = host.querySelector('.al-skeleton');
    expect(sk?.getAttribute('role')).toBe('status');
    expect(sk?.getAttribute('aria-busy')).toBe('true');
    expect(host.textContent).not.toMatch(/Loading…/);
    expect(host.querySelector('h1')?.textContent).toBe(S.appTitle);
  });

  it('the deep link shows the shared Skeleton while its request loads', async () => {
    vi.useFakeTimers();
    history.replaceState(null, '', `/approve/${id('A')}`);
    const fetchFn = ((u: RequestInfo | URL) =>
      String(u) === PASSKEY
        ? Promise.resolve(new Response(JSON.stringify({ passkey: null }), { status: 200 }))
        : new Promise<Response>(() => undefined)) as typeof fetch;
    await act(async () => {
      root.render(
        h<ApprovalsPageProps>(ApprovePage, {
          client: createApprovalsClient({ fetch: fetchFn, token: 't' }),
          canPasskey: false,
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(450);
    });
    expect(host.querySelector('.al-skeleton')).not.toBeNull();
    history.replaceState(null, '', '/');
  });
});

describe('focus and accessibility (structure; axe-core is not a dependency of this app)', () => {
  it('nothing is focused on load, no autofocus, and Approve is never the focus after a click', async () => {
    await mount({
      [LIST]: [
        ok({ approvals: [item('A'), item('C', { paid: true }), item('D', { commitment: true })] }),
      ],
    });
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
    expect(host.querySelector('[autofocus]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(buttonNamed(S.approve, cardOf('D') as ParentNode));
    const active = document.activeElement as HTMLElement | null;
    expect(active?.getAttribute('role')).toBe('group');
    expect(active?.tagName).not.toBe('BUTTON');
  });

  it('one h1, every control and meter named, and the default text passes the vocabulary lint', async () => {
    await mount(
      {
        [LIST]: [
          ok({
            approvals: [item('A'), item('C', { paid: true }), item('D', { commitment: true })],
          }),
        ],
      },
      {},
      true,
    );
    expect(host.querySelectorAll('h1').length).toBe(1);
    for (const b of host.querySelectorAll('button')) {
      expect((b.textContent ?? '').trim() || b.getAttribute('aria-label')).toBeTruthy();
    }
    for (const m of host.querySelectorAll('[role="meter"]')) {
      expect(m.getAttribute('aria-label')).toBeTruthy();
      expect(m.getAttribute('aria-valuetext')).toBeTruthy();
    }
    expect(lintVocabulary(host.textContent ?? '')).toEqual([]);
  });
});
