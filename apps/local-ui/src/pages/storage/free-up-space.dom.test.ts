// @vitest-environment jsdom
// RET-4 (D-148; 08 §1 "Free up space"; 11 §5): Settings > Storage gains Free up space. Filters by
// person, by age and "Files only"; Review asks the server what that would remove and shows the
// counts and sizes before anything is deleted (then the delete sheet). The Inbox folder gets Show in
// Finder (one fixed POST, no input, no presence).
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { StoragePage } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MARKO = '0x00000000000000000000000000000000000000a1';
const STORAGE = {
  status: 'ok',
  switchable: true,
  ids: [
    {
      name: 'default',
      label: 'Tali',
      current: true,
      status: 'ok',
      storeBytes: 2_000_000,
      walBytes: 0,
      messageBytes: 1_200_000,
      fileCount: 3,
      fileBytes: 45_000_000,
      people: [{ name: 'Marko Novak', messageBytes: 900_000, fileCount: 2, fileBytes: 40_000_000 }],
    },
  ],
  inbox: { folder: '~/AgentLink/Inbox', files: 0, bytes: 0, truncated: false },
};
const PEOPLE = {
  conversations: [{ contactId: MARKO, name: 'Marko Novak', lastAt: 1_800_000_000, lastInAt: 0 }],
};

let host: HTMLElement;
let root: Root;
let sent: { path: string; body: unknown }[];
beforeEach(() => {
  sent = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const api = {
  get: vi.fn((path: string): Promise<ApiResult<unknown>> => {
    const data = path.startsWith('/api/ui/messages') ? PEOPLE : STORAGE;
    return Promise.resolve({ kind: 'ok', status: 200, data });
  }),
} as unknown as ApiClient;

const fetchFn = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = typeof input === 'string' ? input : input.toString();
  const raw = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : '';
  if ((init?.method ?? 'GET') === 'POST') {
    sent.push({ path, body: raw === '' ? undefined : (JSON.parse(raw) as unknown) });
  }
  const body =
    path === '/api/ui/history/delete/begin'
      ? {
          status: 'planned',
          nonce: 'N'.repeat(43),
          messages: { count: 0, bytes: 0 },
          files: { count: 4, bytes: 30_000_000 },
          notarized: 0,
          kept: 0,
          truncated: false,
          undoSeconds: 10,
        }
      : { status: 'shown' };
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}) as typeof fetch;

async function mount(): Promise<void> {
  await act(async () => {
    root.render(h(StoragePage, { api, fetch: fetchFn, token: 't' }));
  });
  await settle();
}

const select = async (label: string, value: string): Promise<void> => {
  const el = [...host.querySelectorAll('label')]
    .find((l) => (l.textContent ?? '').includes(label))
    ?.querySelector('select');
  if (el === undefined || el === null) throw new Error(`no ${label}`);
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

describe('Settings > Storage: Free up space (RET-4)', () => {
  it('filters by person, age and files only; Review shows what it removes before acting', async () => {
    await mount();
    expect(host.textContent).toContain('Free up space');
    expect(host.textContent).not.toContain('Deleting is coming');
    await select('Person', MARKO);
    await select('Older than', '90');
    const filesOnly = [...host.querySelectorAll('label')]
      .find((l) => (l.textContent ?? '').includes('Files only'))
      ?.querySelector('input');
    await act(async () => {
      filesOnly?.click();
    });
    const review = [...host.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').trim() === 'Review',
    );
    await act(async () => {
      review?.click();
    });
    await settle();
    expect(sent[0]).toEqual({
      path: '/api/ui/history/delete/begin',
      body: { contact: MARKO, olderThanDays: 90, include: 'files' },
    });
    expect(host.textContent).toContain('This removes 0 messages and 4 files (30 MB).');
    // Nothing was deleted: only the plan was asked for.
    expect(sent.map((s) => s.path)).toEqual(['/api/ui/history/delete/begin']);
  });

  it('the Inbox folder has Show in Finder: one fixed POST with no input', async () => {
    await mount();
    const show = [...host.querySelectorAll('button')].find((b) =>
      /^Show in (Finder|Explorer|folder)$/.test((b.textContent ?? '').trim()),
    );
    await act(async () => {
      show?.click();
    });
    await settle();
    expect(sent).toEqual([{ path: '/api/ui/storage/inbox/reveal', body: undefined }]);
  });
});
