// @vitest-environment jsdom
// W4-PEOPLE-INVITE on the interim People page (/contacts, until U3 folds it into Home):
// - "Invite someone" opens the Invite screen in place (and `?invite` opens it at once); Done
//   closes it and the new pending row is there.
// - The inviter's side of "Connected ✓": an open invite goes and a new paired contact arrives, and
//   the page shows "You and {name} are connected" with the safety code.
// - The person ⋯ menu carries Rename, Check safety code and Remove.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { INVITE_STRINGS as I } from '../invite/strings.js';
import { ContactsPage, type ContactsPageProps } from './index.js';
import { createInviteApi } from './invite-api.js';
import { createOwnerClient } from './owner.js';
import { CONTACTS_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MARKO = '0x7f3a19c200000000000000000000000000000001';
const SHORT = 'https://agentlink.4thtech.io/i#2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const marko = {
  ref: MARKO,
  name: 'Marko',
  nameSource: 'counterparty',
  fingerprint: '7F3A·19C2',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1_800_000_000,
};

interface State {
  contacts: unknown[];
  open: { inviteId: string; name: string | null; expiresAt: string }[];
  accepted?: number;
  created?: number;
}

function server(state: State): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (method === 'GET' && url === '/api/ui/contacts') {
      return json({ status: 'ok', contacts: state.contacts });
    }
    if (method === 'GET' && url === '/api/ui/invites') {
      return json({ status: 'ok', invites: state.open });
    }
    if (method === 'GET' && url === `/api/ui/contacts/${MARKO}/safety-code`) {
      return json({ status: 'ok', code: '4821 0937 5512' });
    }
    if (method === 'GET' && url === '/api/owner/passkey') {
      return json({
        passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' },
      });
    }
    if (method === 'POST' && url === '/api/ui/invites') {
      state.created = (state.created ?? 0) + 1;
      state.open.push({
        inviteId: 'AQEBAQEBAQEBAQEBAQEBAQ',
        name: null,
        expiresAt: '2999-01-01T00:00:00Z',
      });
      return json({
        status: 'ok',
        inviteUrl: SHORT,
        shareText: `Add my AI agent on AgentLink: ${SHORT}`,
        expiresAt: '2999-01-01T00:00:00Z',
        format: 'short',
        inviteId: 'AQEBAQEBAQEBAQEBAQEBAQ',
      });
    }
    // W4-WIRE-2: a pasted link (the Invite screen's "Paste it"): check, then accept.
    if (method === 'POST' && url === '/api/ui/invites/check') {
      return json({
        status: 'ok',
        contact: { name: 'Marko', label: 'self-declared', ownerFingerprint: '7F3A·19C2' },
        expiresAt: '2999-01-01T00:00:00Z',
      });
    }
    if (method === 'POST' && url === '/api/ui/invites/accept') {
      state.accepted = (state.accepted ?? 0) + 1;
      return json({ status: 'pending' });
    }
    if (method === 'POST' && url === '/api/ui/invites/cancel') {
      state.open = [];
      return json({ status: 'cancelled' });
    }
    return json({}, 404);
  }) as typeof fetch;
}

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
  history.replaceState(null, '', '/');
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'clipboard');
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(state: State): Promise<void> {
  const fetch = server(state);
  await act(async () => {
    root.render(
      createElement<ContactsPageProps>(ContactsPage, {
        api: createApiClient({ fetch, token: 't' }),
        owner: createOwnerClient({ fetch, token: 't' }),
        invites: createInviteApi({ fetch, token: 't' }),
        pollMs: 20,
      }),
    );
  });
  await settle();
}

const text = (): string => document.body.textContent ?? '';
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label || b.getAttribute('aria-label') === label,
  );
  if (found === undefined) throw new Error(`no button "${label}" in: ${text()}`);
  return found;
}
async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
  });
  await settle();
}

describe('People: the Invite screen in place', () => {
  it('"Invite someone" opens the Invite screen with a short link; Done brings the pending row', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
    await mount({ contacts: [marko], open: [] });
    await click(I.title);
    expect(document.querySelector('h1')?.textContent).toBe(I.title);
    expect(text()).toContain('agentlink.4thtech.io/i#2.AAAA');
    await click(I.copy);
    await click(I.done);
    expect(document.querySelector('h1')?.textContent).not.toBe(I.title);
    expect(text()).toContain('Waiting for them to accept');
    expect(button(I.cancelInvite)).toBeTruthy();
  });

  it('`?invite` opens it at once and leaves nothing in the address', async () => {
    history.replaceState(null, '', '/contacts?invite');
    await mount({ contacts: [], open: [] });
    expect(document.querySelector('h1')?.textContent).toBe(I.title);
    expect(location.search).toBe('');
  });
});

describe('W4-WIRE-2: a pasted invite link on the Invite screen (Decision 52 (3))', () => {
  it('People has no Add contact sheet; Invite someone is the one way in', async () => {
    await mount({ contacts: [marko], open: [] });
    const names = [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
    expect(names).not.toContain('Add contact');
    expect(document.querySelector('[role="tab"]')).toBeNull();
  });

  it('Paste it → Continue → Accept with the backup code → the Connected moment', async () => {
    const state: State = { contacts: [], open: [] };
    await mount(state);
    await click('Have an invite link? Paste it');
    const field = document.querySelector<HTMLTextAreaElement>('textarea[name="invite-link"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        field,
        SHORT,
      );
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Continue');
    expect(text()).toContain('invites you to connect your AIs');
    await click('Accept with your backup code');
    const code = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        code,
        '123456',
      );
      code.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(S.confirm);
    expect(state.accepted).toBe(1);
    state.contacts = [marko];
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    await settle();
    expect(text()).toContain('You and “Marko” are connected');
    // IR-W4-WIRE-2X-1: pasting someone's invite makes no invite of your own.
    expect(state.created ?? 0).toBe(0);
  });

  it('Paste it on the Invite screen opens the paste screen; the link it made goes (U4 rule)', async () => {
    const state: State = { contacts: [], open: [] };
    await mount(state);
    await click(I.title);
    expect(state.created).toBe(1);
    await click('Have an invite link? Paste it');
    expect(document.querySelector('.inv-panel')).toBeNull();
    expect(document.querySelector('textarea[name="invite-link"]')).not.toBeNull();
    expect(state.open).toEqual([]);
  });
});

describe("People: the inviter's Connected moment (A7)", () => {
  it('an open invite goes and a new paired contact arrives: "You and Marko are connected"', async () => {
    const state: State = {
      contacts: [],
      open: [
        { inviteId: 'AQEBAQEBAQEBAQEBAQEBAQ', name: 'Marko', expiresAt: '2999-01-01T00:00:00Z' },
      ],
    };
    await mount(state);
    expect(text()).toContain('Waiting for Marko to accept');
    state.open = [];
    state.contacts = [marko];
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    await settle();
    // The name rule quotes a name the contact gave itself (I-5).
    expect(text()).toContain('You and “Marko” are connected');
    expect(text()).toContain('4821');
    await click(I.done);
    expect(text()).not.toContain('are connected');
  });

  it('a contact that was already there never triggers it', async () => {
    await mount({ contacts: [marko], open: [] });
    expect(text()).not.toContain('are connected');
  });
});

describe('People: the person ⋯ menu', () => {
  it('Rename, Check safety code and Remove sit in the menu', async () => {
    await mount({ contacts: [marko], open: [] });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.ct-row')?.click();
    });
    await settle();
    await click('More for “Marko”');
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent);
    expect(items).toEqual([I.rename, I.checkCode, I.remove]);
    await click(I.rename);
    expect(document.querySelector('input[name="alias"]')).not.toBeNull();
    expect(S.rename).toBe(I.rename);
  });
});
