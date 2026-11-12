// @vitest-environment jsdom
// U3-map-2 (S1): the moving-row mark in Files (b11 §32.1, §32.3, §32.5; owner decision 8).
// A calm mark and a word on a row whose contact has a stream now; direction and word only, never
// content; static under reduced motion; nothing at all when the flow read fails.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPrefsForTests } from '../../prefs/store.js';
import { FilesPage, type FilesPageProps } from '../files/index.js';

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
