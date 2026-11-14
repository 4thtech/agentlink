// @vitest-environment jsdom
// FILES-SETTINGS-COPY (D-152; 08 §1 "Settings › Files"; 11 §5.7; I-4): the explainer is the 11 §5.7
// string exactly, "You don't upload here" appears nowhere, the Send folders tab shows the one line
// and the fixed AI app tip above the list, and Show in Finder sits on the Send folder card and on the
// Inbox line and on no other folder card. Show in Finder sends an empty POST: no path, no input.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesPage, type FilesPageProps } from './index.js';
import { FILES_COPY, appTip, computerWord, showInLabel } from './folders-copy.js';

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
  readonly body: unknown;
}

function mountPage(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body });
    const status = method === 'POST' ? (routes[`POST ${url}`] === undefined ? 404 : 200) : 200;
    const found = method === 'GET' ? routes[url] : routes[`POST ${url}`];
    return Promise.resolve(
      found === undefined && method === 'GET'
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify(found ?? {}), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
    );
  }) as typeof fetch;
  return { calls, fetch: fetchFn };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const LIST = {
  folders: [
    { path: '~/AgentLink/Send', resolved: '/Users/a/AgentLink/Send' },
    { path: '~/Documents/Shared', resolved: '/Users/a/Documents/Shared' },
  ],
  max: 32,
  version: 3,
};
const ROUTES = {
  '/api/ui/files': LIST,
  '/api/ui/files/received?limit=20': {
    items: [],
    autoSave: { on: true, folder: '~/AgentLink/Inbox', notice: false },
  },
  '/api/ui/files/sent?limit=20': { items: [] },
  'POST /api/ui/files/send-folder/reveal': { status: 'shown' },
  'POST /api/ui/storage/inbox/reveal': { status: 'shown' },
};

async function mount(props: Partial<FilesPageProps> = {}) {
  const s = mountPage(ROUTES);
  await act(async () => {
    root.render(h<FilesPageProps>(FilesPage, { fetch: s.fetch, token: 'tok', ...props }));
  });
  await flush();
  return s;
}

const showButtons = (): HTMLButtonElement[] =>
  [...host.querySelectorAll('button')].filter((b) => b.textContent?.trim() === showInLabel());

describe('Settings › Files copy', () => {
  it('the explainer is the 11 §5.7 string, and the old line appears nowhere', async () => {
    await mount();
    expect(host.textContent).toContain(FILES_COPY.explainer);
    expect(FILES_COPY.explainer).toBe(
      'Your AI sends files from your Send folder, and files you receive are saved in Inbox. To send a text file yourself, use Attach in a conversation.',
    );
    expect(host.textContent).not.toContain("You don't upload here");
  });

  it('the Send folders tab shows the one line and the fixed tip above the list', async () => {
    await mount({ initialTab: 'folders' });
    const text = host.textContent ?? '';
    expect(text).toContain(FILES_COPY.oneLine);
    expect(text).toContain(appTip(undefined, computerWord()));
    expect(text.indexOf(FILES_COPY.oneLine)).toBeLessThan(text.indexOf('~/AgentLink/Send'));
  });

  it('Show in Finder is on the Send folder card and the Inbox line only', async () => {
    const s = await mount({ initialTab: 'folders' });
    const buttons = showButtons();
    expect(buttons).toHaveLength(2);
    const rows = buttons.map((b) => b.closest('li, div.fl-row')?.textContent ?? '');
    expect(rows[0]).toContain('~/AgentLink/Send');
    expect(rows[1]).toContain('~/AgentLink/Inbox');
    expect(host.textContent).toContain('~/Documents/Shared');
    // The other folder's card has none.
    const other = [...host.querySelectorAll('li.fl-row')].find((li) =>
      li.textContent?.includes('~/Documents/Shared'),
    );
    expect(other?.textContent).not.toContain(showInLabel());

    await act(async () => {
      buttons[0]?.click();
    });
    await flush();
    await act(async () => {
      buttons[1]?.click();
    });
    await flush();
    const posts = s.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url)).toEqual([
      '/api/ui/files/send-folder/reveal',
      '/api/ui/storage/inbox/reveal',
    ]);
    for (const c of posts) expect((c.body as Uint8Array).length).toBe(0);
  });

  it('a Send folder that is not found has no Show in Finder', async () => {
    const s = mountPage({
      ...ROUTES,
      '/api/ui/files': { ...LIST, folders: [{ path: '~/AgentLink/Send', resolved: null }] },
    });
    await act(async () => {
      root.render(
        h<FilesPageProps>(FilesPage, { fetch: s.fetch, token: 'tok', initialTab: 'folders' }),
      );
    });
    await flush();
    // Only the Inbox line.
    expect(showButtons()).toHaveLength(1);
  });
});
