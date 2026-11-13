// @vitest-environment jsdom
// RET-4 + RET-5 (D-148; 08 §1 "Conversation menu"; 11 §5): the person menu gains Archive (no
// presence, nothing deleted; the app keeps the choice for every browser through its UI settings, so
// it is not this browser's alone) and "Delete history…" (the delete sheet). Archive says the AI
// still sees the conversation and offers Undo; Unarchive brings it back.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ToastItem } from '@4thtech-io/ui';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { archivedOf, resetNoticesForTests, subscribeToasts } from '../../notices/index.js';
import type { ContactRow } from '../contacts/data.js';
import { PersonMenu } from './person-menu.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REF = '0x4c21a0f700000000000000000000000000000002';
const CONTACT = {
  ref: REF,
  name: 'Ana',
  nameSource: 'counterparty',
  fingerprint: '4C21·A0F7',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1_759_449_600,
} as unknown as ContactRow;

let host: HTMLElement;
let root: Root;
let toasts: ToastItem[];
let unsubscribe: () => void;
let posts: string[];
beforeEach(() => {
  resetNoticesForTests();
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
  toasts = [];
  posts = [];
  unsubscribe = subscribeToasts((t) => void toasts.push(t));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  unsubscribe();
  act(() => root.unmount());
  host.remove();
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

const fetchFn = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input.toString();
  if ((init?.method ?? 'GET') === 'POST') posts.push(url);
  const body =
    url === '/api/ui/history/delete/begin'
      ? {
          status: 'planned',
          nonce: 'N'.repeat(43),
          messages: { count: 5, bytes: 5_000 },
          files: { count: 1, bytes: 1_000_000 },
          notarized: 0,
          kept: 2,
          truncated: false,
          undoSeconds: 10,
        }
      : { status: 'ok' };
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}) as typeof fetch;

const item = (pattern: RegExp): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) =>
    pattern.test((b.textContent ?? '').trim()),
  );

async function openMenu(): Promise<void> {
  const api = createApiClient({ fetch: fetchFn, token: 't' });
  await act(async () => {
    root.render(
      createElement(PersonMenu, {
        name: 'Ana',
        contact: CONTACT,
        api,
        fetch: fetchFn,
        token: 't',
        idName: 'Personal',
        onChanged: () => undefined,
      }),
    );
  });
  await settle();
  const more = host.querySelector<HTMLButtonElement>('button[aria-label^="More for"]');
  await act(async () => {
    more?.click();
  });
  await settle();
}

describe('the person menu: Archive and Delete history (RET-4, RET-5)', () => {
  it('Archive needs no presence, deletes nothing, and offers Undo', async () => {
    await openMenu();
    const archive = item(/^Archive$/);
    expect(archive).toBeDefined();
    await act(async () => {
      archive?.click();
    });
    await settle();
    expect(archivedOf('Personal').has(REF)).toBe(true);
    expect(posts).toEqual([]);
    const toast = toasts.find((t) => t.text === 'Archived. Your AI still sees it.');
    expect(toast?.action).toBe('Undo');
    await act(async () => {
      toast?.onAction?.();
    });
    expect(archivedOf('Personal').has(REF)).toBe(false);
  });

  it('an archived person offers Unarchive', async () => {
    await openMenu();
    await act(async () => {
      item(/^Archive$/)?.click();
    });
    await settle();
    const more = host.querySelector<HTMLButtonElement>('button[aria-label^="More for"]');
    await act(async () => {
      more?.click();
    });
    await settle();
    await act(async () => {
      item(/^Unarchive$/)?.click();
    });
    await settle();
    expect(archivedOf('Personal').has(REF)).toBe(false);
  });

  it('Delete history… opens the sheet with the plan for this person', async () => {
    await openMenu();
    await act(async () => {
      item(/^Delete history…$/)?.click();
    });
    await settle();
    expect(posts).toContain('/api/ui/history/delete/begin');
    expect(host.textContent).toContain('Delete history with Ana?');
    expect(host.textContent).toContain('5 messages, 1 file, 1 MB');
  });
});
