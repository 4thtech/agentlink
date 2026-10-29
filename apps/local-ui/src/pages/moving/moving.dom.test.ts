// @vitest-environment jsdom
// U3-map-2 (S1): the moving-row mark in Messages and Files (b11 §32.1, §32.3, §32.5; owner decision 8).
// A calm mark and a word on a row whose contact has a stream now; direction and word only, never
// content; static under reduced motion; nothing at all when the flow read fails.
import axe from 'axe-core';
import { HoodProvider } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { resetPrefsForTests } from '../../prefs/store.js';
import { FilesPage, type FilesPageProps } from '../files/index.js';
import { MessagesPage } from '../messages/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MARKO = `0x${'a1'.repeat(20)}`;
const ANA = `0x${'b2'.repeat(20)}`;
const nowSec = (): number => Math.floor(Date.now() / 1000);
const flowBody = (items: unknown[]): unknown => ({
  now: nowSec(),
  cursor: String(nowSec()),
  items,
  partial: false,
});
const ago = (s: number): number => nowSec() - s;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  resetPrefsForTests();
  document.documentElement.removeAttribute('data-motion');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.documentElement.removeAttribute('data-motion');
  vi.restoreAllMocks();
});

const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });
const CONVS = [
  { contactId: MARKO, name: 'Marko', lastAt: ago(100), lastInAt: ago(100) },
  { contactId: ANA, name: 'Ana', lastAt: ago(900), lastInAt: ago(900) },
];

function client(flow: () => ApiResult<unknown>): ApiClient {
  const get = vi.fn((path: string): Promise<ApiResult<unknown>> => {
    if (path === '/api/ui/messages') return Promise.resolve(ok({ conversations: CONVS }));
    if (path.startsWith('/api/ui/flow')) return Promise.resolve(flow());
    return Promise.resolve(ok({ items: [] }));
  });
  return { get, post: vi.fn(), owner: vi.fn() } as unknown as ApiClient;
}
async function mountMessages(c: ApiClient): Promise<void> {
  await act(async () => {
    root.render(h(HoodProvider, { value: false }, h(MessagesPage, { api: c })));
  });
}
const rowOf = (id: string): HTMLElement => {
  const el = host.querySelector<HTMLElement>(`button[data-contact="${id}"]`)?.closest('li');
  if (el === null || el === undefined) throw new Error(`no row ${id}`);
  return el;
};

describe('Messages', () => {
  it('marks only the row that is moving, with the word and an accessible label', async () => {
    await mountMessages(
      client(() =>
        ok(
          flowBody([
            { contactId: MARKO, direction: 'out', kind: 'message', state: 'sent', at: ago(4) },
          ]),
        ),
      ),
    );
    const mark = rowOf(MARKO).querySelector('.mv-mark');
    expect(mark?.textContent).toBe('Sending');
    expect(mark?.getAttribute('aria-label')).toBe('Sending…');
    expect(rowOf(ANA).querySelector('.mv-mark')).toBeNull();
    expect(host.querySelectorAll('.mv-mark').length).toBe(1);
  });

  it('says Receiving for an arrival, and the dash runs once', async () => {
    await mountMessages(
      client(() =>
        ok(
          flowBody([
            { contactId: ANA, direction: 'in', kind: 'message', state: 'received', at: ago(2) },
          ]),
        ),
      ),
    );
    const mark = rowOf(ANA).querySelector('.mv-mark');
    expect(mark?.textContent).toBe('Receiving');
    expect(mark?.getAttribute('aria-label')).toBe('Receiving…');
    expect(mark?.querySelector('.mv-run')).not.toBeNull();
  });

  it('is static under reduced motion: no travelling dash, the word "now" shows', async () => {
    document.documentElement.setAttribute('data-motion', 'reduced');
    await mountMessages(
      client(() =>
        ok(
          flowBody([
            { contactId: MARKO, direction: 'out', kind: 'file', state: 'queued', at: ago(3) },
          ]),
        ),
      ),
    );
    const mark = rowOf(MARKO).querySelector('.mv-mark');
    expect(mark?.querySelector('.mv-run')).toBeNull();
    expect(mark?.textContent).toBe('Sending now');
  });

  it('shows nothing after a minute, for a failed send, or when the flow read fails', async () => {
    await mountMessages(
      client(() =>
        ok(
          flowBody([
            { contactId: MARKO, direction: 'out', kind: 'message', state: 'sent', at: ago(90) },
            {
              contactId: ANA,
              direction: 'out',
              kind: 'message',
              state: 'not_delivered',
              at: ago(1),
            },
          ]),
        ),
      ),
    );
    expect(host.querySelector('.mv-mark')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    await mountMessages(client(() => ({ kind: 'error', status: 503 })));
    expect(host.querySelector('.mv-mark')).toBeNull();
    expect(host.querySelectorAll('button[data-contact]').length).toBe(2);
  });

  it('draws no content: a field the server should not send never reaches the row', async () => {
    await mountMessages(
      client(() =>
        ok(
          flowBody([
            {
              contactId: MARKO,
              direction: 'out',
              kind: 'message',
              state: 'sent',
              at: ago(1),
              text: 'CANARY-BODY',
              fileName: 'CANARY-FILE.pdf',
            },
          ]),
        ),
      ),
    );
    expect(host.querySelector('.mv-mark')).not.toBeNull();
    expect(host.textContent).not.toContain('CANARY');
    expect(rowOf(MARKO).querySelector('.mv-mark')?.getAttribute('title')).toBeNull();
  });

  it('has no accessibility violations with a mark on a row', async () => {
    await mountMessages(
      client(() =>
        ok(
          flowBody([
            { contactId: MARKO, direction: 'out', kind: 'message', state: 'sent', at: ago(4) },
          ]),
        ),
      ),
    );
    const result = await axe.run(host, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations).toEqual([]);
  });
});

describe('Files', () => {
  const SENT = (to: string, at: number, id = 'e1.00'): unknown => ({
    id,
    to,
    at,
    name: 'report.pdf',
    size: 1200,
    status: 'queued',
    receipt: false,
    state: 'available',
    expiresAt: at + 500_000,
  });
  const contact = (ref: string, name: string, source = 'owner'): unknown => ({
    ref,
    name,
    nameSource: source,
    label: 'self-declared',
    status: 'active',
    pairing: 'complete',
    since: 1,
  });

  async function mountFiles(routes: Record<string, unknown>): Promise<void> {
    const fetchFn = (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const key = Object.keys(routes).find((k) => url.startsWith(k));
      return Promise.resolve(
        key === undefined
          ? new Response('{}', { status: 404 })
          : new Response(JSON.stringify(routes[key]), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
      );
    };
    await act(async () => {
      root.render(
        h<FilesPageProps>(FilesPage, {
          fetch: fetchFn as typeof fetch,
          token: 'tok',
          initialTab: 'sent',
        }),
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  it('marks the sent file that is moving, and not a message-only contact', async () => {
    await mountFiles({
      '/api/ui/files/sent': {
        items: [SENT('Marko', ago(5)), SENT('Ana', ago(5), 'e2.00')],
      },
      '/api/ui/flow': flowBody([
        { contactId: MARKO, direction: 'out', kind: 'file', state: 'queued', at: ago(4) },
        { contactId: ANA, direction: 'out', kind: 'message', state: 'sent', at: ago(4) },
      ]),
      '/api/ui/contacts': {
        status: 'ok',
        contacts: [contact(MARKO, 'Marko'), contact(ANA, 'Ana')],
      },
    });
    const marks = [...host.querySelectorAll('.mv-mark')];
    expect(marks.length).toBe(1);
    expect(marks[0]?.textContent).toBe('Sending');
    expect(marks[0]?.closest('li')?.textContent).toContain('Marko');
  });

  it('never marks a row it cannot match to one contact (the other side chose the name)', async () => {
    await mountFiles({
      '/api/ui/files/sent': { items: [SENT('Marko', ago(5))] },
      '/api/ui/flow': flowBody([
        { contactId: MARKO, direction: 'out', kind: 'file', state: 'queued', at: ago(4) },
      ]),
      '/api/ui/contacts': {
        status: 'ok',
        contacts: [contact(MARKO, 'Marko', 'counterparty')],
      },
    });
    expect(host.querySelector('.mv-mark')).toBeNull();
  });
});
