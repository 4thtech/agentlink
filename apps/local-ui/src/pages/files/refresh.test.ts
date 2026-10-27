// @vitest-environment jsdom
/// <reference types="vite/client" />
// UI-REFRESH-j: the Files page refresh (B-11 §16 Files, §15, §17.3; invariants I-5, I-7).
//
// - Loading uses the shared Skeleton (no local shimmer). The stylesheet rules (no literal duration,
//   no background-position keyframes, no colour transition) are checked by the motion lint in
//   packages/ui/src/motion-lint.test.ts, which no longer lists any files.css exception.
// - The Received list sits on a raised card (Surface 2), rows on Surface 1.
// - Rows still in flight carry a stepped ProgressBar with plain words (no byte progress is served,
//   so no determinate bar); no file or contact name in its label.
// - Tab badges (CountBadge) for files waiting to be saved and files waiting to send.
// - A file that arrives while the page is open gets the file-received moment and the row entrance;
//   the first load plays none. Reduced motion (media query and the app's own attribute): no animate
//   call, the words still say it.
// - Under the hood: counts and sizes of what is listed and the folder paths (path kind); never a
//   file name, key or link.
// - Others' names stay plain text inside UntrustedContent.
import { HoodProvider } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesPage, type FilesPageProps } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let animateCalls: number;
let reducedQuery: boolean;

beforeEach(() => {
  animateCalls = 0;
  reducedQuery = false;
  document.documentElement.removeAttribute('data-motion');
  (Element.prototype as unknown as { animate: unknown }).animate = function () {
    animateCalls += 1;
    return { onfinish: null, cancel: () => undefined, reverse: () => undefined };
  };
  window.matchMedia = ((q: string) => ({
    matches: reducedQuery && q.includes('prefers-reduced-motion'),
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  document.documentElement.removeAttribute('data-motion');
});

const RECEIVED = '/api/ui/files/received?limit=20';
const SENT = '/api/ui/files/sent?limit=20';
const FOLDERS = '/api/ui/files';

function server(routes: Record<string, unknown>): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const found = (init?.method ?? 'GET') === 'GET' ? routes[url] : undefined;
    if (found === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(found), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
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
  hood = false,
): Promise<void> {
  const el = h<FilesPageProps>(FilesPage, { fetch: server(routes), token: 'tok', ...props });
  await act(async () => {
    root.render(hood ? h(HoodProvider, { value: true }, el) : el);
  });
  await flush();
}

const tabs = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
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
const page = (items: unknown[]) => ({ items });

describe('loading', () => {
  it('uses the shared Skeleton after 400 ms, with the status word kept', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchFn = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    await act(async () => {
      root.render(h<FilesPageProps>(FilesPage, { fetch: fetchFn, token: 'tok' }));
    });
    expect(host.querySelector('.al-skeleton')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(host.querySelector('.al-skeleton')).not.toBeNull();
    expect(host.textContent).toContain('Loading files…');
  });
});

describe('surfaces', () => {
  it('puts the Received list on a raised card and rows on Surface 1', async () => {
    await mount({ [RECEIVED]: page([received(), received({ id: 'b.00' })]) });
    const card = host.querySelector('[data-level="2"]');
    expect(card).not.toBeNull();
    const rows = [...(card?.querySelectorAll('.fl-item') ?? [])];
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.getAttribute('data-level')).toBe('1');
  });
  it('puts Sent rows on Surface 1 and no raised card', async () => {
    await mount({ [RECEIVED]: page([]), [SENT]: page([sent()]) });
    await click(tabs()[1]);
    expect(host.querySelector('.fl-item')?.getAttribute('data-level')).toBe('1');
    expect(host.querySelector('[data-level="2"]')).toBeNull();
  });
});

describe('progress on rows in flight', () => {
  const bar = (row: Element | null | undefined) => row?.querySelector('[role="progressbar"]');

  it('a file waiting to be saved shows a stepped bar at "Arrived"; a saved one shows none', async () => {
    await mount({
      [RECEIVED]: page([
        received({ id: 'a.00', state: 'not_saved', savedName: undefined, name: 'secret-plan.pdf' }),
        received({ id: 'b.00' }),
      ]),
    });
    const [first, second] = [...host.querySelectorAll('.fl-item')];
    const b = bar(first);
    expect(b).not.toBeNull();
    expect(b?.getAttribute('aria-valuetext')).toContain('Arrived');
    expect(bar(second)).toBeNull();
    // the label names neither the file nor the contact (I-5)
    expect(b?.getAttribute('aria-label')).toBe('File arriving');
  });

  it('a queued file waits to send, a sent one waits for delivery, a delivered one shows none', async () => {
    await mount({
      [RECEIVED]: page([]),
      [SENT]: page([
        sent({ id: 'q.00', status: 'queued', name: 'queued-name.txt' }),
        sent({ id: 's.00', status: 'sent', receipt: false }),
        sent({ id: 'd.00', status: 'sent', receipt: true }),
        sent({ id: 'n.00', status: 'not_delivered' }),
      ]),
    });
    await click(tabs()[1]);
    const rows = [...host.querySelectorAll('.fl-item')];
    expect(bar(rows[0])?.getAttribute('aria-valuetext')).toContain('Waiting to send');
    expect(bar(rows[1])?.getAttribute('aria-valuetext')).toContain('Sent');
    expect(bar(rows[2])).toBeNull();
    expect(bar(rows[3])).toBeNull();
    expect(bar(rows[0])?.getAttribute('aria-label')).toBe('File sending');
  });
});

describe('tab badges', () => {
  it('shows how many received files wait to be saved, none when all are saved', async () => {
    await mount({
      [RECEIVED]: page([
        received({ id: 'a.00', state: 'not_saved', savedName: undefined }),
        received({ id: 'b.00', state: 'not_saved', savedName: undefined }),
        received({ id: 'c.00' }),
      ]),
    });
    expect(tabs()[0]?.querySelector('.al-count')?.textContent).toContain('2');
    expect(tabs()[1]?.querySelector('.al-count')).toBeNull();
  });
  it('shows no badge when nothing waits', async () => {
    await mount({ [RECEIVED]: page([received()]) });
    expect(host.querySelector('[role="tab"] .al-count')).toBeNull();
  });
  it('shows how many sent files wait to send, once the Sent list is loaded', async () => {
    await mount({
      [RECEIVED]: page([]),
      [SENT]: page([
        sent({ status: 'queued' }),
        sent({ id: 'x.00', status: 'queued' }),
        sent({ id: 'y.00' }),
      ]),
    });
    await click(tabs()[1]);
    expect(tabs()[1]?.querySelector('.al-count')?.textContent).toContain('2');
  });
});

describe('a file that arrives while the page is open', () => {
  async function arrive(routes: Record<string, unknown>): Promise<void> {
    routes[RECEIVED] = page([
      received({ id: 'new.00', name: 'fresh.pdf', state: 'not_saved', savedName: undefined }),
      received(),
    ]);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
  }

  it('plays no moment on the first load', async () => {
    await mount({ [RECEIVED]: page([received()]) });
    expect(host.textContent).not.toContain('File received');
    expect(host.querySelector('.al-row-presence')).toBeNull();
  });

  it('shows the file-received moment and enters the new row when the page is shown again', async () => {
    const routes: Record<string, unknown> = { [RECEIVED]: page([received()]) };
    await mount(routes);
    await arrive(routes);
    expect(host.querySelectorAll('.fl-item').length).toBe(2);
    expect(host.textContent).toContain('File received');
    expect(host.querySelectorAll('.al-row-presence').length).toBe(1);
    expect(host.querySelector('.al-row-presence')?.textContent).toContain('fresh.pdf');
    expect(animateCalls).toBeGreaterThan(0);
  });

  it('keeps the list when the refresh fails', async () => {
    const routes: Record<string, unknown> = { [RECEIVED]: page([received()]) };
    await mount(routes);
    delete routes[RECEIVED];
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(host.textContent).toContain('proposal.pdf');
    expect(host.textContent).toContain('Showing the list as of');
  });

  it('with reduced motion (media query) nothing animates and the words still say it', async () => {
    reducedQuery = true;
    const routes: Record<string, unknown> = { [RECEIVED]: page([received()]) };
    await mount(routes);
    animateCalls = 0;
    await arrive(routes);
    expect(animateCalls).toBe(0);
    expect(host.textContent).toContain('File received');
  });

  it('with reduced motion (the app setting) nothing animates and the words still say it', async () => {
    document.documentElement.setAttribute('data-motion', 'reduced');
    const routes: Record<string, unknown> = { [RECEIVED]: page([received()]) };
    await mount(routes);
    animateCalls = 0;
    await arrive(routes);
    expect(animateCalls).toBe(0);
    expect(host.textContent).toContain('File received');
  });
});

describe('Under the hood', () => {
  it('is absent while the switch is off', async () => {
    await mount({ [RECEIVED]: page([received()]) });
    expect(host.querySelector('.al-hood')).toBeNull();
  });

  it('shows counts and sizes of what is listed, and nothing private', async () => {
    await mount(
      {
        [RECEIVED]: page([
          received({ name: 'https://evil.example/x.pdf' }),
          received({ id: 'b.00', size: 600_000 }),
        ]),
      },
      {},
      true,
    );
    const hood = host.querySelector('.al-hood');
    expect(hood).not.toBeNull();
    const text = hood?.textContent ?? '';
    expect(text).toContain('Under the hood');
    expect(text).toContain('2');
    expect(text).toContain('3 MB');
    expect(text).not.toContain('evil.example');
    expect(text).not.toContain('proposal');
    expect(text).not.toContain('Marko');
    expect(text).not.toMatch(/https?:|\/Users|\/home|~\//);
  });

  it('on Send folders shows the number of folders and each real folder path (the path kind)', async () => {
    await mount(
      {
        [RECEIVED]: page([]),
        [FOLDERS]: {
          folders: [{ path: '/Users/ana/Send', resolved: '/Users/ana/Send' }],
          version: 3,
        },
      },
      { initialTab: 'folders' },
      true,
    );
    const hoodText = host.querySelector('.al-hood')?.textContent ?? '';
    expect(hoodText).toContain('Under the hood');
    expect(hoodText).toContain('Folders allowed');
    expect(hoodText).toContain('/Users/ana/Send');
  });
});

describe("others' names (I-5)", () => {
  it('stay plain text inside UntrustedContent, never in a live region or the bar', async () => {
    const name = '<img src=x onerror=alert(1)>.pdf';
    await mount({
      [RECEIVED]: page([
        received({ name, state: 'not_saved', savedName: undefined, from: 'Eve <b>' }),
      ]),
    });
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('b')).toBeNull();
    const row = host.querySelector('.fl-item');
    expect(row?.textContent).toContain('onerror=alert(1)');
    for (const live of host.querySelectorAll('[role="status"], [aria-live], [role="alert"]')) {
      expect(live.textContent).not.toContain('onerror');
      expect(live.textContent).not.toContain('Eve');
    }
    expect(row?.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe(
      'File arriving',
    );
  });
});
