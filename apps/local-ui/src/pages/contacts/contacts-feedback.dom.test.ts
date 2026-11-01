// @vitest-environment jsdom
// W5-INVITE-FEEDBACK + W5-PASTE-ENTRY on People (08 §1; 11 §5; I-5): the waiting rows come from the
// server, so they survive a reload: the inviter's open invites (with Cancel) and the accepter's
// "Connecting to {name}…", or, while the accept could not leave this computer yet, "Waiting for
// {name} to come online. This finishes on its own." A `contacts` event reads the list again at
// once, and the contact that just connected is highlighted. "Someone invited you? Paste link" is a
// top-level button, and `?paste` opens the paste screen.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client.js';
import { announceContactsChanged } from '../../api/contact-changes.js';
import { ContactsPage, type ContactsPageProps } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MARKO = `0x${'3d'.repeat(20)}`;
const EXPIRES = '2999-01-15T08:00:00Z';

let host: HTMLElement;
let root: Root;
let contacts: unknown[];
let connecting: unknown[];
let reads: number;

const api = {
  get: async (path: string) => {
    if (path === '/api/ui/invites') return { kind: 'ok', data: { invites: [], connecting } };
    if (path !== '/api/ui/contacts') return { kind: 'error', status: 404 };
    reads += 1;
    return { kind: 'ok', data: { status: 'ok', contacts } };
  },
  post: async () => ({ kind: 'error', status: 404 }),
} as unknown as ApiClient;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement<ContactsPageProps>(ContactsPage, { api, pollMs: 60_000 }));
  });
  await settle();
}

beforeEach(() => {
  history.replaceState(null, '', '/contacts');
  contacts = [];
  connecting = [];
  reads = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const text = (): string => host.textContent ?? '';

describe('waiting rows from the server', () => {
  it('shows "Connecting to {name}…" for an accept that was sent', async () => {
    connecting = [{ ref: MARKO, name: 'Marko', expiresAt: EXPIRES, sent: true, again: false }];
    await mount();
    expect(text()).toContain('Connecting to Marko…');
  });

  it('shows the honest offline line while the accept waits to leave this computer', async () => {
    connecting = [{ ref: MARKO, name: 'Marko', expiresAt: EXPIRES, sent: false, again: false }];
    await mount();
    expect(text()).toContain('Waiting for Marko to come online. This finishes on its own.');
  });

  it('a hostile name stays text', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    connecting = [{ ref: MARKO, name: hostile, expiresAt: EXPIRES, sent: true, again: false }];
    await mount();
    expect(text()).toContain(`Connecting to ${hostile}…`);
    expect(host.querySelector('img')).toBeNull();
  });
});

describe('the contacts event', () => {
  it('reads again at once and highlights the contact that connected', async () => {
    connecting = [{ ref: MARKO, name: 'Marko', expiresAt: EXPIRES, sent: true, again: false }];
    await mount();
    const before = reads;
    connecting = [];
    contacts = [
      {
        ref: MARKO,
        name: 'Marko',
        nameSource: 'counterparty',
        label: 'self-declared',
        status: 'active',
        pairing: 'complete',
        since: 1_800_000_000,
        pairedAt: 1_800_000_000,
      },
    ];
    await act(async () => {
      announceContactsChanged();
    });
    await settle();
    expect(reads).toBeGreaterThan(before);
    expect(text()).not.toContain('Connecting to Marko…');
    expect(host.querySelector('.ct-row.is-fresh')).not.toBeNull();
  });
});

describe('W5-PASTE-ENTRY on People', () => {
  it('has a top-level "Someone invited you? Paste link" button that opens the paste screen', async () => {
    contacts = [
      {
        ref: MARKO,
        name: 'Marko',
        nameSource: 'counterparty',
        label: 'self-declared',
        status: 'active',
        pairing: 'complete',
        since: 1_800_000_000,
      },
    ];
    await mount();
    const open = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Someone invited you? Paste link',
    );
    expect(open).toBeDefined();
    await act(async () => {
      open?.click();
    });
    await settle();
    expect(host.querySelector('textarea[name="invite-link"]')).not.toBeNull();
  });

  it('?paste opens the paste screen, and the marker leaves the address', async () => {
    history.replaceState(null, '', '/contacts?paste');
    await mount();
    expect(host.querySelector('textarea[name="invite-link"]')).not.toBeNull();
    expect(location.search).toBe('');
  });
});
