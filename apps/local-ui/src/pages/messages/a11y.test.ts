// @vitest-environment jsdom
// UI-REFRESH-r (b): axe finds no WCAG 2.1 A/AA violation on Messages: the contact list, and an open
// conversation with Under the hood on. (Colour contrast is a visual check; jsdom has no layout.)
import axe from 'axe-core';
import { HoodProvider } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { MessagesPage } from './index.js';
import { MESSAGES_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-motion');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.documentElement.removeAttribute('data-motion');
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (Element.prototype as { animate?: unknown }).animate;
  delete (window as { matchMedia?: unknown }).matchMedia;
});

const AT = 1_760_000_000;
const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });
const ONE = [{ contactId: 'c-marko', name: 'Marko', lastAt: AT + 100, lastInAt: AT + 100 }];
const TWO = [...ONE, { contactId: 'c-zed', name: 'Zed', lastAt: AT + 200, lastInAt: AT + 200 }];
const item = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  at: AT + 10,
  type: 'message',
  text: `CANARY-${id}`,
  files: [],
  receipt: false,
  proof: false,
  size: 512,
  ...extra,
});
const INBOX = {
  items: [
    item('env-1', {
      proof: true,
      url: 'https://drop.example/o/SECRET-URL',
      fileKey: 'SECRET-FILE-KEY',
      proofLink: 'https://basescan.org/tx/0x' + 'ab'.repeat(32),
    }),
    item('env-2'),
  ],
};

type Get = (path: string) => Promise<ApiResult<unknown>>;
function api(conversations: () => unknown, override?: Get): ApiClient {
  const fallback: Get = (path) => {
    if (path === '/api/ui/messages') return Promise.resolve(ok({ conversations: conversations() }));
    if (path.startsWith('/api/ui/messages/c-marko')) return Promise.resolve(ok(INBOX));
    return Promise.resolve(ok({ items: [] }));
  };
  const get = vi.fn((path: string) => (override ?? fallback)(path));
  return { get, post: vi.fn(), owner: vi.fn() } as unknown as ApiClient;
}

async function mount(client: ApiClient, hood = false): Promise<void> {
  await act(async () => {
    root.render(h(HoodProvider, { value: hood }, h(MessagesPage, { api: client })));
  });
}
async function click(el: Element | null | undefined): Promise<void> {
  if (el === null || el === undefined) throw new Error('nothing to click');
  await act(async () => {
    (el as HTMLElement).click();
  });
}
const button = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
async function openMarko(hood = false): Promise<void> {
  await mount(
    api(() => ONE),
    hood,
  );
  await click(button('Marko'));
}

const run = (): Promise<axe.AxeResults> =>
  axe.run(host, {
    runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
    rules: { 'color-contrast': { enabled: false } },
  });

describe('axe', () => {
  it('finds no violation on the contact list', async () => {
    await mount(
      api(() => TWO),
      true,
    );
    expect(host.querySelector(`ul[aria-label="${S.listLabel}"]`)).not.toBeNull();
    expect((await run()).violations.map((v) => v.id)).toEqual([]);
  });
  it('finds no violation in an open conversation', async () => {
    await openMarko(true);
    expect(host.querySelectorAll('.ms-item').length).toBe(2);
    expect((await run()).violations.map((v) => v.id)).toEqual([]);
  });
});
