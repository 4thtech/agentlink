// @vitest-environment jsdom
// M1-11b-2: Approvals inside the app (08 §1; 04 §2.5, §2.5.2, §2.5.3; D-68, D-118, D-132; I-4, I-5).
// Parity with the former server-rendered approval page (removed in M1-11b-2c): the
// same endpoints, headers and bodies, the same words, the same rules. A paid request is never a list
// item: its card has its own Approve, which opens the confirmation sheet (proof flow, "Remember for
// this contact" when offered, the backup code with the server's three tries). Review together leaves
// out paid and terms items and what is no longer waiting. `/approve/<id>` renders inside the shell.
// Every value from the server is text only (I-5).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAY_CONFIRM_STRINGS as P } from '@4thtech-io/ui';
import { createPayConfirmClient } from '../../pay-confirm/index.js';
import { AppRoutes } from '../../router.js';
import { ApprovePage } from '../approve/index.js';
import { ApprovalsBoard } from './board.js';
import type { ApprovalsPageProps } from './index.js';
import { createApprovalsClient } from './client.js';
import { APPROVAL_STRINGS as S } from './strings.js';

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
  document.body.textContent = '';
  vi.unstubAllGlobals();
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}
type Answer = { status: number; body: unknown };

function server(answers: Record<string, Answer[]>) {
  const calls: Call[] = [];
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const raw = init?.body;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(0),
    });
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
const DIGEST = (c: string): string => c.repeat(64);

function item(c: string, over: Record<string, unknown> = {}) {
  return {
    approvalId: id(c),
    summary: `Send a message to Ana (${c})`,
    actionDigest: DIGEST(c === 'A' ? 'a' : c === 'B' ? 'b' : c === 'C' ? 'c' : 'd'),
    expiresAt: 1_800_000_000,
    commitment: false,
    details: {
      headline: `Headline ${c}`,
      who: 'Ana (self-declared)',
      what: 'Send a message',
      cost: 'Free',
      expires: '12 Oct 2026 14:02 UTC',
      rule: 'Ask me',
      fromAi: [{ name: 'text', value: `hello ${c}` }],
    },
    ...over,
  };
}

const PASSKEY_NONE = { status: 200, body: { passkey: null } };
const LIST = '/api/approvals';
const REVIEW = '/api/approvals/review';
const BEGIN = '/api/ui/pay-confirm/begin';
const FINISH = '/api/ui/pay-confirm/finish';
const PASSKEY = '/api/owner/passkey';

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
const setValue = (input: HTMLInputElement | null, value: string): void => {
  expect(input).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const decodeInput = (call: Call | undefined): unknown => {
  const raw = call?.headers.get('x-agentlink-input') ?? '';
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
};
const cardOf = (c: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-approval="${id(c)}"]`);
const statuses = (): string[] =>
  [...document.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? '');

async function mount(answers: Record<string, Answer[]>, over: Partial<ApprovalsPageProps> = {}) {
  const srv = server({ [PASSKEY]: [PASSKEY_NONE], ...answers });
  const client = createApprovalsClient({ fetch: srv.fetch, token: 't0ken' });
  const payConfirm = createPayConfirmClient({ fetch: srv.fetch, token: 't0ken' });
  act(() =>
    root.render(
      createElement<ApprovalsPageProps>(ApprovalsBoard, {
        client,
        payConfirm,
        canPasskey: false,
        platform: 'other',
        reducedMotion: true,
        ...over,
      }),
    ),
  );
  await flush();
  return srv;
}

describe('the list (D-68): parity with the approval page', () => {
  it('shows the count, soonest to expire first, with Approve, Deny or Later for plain requests', async () => {
    await mount({
      [LIST]: [
        ok({
          approvals: [
            item('B', { expiresAt: 1_900_000_000 }),
            item('A', { expiresAt: 1_800_000_000 }),
          ],
        }),
      ],
    });
    expect(host.querySelector('main, h1')?.textContent ?? '').toBeTruthy();
    expect(host.textContent).toContain('Waiting for you (2)');
    const cards = [...host.querySelectorAll('[data-approval]')].map((n) =>
      n.getAttribute('data-approval'),
    );
    expect(cards).toEqual([id('A'), id('B')]);
    const radios = cardOf('A')?.querySelectorAll('input[type="radio"]');
    expect([...(radios ?? [])].map((r) => (r as HTMLInputElement).value)).toEqual([
      'approve',
      'deny',
      'later',
    ]);
    expect(buttonNamed(S.nothingSelected)?.disabled).toBe(true);
    expect(host.textContent).toContain(S.cannotApprove);
  });

  it('says nothing is waiting', async () => {
    await mount({ [LIST]: [ok({ approvals: [] })] });
    expect(host.textContent).toContain('Waiting for you (0)');
    expect(statuses()).toContain(S.nothingWaiting);
  });

  it('renders every server value as text only (I-5)', async () => {
    const evil = '<img src=x onerror="alert(1)">';
    await mount({
      [LIST]: [
        ok({
          approvals: [
            item('A', {
              details: {
                ...item('A').details,
                headline: evil,
                fromAi: [{ name: evil, value: evil }],
              },
            }),
          ],
        }),
      ],
    });
    expect(host.querySelector('img')).toBeNull();
    const region = host.querySelector(`figure[aria-label="${S.fromAi}"]`);
    expect(region?.querySelector('pre')?.textContent).toBe(evil);
    expect(cardOf('A')?.querySelector('h2')?.textContent).toBe(evil);
  });
});

describe('a request that costs credits (M1-PAY-CONFIRM-b parity)', () => {
  it('is never a list item: its own card, its own Approve, the "on its own" note', async () => {
    await mount({ [LIST]: [ok({ approvals: [item('A'), item('C', { paid: true })] })] });
    const paid = cardOf('C');
    expect(paid?.querySelector('input[type="radio"]')).toBeNull();
    expect(paid?.textContent).toContain(S.paidAlone);
    expect(buttonNamed(S.approve, paid as ParentNode)).toBeDefined();
    expect(buttonNamed(S.deny, paid as ParentNode)).toBeDefined();
  });

  it('Approve opens the confirmation sheet with the proof flow; nothing asked before', async () => {
    const srv = await mount({
      [LIST]: [ok({ approvals: [item('C', { paid: true })] })],
      [BEGIN]: [ok(PROOF_READY)],
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(buttonNamed(S.approve, cardOf('C') as ParentNode));
    const begin = srv.calls.find((c) => c.url === BEGIN);
    expect(decodeInput(begin)).toEqual({ flow: 'proof', approvalId: id('C') });
    expect(begin?.body.length).toBe(0);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.textContent).toContain(P.titleProof);
    // The decide route is never used for a paid approve.
    expect(srv.calls.some((c) => c.url.endsWith('/approve'))).toBe(false);
  });

  it('"Remember for this contact" begins again with remember, when the server offers it', async () => {
    const srv = await mount({
      [LIST]: [ok({ approvals: [item('C', { paid: true })] })],
      [BEGIN]: [ok({ ...PROOF_READY, rememberOffered: true })],
    });
    await click(buttonNamed(S.approve, cardOf('C') as ParentNode));
    const box = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')].find(
      (i) => i.type === 'checkbox',
    );
    await click(box);
    const begins = srv.calls.filter((c) => c.url === BEGIN);
    expect(begins).toHaveLength(2);
    expect(decodeInput(begins[1])).toEqual({ flow: 'proof', approvalId: id('C'), remember: true });
  });

  it('the backup code: the body, no presence header; a wrong one, then the third try ends it', async () => {
    const srv = await mount({
      [LIST]: [ok({ approvals: [item('C', { paid: true })] })],
      [BEGIN]: [ok(PROOF_READY)],
      [FINISH]: [
        { status: 403, body: { status: 'presence_rejected' } },
        { status: 403, body: { status: 'tries_exhausted' } },
      ],
    });
    await click(buttonNamed(S.approve, cardOf('C') as ParentNode));
    const input = document.querySelector<HTMLInputElement>(
      '[role="dialog"] input[type="password"]',
    );
    setValue(input, 'ABCD-EFGH');
    await click(
      buttonNamed(P.confirmCode, document.querySelector('[role="dialog"]') as ParentNode),
    );
    const finish = srv.calls.find((c) => c.url === FINISH);
    expect(finish?.headers.get('x-agentlink-presence')).toBeNull();
    expect(new TextDecoder().decode(finish?.body)).toBe('ABCD-EFGH');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(P.wrongCode);
    setValue(input, 'WXYZ-0000');
    await click(
      buttonNamed(P.confirmCode, document.querySelector('[role="dialog"]') as ParentNode),
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(P.triesUsed);
  });

  it('applied: the card says Approved and its buttons go', async () => {
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
    expect(cardOf('C')?.textContent).toContain(S.approved);
    expect(buttonNamed(S.approve, cardOf('C') as ParentNode)).toBeUndefined();
  });

  it('Deny on a paid card is the plain owner step (no sheet)', async () => {
    const srv = await mount({
      [LIST]: [ok({ approvals: [item('C', { paid: true })] })],
      [`/api/approvals/${id('C')}/deny`]: [ok({ status: 'applied', decision: 'deny' })],
    });
    await click(buttonNamed(S.deny, cardOf('C') as ParentNode));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    setValue(cardOf('C')?.querySelector('input[type="password"]') ?? null, 'code-1');
    await click(buttonNamed(S.confirmDenial));
    const deny = srv.calls.find((c) => c.url.endsWith('/deny'));
    expect(deny?.headers.get('x-agentlink-digest')).toBe(DIGEST('c'));
    expect(new TextDecoder().decode(deny?.body)).toBe('code-1');
    expect(cardOf('C')?.textContent).toContain(S.denied);
  });
});

describe('review together (04 §2.5.2): batch rules', () => {
  it('checks again, leaves out paid, terms and changed items, then one owner code signs exactly those', async () => {
    const A = item('A');
    const B = item('B');
    const srv = await mount({
      [LIST]: [
        ok({ approvals: [A, B, item('C', { paid: true }), item('D', { commitment: true })] }),
        ok({ approvals: [A, B, item('C', { paid: true }), item('D', { commitment: true })] }),
        ok({ approvals: [] }),
      ],
      [REVIEW]: [ok({ status: 'applied' })],
    });
    // Paid and terms are their own cards, with no choice.
    expect(cardOf('C')?.querySelector('input[type="radio"]')).toBeNull();
    expect(cardOf('D')?.querySelector('input[type="radio"]')).toBeNull();
    expect(cardOf('D')?.textContent).toContain(S.termsAlone);
    await click(cardOf('A')?.querySelector('input[value="approve"]'));
    await click(cardOf('B')?.querySelector('input[value="deny"]'));
    const summary = buttonNamed('Approve 1 and deny 1');
    await click(summary);
    expect(host.textContent).toContain('Approve: Send a message to Ana (A)');
    expect(host.textContent).toContain('Deny: Send a message to Ana (B)');
    expect(host.textContent).toContain('This covers exactly these 2.');
    const code = host.querySelector<HTMLInputElement>('input[type="password"]');
    setValue(code, 'owner-code');
    await click(buttonNamed(S.confirm));
    const review = srv.calls.find((c) => c.url === REVIEW);
    expect(review?.method).toBe('POST');
    expect(review?.headers.get('x-agentlink-items')).toBe(
      `${id('A')}:${DIGEST('a')}:a,${id('B')}:${DIGEST('b')}:d`,
    );
    expect(review?.headers.get('x-agentlink-items')).not.toContain(id('C'));
    expect(review?.headers.get('content-type')).toBe('application/octet-stream');
    expect(review?.headers.get('x-agentlink-csrf')).toBe('t0ken');
    expect(new TextDecoder().decode(review?.body)).toBe('owner-code');
    expect(statuses()).toContain('Done: approved 1 and denied 1.');
  });

  it('leaves out what is no longer waiting and says so', async () => {
    const A = item('A');
    const B = item('B');
    const srv = await mount({
      [LIST]: [ok({ approvals: [A, B] }), ok({ approvals: [A] })],
    });
    await click(cardOf('A')?.querySelector('input[value="approve"]'));
    await click(cardOf('B')?.querySelector('input[value="approve"]'));
    await click(buttonNamed('Approve 2'));
    expect(statuses()).toContain(S.droppedOne);
    expect(host.textContent).toContain('This covers exactly this one.');
    expect(srv.calls.some((c) => c.url === REVIEW)).toBe(false);
  });

  it('a paid item in the batch refused by the server shows the batch rule', async () => {
    const A = item('A');
    await mount({
      [LIST]: [ok({ approvals: [A] }), ok({ approvals: [A] }), ok({ approvals: [A] })],
      [REVIEW]: [{ status: 409, body: { status: 'paid_item_in_batch' } }],
    });
    await click(cardOf('A')?.querySelector('input[value="approve"]'));
    await click(buttonNamed('Approve 1'));
    setValue(host.querySelector<HTMLInputElement>('input[type="password"]'), 'owner-code');
    await click(buttonNamed(S.confirm));
    expect(statuses()).toContain(S.listPaid);
  });
});

describe('one request: its own Approve or Deny, then presence', () => {
  it('Approve, then the owner code: the decide route with the digest; "Approved."', async () => {
    const srv = await mount({
      [LIST]: [ok({ approvals: [item('D', { commitment: true })] })],
      [`/api/approvals/${id('D')}/approve`]: [ok({ status: 'applied', decision: 'approve' })],
    });
    await click(buttonNamed(S.approve, cardOf('D') as ParentNode));
    const field = cardOf('D')?.querySelector<HTMLInputElement>('input[type="password"]') ?? null;
    expect(field?.getAttribute('autocomplete')).toBe('off');
    expect(field?.maxLength).toBe(-1);
    setValue(field, 'owner-code');
    await click(buttonNamed(S.confirmApproval));
    const call = srv.calls.find((c) => c.url.endsWith('/approve'));
    expect(call?.headers.get('x-agentlink-digest')).toBe(DIGEST('d'));
    expect(call?.headers.get('x-agentlink-presence')).toBeNull();
    expect(new TextDecoder().decode(call?.body)).toBe('owner-code');
    expect(field?.value).toBe('');
    expect(statuses()).toContain(S.approved);
  });

  it('too many wrong tries: the wait in seconds, and the buttons come back', async () => {
    await mount({
      [LIST]: [ok({ approvals: [item('D', { commitment: true })] })],
      [`/api/approvals/${id('D')}/approve`]: [
        { status: 429, body: { status: 'wait', retryAfter: 4.2 } },
      ],
    });
    await click(buttonNamed(S.approve, cardOf('D') as ParentNode));
    setValue(cardOf('D')?.querySelector('input[type="password"]') ?? null, 'nope');
    await click(buttonNamed(S.confirmApproval));
    expect(statuses().some((t) => t.startsWith('Too many wrong tries. Wait 5 seconds'))).toBe(true);
    expect(buttonNamed(S.approve, cardOf('D') as ParentNode)).toBeDefined();
  });

  it('with a passkey: one gesture, the presence header, the four fields', async () => {
    const asked: CredentialRequestOptions[] = [];
    const credentials = {
      get: (options: CredentialRequestOptions) => {
        asked.push(options);
        return Promise.resolve({
          rawId: new Uint8Array([9]).buffer,
          response: { authenticatorData: new Uint8Array([1, 2]).buffer, userHandle: null },
          getClientExtensionResults: () => ({
            prf: { results: { first: new Uint8Array(32).fill(5).buffer } },
          }),
        });
      },
    } as unknown as CredentialsContainer;
    const srv = server({
      [PASSKEY]: [
        ok({
          passkey: {
            rpId: 'localhost',
            registered: true,
            credentialId: 'CQ',
            prfSalt: 'BQY',
            userId: 'AQ',
          },
        }),
      ],
      [LIST]: [ok({ approvals: [item('D', { commitment: true })] })],
      [`/api/approvals/${id('D')}/approve`]: [ok({ status: 'applied', decision: 'approve' })],
    });
    act(() =>
      root.render(
        createElement<ApprovalsPageProps>(ApprovalsBoard, {
          client: createApprovalsClient({ fetch: srv.fetch, token: 't', credentials }),
          canPasskey: true,
        }),
      ),
    );
    await flush();
    await click(buttonNamed(S.approve, cardOf('D') as ParentNode));
    expect(asked).toHaveLength(0);
    await click(buttonNamed(S.approveWithPasskey));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.publicKey?.rpId).toBe('localhost');
    expect(asked[0]?.publicKey?.userVerification).toBe('required');
    const call = srv.calls.find((c) => c.url.endsWith('/approve'));
    expect(call?.headers.get('x-agentlink-presence')).toBe('passkey');
    expect(call?.headers.get('x-agentlink-digest')).toBe(DIGEST('d'));
    expect(statuses()).toContain(S.approved);
  });

  it('before the owner is set up nothing can be approved, with the reason', async () => {
    await mount({
      [PASSKEY]: [{ status: 503, body: { status: 'needs_setup' } }],
      [LIST]: [ok({ approvals: [item('A')] })],
    });
    expect(host.textContent).toContain(S.needsOwnerTitle);
    expect(buttonNamed(S.approve)).toBeUndefined();
    expect(host.querySelector('input[type="radio"]')).toBeNull();
  });
});

describe('/approve/<id>: the deep link renders inside the app shell', () => {
  it('the router shows the one request with Home current in the section menu (W4-SHELL-V2)', async () => {
    const srv = server({
      [PASSKEY]: [PASSKEY_NONE],
      [`/api/approvals/${id('A')}`]: [ok({ approval: item('A') })],
    });
    vi.stubGlobal('fetch', srv.fetch);
    history.replaceState(null, '', `/approve/${id('A')}`);
    act(() => root.render(createElement(AppRoutes)));
    await flush();
    expect(srv.calls.some((c) => c.url === `/api/approvals/${id('A')}`)).toBe(true);
    expect(cardOf('A')?.querySelector('h2')?.textContent).toBe('Headline A');
    expect(
      host.querySelector('nav.al-rail a[aria-current="page"]')?.getAttribute('aria-label'),
    ).toBe('Home');
    expect(host.querySelector('main h1')?.textContent).toBe(S.appTitle);
  });

  it('a request that is no longer waiting says so', async () => {
    const srv = server({ [PASSKEY]: [PASSKEY_NONE] });
    history.replaceState(null, '', `/approve/${id('B')}`);
    act(() =>
      root.render(
        createElement(ApprovePage, {
          client: createApprovalsClient({ fetch: srv.fetch, token: 't' }),
        }),
      ),
    );
    await flush();
    expect(statuses()).toContain(S.notPending);
  });

  it('a path that is not an approval ID asks nothing of the server', async () => {
    const srv = server({ [PASSKEY]: [PASSKEY_NONE] });
    history.replaceState(null, '', '/approve/apr_short');
    act(() =>
      root.render(
        createElement(ApprovePage, {
          client: createApprovalsClient({ fetch: srv.fetch, token: 't' }),
        }),
      ),
    );
    await flush();
    expect(srv.calls.some((c) => c.url.startsWith('/api/approvals'))).toBe(false);
  });

  it('a paid request on its own page opens the sheet too', async () => {
    const srv = server({
      [PASSKEY]: [PASSKEY_NONE],
      [`/api/approvals/${id('C')}`]: [ok({ approval: item('C', { paid: true }) })],
      [BEGIN]: [ok(PROOF_READY)],
    });
    history.replaceState(null, '', `/approve/${id('C')}`);
    act(() =>
      root.render(
        createElement(ApprovePage, {
          client: createApprovalsClient({ fetch: srv.fetch, token: 't' }),
          payConfirm: createPayConfirmClient({ fetch: srv.fetch, token: 't' }),
        }),
      ),
    );
    await flush();
    await click(buttonNamed(S.approve));
    expect(decodeInput(srv.calls.find((c) => c.url === BEGIN))).toEqual({
      flow: 'proof',
      approvalId: id('C'),
    });
  });
});

describe('the client', () => {
  it('sends only same-origin /api/approvals paths and never logs', async () => {
    const log = vi.spyOn(console, 'log');
    const srv = server({ [LIST]: [ok({ approvals: [] })] });
    const client = createApprovalsClient({ fetch: srv.fetch, token: 't' });
    await client.list();
    expect(srv.calls[0]?.url).toBe(LIST);
    expect(srv.calls[0]?.headers.get('x-agentlink-csrf')).toBe('t');
    await expect(client.one('../owner')).resolves.toEqual({ kind: 'not_pending' });
    expect(srv.calls).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
  });
});
