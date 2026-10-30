// @vitest-environment jsdom
// UI-REFRESH-o-b (S2 by content; B-11 §7, §16 Approvals row, §6 row 4; 08 §1; 04 §2.5; I-4, I-5):
// follow-ups to the Approvals refresh. Visual and state handling only: the routes, headers, bodies,
// presence and review-together flow stay as approvals.test.ts pins them.
//
// (a) Under the hood shows the approval ID, through the shared panel's `id` kind (its allowlist
//     decides; the page offers only a well-formed `apr_` ID).
// (b) After an applied approval the card holds "Approved." and every fact while the check draws,
//     then collapses out (reduced motion: removed without animation). The result stays on the page
//     as text a screen reader can reach. A refused attempt and an open sheet keep the card.
// (d) UI-REFRESH-o-c: an applied denial leaves the same way ("Denied." held with every fact, then
//     the shared row leave, then "Denied: <summary>" as text). A refused, expired or failed denial
//     keeps the card, and so does an open sheet.
// (c) The sidebar Approvals badge shows how many requests wait, with the shared tick, and counts
//     down when one is decided; a failed decision changes nothing.
import axe from 'axe-core';
import { HoodProvider, PAY_CONFIRM_STRINGS as P, acceptHoodField } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Layout } from '../../layout/index.js';
import { createPayConfirmClient } from '../../pay-confirm/index.js';
import { SHELL_STRINGS } from '../../strings.js';
import { ApprovePage } from '../approve/index.js';
import { announceDecided, announceWaiting } from './badge.js';
import { APPROVED_HOLD_MS, approvalHoodFields } from './card.js';
import { createApprovalsClient, type ApprovalItem } from './client.js';
import { ApprovalsBoard } from './board.js';
import type { ApprovalsPageProps } from './index.js';
import { APPROVAL_STRINGS as S, fmt } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_900_000_000_000; // ms
const NOW_S = NOW / 1000;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  document.documentElement.removeAttribute('data-motion');
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.textContent = '';
  document.documentElement.removeAttribute('data-motion');
  window.localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (Element.prototype as { animate?: unknown }).animate;
  history.replaceState(null, '', '/');
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
const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
};

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

async function mount(
  answers: Record<string, Answer[]>,
  over: Partial<ApprovalsPageProps> = {},
  hood = false,
) {
  const { srv, props } = pageProps(answers, over);
  act(() =>
    root.render(h(HoodProvider, { value: hood }, h<ApprovalsPageProps>(ApprovalsBoard, props))),
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
    S.cannotApprove,
  ]) {
    expect(text, fact).toContain(fact);
  }
}

const approveOwn = async (c: string): Promise<void> => {
  await click(buttonNamed(S.approve, cardOf(c) as ParentNode));
  setValue(cardOf(c)?.querySelector<HTMLInputElement>('input[type="password"]'), 'owner-code');
  await click(buttonNamed(S.confirmApproval));
};
const reduced = (): void => document.documentElement.setAttribute('data-motion', 'reduced');

// ------------------------------------------------------------------------------------------- (a)

describe('(a) Under the hood shows the approval ID', () => {
  const hoodRows = (c: string): (string | null | undefined)[][] =>
    [...(cardOf(c)?.querySelectorAll('.al-hood .al-hood-row') ?? [])].map((r) => [
      r.querySelector('dt')?.textContent,
      r.querySelector('dd')?.textContent,
    ]);

  it('lists the approval ID first, then the kind and the exact expiry, on every card', async () => {
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
    const iso = new Date((NOW_S + 3 * 3600) * 1000).toISOString();
    expect(hoodRows('A')).toEqual([
      [S.hoodId, id('A')],
      [S.hoodKind, S.kindRequest],
      [S.hoodExpiry, iso],
    ]);
    expect(hoodRows('C')[0]).toEqual([S.hoodId, id('C')]);
    expect(hoodRows('D')[0]).toEqual([S.hoodId, id('D')]);
  });

  it('shows the ID on the deep link card too', async () => {
    history.replaceState(null, '', `/approve/${id('B')}`);
    const { props } = pageProps({
      [`/api/approvals/${id('B')}`]: [ok({ approval: item('B', { commitment: true }) })],
    });
    act(() =>
      root.render(h(HoodProvider, { value: true }, h<ApprovalsPageProps>(ApprovePage, props))),
    );
    await flush();
    expect(hoodRows('B')[0]).toEqual([S.hoodId, id('B')]);
  });

  it('offers the ID through the id kind, so the shared allowlist decides', () => {
    const fields = approvalHoodFields(item('A') as unknown as ApprovalItem);
    expect(fields[0]).toEqual({ kind: 'id', label: S.hoodId, value: id('A') });
  });

  it('the shared id kind accepts real approval IDs (apr_ plus 22 base64url characters)', () => {
    // Realistic 16-byte IDs, dashes and underscores included (owner-approval.ts; 04 §2.4.1).
    for (const value of [
      'apr_Qm9vdHN0cmFwX2lkMTIzNA',
      'apr_x9-Qz7_LmN0pR2sT4uVwXy',
      'apr_-_AbCdEfGhIjKlMnOpQrSt',
      'apr_Zz0123456789abcdefABCD',
      'apr_9fK2-mWq_7Lx3Rt8Yv1nQe',
    ]) {
      expect(value).toMatch(/^apr_[A-Za-z0-9_-]{22}$/);
      expect(acceptHoodField({ kind: 'id', label: S.hoodId, value }), value).toEqual({
        kind: 'id',
        label: S.hoodId,
        value,
      });
    }
  });

  it('never offers a malformed ID, the digest, a link or anything the agent wrote', async () => {
    const odd = approvalHoodFields({
      ...(item('A') as unknown as ApprovalItem),
      approvalId: 'apr_short',
    });
    expect(JSON.stringify(odd)).not.toContain('apr_short');
    await mount({ [LIST]: [ok({ approvals: [item('A'), item('B')] })] }, {}, true);
    for (const panel of host.querySelectorAll('.al-hood')) {
      expect(panel.textContent).not.toContain(CANARY);
      expect(panel.textContent).not.toContain('Headline');
      expect(panel.textContent).not.toMatch(/[0-9a-f]{64}/);
      expect(panel.querySelector('a')).toBeNull();
    }
  });
});

// ------------------------------------------------------------------------------------------- (b)

describe('(b) an approved card collapses out after the check', () => {
  it('holds "Approved." and every fact while the check draws', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reduced();
    await mount({
      [LIST]: [
        ok({ approvals: [item('D', { commitment: true }), item('E', { commitment: true })] }),
      ],
      [`/api/approvals/${id('D')}/approve`]: [ok({ status: 'applied', decision: 'approve' })],
    });
    await approveOwn('D');
    expect(statuses()).toContain(S.approved);
    expect(cardOf('D')?.getAttribute('data-outcome')).toBe('approved');
    expectAllFacts(cardOf('D'), 'D');
    await advance(APPROVED_HOLD_MS - 50);
    expectAllFacts(cardOf('D'), 'D');
  });

  it('with reduced motion it is removed without animation; the result stays as text', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reduced();
    const animate = vi.fn();
    (Element.prototype as { animate?: unknown }).animate = animate;
    await mount({
      [LIST]: [
        ok({ approvals: [item('D', { commitment: true }), item('E', { commitment: true })] }),
      ],
      [`/api/approvals/${id('D')}/approve`]: [ok({ status: 'applied', decision: 'approve' })],
    });
    await approveOwn('D');
    await advance(APPROVED_HOLD_MS + 10);
    expect(cardOf('D')).toBeNull();
    expect(animate).not.toHaveBeenCalled();
    const result = host.querySelector('.ap-result');
    expect(result?.textContent).toBe(fmt(S.approvedLine, { summary: 'Send a message to Ana (D)' }));
    // Reachable by reading, not announced a second time (the card's status line already was).
    expect(result?.closest('[role="status"], [aria-live]')).toBeNull();
    expect(result?.closest('[aria-hidden="true"]')).toBeNull();
    // The other card and the count are as they should be.
    expectAllFacts(cardOf('E'), 'E');
    expect(host.textContent).toContain(fmt(S.waiting, { count: 1 }));
  });

  it('with full motion it fades and collapses its height (the shared row leave), then goes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const anims: { frames: Keyframe[]; anim: { onfinish: (() => void) | null } }[] = [];
    (Element.prototype as { animate?: unknown }).animate = vi.fn(function (frames: Keyframe[]) {
      const anim = {
        onfinish: null as (() => void) | null,
        cancel: vi.fn(),
        reverse: vi.fn(),
        finished: Promise.resolve(),
      };
      anims.push({ frames, anim });
      return anim;
    });
    await mount({
      [LIST]: [ok({ approvals: [item('D', { commitment: true })] })],
      [`/api/approvals/${id('D')}/approve`]: [ok({ status: 'applied', decision: 'approve' })],
    });
    await approveOwn('D');
    await advance(APPROVED_HOLD_MS + 10);
    const collapse = anims.find((a) => a.frames.some((f) => f['height'] === '0px'));
    expect(collapse).toBeDefined();
    expect(collapse?.frames.at(-1)).toMatchObject({ height: '0px', opacity: 0 });
    // Still there while it collapses, gone once the motion ends.
    expect(cardOf('D')).not.toBeNull();
    act(() => collapse?.anim.onfinish?.());
    await flush();
    expect(cardOf('D')).toBeNull();
    expect(host.querySelector('.ap-result')?.textContent).toBe(
      fmt(S.approvedLine, { summary: 'Send a message to Ana (D)' }),
    );
  });

  // UI-REFRESH-o-c: a denial now leaves as an approval does ((d) below); a refused attempt stays.
  it('a refused attempt keeps the card; an applied denial leaves its line', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reduced();
    await mount({
      [LIST]: [
        ok({ approvals: [item('D', { commitment: true }), item('E', { commitment: true })] }),
      ],
      [`/api/approvals/${id('D')}/approve`]: [
        { status: 403, body: { status: 'presence_rejected' } },
      ],
      [`/api/approvals/${id('E')}/deny`]: [ok({ status: 'applied', decision: 'deny' })],
    });
    await approveOwn('D');
    await click(buttonNamed(S.deny, cardOf('E') as ParentNode));
    setValue(cardOf('E')?.querySelector<HTMLInputElement>('input[type="password"]'), 'owner-code');
    await click(buttonNamed(S.confirmDenial));
    await advance(APPROVED_HOLD_MS * 3);
    expectAllFacts(cardOf('D'), 'D');
    expect(cardOf('D')?.hasAttribute('data-outcome')).toBe(false);
    expect(cardOf('E')).toBeNull();
    expect([...host.querySelectorAll('.ap-result')].map((n) => n.textContent)).toEqual([
      fmt(S.deniedLine, { summary: 'Send a message to Ana (E)' }),
    ]);
  });

  it('a paid approval stays while the sheet is open and collapses out after Close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reduced();
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
    await advance(APPROVED_HOLD_MS * 2);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(cardOf('C')?.getAttribute('data-outcome')).toBe('approved');
    await click(buttonNamed(P.close));
    expect(cardOf('C')).not.toBeNull();
    await advance(APPROVED_HOLD_MS + 10);
    expect(cardOf('C')).toBeNull();
    expect(host.querySelector('.ap-result')).not.toBeNull();
  });

  it('the deep link card collapses out too, leaving the result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reduced();
    history.replaceState(null, '', `/approve/${id('B')}`);
    const { props } = pageProps({
      [`/api/approvals/${id('B')}`]: [ok({ approval: item('B', { commitment: true }) })],
      [`/api/approvals/${id('B')}/approve`]: [ok({ status: 'applied', decision: 'approve' })],
    });
    act(() => root.render(h<ApprovalsPageProps>(ApprovePage, props)));
    await flush();
    await approveOwn('B');
    expectAllFacts(cardOf('B'), 'B');
    await advance(APPROVED_HOLD_MS + 10);
    expect(cardOf('B')).toBeNull();
    expect(host.querySelector('.ap-result')?.textContent).toBe(
      fmt(S.approvedLine, { summary: 'Send a message to Ana (B)' }),
    );
    expect(host.textContent).not.toContain(S.notPending);
  });

  it('no autofocus on Approve, and the leave never moves focus onto a button', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reduced();
    await mount({
      [LIST]: [
        ok({ approvals: [item('D', { commitment: true }), item('E', { commitment: true })] }),
      ],
      [`/api/approvals/${id('D')}/approve`]: [ok({ status: 'applied', decision: 'approve' })],
    });
    expect(host.querySelector('[autofocus]')).toBeNull();
    await approveOwn('D');
    await advance(APPROVED_HOLD_MS + 10);
    expect(document.activeElement?.tagName).not.toBe('BUTTON');
  });
});

// ------------------------------------------------------------------------------------------- (d)

describe('(d) a denied card leaves like an approved one (UI-REFRESH-o-c)', () => {
  const denyOwn = async (c: string): Promise<void> => {
    await click(buttonNamed(S.deny, cardOf(c) as ParentNode));
    setValue(cardOf(c)?.querySelector<HTMLInputElement>('input[type="password"]'), 'owner-code');
    await click(buttonNamed(S.confirmDenial, cardOf(c) as ParentNode));
  };
  const deniedLine = (c: string): string =>
    fmt(S.deniedLine, { summary: `Send a message to Ana (${c})` });
  const results = (): (string | null)[] =>
    [...host.querySelectorAll('.ap-result')].map((n) => n.textContent);

  it('the result line is plain words (11 §5) built from the trusted summary only', () => {
    expect(S.deniedLine).toBe('Denied: {summary}');
  });

  it('holds "Denied." and every fact, then (reduced motion) is removed without animation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reduced();
    const animate = vi.fn();
    (Element.prototype as { animate?: unknown }).animate = animate;
    await mount({
      [LIST]: [
        ok({ approvals: [item('D', { commitment: true }), item('E', { commitment: true })] }),
      ],
      [`/api/approvals/${id('D')}/deny`]: [ok({ status: 'applied', decision: 'deny' })],
    });
    await denyOwn('D');
    expect(statuses()).toContain(S.denied);
    expect(cardOf('D')?.getAttribute('data-outcome')).toBe('denied');
    expectAllFacts(cardOf('D'), 'D');
    await advance(APPROVED_HOLD_MS - 50);
    expectAllFacts(cardOf('D'), 'D');
    expect(results()).toEqual([]);
    await advance(60);
    expect(cardOf('D')).toBeNull();
    expect(animate).not.toHaveBeenCalled();
    expect(results()).toEqual([deniedLine('D')]);
    const result = host.querySelector('.ap-result');
    // Reachable by reading, not announced a second time (the card's status line already was).
    expect(result?.closest('[role="status"], [aria-live]')).toBeNull();
    expect(result?.closest('[aria-hidden="true"]')).toBeNull();
    // Plain text: nothing the agent wrote, no markup.
    expect(result?.textContent).not.toContain(CANARY);
    expect(result?.children.length).toBe(0);
    expectAllFacts(cardOf('E'), 'E');
    expect(host.textContent).toContain(fmt(S.waiting, { count: 1 }));
  });

  it('with full motion it fades and collapses its height (the shared row leave), then goes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const anims: { frames: Keyframe[]; anim: { onfinish: (() => void) | null } }[] = [];
    (Element.prototype as { animate?: unknown }).animate = vi.fn(function (frames: Keyframe[]) {
      const anim = {
        onfinish: null as (() => void) | null,
        cancel: vi.fn(),
        reverse: vi.fn(),
        finished: Promise.resolve(),
      };
      anims.push({ frames, anim });
      return anim;
    });
    await mount({
      [LIST]: [ok({ approvals: [item('D', { commitment: true })] })],
      [`/api/approvals/${id('D')}/deny`]: [ok({ status: 'applied', decision: 'deny' })],
    });
    await denyOwn('D');
    await advance(APPROVED_HOLD_MS + 10);
    const collapse = anims.find((a) => a.frames.some((f) => f['height'] === '0px'));
    expect(collapse).toBeDefined();
    expect(collapse?.frames.at(-1)).toMatchObject({ height: '0px', opacity: 0 });
    expect(cardOf('D')).not.toBeNull();
    act(() => collapse?.anim.onfinish?.());
    await flush();
    expect(cardOf('D')).toBeNull();
    expect(results()).toEqual([deniedLine('D')]);
    expect(host.textContent).toContain(fmt(S.waiting, { count: 0 }));
  });

  it('a refused, an expired and a failed denial keep the card, with every fact', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reduced();
    await mount({
      [LIST]: [
        ok({
          approvals: [
            item('D', { commitment: true }),
            item('E', { commitment: true }),
            item('F', { commitment: true }),
          ],
        }),
      ],
      [`/api/approvals/${id('D')}/deny`]: [{ status: 403, body: { status: 'presence_rejected' } }],
      [`/api/approvals/${id('E')}/deny`]: [{ status: 409, body: { status: 'not_pending' } }],
      [`/api/approvals/${id('F')}/deny`]: [{ status: 500, body: {} }],
    });
    await denyOwn('D');
    expect(statuses()).toContain(S.presenceRejected);
    await denyOwn('E');
    expect(statuses()).toContain(S.notPending);
    await denyOwn('F');
    await advance(APPROVED_HOLD_MS * 3);
    for (const c of ['D', 'E', 'F']) {
      expectAllFacts(cardOf(c), c);
      expect(cardOf(c)?.getAttribute('data-outcome')).toBeNull();
    }
    expect(results()).toEqual([]);
    expect(host.textContent).toContain(fmt(S.waiting, { count: 3 }));
  });

  it('a request that has run out of time keeps its card when the deny is refused', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reduced();
    await mount({
      [LIST]: [ok({ approvals: [item('D', { commitment: true, expiresAt: NOW_S - 5 })] })],
      [`/api/approvals/${id('D')}/deny`]: [{ status: 409, body: { status: 'not_pending' } }],
    });
    await denyOwn('D');
    await advance(APPROVED_HOLD_MS * 3);
    expectAllFacts(cardOf('D'), 'D');
    expect(results()).toEqual([]);
  });

  it('stays while the sheet is open, and leaves once it is closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reduced();
    await mount({
      [LIST]: [ok({ approvals: [item('C', { paid: true })] })],
      [BEGIN]: [ok(PROOF_READY)],
      [`/api/approvals/${id('C')}/deny`]: [ok({ status: 'applied', decision: 'deny' })],
    });
    await click(buttonNamed(S.approve, cardOf('C') as ParentNode));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    // A denial applied while the sheet is up (a scripted click; the page is inert to people): the
    // card does not move until the sheet is closed.
    await denyOwn('C');
    expect(cardOf('C')?.getAttribute('data-outcome')).toBe('denied');
    await advance(APPROVED_HOLD_MS * 3);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(cardOf('C')).not.toBeNull();
    expect(results()).toEqual([]);
    await click(buttonNamed(P.cancel));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(cardOf('C')).not.toBeNull();
    await advance(APPROVED_HOLD_MS + 10);
    expect(cardOf('C')).toBeNull();
    expect(results()).toEqual([deniedLine('C')]);
  });

  it('a paid request denied through the plain owner step leaves too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reduced();
    await mount({
      [LIST]: [ok({ approvals: [item('C', { paid: true })] })],
      [`/api/approvals/${id('C')}/deny`]: [ok({ status: 'applied', decision: 'deny' })],
    });
    await denyOwn('C');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await advance(APPROVED_HOLD_MS + 10);
    expect(cardOf('C')).toBeNull();
    expect(results()).toEqual([deniedLine('C')]);
  });

  it('the deep link card leaves too, leaving "Denied: <summary>"', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reduced();
    history.replaceState(null, '', `/approve/${id('B')}`);
    const { props } = pageProps({
      [`/api/approvals/${id('B')}`]: [ok({ approval: item('B', { commitment: true }) })],
      [`/api/approvals/${id('B')}/deny`]: [ok({ status: 'applied', decision: 'deny' })],
    });
    act(() => root.render(h<ApprovalsPageProps>(ApprovePage, props)));
    await flush();
    await denyOwn('B');
    expectAllFacts(cardOf('B'), 'B');
    await advance(APPROVED_HOLD_MS + 10);
    expect(cardOf('B')).toBeNull();
    expect(results()).toEqual([deniedLine('B')]);
    expect(host.textContent).not.toContain(S.notPending);
  });

  it('no autofocus on Approve; after the leave the focus is on the result, never a button', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reduced();
    await mount({
      [LIST]: [
        ok({ approvals: [item('D', { commitment: true }), item('E', { commitment: true })] }),
      ],
      [`/api/approvals/${id('D')}/deny`]: [ok({ status: 'applied', decision: 'deny' })],
    });
    expect(host.querySelector('[autofocus]')).toBeNull();
    await denyOwn('D');
    await advance(APPROVED_HOLD_MS + 10);
    expect(document.activeElement?.tagName).not.toBe('BUTTON');
    expect(document.activeElement?.classList.contains('ap-result')).toBe(true);
    expect(document.activeElement?.textContent).toBe(deniedLine('D'));
  });

  it('the badge and the count tick down only after an applied denial', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reduced();
    const navCount = (): string | null | undefined =>
      // W4-SHELL-V2: the badge sits on Home in the section menu.
      [...host.querySelectorAll<HTMLAnchorElement>('nav.al-rail a')]
        .find((a) => a.getAttribute('href') === '/')
        ?.querySelector('.al-count-in')?.textContent;
    const { props } = pageProps({
      [LIST]: [
        ok({ approvals: [item('D', { commitment: true }), item('E', { commitment: true })] }),
      ],
      [`/api/approvals/${id('D')}/deny`]: [
        { status: 403, body: { status: 'presence_rejected' } },
        ok({ status: 'applied', decision: 'deny' }),
      ],
    });
    act(() =>
      root.render(
        h(
          Layout,
          {
            path: '/',
            nextStep: async () => false,
            unseenMessages: async () => 0,
            waitingApprovals: async () => 2,
            readHealth: () => new Promise<never>(() => undefined),
          } as never,
          h<ApprovalsPageProps>(ApprovalsBoard, props) as never,
        ),
      ),
    );
    await flush();
    expect(navCount()).toBe('2');
    await denyOwn('D');
    await advance(APPROVED_HOLD_MS * 2);
    expect(navCount()).toBe('2');
    expect(host.textContent).toContain(fmt(S.waiting, { count: 2 }));
    expect(cardOf('D')).not.toBeNull();
    await denyOwn('D');
    expect(navCount()).toBe('1');
    await advance(APPROVED_HOLD_MS + 10);
    expect(cardOf('D')).toBeNull();
    expect(navCount()).toBe('1');
    expect(host.textContent).toContain(fmt(S.waiting, { count: 1 }));
  });

  it('axe finds no violation after a denied card has left', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reduced();
    await mount({
      [LIST]: [
        ok({ approvals: [item('D', { commitment: true }), item('E', { commitment: true })] }),
      ],
      [`/api/approvals/${id('D')}/deny`]: [ok({ status: 'applied', decision: 'deny' })],
    });
    await denyOwn('D');
    await advance(APPROVED_HOLD_MS + 10);
    vi.useRealTimers();
    expect(host.querySelector('.ap-result')).not.toBeNull();
    const out = await axe.run(host, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(out.violations.map((v) => v.id)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------- (c)

describe('(c) the sidebar Approvals badge', () => {
  const navLink = (): HTMLAnchorElement | null =>
    // W4-SHELL-V2: the badge sits on Home in the section menu.
    [...host.querySelectorAll<HTMLAnchorElement>('nav.al-rail a')].find(
      (a) => a.getAttribute('href') === '/',
    ) ?? null;

  function mountLayout(
    path: string,
    waitingApprovals: () => Promise<number>,
    children?: unknown,
  ): void {
    act(() =>
      root.render(
        h(
          Layout,
          {
            path,
            nextStep: async () => false,
            unseenMessages: async () => 0,
            waitingApprovals,
            readHealth: () => new Promise<never>(() => undefined),
          } as never,
          (children ?? h('p', null, 'page')) as never,
        ),
      ),
    );
  }

  it('shows the number waiting with the shared tick badge, named for screen readers', async () => {
    mountLayout('/settings/home', async () => 3);
    await flush();
    const badge = navLink()?.querySelector('.al-count');
    expect(badge).not.toBeNull();
    expect(badge?.classList.contains('al-nav-count')).toBe(true);
    expect(badge?.querySelector('.al-count-in')?.textContent).toBe('3');
    expect(badge?.textContent).toContain(`3 ${SHELL_STRINGS.approvalsWaiting}`);
  });

  it('shows no badge when nothing waits or the read fails', async () => {
    mountLayout('/settings/home', async () => 0);
    await flush();
    expect(navLink()?.querySelector('.al-count, .al-nav-count')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    mountLayout('/settings/home', () => Promise.reject(new Error('down')));
    await flush();
    expect(navLink()?.querySelector('.al-count, .al-nav-count')).toBeNull();
  });

  it('ticks with the page: a count from the list, one down per decision', async () => {
    mountLayout('/settings/home', async () => 4);
    await flush();
    act(() => announceDecided(1));
    expect(navLink()?.querySelector('.al-count-in')?.textContent).toBe('3');
    act(() => announceWaiting(2));
    expect(navLink()?.querySelector('.al-count-in')?.textContent).toBe('2');
    act(() => announceDecided(5));
    expect(navLink()?.querySelector('.al-count')).toBeNull();
  });

  it('counts down when a card is decided on the page, and not on a failed decision', async () => {
    const { props } = pageProps({
      [LIST]: [
        ok({
          approvals: [
            item('D', { commitment: true }),
            item('E', { commitment: true }),
            item('F', { commitment: true }),
          ],
        }),
      ],
      [`/api/approvals/${id('D')}/approve`]: [
        { status: 403, body: { status: 'presence_rejected' } },
        ok({ status: 'applied', decision: 'approve' }),
      ],
      [`/api/approvals/${id('E')}/deny`]: [ok({ status: 'applied', decision: 'deny' })],
    });
    mountLayout('/', async () => 3, h<ApprovalsPageProps>(ApprovalsBoard, props));
    await flush();
    const count = (): string | null | undefined =>
      navLink()?.querySelector('.al-count-in')?.textContent;
    expect(count()).toBe('3');
    // A failed decision: no change.
    await approveOwn('D');
    expect(statuses()).toContain(S.presenceRejected);
    expect(count()).toBe('3');
    // An applied denial and an applied approval each count one down, at once.
    await click(buttonNamed(S.deny, cardOf('E') as ParentNode));
    setValue(cardOf('E')?.querySelector<HTMLInputElement>('input[type="password"]'), 'owner-code');
    await click(buttonNamed(S.confirmDenial));
    expect(count()).toBe('2');
    await approveOwn('D');
    expect(count()).toBe('1');
  });

  it('review together counts the applied decisions down', async () => {
    const { props } = pageProps({
      [LIST]: [
        ok({ approvals: [item('A'), item('B'), item('C')] }),
        ok({ approvals: [item('A'), item('B'), item('C')] }),
        ok({ approvals: [item('C')] }),
      ],
      [REVIEW]: [ok({ status: 'applied' })],
    });
    mountLayout('/', async () => 3, h<ApprovalsPageProps>(ApprovalsBoard, props));
    await flush();
    await click(cardOf('A')?.querySelector('input[value="approve"]'));
    await click(cardOf('B')?.querySelector('input[value="deny"]'));
    await click(buttonNamed('Approve 1 and deny 1'));
    setValue(host.querySelector<HTMLInputElement>('input[type="password"]'), 'owner-code');
    await click(buttonNamed(S.confirm));
    expect(navLink()?.querySelector('.al-count-in')?.textContent).toBe('1');
  });

  it('the badge carries only a number: nothing the agent wrote', async () => {
    const { props } = pageProps({
      [LIST]: [ok({ approvals: [item('A'), item('B')] })],
    });
    mountLayout('/', async () => 2, h<ApprovalsPageProps>(ApprovalsBoard, props));
    await flush();
    const badge = navLink()?.querySelector('.al-count');
    expect(badge?.textContent).not.toContain(CANARY);
    expect(badge?.textContent).not.toContain('Ana');
    expect(badge?.querySelector('.al-count-in')?.textContent).toMatch(/^\d+$/);
  });
});

// --------------------------------------------------------------------------------------- axe

describe('axe (WCAG 2.1 A/AA; colour contrast is a visual check, jsdom has no layout)', () => {
  const run = (): Promise<axe.AxeResults> =>
    axe.run(host, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      rules: { 'color-contrast': { enabled: false } },
    });

  it('finds no violation with the badge, the cards and Under the hood on', async () => {
    const { props } = pageProps({
      [LIST]: [
        ok({
          approvals: [item('A'), item('C', { paid: true }), item('D', { commitment: true })],
        }),
      ],
    });
    act(() =>
      root.render(
        h(
          Layout,
          {
            path: '/',
            nextStep: async () => false,
            unseenMessages: async () => 0,
            waitingApprovals: async () => 3,
            readHealth: () => new Promise<never>(() => undefined),
          } as never,
          h(HoodProvider, { value: true }, h<ApprovalsPageProps>(ApprovalsBoard, props)) as never,
        ),
      ),
    );
    await flush();
    expect(host.querySelector('.al-rail-item .al-count')).not.toBeNull();
    expect(host.querySelector('.al-hood')).not.toBeNull();
    expect((await run()).violations.map((v) => v.id)).toEqual([]);
  });

  it('finds no violation after an approved card has collapsed out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reduced();
    await mount({
      [LIST]: [
        ok({ approvals: [item('D', { commitment: true }), item('E', { commitment: true })] }),
      ],
      [`/api/approvals/${id('D')}/approve`]: [ok({ status: 'applied', decision: 'approve' })],
    });
    await approveOwn('D');
    await advance(APPROVED_HOLD_MS + 10);
    vi.useRealTimers();
    expect(host.querySelector('.ap-result')).not.toBeNull();
    expect((await run()).violations.map((v) => v.id)).toEqual([]);
  });
});
