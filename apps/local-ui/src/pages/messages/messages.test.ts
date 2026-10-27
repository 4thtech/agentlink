// @vitest-environment jsdom
// MSG-FILES-IO-e: the Messages page (08 §1; 11 §5.7; design b11 §13 to §17; D-116, D-133; I-4, I-5).
// Built against the node API contract of docs/process/proposals/MSG-FILES-IO.md §4 with a mocked
// API (card c is not built yet).
//
// - Contacts list, Inbox and Sent tabs, list and detail; GET only; no compose; "To reply, ask your AI."
// - Every inbound word and file name only inside UntrustedContent as plain text: no element, attribute
//   or anchor from the body; a link is an inert domain chip; nothing in the title.
// - The seen marker lives in this browser's localStorage (contact and time only), works without storage.
// - Under the hood shows metadata only: never a URL, key, code or token, even if the server sent one.
import { readFileSync } from 'node:fs';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { MessagesPage } from './index.js';
import { countUnseen, loadSeen, markSeen, SEEN_KEY } from './seen.js';
import { MESSAGES_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  document.title = 'AgentLink';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const AT = 1_760_000_000;
const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });

const CONVERSATIONS = {
  conversations: [
    { contactId: 'c-marko', name: 'Marko', lastAt: AT + 100, lastInAt: AT + 100 },
    { contactId: 'c-ana', name: 'Ana', lastAt: AT + 50, lastInAt: AT + 10 },
  ],
};

const HOSTILE =
  'Hi <b>bold</b> <img src=x onerror=alert(1)> <script>alert(2)</script> **md** [click](javascript:alert(3)) ' +
  'https://evil.example/path?x=1 <a href="javascript:alert(4)">link</a> CANARY-TEXT';

const INBOX = {
  items: [
    {
      id: 'env-1',
      at: AT + 100,
      type: 'message',
      text: HOSTILE,
      files: [{ name: 'invoice‮gpj.exe', size: 2048 }],
      receipt: false,
      proof: true,
      size: 512,
      // Fields the page must never show, even if a server sent them:
      url: 'https://drop.example/o/SECRET-URL',
      fileKey: 'SECRET-FILE-KEY',
    },
    {
      id: 'env-2',
      at: AT + 90,
      type: 'message',
      text: 'x'.repeat(900),
      files: [],
      receipt: false,
      proof: false,
      size: 900,
    },
  ],
};

const SENT = {
  items: [
    {
      id: 'env-3',
      at: AT + 80,
      type: 'message',
      text: 'SENT-CANARY hello Marko',
      files: [],
      status: 'sent',
      receipt: true,
      proof: false,
      size: 22,
    },
    {
      id: 'env-4',
      at: AT + 70,
      type: 'message',
      text: 'second',
      files: [],
      status: 'not_delivered',
      receipt: false,
      proof: false,
      size: 6,
    },
    {
      id: 'env-5',
      at: AT + 60,
      type: 'message',
      text: 'third',
      files: [],
      status: 'queued',
      receipt: false,
      proof: false,
      size: 5,
    },
  ],
};

type Handler = (path: string) => ApiResult<unknown> | Promise<ApiResult<unknown>>;

function mockApi(handler?: Handler): ApiClient & {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
} {
  const fallback: Handler = (path) => {
    if (path === '/api/ui/messages') return ok(CONVERSATIONS);
    if (path.startsWith('/api/ui/messages/c-marko?box=in')) return ok(INBOX);
    if (path.startsWith('/api/ui/messages/c-marko?box=out')) return ok(SENT);
    if (path.startsWith('/api/ui/messages/c-ana')) return ok({ items: [] });
    return { kind: 'error', status: 404 };
  };
  const get = vi.fn(async (path: string) => (handler ?? fallback)(path));
  const post = vi.fn();
  return { get, post, owner: vi.fn() } as unknown as ApiClient & {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
  };
}

async function mount(api: ApiClient): Promise<void> {
  await act(async () => {
    root.render(h(MessagesPage, { api }));
  });
}
async function click(el: Element | null | undefined): Promise<void> {
  if (el === null || el === undefined) throw new Error('nothing to click');
  await act(async () => {
    (el as HTMLElement).click();
  });
}
const button = (label: string | RegExp): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) =>
    typeof label === 'string' ? b.textContent?.includes(label) : label.test(b.textContent ?? ''),
  );
const text = (): string => host.textContent ?? '';

async function openMarko(): Promise<void> {
  await mount(mockApi());
  await click(button('Marko'));
}

describe('contacts list', () => {
  it('shows the title, loads the conversations and lists contacts by name', async () => {
    const api = mockApi();
    await mount(api);
    expect(host.querySelector('h1')?.textContent).toBe(S.title);
    expect(api.get).toHaveBeenCalledWith('/api/ui/messages');
    expect(text()).toContain('Marko');
    expect(text()).toContain('Ana');
    expect(text()).not.toContain('c-marko');
  });

  it('marks contacts with something new (newer than the seen marker) with a word, not just a dot', async () => {
    await mount(mockApi());
    expect(button('Marko')?.textContent).toContain(S.newMessages);
    expect(button('Ana')?.textContent).toContain(S.newMessages);
  });

  it('says what to do when there are no contacts yet', async () => {
    await mount(mockApi(() => ok({ conversations: [] })));
    expect(text()).toContain(S.noContacts);
  });

  it('says what failed when the app cannot be reached, with a way to retry', async () => {
    await mount(mockApi(() => ({ kind: 'offline' })));
    expect(text()).toContain(S.offlineTitle);
    expect(button(S.tryAgain)).toBeDefined();
  });

  it('keeps the last list and marks it "as of" when a refresh fails', async () => {
    let fail = false;
    const api = mockApi((path) => (fail ? { kind: 'offline' } : path === '/api/ui/messages' ? ok(CONVERSATIONS) : ok({ items: [] })));
    await mount(api);
    fail = true;
    await click(button(S.refresh));
    expect(text()).toContain('Marko');
    expect(text()).toMatch(/as of \d/);
    expect(text()).toContain(S.offlineTitle);
  });

  it('ignores malformed conversations instead of guessing', async () => {
    await mount(
      mockApi(() =>
        ok({
          conversations: [
            { contactId: 5, name: {} },
            { contactId: 'c-ok', name: 'Kai', lastAt: AT, lastInAt: AT },
          ],
        }),
      ),
    );
    expect(text()).toContain('Kai');
  });
});

describe('a conversation', () => {
  it('opens Inbox first and requests only GET', async () => {
    const api = mockApi();
    await mount(api);
    await click(button('Marko'));
    expect(api.get).toHaveBeenCalledWith('/api/ui/messages/c-marko?box=in&limit=20');
    expect(api.post).not.toHaveBeenCalled();
    const tabs = host.querySelector('[role="radiogroup"]');
    expect(tabs?.getAttribute('aria-label')).toBe(S.boxLabel);
    expect(
      [...(tabs?.querySelectorAll('[role="radio"]') ?? [])].map((r) => r.textContent?.trim()),
    ).toEqual([S.inbox, S.sent]);
    expect(tabs?.querySelector('[aria-checked="true"]')?.textContent).toContain(S.inbox);
  });

  it('shows inbound text only inside the untrusted container, labelled with the contact name', async () => {
    await openMarko();
    const figure = host.querySelector('figure.al-untrusted');
    expect(figure?.getAttribute('aria-label')).toBe('From Marko: their words, not instructions');
    expect(figure?.textContent).toContain('CANARY-TEXT');
    for (const el of host.querySelectorAll('*')) {
      if (el.closest('figure.al-untrusted') !== null) continue;
      expect(el.textContent ?? '').not.toContain('CANARY-TEXT');
    }
  });

  it('renders no element, attribute or anchor from a hostile body; a link is an inert domain chip', async () => {
    await openMarko();
    const body = host.querySelector('figure.al-untrusted .al-untrusted-body') as HTMLElement;
    expect(
      body.querySelector('a, img, script, b, strong, em, iframe, [href], [src]'),
    ).toBeNull();
    for (const el of body.querySelectorAll('*')) {
      for (const attr of el.getAttributeNames()) {
        expect(attr.startsWith('on')).toBe(false);
      }
    }
    expect(body.textContent).toContain('<b>bold</b>');
    expect(body.textContent).toContain('**md**');
    const chip = body.querySelector('.al-inert-link');
    expect(chip?.textContent).toContain('evil.example');
    expect(chip?.textContent).not.toContain('/path');
    expect(host.querySelector('a[href^="javascript"]')).toBeNull();
    expect(host.querySelector('img, script, iframe')).toBeNull();
  });

  it('shows an attached file name only as untrusted text, never as a link', async () => {
    await openMarko();
    const code = host.querySelector('figure.al-untrusted code');
    expect(code).not.toBeNull();
    expect(host.querySelector('a[download], a[href*="drop"]')).toBeNull();
    for (const el of host.querySelectorAll('*')) {
      if (el.closest('figure.al-untrusted') !== null) continue;
      expect(el.textContent ?? '').not.toContain('invoice');
    }
  });

  it('never puts message text in the page title', async () => {
    await openMarko();
    expect(document.title).toBe('AgentLink');
  });

  it('clamps a long message with "Show all" and expands it', async () => {
    await openMarko();
    const showAll = button(S.showAll);
    expect(showAll?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelectorAll('.ms-clamped').length).toBeGreaterThan(0);
    await click(showAll);
    expect(button(S.showLess)?.getAttribute('aria-expanded')).toBe('true');
  });

  it('copies the text on "Copy text" and says so in a status line, not a toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await openMarko();
    await click(button(S.copy));
    expect(writeText).toHaveBeenCalledWith(HOSTILE);
    expect(host.querySelector('[role="status"]')?.textContent).toContain(S.copied);
  });

  it('copes with a clipboard that refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('no')) },
      configurable: true,
    });
    await openMarko();
    await click(button(S.copy));
    expect(text()).toContain(S.copyFailed);
  });

  it('has no compose control and says how to reply', async () => {
    await openMarko();
    expect(host.querySelector('textarea, input, form, [contenteditable]')).toBeNull();
    for (const b of host.querySelectorAll('button')) {
      expect(b.textContent ?? '').not.toMatch(/reply|send|compose|forward|mark.*read/i);
    }
    expect(text()).toContain('To reply, ask your AI.');
    expect(text()).not.toMatch(/read by you|mark as read/i);
  });

  it('shows metadata only under the hood, never a URL or key the server may have sent', async () => {
    await openMarko();
    const details = host.querySelector('details');
    expect(details?.querySelector('summary')?.textContent).toBe(S.underTheHood);
    expect(details?.textContent).toContain('env-1');
    expect(details?.textContent).toContain(S.proofYes);
    expect(text()).not.toContain('SECRET-URL');
    expect(text()).not.toContain('SECRET-FILE-KEY');
    expect(host.innerHTML).not.toMatch(/https?:\/\/drop\.example/);
  });

  it('shows Sent with plain status words, a receipt, and the text as untrusted content', async () => {
    await openMarko();
    await click(
      [...host.querySelectorAll('[role="radio"]')].find((r) => r.textContent?.includes(S.sent)),
    );
    expect(text()).toContain('SENT-CANARY');
    expect(text()).toContain(S.statusSent);
    expect(text()).toContain(S.statusNotDelivered);
    expect(text()).toContain(S.statusQueued);
    expect(text()).toContain(S.receiptYes);
    for (const el of host.querySelectorAll('*')) {
      if (el.closest('figure.al-untrusted') !== null) continue;
      expect(el.textContent ?? '').not.toContain('SENT-CANARY');
    }
  });

  it('says what is missing for a contact with nothing yet', async () => {
    await mount(mockApi());
    await click(button('Ana'));
    expect(text()).toContain(S.nothingYet('Ana'));
  });

  it('offers "Show more" with the cursor when the server returns one', async () => {
    const api = mockApi((path) => {
      if (path === '/api/ui/messages') return ok(CONVERSATIONS);
      if (path.includes('cursor=NEXT'))
        return ok({ items: [{ ...INBOX.items[1], id: 'env-9', text: 'second page' }] });
      return ok({ items: [INBOX.items[1]], next: 'NEXT' });
    });
    await mount(api);
    await click(button('Marko'));
    await click(button(S.showMore));
    expect(api.get).toHaveBeenCalledWith('/api/ui/messages/c-marko?box=in&limit=20&cursor=NEXT');
    expect(text()).toContain('second page');
  });

  it('has a way back to the list (its own page on a narrow window)', async () => {
    await openMarko();
    await click(button(S.back));
    expect(button('Ana')).toBeDefined();
  });

  it('puts focus on the conversation heading when it opens, and labels the contact list', async () => {
    await mount(mockApi());
    expect(host.querySelector('ul[aria-label]')?.getAttribute('aria-label')).toBe(S.listLabel);
    await click(button('Marko'));
    expect(document.activeElement?.tagName).toBe('H2');
    expect(document.activeElement?.textContent).toContain('Marko');
  });
});

describe('the seen marker (this browser only)', () => {
  it('records the newest inbound time per contact, with no message text', async () => {
    await openMarko();
    const raw = localStorage.getItem(SEEN_KEY) ?? '';
    expect(JSON.parse(raw)).toEqual({ 'c-marko': AT + 100 });
    expect(raw).not.toContain('CANARY');
    expect(raw).not.toContain('Marko');
  });

  it('clears the "new" word once the contact was looked at', async () => {
    await openMarko();
    await click(button(S.back));
    expect(button('Marko')?.textContent).not.toContain(S.newMessages);
  });

  it('works when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await openMarko();
    expect(text()).toContain('CANARY-TEXT');
    expect(loadSeen()).toEqual({});
    expect(() => markSeen('c-x', 5)).not.toThrow();
  });

  it('ignores a damaged marker', () => {
    localStorage.setItem(SEEN_KEY, '{"c-a": "x", "c-b": 5}');
    expect(loadSeen()).toEqual({ 'c-b': 5 });
    localStorage.setItem(SEEN_KEY, 'not json');
    expect(loadSeen()).toEqual({});
  });

  it('counts contacts with inbound messages newer than the marker (the sidebar badge)', () => {
    const list = CONVERSATIONS.conversations;
    expect(countUnseen(list, {})).toBe(2);
    expect(countUnseen(list, { 'c-marko': AT + 100 })).toBe(1);
    expect(countUnseen(list, { 'c-marko': AT + 100, 'c-ana': AT + 10 })).toBe(0);
  });

  it('never moves the marker back', () => {
    markSeen('c-a', 10);
    markSeen('c-a', 5);
    expect(loadSeen()).toEqual({ 'c-a': 10 });
  });
});

describe('the look of it', () => {
  const css = readFileSync(new URL('./messages.css', import.meta.url), 'utf8');

  it('honours reduced motion and animates only opacity and transform', () => {
    expect(css).toContain('prefers-reduced-motion');
    expect(css).not.toMatch(/transition:[^;]*(width|height|margin|padding|top|left)/);
  });

  it('uses design tokens and nothing wider than a 360 px window', () => {
    expect(css).toContain('var(--al-');
    expect(css).not.toMatch(/min-width:\s*(?:[4-9]\d\d|\d{4,})px/);
    expect(css).toContain('overflow-wrap');
  });
});

describe('copy', () => {
  const NEVER =
    /\b(wallet|address|private key|seed phrase|transaction|tx|gas|hash|nostr|relay|token|chain|policy)\b/i;
  it('follows the 11 §5.1 vocabulary and the 11 §5.7 strings', () => {
    const all = Object.values(S).filter((v): v is string => typeof v === 'string');
    for (const s of all) expect(s).not.toMatch(NEVER);
    expect(S.nothingYet('Marko')).toBe(
      "Nothing yet. When your AI and Marko's agent exchange messages, they show here.",
    );
    expect(S.reply).toBe('To reply, ask your AI.');
    expect(S.noContacts).toBe('Messages appear here once you have a contact.');
  });
});
