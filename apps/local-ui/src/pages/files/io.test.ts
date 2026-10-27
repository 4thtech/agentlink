// @vitest-environment jsdom
/// <reference types="vite/client" />
// MSG-FILES-IO-f: the Files page's three tabs, Received · Sent · Send folders (08 §1; 11 §5.7;
// design b11 §15, §17.3; plan docs/process/proposals/MSG-FILES-IO.md §4, §5).
//
// - Received is the default tab; Send folders keeps today's page. Read-only: only GETs.
// - Other people's file names are untrusted (I-5): inert plain text, no control or bidi characters,
//   no link, no URL, no path, no element from the name; the page never shows a URL or a key.
// - Received states: saved ("saved as", may be stale), not saved, expired, deleted. Sent: status
//   chips, receipt icon, available / expired / deleted.
// - Skeleton while loading (after 400 ms, no flash); empty and offline states.
// - MSG-FILES-IO-h: names another party chose sit in UntrustedContent; a malformed item is left out
//   and the rest still shows; "Show in Finder" ("Show in folder" off macOS) sends only the item ID;
//   not delivered says so; a `?folder=` link opens Send folders with the folder filled in.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesPage, type FilesPageProps } from './index.js';
import { REVEAL_PATH, plain } from './io-api.js';
import { FILES_IO_STRINGS as IO } from './strings.js';

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
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

const RECEIVED = '/api/ui/files/received?limit=20';
const SENT = '/api/ui/files/sent?limit=20';
const FOLDERS = '/api/ui/files';

/** A route's answer: a body (200), or `[status, body]`; `POST <path>` keys a POST. */
function server(routes: Record<string, unknown>, offline: readonly string[] = []) {
  const calls: Call[] = [];
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    calls.push({ url, method, headers: new Headers(init?.headers), body: init?.body });
    if (offline.includes(url)) return Promise.reject(new TypeError('offline'));
    const found = method === 'GET' ? routes[url] : routes[`${method} ${url}`];
    if (found === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    const [status, body] =
      Array.isArray(found) && typeof found[0] === 'number'
        ? (found as [number, unknown])
        : [200, found];
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { calls, fetch: fetchFn as typeof fetch };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

async function mount(
  routes: Record<string, unknown>,
  props: Partial<FilesPageProps> = {},
  offline: readonly string[] = [],
) {
  const s = server(routes, offline);
  await act(async () => {
    root.render(h<FilesPageProps>(FilesPage, { fetch: s.fetch, token: 'tok', ...props }));
  });
  await flush();
  return s;
}

const tabs = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
async function click(el: Element | undefined): Promise<void> {
  if (el === undefined) throw new Error('nothing to click');
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

const received = (over: Record<string, unknown> = {}) => ({
  id: 'env1.00',
  from: 'Marko',
  at: 1_792_000_000,
  name: 'proposal.pdf',
  size: 2_400_000,
  state: 'saved',
  savedName: 'proposal-2.pdf',
  proof: false,
  ...over,
});
const sent = (over: Record<string, unknown> = {}) => ({
  id: 'env2.00',
  to: 'Marko',
  at: 1_792_000_100,
  name: 'report.pdf',
  size: 1_200,
  status: 'sent',
  receipt: false,
  state: 'available',
  expiresAt: 1_792_500_000,
  ...over,
});
// The node API's page shape (MSG-FILES-IO-d): `nextCursor` only when there is more.
const page = (items: unknown[], next: string | null = null) =>
  next === null ? { items } : { items, nextCursor: next };

describe('tabs', () => {
  it('shows Received · Sent · Send folders in that order, Received selected', async () => {
    const s = await mount({ [RECEIVED]: page([received()]) });
    expect(tabs().map((t) => t.textContent)).toEqual(['Received', 'Sent', 'Send folders']);
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(host.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBeTruthy();
    expect(host.querySelector('[role="tabpanel"]')).not.toBeNull();
    expect(s.calls.map((c) => c.url)).toEqual([RECEIVED]);
    expect(host.textContent).toContain(IO.explainer);
  });

  it('the explainer says the page does not upload', () => {
    expect(IO.explainer).toBe(
      "You don't upload here. Put files in your Send folder or ask your AI to send them; files you receive appear under Received.",
    );
  });

  it('arrow keys move between tabs and show that tab', async () => {
    await mount({ [RECEIVED]: page([]), [SENT]: page([sent()]) });
    await act(async () => {
      tabs()[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await flush();
    expect(tabs()[1]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs()[1]?.getAttribute('tabindex')).toBe('0');
    expect(tabs()[0]?.getAttribute('tabindex')).toBe('-1');
    expect(host.textContent).toContain('report.pdf');
  });

  it("Send folders is today's page: folders and Allow a folder, no call to the file lists", async () => {
    const s = await mount({
      [RECEIVED]: page([]),
      [FOLDERS]: {
        folders: [{ path: '/Users/tali/Work', resolved: '/Users/tali/Work' }],
        max: 32,
        version: 3,
      },
    });
    await click(tabs()[2]);
    expect(host.textContent).toContain('/Users/tali/Work');
    expect(buttonNamed('Allow a folder')).toBeDefined();
    expect(s.calls.some((c) => c.url.includes('/sent'))).toBe(false);
  });

  it('can open on Send folders (a ?folder= link does)', async () => {
    const s = await mount(
      { [FOLDERS]: { folders: [], max: 32, version: 3 } },
      { initialTab: 'folders' },
    );
    expect(tabs()[2]?.getAttribute('aria-selected')).toBe('true');
    expect(s.calls.map((c) => c.url)).toEqual([FOLDERS]);
  });

  it('a ?folder= link opens Send folders with the folder filled in, and reads no file list', async () => {
    const before = window.location.href;
    window.history.replaceState(null, '', '/settings/files?folder=%2FUsers%2Fme%2FProjects');
    try {
      const s = await mount({ [FOLDERS]: { folders: [], max: 32, version: 3 } });
      expect(tabs()[2]?.getAttribute('aria-selected')).toBe('true');
      const field = host.querySelector<HTMLInputElement>('input[name="folder"]');
      expect(field?.value).toBe('/Users/me/Projects');
      expect(s.calls.map((c) => c.url)).toEqual([FOLDERS]);
    } finally {
      window.history.replaceState(null, '', before);
    }
  });
});

describe('Received', () => {
  it('shows from, when, size, the proof badge and the saved-as name with a stale note', async () => {
    await mount({ [RECEIVED]: page([received({ proof: true })]) });
    const text = host.textContent ?? '';
    expect(text).toContain('Marko');
    expect(text).toContain('proposal.pdf');
    expect(text).toContain('2.4 MB');
    expect(text).toContain('Proof recorded');
    expect(text).toContain(`${IO.savedAs} proposal-2.pdf`);
    expect(text).toContain(IO.mayHaveMoved);
    expect(host.querySelector('time')?.getAttribute('datetime')).toBe(
      new Date(1_792_000_000 * 1000).toISOString(),
    );
  });

  it('says what each state means', async () => {
    await mount({
      [RECEIVED]: page([
        received({ id: 'a.00', name: 'one.txt', state: 'not_saved', savedName: undefined }),
        received({ id: 'b.00', name: 'two.txt', state: 'expired', savedName: undefined }),
        received({ id: 'c.00', name: 'three.txt', state: 'deleted', savedName: undefined }),
      ]),
    });
    const text = host.textContent ?? '';
    expect(text).toContain(IO.notSaved);
    expect(text).toContain(IO.expired);
    expect(text).toContain(IO.deleted);
    expect(text).not.toContain(IO.savedAs);
  });

  it('shows the untrusted-file note, and Got it hides it', async () => {
    await mount({ [RECEIVED]: page([received()]) });
    expect(host.textContent).toContain(IO.untrustedNote);
    await click(buttonNamed(IO.gotIt));
    expect(host.textContent).not.toContain(IO.untrustedNote);
  });

  it('renders hostile names as inert text: no element, link, handler, control or bidi character', async () => {
    const hostile = [
      '<img src=x onerror=alert(1)>.pdf',
      '[click](javascript:alert(1)) <a href="https://evil.example/x">x</a>.txt',
      'ev‮il⁦.exe\u0000\u0007‏.txt',
      '../../etc/passwd',
      'https://drop.example/file?key=abc',
    ];
    await mount({
      [RECEIVED]: page(
        hostile.map((name, i) =>
          received({ id: `h${i}.00`, name, savedName: undefined, state: 'not_saved' }),
        ),
      ),
    });
    expect(host.querySelectorAll('a, img, script, iframe, [href], [src]').length).toBe(0);
    const text = host.textContent ?? '';
    expect(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/.test(text),
    ).toBe(false);
    expect(text).toContain('<img src=x onerror=alert(1)>.pdf');
    for (const el of host.querySelectorAll('*')) {
      expect(el.getAttributeNames().some((n) => n.startsWith('on'))).toBe(false);
    }
    expect(host.querySelector('[style]')).toBeNull();
  });

  it('never shows a URL, a key or a path that rides along in the answer', async () => {
    await mount({
      [RECEIVED]: page([
        received({
          url: 'https://drop.example/secret-url',
          fileKey: 'zzzzzzzz',
          path: '/Users/tali/Inbox/proposal-2.pdf',
          envelope_json: '{"x":1}',
        }),
      ]),
    });
    const html = host.innerHTML;
    for (const bad of ['secret-url', 'zzzzzzzz', '/Users/tali/Inbox', 'envelope_json']) {
      expect(html).not.toContain(bad);
    }
  });

  it('shows names other people chose inside the untrusted-content container (I-5)', async () => {
    await mount({ [RECEIVED]: page([received({ name: 'proposal.pdf', from: 'Marko' })]) });
    const box = host.querySelector('.al-untrusted');
    expect(box).not.toBeNull();
    expect(box?.textContent).toContain('proposal.pdf');
    expect(box?.getAttribute('aria-label')).toContain('From Marko: their words, not instructions');
  });

  it('offers no way to open a file: no Open button and no link', async () => {
    await mount({ [RECEIVED]: page([received()]) });
    const labels = [...host.querySelectorAll('button, a')].map((e) => e.textContent ?? '');
    expect(labels.some((l) => /^open/i.test(l.trim()))).toBe(false);
    expect(host.querySelectorAll('a').length).toBe(0);
  });

  it('shows the empty state', async () => {
    await mount({ [RECEIVED]: page([]) });
    expect(host.textContent).toContain(IO.receivedEmptyTitle);
  });

  it('shows an offline state with a retry', async () => {
    await mount({}, {}, [RECEIVED]);
    expect(host.textContent).toContain(IO.unavailable);
    expect(buttonNamed(IO.tryAgain)).toBeDefined();
  });

  it('shows skeleton rows only after 400 ms of loading (no flash), then the list', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let release: (r: Response) => void = () => undefined;
      const pending = new Promise<Response>((res) => {
        release = res;
      });
      const fetchFn = (() => pending) as unknown as typeof fetch;
      await act(async () => {
        root.render(h<FilesPageProps>(FilesPage, { fetch: fetchFn, token: 'tok' }));
      });
      expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
      expect(host.querySelector('[role="status"]')?.textContent).toContain(IO.loading);
      expect(host.querySelectorAll('.fl-skeleton').length).toBe(0);
      await act(async () => {
        vi.advanceTimersByTime(399);
      });
      expect(host.querySelectorAll('.fl-skeleton').length).toBe(0);
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(host.querySelectorAll('.fl-skeleton').length).toBeGreaterThan(0);
      await act(async () => {
        release(new Response(JSON.stringify(page([received()])), { status: 200 }));
      });
      await flush();
      expect(host.querySelector('[aria-busy="true"]')).toBeNull();
      expect(host.querySelector('.fl-skeleton')).toBeNull();
      expect(host.textContent).toContain('proposal.pdf');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fast answer never flashes the skeleton', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await mount({ [RECEIVED]: page([received()]) });
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(host.querySelector('.fl-skeleton')).toBeNull();
      expect(host.textContent).toContain('proposal.pdf');
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads more with the cursor and keeps what is on screen', async () => {
    const s = await mount({
      [RECEIVED]: page([received()], 'cur1'),
      [`${RECEIVED}&cursor=cur1`]: page([received({ id: 'z.00', name: 'later.txt' })]),
    });
    await click(buttonNamed(IO.showMore));
    expect(host.textContent).toContain('proposal.pdf');
    expect(host.textContent).toContain('later.txt');
    expect(s.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('does not show a malformed answer', async () => {
    await mount({ [RECEIVED]: { items: 'x' } });
    expect(host.textContent).toContain(IO.unavailable);
    act(() => root.unmount());
    root = createRoot(host);
    await mount({ [RECEIVED]: { items: [], nextCursor: 3 } });
    expect(host.textContent).toContain(IO.unavailable);
  });

  it('leaves out a malformed item and still shows the rest', async () => {
    await mount({
      [RECEIVED]: page([
        { id: 1, name: {} },
        'x',
        received({ id: 'ok.00', name: 'kept.pdf' }),
        received({ id: 'bad.00', state: 'unknown' }),
      ]),
    });
    expect(host.textContent).not.toContain(IO.unavailable);
    expect(host.textContent).toContain('kept.pdf');
    expect(host.querySelectorAll('.fl-item')).toHaveLength(1);
  });

  it('does not put a file name in the document title', async () => {
    const before = document.title;
    await mount({ [RECEIVED]: page([received()]) });
    expect(document.title).toBe(before);
  });
});

describe('Sent', () => {
  async function openSent(items: unknown[]) {
    const s = await mount({ [RECEIVED]: page([]), [SENT]: page(items) });
    await click(tabs()[1]);
    return s;
  }

  it('a file that was not delivered says so, with no receipt wait or availability line', async () => {
    await openSent([sent({ id: 'c.00', name: 'failed.txt', status: 'not_delivered' })]);
    const text = host.textContent ?? '';
    expect(text).toContain(IO.statusNotDelivered);
    expect(text).toContain(IO.sentNotDelivered);
    expect(text).not.toContain(IO.receiptNone);
    expect(text).not.toContain(IO.availableUntil);
  });

  it('shows file, to whom, when, size, status chips and the receipt icon', async () => {
    await openSent([
      sent({ id: 'a.00', status: 'sent', receipt: true }),
      sent({ id: 'b.00', name: 'queued.txt', status: 'queued' }),
      sent({ id: 'c.00', name: 'failed.txt', status: 'not_delivered' }),
    ]);
    const text = host.textContent ?? '';
    expect(text).toContain('report.pdf');
    expect(text).toContain('Marko');
    expect(text).toContain('1.2 KB');
    expect(text).toContain(IO.statusSent);
    expect(text).toContain(IO.statusQueued);
    expect(text).toContain(IO.statusNotDelivered);
    expect(host.querySelectorAll('[data-receipt="true"]').length).toBe(1);
    expect(host.querySelector('[data-receipt="true"]')?.textContent).toContain(IO.receiptConfirmed);
    // A file that was not delivered waits for no receipt.
    expect(host.querySelectorAll('[data-receipt="false"]').length).toBe(1);
  });

  it('says when a file is available, expired or deleted', async () => {
    await openSent([
      sent({ id: 'a.00', state: 'available' }),
      sent({ id: 'b.00', name: 'old.txt', state: 'expired' }),
      sent({ id: 'c.00', name: 'gone.txt', state: 'deleted', expiresAt: null }),
    ]);
    const text = host.textContent ?? '';
    expect(text).toContain(IO.availableUntil);
    expect(text).toContain(IO.sentExpired);
    expect(text).toContain(IO.sentDeleted);
  });

  it('shows the empty state', async () => {
    await openSent([]);
    expect(host.textContent).toContain(IO.sentEmptyTitle);
  });

  it('shows a recipient name as plain text', async () => {
    await openSent([sent({ to: '<b>Mallory</b>' })]);
    expect(host.querySelector('b')).toBeNull();
    expect(host.textContent).toContain('<b>Mallory</b>');
  });
});

describe('Show in Finder (MSG-FILES-IO-h, D-134)', () => {
  const REVEAL = `POST ${REVEAL_PATH}`;
  const finder = (): HTMLButtonElement | undefined =>
    buttonNamed(IO.showInFinder) ?? buttonNamed(IO.showInFolder);

  it('is offered only for a saved file, and names the platform file manager', async () => {
    await mount({
      [RECEIVED]: page([
        received({ id: 'a.00' }),
        received({ id: 'b.00', state: 'not_saved', savedName: undefined }),
        received({ id: 'c.00', state: 'expired', savedName: undefined }),
      ]),
    });
    const labels: string[] = [IO.showInFinder, IO.showInFolder];
    const buttons = [...host.querySelectorAll('button')].filter((b) =>
      labels.includes(b.textContent?.trim() ?? ''),
    );
    expect(buttons).toHaveLength(1);
    expect(host.querySelector('[data-slot="show-in-finder"]')).toBeNull();
  });

  it('says "Show in folder" off macOS and "Show in Finder" on macOS', async () => {
    const spy = vi.spyOn(navigator, 'platform', 'get');
    try {
      spy.mockReturnValue('Win32');
      await mount({ [RECEIVED]: page([received()]) });
      expect(buttonNamed(IO.showInFolder)).toBeDefined();
      expect(buttonNamed(IO.showInFinder)).toBeUndefined();
      act(() => root.unmount());
      root = createRoot(host);
      spy.mockReturnValue('MacIntel');
      await mount({ [RECEIVED]: page([received()]) });
      expect(buttonNamed(IO.showInFinder)).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('sends only the item ID: one POST, octet-stream, CSRF, no name, no path, no presence', async () => {
    const s = await mount({
      [RECEIVED]: page([received({ id: 'env1.00', name: 'proposal.pdf', savedName: 'p-2.pdf' })]),
      [REVEAL]: { status: 'shown' },
    });
    await click(finder());
    const posts = s.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    const post = posts[0] as Call;
    expect(post.url).toBe(REVEAL_PATH);
    expect(post.headers.get('content-type')).toBe('application/octet-stream');
    expect(post.headers.get('x-agentlink-csrf')).toBe('tok');
    expect(post.headers.get('x-agentlink-input')).toBeNull();
    expect(post.headers.get('x-agentlink-presence')).toBeNull();
    const body = new TextDecoder().decode(post.body as Uint8Array);
    expect(JSON.parse(body)).toEqual({ id: 'env1.00' });
    expect(body).not.toMatch(/proposal|p-2|Inbox|\//);
  });

  it('says what went wrong in plain words, never a path', async () => {
    const cases: [number, Record<string, string>, string][] = [
      [404, { error: 'not_found' }, IO.revealNotFound],
      [403, { error: 'refused' }, IO.revealRefused],
      [503, { error: 'unavailable' }, IO.revealUnavailable],
      [502, { error: 'not_opened' }, IO.revealFailed],
    ];
    for (const [status, body, message] of cases) {
      await mount({ [RECEIVED]: page([received()]), [REVEAL]: [status, body] });
      await click(finder());
      const said = [...host.querySelectorAll('[role="status"]')].map((e) => e.textContent).join();
      expect(said, body.error).toContain(message);
      act(() => root.unmount());
      root = createRoot(host);
    }
  });
});

describe('plain(): bounded text another party chose', () => {
  it('truncates by whole characters, never splitting a surrogate pair', () => {
    const out = plain('\u{1F600}'.repeat(300), 10);
    expect([...out]).toHaveLength(10);
    expect(out.endsWith('\u2026')).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(
      false,
    );
    expect(plain('a\u{1F600}b', 10)).toBe('a\u{1F600}b');
  });
});

describe('the lists are read-only and small-screen safe', () => {
  it('only reads: GET, never another method (until the owner clicks Show in Finder)', async () => {
    const s = await mount({ [RECEIVED]: page([received()]), [SENT]: page([sent()]) });
    await click(tabs()[1]);
    expect(s.calls.length).toBeGreaterThan(1);
    expect(s.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('shows names in the wrapping, recessed name well and no inline style (CSP)', async () => {
    await mount({ [RECEIVED]: page([received({ name: `${'long-'.repeat(60)}.pdf` })]) });
    expect(host.querySelectorAll('.fl-name').length).toBeGreaterThan(0);
    expect(host.querySelector('[style]')).toBeNull();
  });
});
