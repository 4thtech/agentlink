// @vitest-environment jsdom
// ATT-SENDFOLDER-FIX (D-121 D6; 08 §1; 11 §5; I-4): Home's "Allow your Send folder" banner.
//
// - Shown only when the open ID allows no folder (`GET /api/ui/files` answers an empty list).
// - Its one button asks the local server to set up the Send folder (`POST /api/ui/files/send-folder`,
//   a mark-kind route: an empty octet-stream body, no presence, nothing signed), then opens
//   Settings > Files with that folder filled in and checked, where the owner confirms with Touch ID
//   or the master code. The browser never signs and no policy changes here.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SEND_FOLDER_BANNER_TEXT,
  SEND_FOLDER_PATH,
  SendFolderBanner,
  createSendFolderApi,
} from './send-folder-banner.js';

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
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function server(answers: Record<string, { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    const a = answers[`${init?.method ?? 'GET'} ${url}`] ?? { status: 404, body: {} };
    return Promise.resolve(new Response(JSON.stringify(a.body), { status: a.status }));
  };
  return { calls, fetch: fetchFn as typeof fetch };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(answers: Record<string, { status: number; body: unknown }>) {
  const s = server(answers);
  const went: string[] = [];
  await act(async () => {
    root.render(
      h(SendFolderBanner, {
        api: createSendFolderApi({ fetch: s.fetch, token: 'csrf' }),
        go: (to: string) => went.push(to),
      }),
    );
  });
  await settle();
  return { ...s, went };
}

const EMPTY = { 'GET /api/ui/files': { status: 200, body: { folders: [], max: 32, version: 1 } } };

describe('ATT-SENDFOLDER-FIX: the Send folder banner', () => {
  it('says what to do in plain words, with one button', async () => {
    await mount(EMPTY);
    expect(SEND_FOLDER_BANNER_TEXT).toBe('Allow your Send folder so your AI can send files.');
    const banner = host.querySelector('[data-send-folder-banner]');
    expect(banner?.textContent).toContain(SEND_FOLDER_BANNER_TEXT);
    expect(banner?.querySelectorAll('button')).toHaveLength(1);
  });

  it('is absent when a folder is allowed, on an error, or without an ID', async () => {
    for (const answer of [
      { status: 200, body: { folders: [{ path: '/x', resolved: '/x' }], max: 32, version: 2 } },
      { status: 409, body: { error: 'not_set_up' } },
      { status: 500, body: {} },
      { status: 200, body: { folders: 'nope' } },
    ]) {
      await mount({ 'GET /api/ui/files': answer });
      expect(host.querySelector('[data-send-folder-banner]')).toBeNull();
    }
  });

  it('the button sets up the folder (an empty mark POST), then opens Files filled in and checked', async () => {
    const s = await mount({
      ...EMPTY,
      [`POST ${SEND_FOLDER_PATH}`]: { status: 200, body: { folder: '/Users/t/AgentLink/Send-2' } },
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-send-folder-banner] button')?.click();
    });
    await settle();
    const post = s.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/ui/files/send-folder');
    expect(post?.headers.get('content-type')).toBe('application/octet-stream');
    expect(post?.headers.get('x-agentlink-csrf')).toBe('csrf');
    expect(post?.headers.get('x-agentlink-input')).toBeNull();
    expect((post?.body as Uint8Array | undefined)?.length ?? 0).toBe(0);
    expect(s.went).toEqual([
      `/settings/files?folder=${encodeURIComponent('/Users/t/AgentLink/Send-2')}&check=1`,
    ]);
  });

  it('a folder that could not be set up opens Files with nothing filled in, and says so', async () => {
    const s = await mount({
      ...EMPTY,
      [`POST ${SEND_FOLDER_PATH}`]: { status: 200, body: { error: 'unavailable' } },
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-send-folder-banner] button')?.click();
    });
    await settle();
    expect(s.went).toEqual([]);
    expect(host.querySelector('[data-send-folder-banner]')?.textContent).toMatch(/Files/);
  });
});
