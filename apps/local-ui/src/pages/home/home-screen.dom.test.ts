// @vitest-environment jsdom
// W4-HOME (W4 UX v2 "Layer 2" Home and "Layer 3" Home pro; prototype v23 A4 and A10; ux-inventory
// §9 items 1–4): Home at `/`. Simple: the approval card on top (+N more), Invite someone, People
// with the last activity; a row opens in place to the conversation (both ways, Sent / Waiting to send
// / Not delivered, Copy, earlier messages), the files (received and sent, Show in Finder / Explorer
// / folder by OS, Save to Inbox until auto-save lands) and the ⋯ menu (Rename, Check safety code,
// Remove: the existing presence routes). Pro (Under the hood on): the same route as a dense table
// (person, handled by, last message, delivery, proofs, files), search and the agent filter, message
// details (ID, exact time, size, agent, receipt, proof), contact facts, approval ID/kind/expiry and
// a bulk list where paid and terms approvals stay single.
//
// Security (I-4, I-5, I-7; 04 §2.5, §4): every word another party wrote is shown only inside the
// untrusted container; reading Home sends GETs only; Show in Finder and Save send only the item ID.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPrefsForTests, setPref } from '../../prefs/index.js';
import { HomeScreen, type HomeScreenProps } from './home-screen.js';
import { HOME_STRINGS as S } from './people-strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  resetPrefsForTests();
  history.replaceState(null, '', '/');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.textContent = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetPrefsForTests();
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}
type Answer = { status: number; body: unknown };
type Answers = Record<string, Answer | Answer[]>;

function server(answers: Answers) {
  const calls: Call[] = [];
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const raw = init?.body;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: ArrayBuffer.isView(raw)
        ? new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
        : new Uint8Array(0),
    });
    const entry = answers[url];
    const a = Array.isArray(entry)
      ? ((entry.length > 1 ? entry.shift() : entry[0]) ?? { status: 404, body: {} })
      : (entry ?? { status: 404, body: {} });
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
const AT = 1_792_000_000;
const DENIS = {
  contactId: '0x' + '11'.repeat(20),
  name: 'Denis',
  lastAt: AT + 60,
  lastInAt: AT + 50,
};
const ANA = { contactId: '0x' + '22'.repeat(20), name: 'Ana', lastAt: AT + 10, lastInAt: AT + 10 };
const ENV_IN = 'AQEBAQEBAQEBAQEBAQEBAQ';
const ENV_FILE = 'BwcHBwcHBwcHBwcHBwcHBw';
const ENV_OUT1 = 'CAgICAgICAgICAgICAgICA';
const ENV_OUT2 = 'CQkJCQkJCQkJCQkJCQkJCQ';
const ENV_OUT3 = 'CgoKCgoKCgoKCgoKCgoKCg';
const ENV_OLD = 'CwsLCwsLCwsLCwsLCwsLCw';
const APR_TERMS = `apr_${'A'.repeat(22)}`;
const APR_FREE = `apr_${'B'.repeat(22)}`;
const APR_PAID = `apr_${'C'.repeat(22)}`;

const contact = (c: { contactId: string; name: string }, checked = false) => ({
  ref: c.contactId,
  name: c.name,
  nameSource: 'counterparty',
  fingerprint: '7F3A91C20B4ED8A5',
  label: checked ? 'safety-code-checked' : 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: AT - 86_400,
});

const msg = (
  id: string,
  text: string,
  at: number,
  extra: Partial<{
    files: unknown[];
    status: string;
    receipt: boolean;
    proof: boolean;
  }> = {},
) => ({
  id,
  at,
  text,
  files: extra.files ?? [],
  receipt: extra.receipt ?? false,
  proof: extra.proof ?? false,
  size: 1200,
  ...(extra.status === undefined ? {} : { status: extra.status }),
});

const approval = (id: string, over: Partial<{ commitment: boolean; paid: boolean }> = {}) => ({
  approvalId: id,
  summary: `Request ${id.slice(4, 5)}`,
  actionDigest: 'a'.repeat(64),
  expiresAt: 1_900_000_000,
  commitment: over.commitment ?? false,
  paid: over.paid ?? false,
  details: {
    headline: `Headline ${id.slice(4, 5)}`,
    who: '“Denis” (self-declared)',
    what: 'Accept terms',
    cost: 'Free',
    expires: '12 Oct 2026 14:02 UTC',
    rule: 'Ask me',
    fromAi: [],
  },
});

const MESSAGES = '/api/ui/messages';
const CONTACTS = '/api/ui/contacts';
const RECEIVED = '/api/ui/files/received?limit=100';
const SENT = '/api/ui/files/sent?limit=100';
const APPROVALS = '/api/approvals';
const PASSKEY = '/api/owner/passkey';
const REVEAL = '/api/ui/files/received/reveal';
const box = (c: { contactId: string }, b: 'in' | 'out', cursor?: string) =>
  `/api/ui/messages/${encodeURIComponent(c.contactId)}?box=${b}&limit=20${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;

function base(over: Answers = {}): Answers {
  return {
    [MESSAGES]: ok({ conversations: [DENIS, ANA] }),
    [CONTACTS]: ok({ status: 'ok', contacts: [contact(DENIS, true), contact(ANA)] }),
    [RECEIVED]: ok({
      items: [
        {
          id: `${ENV_FILE}.00`,
          from: 'Denis',
          at: AT + 40,
          name: 'logo-sketch-v1.png',
          size: 1_200_000,
          state: 'saved',
          savedName: 'logo-sketch-v1.png',
          proof: false,
        },
      ],
    }),
    [SENT]: ok({ items: [] }),
    [APPROVALS]: ok({ approvals: [] }),
    [PASSKEY]: ok({ passkey: null }),
    [box(DENIS, 'in')]: ok({
      items: [
        msg(ENV_IN, 'Got them. Here is a first sketch.', AT + 50),
        msg(ENV_FILE, '', AT + 40, { files: [{ name: 'logo-sketch-v1.png', size: 1_200_000 }] }),
      ],
      next: 'cur-in-1',
    }),
    [box(DENIS, 'out')]: ok({
      items: [
        msg(ENV_OUT3, 'Tali will look at the terms tonight.', AT + 60, { status: 'not_delivered' }),
        msg(ENV_OUT2, 'One more thing.', AT + 55, { status: 'queued' }),
        msg(ENV_OUT1, 'Sending the brief.', AT + 20, {
          status: 'sent',
          receipt: true,
          proof: true,
        }),
      ],
    }),
    [box(DENIS, 'in', 'cur-in-1')]: ok({ items: [msg(ENV_OLD, 'Hi, Denis here.', AT)] }),
    [box(ANA, 'in')]: ok({ items: [msg('DAwMDAwMDAwMDAwMDAwMDA', 'March numbers.', AT + 10)] }),
    [box(ANA, 'out')]: ok({ items: [] }),
    ...over,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render(answers: Answers, props: Partial<HomeScreenProps> = {}) {
  const s = server(answers);
  vi.stubGlobal('fetch', s.fetch);
  await act(async () => {
    root.render(h(HomeScreen, { fetch: s.fetch, token: 't', pollMs: 0, ...props }));
  });
  await settle();
  return s;
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => host.querySelector<T>(sel);
const all = (sel: string): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(sel)];
const byText = (sel: string, text: string | RegExp): HTMLElement | undefined =>
  all(sel).find((e) =>
    typeof text === 'string' ? e.textContent?.trim() === text : text.test(e.textContent ?? ''),
  );
async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}
const row = (name: string): HTMLButtonElement | undefined =>
  all('button[aria-expanded]').find((b) => b.textContent?.includes(name)) as
    HTMLButtonElement | undefined;

describe('Home simple (A4)', () => {
  it('shows Invite someone and People with the last activity; reading sends GETs only', async () => {
    const s = await render(base());
    expect(q('h1')?.textContent).toBe(S.title);
    const invite = byText('a', S.inviteSomeone);
    expect(invite).toBeTruthy();
    expect(byText('h2', S.people)).toBeTruthy();
    const denis = row('Denis');
    expect(denis?.getAttribute('aria-expanded')).toBe('false');
    expect(denis?.textContent).toMatch(/Last message/);
    expect(denis?.textContent).toContain('1 file');
    // Denis's newest message to him was not delivered: the row says so.
    expect(denis?.textContent).toContain(S.notDelivered);
    expect(row('Ana')).toBeTruthy();
    expect(s.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(lintVocabulary(host.textContent ?? '')).toEqual([]);
  });

  it('opens a row in place to the conversation, both directions, with delivery words and Copy', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText }, platform: 'MacIntel' });
    await render(base());
    await click(row('Denis'));
    expect(row('Denis')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain(S.conversationTitle);
    // Inbound words only inside the untrusted container.
    const inbound = all('figure.al-untrusted').map((f) => f.textContent ?? '');
    expect(inbound.some((t) => t.includes('Got them. Here is a first sketch.'))).toBe(true);
    const heads = all('h1, h2, h3, button, [role="status"]').map((e) => e.textContent ?? '');
    expect(heads.some((t) => t.includes('Got them'))).toBe(false);
    // Outbound: Sent / Waiting to send / Not delivered.
    expect(host.textContent).toContain('Sending the brief.');
    expect(byText('span', S.sent)).toBeTruthy();
    expect(byText('span', S.waitingToSend)).toBeTruthy();
    expect(byText('span', S.notDelivered)).toBeTruthy();
    expect(host.textContent).toContain(S.notDeliveredRetry);
    // Oldest first: the brief comes before the reply.
    const text = host.textContent ?? '';
    expect(text.indexOf('Sending the brief.')).toBeLessThan(text.indexOf('Got them.'));
    // Copy writes the message text and says Copied.
    const copy = all('button').find((b) => b.getAttribute('aria-label') === S.copyLabel);
    await click(copy);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(byText('span', S.copied)).toBeTruthy();
    expect(host.textContent).toContain(fmtName(S.encrypted, 'Denis'));
  });

  it('loads earlier messages with the cursor', async () => {
    const s = await render(base());
    await click(row('Denis'));
    expect(host.textContent).not.toContain('Hi, Denis here.');
    await click(byText('button', S.loadEarlier));
    expect(s.calls.some((c) => c.url === box(DENIS, 'in', 'cur-in-1'))).toBe(true);
    expect(host.textContent).toContain('Hi, Denis here.');
    expect(byText('button', S.loadEarlier)).toBeUndefined();
  });

  it('lists files with Show in Finder on a Mac; it sends only the item ID', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel' });
    const s = await render(base({ [REVEAL]: ok({ status: 'shown' }) }));
    await click(row('Denis'));
    expect(byText('span', S.filesTitle)).toBeTruthy();
    const show = byText('button', S.showInFinder);
    expect(show).toBeTruthy();
    await click(show);
    const post = s.calls.find((c) => c.url === REVEAL);
    expect(post?.method).toBe('POST');
    expect(JSON.parse(new TextDecoder().decode(post?.body))).toEqual({ id: `${ENV_FILE}.00` });
  });

  it.each([
    ['Win32', S.showInExplorer],
    ['Linux x86_64', S.showInFolder],
  ])('says the file manager by OS (%s)', async (platform, label) => {
    vi.stubGlobal('navigator', { ...navigator, platform });
    await render(base());
    await click(row('Denis'));
    expect(byText('button', label)).toBeTruthy();
  });

  it('offers Save to Inbox for a file that arrived and is not saved', async () => {
    await render(
      base({
        [RECEIVED]: ok({
          items: [
            {
              id: `${ENV_FILE}.00`,
              from: 'Denis',
              at: AT + 40,
              name: 'logo-sketch-v1.png',
              size: 1_200_000,
              state: 'not_saved',
              proof: false,
            },
          ],
        }),
      }),
    );
    await click(row('Denis'));
    expect(host.textContent).toContain(S.arrivedNotSaved);
    expect(byText('button', 'Save to Inbox')).toBeTruthy();
  });

  it('shows the approval card on top with +N more, Approve and Deny', async () => {
    await render(
      base({
        [APPROVALS]: ok({
          approvals: [approval(APR_TERMS, { commitment: true }), approval(APR_FREE)],
        }),
      }),
    );
    const card = q('section[aria-label="' + S.approvalsLabel + '"]');
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain('Headline A');
    expect(byText('button', 'Approve')).toBeTruthy();
    const more = byText('button', fmtCount(S.moreWaiting, 1));
    await click(more);
    expect(card?.textContent).toContain('Headline B');
    expect(byText('button', fmtCount(S.hideMore, 1))).toBeTruthy();
  });

  it('the ⋯ menu offers Rename, Check safety code and Remove; Remove asks first, then presence', async () => {
    await render(base());
    await click(row('Ana'));
    await click(all('button').find((b) => b.getAttribute('aria-label') === 'More for Ana'));
    const items = all('[role="menuitem"]').map((e) => e.textContent?.trim());
    expect(items).toEqual([S.rename, S.checkSafetyCode, S.remove]);
    await click(all('[role="menuitem"]').find((e) => e.textContent?.trim() === S.remove));
    const confirm = q('[role="alertdialog"]');
    expect(confirm?.textContent).toContain('Remove Ana?');
    await click(byText('[role="alertdialog"] button', S.remove));
    // The presence step of Contacts: nothing is sent before the owner confirms.
    expect(host.textContent).toMatch(/backup code/i);
  });

  it('shows a skeleton shaped like Home while it loads (after ~300 ms)', async () => {
    vi.useFakeTimers();
    try {
      const never = (() => new Promise<Response>(() => undefined)) as typeof fetch;
      vi.stubGlobal('fetch', never);
      await act(async () => {
        root.render(h(HomeScreen, { fetch: never, token: 't', pollMs: 0 }));
      });
      expect(q('[aria-busy="true"]')).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(350);
      });
      expect(q('[aria-busy="true"]')).toBeTruthy();
      expect(all('.al-skel-row').length).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Home pro (A10, Under the hood on)', () => {
  beforeEach(() => setPref('hood', true));

  it('shows People as a table with search and the agent filter; search filters', async () => {
    await render(base());
    const head = q('[data-people-head]');
    expect(head?.textContent).toContain(S.colPerson);
    expect(head?.textContent).toContain(S.colHandledBy);
    expect(head?.textContent).toContain(S.colDelivery);
    expect(head?.textContent).toContain(S.colProofs);
    expect(head?.textContent).toContain(S.colFiles);
    // The toggle is the person cell (stretched over the row); the cells are the row's.
    const denis = row('Denis')?.closest('[data-person]');
    expect(denis?.textContent).toContain(S.notDelivered);
    expect(denis?.textContent).toContain('Tali will look at the terms tonight.');
    // No big Invite card in pro: the small Invite button sits in the People header.
    expect(all('a').filter((a) => a.textContent?.trim() === S.inviteSomeone)).toHaveLength(1);
    const search = q<HTMLInputElement>('input[type="search"]');
    expect(search).toBeTruthy();
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(search, 'an');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect(row('Denis')).toBeUndefined();
    expect(row('Ana')).toBeTruthy();
  });

  it('shows message details and contact facts in the conversation', async () => {
    await render(base());
    await click(row('Denis'));
    expect(host.textContent).toContain(S.fingerprint);
    expect(host.textContent).toContain('7F3A');
    expect(host.textContent).toContain(S.identityChecked);
    expect(host.textContent).toContain(S.paired);
    expect(host.textContent).toContain(ENV_OUT1);
    expect(host.textContent).toContain(`${S.receipt} ${S.receiptYes}`);
    expect(host.textContent).toContain(`${S.proof} ${S.proofYes}`);
  });

  it('approvals show ID, kind and expiry; only free plain requests can be picked for a bulk approve', async () => {
    await render(
      base({
        [APPROVALS]: ok({
          approvals: [
            approval(APR_TERMS, { commitment: true }),
            approval(APR_FREE),
            approval(APR_PAID, { paid: true }),
          ],
        }),
      }),
    );
    const card = q('section[aria-label="' + S.approvalsLabel + '"]');
    expect(card?.textContent).toContain(APR_TERMS);
    expect(card?.textContent).toContain(S.kindTerms);
    await click(byText('button', fmtCount(S.moreWaiting, 2)));
    const boxes = all('input[type="checkbox"]');
    expect(boxes).toHaveLength(1);
    await click(boxes[0]);
    expect(byText('button', fmtCount(S.approveSelected, 1))).toBeTruthy();
    expect(host.textContent).toContain(S.paidAlone);
  });
});

function fmtName(t: string, name: string): string {
  return t.replace('{name}', name);
}
function fmtCount(t: string, count: number): string {
  return t.replace('{count}', String(count));
}
