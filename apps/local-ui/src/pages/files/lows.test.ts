// @vitest-environment jsdom
// UI-REFRESH-r (c): Files lows. The "Folder N" hood label lives in the strings file; "N more" shows
// when more than five folder paths exist; a refresh that returns an empty newest page keeps the rows
// already loaded and marks them "as of".
import { HoodProvider } from '@4thtech-io/ui';
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

const RECEIVED = '/api/ui/files/received?limit=20';
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

const received = {
  id: 'env1.00',
  from: 'Marko',
  at: 1_792_000_000,
  name: 'proposal.pdf',
  size: 2_400_000,
  state: 'saved',
  savedName: 'proposal-2.pdf',
  proof: false,
};
const folders = (n: number): unknown => ({
  folders: Array.from({ length: n }, (_, i) => ({
    path: `/Users/ana/Send${String(i + 1)}`,
    resolved: `/Users/ana/Send${String(i + 1)}`,
  })),
  max: 32,
  version: 3,
});
const hoodRows = (): string[][] =>
  [...host.querySelectorAll('.al-hood-row')].map((r) => [
    r.querySelector('dt')?.textContent ?? '',
    r.querySelector('dd')?.textContent ?? '',
  ]);

describe('folder labels in the Under the hood panel', () => {
  it('takes the "Folder N" label from the strings file', async () => {
    expect(typeof IO.hoodFolder).toBe('function');
    await mount(
      { [RECEIVED]: { items: [] }, [FOLDERS]: folders(2) },
      { initialTab: 'folders' },
      true,
    );
    const labels = hoodRows().map((r) => r[0]);
    expect(labels).toContain(IO.hoodFolder(1));
    expect(labels).toContain(IO.hoodFolder(2));
  });

  it('shows "N more" when there are more than five folder paths', async () => {
    await mount(
      { [RECEIVED]: { items: [] }, [FOLDERS]: folders(7) },
      { initialTab: 'folders' },
      true,
    );
    const rows = hoodRows();
    expect(rows.filter((r) => r[0].startsWith('Folder ')).length).toBe(5);
    expect(rows.some((r) => r[1] === '2 more')).toBe(true);
  });

  it('shows no "more" line for five folders or fewer', async () => {
    await mount(
      { [RECEIVED]: { items: [] }, [FOLDERS]: folders(5) },
      { initialTab: 'folders' },
      true,
    );
    expect(hoodRows().some((r) => /more$/.test(r[1] ?? ''))).toBe(false);
  });
});

describe('a refresh that returns an empty newest page', () => {
  it('keeps the rows already loaded and marks them "as of"', async () => {
    const routes: Record<string, unknown> = { [RECEIVED]: { items: [received] } };
    await mount(routes);
    expect(host.textContent).toContain('proposal.pdf');
    routes[RECEIVED] = { items: [] };
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(host.textContent).toContain('proposal.pdf');
    expect(host.textContent).toContain('Showing the list as of');
  });
});
