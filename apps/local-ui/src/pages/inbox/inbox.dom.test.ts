// @vitest-environment jsdom
// W4-INBOX + W4-FILES-SAVE (08 §1 Inbox; b11 §34.4; 04 §2.5, §4; D-118; I-4, I-5, I-7): the Inbox
// is the home. "Needs you" sits on top (approvals as cards, new messages, files that arrived and are
// not saved); conversations per contact below, with messages and files inline and that contact's
// approvals as cards in the conversation; "All caught up" when nothing needs the owner.
//
// - Approving goes through the existing approval routes (POST /api/approvals/<id>/approve with the
//   digest), with the passkey ("Confirm with your passkey") or the backup code: no new way to approve
//   without presence.
// - Save sends POST /api/ui/files/save with only `{id}` in X-AgentLink-Input and the presence in the
//   body: never a name, a folder or a path.
// - Every word another party wrote (message text, file names) is shown only inside the untrusted
//   container; reading here writes nothing (only GETs, besides the owner's own Save or decision).
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_SAVE_PATH } from '@4thtech-io/types/ui-contract/inbox';
import { InboxPage, type InboxPageProps } from './index.js';
import { INBOX_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/inbox');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.textContent = '';
  vi.restoreAllMocks();
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
      body: raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(0),
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
const ENV_IN = 'AQEBAQEBAQEBAQEBAQEBAQ';
const ENV_FILE = 'BwcHBwcHBwcHBwcHBwcHBw';
const MARKO = {
  contactId: '0x' + '11'.repeat(20),
  name: 'Marko',
  lastAt: AT + 50,
  lastInAt: AT + 50,
};
const ANA = { contactId: '0x' + '22'.repeat(20), name: 'Ana', lastAt: AT + 10, lastInAt: 0 };
const APPROVAL_ID = `apr_${'A'.repeat(22)}`;

const approval = (who = '\u201cMarko\u201d (self-declared)') => ({
  approvalId: APPROVAL_ID,
  summary: 'Accept terms from Marko: Logo design',
  actionDigest: 'a'.repeat(64),
  expiresAt: 1_900_000_000,
  commitment: true,
  details: {
    headline: 'Logo design',
    who,
    what: 'Accept terms',
    cost: 'Free',
    expires: '12 Oct 2026 14:02 UTC',
    rule: 'Ask me',
    fromAi: [],
  },
});

const msgIn = (id: string, text: string, at: number, files: unknown[] = []) => ({
  id,
  at,
  text,
  files,
  receipt: false,
  proof: false,
  size: text.length,
});

const receivedFile = (state: 'not_saved' | 'saved', savedName?: string) => ({
  id: `${ENV_FILE}.00`,
  from: 'Marko',
  at: AT + 40,
  name: 'brief.txt',
  size: 262_164,
  state,
  ...(savedName === undefined ? {} : { savedName }),
  proof: false,
});

const LIST = '/api/ui/messages';
const RECEIVED = '/api/ui/files/received?limit=100';
const APPROVALS = '/api/approvals';
const PASSKEY = '/api/owner/passkey';
const inbox = (c: { contactId: string }, box: 'in' | 'out') =>
  `/api/ui/messages/${encodeURIComponent(c.contactId)}?box=${box}&limit=20`;

function base(over: Answers = {}): Answers {
  return {
    [LIST]: ok({ conversations: [MARKO, ANA] }),
    [RECEIVED]: ok({ items: [] }),
    [APPROVALS]: ok({ approvals: [] }),
    [PASSKEY]: ok({ passkey: null }),
    [inbox(MARKO, 'in')]: ok({ items: [msgIn(ENV_IN, 'Hello from Marko', AT + 50)] }),
    [inbox(MARKO, 'out')]: ok({ items: [] }),
    [inbox(ANA, 'in')]: ok({ items: [] }),
    [inbox(ANA, 'out')]: ok({ items: [msgIn('BBBBBBBBBBBBBBBBBBBBBB', 'Hi Ana', AT + 10)] }),
    ...over,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(answers: Answers, extra: Partial<InboxPageProps> = {}) {
  const s = server(answers);
  await act(async () => {
    root.render(h<InboxPageProps>(InboxPage, { fetch: s.fetch, token: 'tok', ...extra }));
  });
  await settle();
  return s;
}

const text = (): string => host.textContent ?? '';
const needsYou = (): HTMLElement | null => host.querySelector('[data-section="needs-you"]');
const button = (name: string | RegExp, within: ParentNode = host): HTMLButtonElement | undefined =>
  [...within.querySelectorAll('button')].find((b) =>
    typeof name === 'string' ? b.textContent?.trim() === name : name.test(b.textContent ?? ''),
  );
async function click(b: HTMLElement | undefined | null): Promise<void> {
  expect(b).toBeTruthy();
  await act(async () => {
    b?.click();
  });
  await settle();
}
async function submitCode(code: string, within: ParentNode = host): Promise<void> {
  const input = within.querySelector<HTMLInputElement>('input[type="password"]');
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, code);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input?.closest('form')?.requestSubmit();
  });
  await settle();
}

const decodeInput = (headers: Headers): unknown => {
  const raw = headers.get('X-AgentLink-Input') ?? '';
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
};

describe('the Inbox home', () => {
  it('says All caught up when nothing needs you, and lists every conversation', async () => {
    localStorage.setItem(
      'agentlink.messages.seen.v1',
      JSON.stringify({ [MARKO.contactId]: MARKO.lastInAt }),
    );
    await mount(base());
    expect(host.querySelector('h1')?.textContent).toBe(S.title);
    expect(text()).toContain(S.allCaughtUp);
    const rows = [...host.querySelectorAll('[data-section="conversations"] button[data-contact]')];
    expect(rows.map((r) => r.getAttribute('data-contact'))).toEqual([
      MARKO.contactId,
      ANA.contactId,
    ]);
  });

  it('puts a new message in Needs you, its text only inside the untrusted container', async () => {
    await mount(base());
    const section = needsYou();
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('Marko');
    expect(section?.textContent).toContain('Hello from Marko');
    expect(text()).not.toContain(S.allCaughtUp);
    for (const el of host.querySelectorAll('*')) {
      if (el.children.length === 0 && el.textContent === 'Hello from Marko') {
        expect(
          el.closest('.al-untrusted'),
          'inbound text outside the untrusted container',
        ).not.toBeNull();
      }
    }
  });

  it('opening the conversation marks it seen; back on the Inbox it is All caught up', async () => {
    await mount(base());
    // A click on the message itself opens the conversation (as the journey does).
    const leaf = [...(needsYou()?.querySelectorAll<HTMLElement>('*') ?? [])].find(
      (el) => el.children.length === 0 && el.textContent === 'Hello from Marko',
    );
    await click(leaf);
    expect(host.querySelector('h2')?.textContent).toContain('Marko');
    expect(new URLSearchParams(location.search).get('c')).toBe(MARKO.contactId);
    // The sidebar's Inbox link (the router's navigate event) goes back to the list.
    await act(async () => {
      history.pushState(null, '', '/inbox');
      window.dispatchEvent(new Event('agentlink:navigate'));
    });
    await settle();
    expect(text()).toContain(S.allCaughtUp);
  });
});

describe('Needs you: an approval is a card with inline Touch ID (the existing approval routes)', () => {
  it('shows the request as an article; Approve asks for presence, then posts the decision', async () => {
    const s = await mount(
      base({
        [APPROVALS]: [ok({ approvals: [approval()] }), ok({ approvals: [] })],
        [`/api/approvals/${APPROVAL_ID}/approve`]: ok({ status: 'applied', decision: 'approve' }),
      }),
    );
    const card = [...host.querySelectorAll('article')].find((a) =>
      a.textContent?.includes('Logo design'),
    );
    expect(card).toBeDefined();
    expect(card?.closest('[data-section="needs-you"]')).not.toBeNull();
    await click(button(S.approve, card));
    // No passkey registered here: the backup code (never a way around presence).
    await submitCode('owner-code-123', card);
    const post = s.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe(`/api/approvals/${APPROVAL_ID}/approve`);
    expect(post?.headers.get('X-AgentLink-Digest')).toBe('a'.repeat(64));
    expect(new TextDecoder().decode(post?.body)).toBe('owner-code-123');
  });

  it('with a passkey, the step says "Confirm with your passkey" and sends the assertion', async () => {
    const credential = {
      rawId: new Uint8Array([1, 2]).buffer,
      response: {
        authenticatorData: new Uint8Array([3]).buffer,
        userHandle: new Uint8Array([4]).buffer,
      },
      getClientExtensionResults: () => ({
        prf: { results: { first: new Uint8Array(32).fill(9).buffer } },
      }),
    };
    const credentials = {
      get: vi.fn(() => Promise.resolve(credential)),
    } as unknown as CredentialsContainer;
    const s = await mount(
      base({
        [APPROVALS]: [ok({ approvals: [approval()] }), ok({ approvals: [] })],
        [PASSKEY]: ok({
          passkey: { rpId: 'localhost', registered: true, credentialId: 'AQID', prfSalt: 'BAUG' },
        }),
        [`/api/approvals/${APPROVAL_ID}/approve`]: ok({ status: 'applied', decision: 'approve' }),
      }),
      { credentials },
    );
    const card = [...host.querySelectorAll('article')].find((a) =>
      a.textContent?.includes('Logo design'),
    );
    await click(button(S.approve, card ?? host));
    expect(credentials.get).not.toHaveBeenCalled();
    await click(button(S.confirmPasskey, card ?? host));
    expect(credentials.get).toHaveBeenCalledTimes(1);
    const post = s.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe(`/api/approvals/${APPROVAL_ID}/approve`);
    expect(post?.headers.get('X-AgentLink-Presence')).toBe('passkey');
  });

  it("shows that contact's approval as a card inside the conversation too", async () => {
    localStorage.setItem(
      'agentlink.messages.seen.v1',
      JSON.stringify({ [MARKO.contactId]: MARKO.lastInAt }),
    );
    await mount(base({ [APPROVALS]: ok({ approvals: [approval()] }) }));
    await click(
      host.querySelector<HTMLButtonElement>(
        `[data-section="conversations"] button[data-contact="${MARKO.contactId}"]`,
      ),
    );
    const conversation = host.querySelector('[data-section="conversation"]');
    const card = [...(conversation?.querySelectorAll('article') ?? [])].find((a) =>
      a.textContent?.includes('Logo design'),
    );
    expect(card).toBeDefined();
    expect(button(S.approve, card ?? host)).toBeDefined();
  });
});

describe('Needs you: a file that arrived is saved from the app (W4-FILES-SAVE)', () => {
  it('"Arrived · not saved" with no moving bar; Save sends only the item ID, then shows Saved as', async () => {
    const s = await mount(
      base({
        [RECEIVED]: [
          ok({ items: [receivedFile('not_saved')] }),
          ok({ items: [receivedFile('saved', 'brief.txt')] }),
        ],
        [FILE_SAVE_PATH]: ok({ status: 'saved' }),
      }),
    );
    const section = needsYou();
    expect(section?.textContent).toContain('brief.txt');
    expect(section?.textContent).toContain(S.arrivedNotSaved);
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    expect(text()).not.toContain('Ask your AI to fetch it');
    await click(button(S.saveToInbox, section ?? host));
    await submitCode('owner-code-123', section ?? host);
    const post = s.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe(FILE_SAVE_PATH);
    expect(post?.headers.get('content-type')).toBe('application/octet-stream');
    expect(decodeInput(post?.headers ?? new Headers())).toEqual({ id: `${ENV_FILE}.00` });
    expect(new TextDecoder().decode(post?.body)).toBe('owner-code-123');
    expect(text()).toContain('Saved as');
    expect(text()).toContain('brief.txt');
  });

  it('says plainly why a save did not happen (the Inbox folder, a refused location)', async () => {
    await mount(
      base({
        [RECEIVED]: ok({ items: [receivedFile('not_saved')] }),
        [FILE_SAVE_PATH]: { status: 503, body: { error: 'inbox_unavailable' } },
      }),
    );
    const section = needsYou();
    await click(button(S.saveToInbox, section ?? host));
    await submitCode('owner-code-123', section ?? host);
    expect(text()).toContain(S.saveOutcome.inbox_unavailable);
  });

  it('shows the file inline in its conversation, with the same Save', async () => {
    localStorage.setItem(
      'agentlink.messages.seen.v1',
      JSON.stringify({ [MARKO.contactId]: MARKO.lastInAt }),
    );
    await mount(
      base({
        [RECEIVED]: ok({ items: [receivedFile('not_saved')] }),
        [inbox(MARKO, 'in')]: ok({
          items: [
            msgIn(ENV_IN, 'Hello from Marko', AT + 50),
            msgIn(ENV_FILE, 'The brief', AT + 40, [{ name: 'brief.txt', size: 262_164 }]),
          ],
        }),
      }),
    );
    await click(
      host.querySelector<HTMLButtonElement>(
        `[data-section="conversations"] button[data-contact="${MARKO.contactId}"]`,
      ),
    );
    const conversation = host.querySelector('[data-section="conversation"]');
    expect(conversation?.textContent).toContain('The brief');
    expect(conversation?.textContent).toContain('brief.txt');
    expect(conversation?.textContent).toContain(S.arrivedNotSaved);
    expect(button(S.saveToInbox, conversation ?? host)).toBeDefined();
    expect(conversation?.textContent).toContain(S.replyHint);
  });
});

describe('copy', () => {
  it('follows 11 §5 (no banned words)', () => {
    const all = JSON.stringify(S);
    expect(lintVocabulary(all)).toEqual([]);
  });
});
