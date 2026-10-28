// @vitest-environment jsdom
// UX2-g (S1): the empty states on Contacts, Messages and Files point to step 2 of Start here
// (B-11 §27.4). While step 2 is known not done they say "Invite someone first" and offer the
// primary Add contact; once it is done (or while it is unknown) they keep today's empty states.
// Until the Add contact sheet (UX2-d1/d2) lands, Add contact goes to Home, where the existing
// invite instructions are.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../api/client.js';
import { ADD_CONTACT_HREF } from './contacts/add-contact-link.js';
import { ContactsPage } from './contacts/index.js';
import { CONTACTS_STRINGS } from './contacts/strings.js';
import { FilesPage } from './files/index.js';
import { FILES_IO_STRINGS } from './files/strings.js';
import { START_STRINGS } from './home/strings.js';
import { StartHereContext, type StartHereModel } from './home/start-here-context.js';
import { MessagesPage } from './messages/index.js';
import { MESSAGES_STRINGS } from './messages/strings.js';

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

const model = (inviteDone: boolean | undefined): StartHereModel => ({
  phase: 'shown',
  view: null,
  announce: '',
  inviteDone,
});

const fetcher = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === 'string' ? input : input.toString();
  const body =
    url === '/api/ui/contacts'
      ? { status: 'ok', contacts: [] }
      : url === '/api/ui/messages'
        ? { conversations: [] }
        : url.startsWith('/api/ui/files/received') || url.startsWith('/api/ui/files/sent')
          ? { status: 'ok', items: [] }
          : {};
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

type Which = 'contacts' | 'messages' | 'files';
async function mount(which: Which, ctx: StartHereModel | null): Promise<void> {
  const api = createApiClient({ fetch: fetcher, token: 't' });
  const page =
    which === 'contacts'
      ? h(ContactsPage, { api } as never)
      : which === 'messages'
        ? h(MessagesPage, { api })
        : h(FilesPage, { fetch: fetcher, token: 't', initialTab: 'received' } as never);
  await act(async () => {
    root.render(h(StartHereContext.Provider, { value: ctx }, page));
  });
  await settle();
}
// The empty state's own Add contact (UX2-d2: Contacts also has one in its title row, b11 §21.1).
const addContact = (): HTMLElement | undefined =>
  [...host.querySelectorAll<HTMLElement>('.al-empty a, .al-empty button')].find(
    (e) => e.textContent === START_STRINGS.addContact,
  );

describe('Empty states point to step 2 of Start here', () => {
  it('Contacts: "No contacts yet. Invite someone to start." with one Add contact that opens the sheet here', async () => {
    await mount('contacts', model(false));
    expect(host.textContent).toContain('No contacts yet. Invite someone to start.');
    expect(host.textContent).toContain(CONTACTS_STRINGS.emptyPrompt);
    const all = [...host.querySelectorAll<HTMLElement>('a, button')].filter(
      (e) => e.textContent === START_STRINGS.addContact,
    );
    expect(all.length).toBe(1);
    const add = all[0] as HTMLElement;
    expect(add.tagName).toBe('BUTTON');
    expect(add.classList.contains('al-btn-primary')).toBe(true);
    expect(add.closest('.al-empty')).not.toBeNull();
    await act(async () => {
      add.click();
    });
    await settle();
    expect(document.body.querySelector('[role="region"][aria-label="Add contact"]')).not.toBeNull();
  });

  it('Messages: "No messages yet. Invite someone first, then ask your AI to say hello."', async () => {
    await mount('messages', model(false));
    expect(host.textContent).toContain(
      'No messages yet. Invite someone first, then ask your AI to say hello.',
    );
    expect(addContact()?.classList.contains('al-btn-primary')).toBe(true);
    expect(addContact()?.getAttribute('href')).toBe(ADD_CONTACT_HREF);
  });

  it('Files: "No files yet. Invite someone first." with Add contact', async () => {
    await mount('files', model(false));
    expect(host.textContent).toContain('No files yet. Invite someone first.');
    expect(addContact()?.getAttribute('href')).toBe(ADD_CONTACT_HREF);
  });

  it("once step 2 is done they return to today's empty states, with no Add contact", async () => {
    await mount('contacts', model(true));
    expect(host.textContent).toContain(CONTACTS_STRINGS.emptyTitle);
    expect(addContact()).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(host);
    await mount('messages', model(true));
    expect(host.textContent).toContain(MESSAGES_STRINGS.noContacts);
    expect(addContact()).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(host);
    await mount('files', model(true));
    expect(host.textContent).toContain(FILES_IO_STRINGS.receivedEmptyTitle);
    expect(addContact()).toBeUndefined();
  });

  it("while step 2 is not known, and with no Start here at all, today's empty states stay", async () => {
    await mount('contacts', model(undefined));
    expect(host.textContent).toContain(CONTACTS_STRINGS.emptyTitle);
    act(() => root.unmount());
    root = createRoot(host);
    await mount('contacts', null);
    expect(host.textContent).toContain(CONTACTS_STRINGS.emptyTitle);
    expect(addContact()).toBeUndefined();
  });
});
