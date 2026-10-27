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
// - Skeleton while loading; empty and offline states; "Show in Finder" is a later card (h).
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesPage, type FilesPageProps } from './index.js';
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
}

const RECEIVED = '/api/ui/files/received?limit=20';
const SENT = '/api/ui/files/sent?limit=20';
const FOLDERS = '/api/ui/files';

function server(routes: Record<string, unknown>, offline: readonly string[] = []) {
  const calls: Call[] = [];
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, method: init?.method ?? 'GET' });
    if (offline.includes(url)) return Promise.reject(new TypeError('offline'));
    const found = routes[url];
    if (found === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(found), {
        status: 200,
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
const page = (items: unknown[], next: string | null = null) => ({ items, next });

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

  it('has no Show in Finder button yet (card h) and no way to open a file, only a marked slot', async () => {
    await mount({ [RECEIVED]: page([received()]) });
    const labels = [...host.querySelectorAll('button, a')].map((e) => e.textContent ?? '');
    expect(labels.some((l) => /finder|open/i.test(l))).toBe(false);
    expect(host.querySelector('[data-slot="show-in-finder"]')).not.toBeNull();
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

  it('shows a skeleton with a busy state while loading, then the list', async () => {
    let release: (r: Response) => void = () => undefined;
    const pending = new Promise<Response>((res) => {
      release = res;
    });
    const fetchFn = (() => pending) as unknown as typeof fetch;
    await act(async () => {
      root.render(h<FilesPageProps>(FilesPage, { fetch: fetchFn, token: 'tok' }));
    });
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(host.querySelectorAll('.fl-skeleton').length).toBeGreaterThan(0);
    expect(host.querySelector('[role="status"]')?.textContent).toContain(IO.loading);
    await act(async () => {
      release(new Response(JSON.stringify(page([received()])), { status: 200 }));
    });
    await flush();
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(host.querySelector('.fl-skeleton')).toBeNull();
    expect(host.textContent).toContain('proposal.pdf');
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
    await mount({ [RECEIVED]: { items: [{ id: 1, name: {} }, 'x'], next: 3 } });
    expect(host.textContent).toContain(IO.unavailable);
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
    expect(host.querySelectorAll('[data-receipt="false"]').length).toBe(2);
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

describe('the lists are read-only and small-screen safe', () => {
  it('only reads: GET, never another method', async () => {
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
