// @vitest-environment jsdom
// RET-7 (D-148 (3) OD-3; 04 §4.2 "The AI proposes, the owner approves"; 08 §1; 11 §5): the link of
// `agentlink_tidy` opens Settings › Storage with the AI's filter (`?tidy=files|both&days=30|90|365`,
// an optional `&contact=`). The page says the AI suggested it, fills Free up space and opens the
// delete sheet: the server plans and shows the exact counts; nothing is deleted until the owner
// presses the sensor button (RET-4 finish, presence) and the 10-second Undo ends. Any other query is
// ignored: no proposal, no plan asked for.
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
  ids: [],
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
    const data = path.startsWith('/api/ui/messages')
      ? PEOPLE
      : path.startsWith('/api/ui/storage/retention')
        ? {
            status: 'ok',
            version: 1,
            active: true,
            keep: { messagesKeepDays: 0, filesKeepDays: 0 },
          }
        : STORAGE;
    return Promise.resolve({ kind: 'ok', status: 200, data });
  }),
} as unknown as ApiClient;

const fetchFn = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = typeof input === 'string' ? input : input.toString();
  const raw = ArrayBuffer.isView(init?.body)
    ? new TextDecoder().decode(init?.body as Uint8Array)
    : '';
  if ((init?.method ?? 'GET') === 'POST') {
    sent.push({ path, body: raw === '' ? undefined : (JSON.parse(raw) as unknown) });
  }
  const body =
    path === '/api/ui/history/delete/begin'
      ? {
          status: 'planned',
          nonce: 'N'.repeat(43),
          messages: { count: 0, bytes: 0 },
          files: { count: 6, bytes: 410_000_000 },
          notarized: 0,
          kept: 0,
          truncated: false,
          undoSeconds: 10,
        }
      : { error: 'not_found' };
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}) as typeof fetch;

async function mount(search: string): Promise<void> {
  await act(async () => {
    root.render(h(StoragePage, { api, fetch: fetchFn, token: 't', search }));
  });
  await settle();
}

describe('Settings › Storage opened from agentlink_tidy (RET-7)', () => {
  it('says the AI suggested it and shows the exact counts; nothing is deleted yet', async () => {
    await mount(`?tidy=files&days=90&contact=${MARKO}`);
    expect(host.textContent).toContain('Your AI suggested this cleanup.');
    expect(host.textContent).toContain('Nothing is deleted until you confirm it here.');
    expect(sent).toEqual([
      {
        path: '/api/ui/history/delete/begin',
        body: { contact: MARKO, olderThanDays: 90, include: 'files' },
      },
    ]);
    expect(host.textContent).toContain('This removes 0 messages and 6 files (410 MB).');
    // Only the plan was asked for: no finish without the owner's gesture.
    expect(sent.map((s) => s.path)).not.toContain('/api/ui/history/delete/finish');
  });

  it('everyone, messages and files', async () => {
    await mount('?tidy=both&days=365');
    expect(sent).toEqual([
      { path: '/api/ui/history/delete/begin', body: { olderThanDays: 365, include: 'both' } },
    ]);
  });

  it('any other query is ignored: no proposal and no plan', async () => {
    for (const search of [
      '?tidy=all&days=90',
      '?tidy=files&days=0',
      '?tidy=files&days=7',
      '?tidy=files',
      '?tidy=files&days=90&contact=Marko',
      `?tidy=files&days=90&contact=${MARKO}&x=1`,
      '?days=90',
      '',
    ]) {
      sent = [];
      await mount(search);
      expect(host.textContent, search).not.toContain('Your AI suggested');
      expect(sent, search).toEqual([]);
    }
  });
});
