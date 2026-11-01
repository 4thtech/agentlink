// @vitest-environment jsdom
// W5-INVITE-FEEDBACK + W5-PASTE-ENTRY (08 §1; 04 §2.9; 11 §5; I-5): when A invites and B pastes, both
// screens show what is happening and when it is done, with no reload.
//
// - The client reads the new answer fields through allowlists: `connecting` rows, `alreadyContact`,
//   and accept's `sent` and `again` (the shared contract samples).
// - diffContacts turns two reads into what changed: a new contact from an open invite ("{name}
//   accepted your invite"), a pasted invite that completed ("You're connected with {name}") and a
//   re-pair ("Connected again with {name}"); another agent's list is never a change.
// - The toast host says it, as text only, and offers the safety code check after a re-pair.
// - The paste screen asks "You're already connected to {name}. Connect again?" before Accept, and
//   hands the page `sent` and `again`.
// - "Someone invited you? Paste link" opens the paste screen; the clipboard is read only on a click,
//   or on focus once the owner turned that on, and its text never leaves the page unless the owner
//   continues with it.
import {
  INVITES_CONNECTING,
  INVITE_ACCEPT_AGAIN_OFFLINE,
  INVITE_CHECK_AGAIN,
} from '@4thtech-io/types/ui-contract/invite-feedback';
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTACTS_CHANGED,
  diffContacts,
  type ContactChange,
  type ContactsPicture,
} from '../../api/contact-changes.js';
import { ContactToasts } from '../../layout/contact-toasts.js';
import type { ContactRow } from '../contacts/data.js';
import {
  createInviteApi,
  parseConnecting,
  type AcceptOutcome,
  type CheckOutcome,
  type InviteApi,
} from '../contacts/invite-api.js';
import type { PasskeyInfo, PresenceProof } from '../contacts/owner.js';
import { CLIPBOARD_OPT_IN_KEY, ClipboardOffer, PASTE_HREF, PasteEntryLink } from './paste-entry.js';
import { PasteInvite } from './paste-invite.js';
import { FEEDBACK_STRINGS as F, changeText } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdE';
const SHORT = `https://agentlink.4thtech.io/i#2.${SECRET}`;
const REF_A = `0x${'3d'.repeat(20)}`;
const REF_B = `0x${'4e'.repeat(20)}`;
const PASSKEY = { credentialId: 'AQID', prfSalt: 'BwgJ' } as unknown as PasskeyInfo;
const PROOF: PresenceProof = { kind: 'passkey', body: new Uint8Array([1, 2, 3]) };

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  history.replaceState(null, '', '/');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  try {
    localStorage.clear();
  } catch {
    // No storage: nothing to clear.
  }
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
const text = (): string => host.textContent ?? '';
function button(name: string | RegExp): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => {
    const t = (b.textContent ?? '').trim();
    return typeof name === 'string' ? t === name : name.test(t);
  });
  if (found === undefined) throw new Error(`no button ${String(name)} in: ${text()}`);
  return found;
}
async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    button(name).click();
  });
  await settle();
}

const answer = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

describe('the client reads the new answer fields (contract samples)', () => {
  it('reads connecting rows, and leaves out a row of another shape', () => {
    expect(parseConnecting(INVITES_CONNECTING.answer.body)).toEqual([
      { ref: REF_A, name: 'Marko', expiresAt: Date.UTC(2027, 0, 15, 8), sent: false, again: false },
    ]);
    expect(
      parseConnecting({
        invites: [],
        connecting: [{ ref: 'x', name: 'Y', expiresAt: '2027-01-15T08:00:00Z', sent: 1 }],
      }),
    ).toEqual([]);
    // An older app answers no connecting at all.
    expect(parseConnecting({ invites: [] })).toEqual([]);
  });

  it('reads alreadyContact from check, and sent and again from accept', async () => {
    const api = createInviteApi({
      token: 't',
      fetch: (input) =>
        Promise.resolve(
          String(input).endsWith('/check')
            ? answer(200, INVITE_CHECK_AGAIN.answer.body)
            : answer(200, INVITE_ACCEPT_AGAIN_OFFLINE.answer.body),
        ),
    });
    const checked = await api.check(SHORT);
    expect(checked).toMatchObject({
      kind: 'ok',
      invite: { name: 'Marko', already: { ref: REF_A, name: 'Marko (work)' } },
    });
    expect(await api.accept(SHORT, PROOF)).toEqual({ kind: 'pending', sent: false, again: true });
  });
});

const row = (ref: string, over: Partial<ContactRow & { pairedAt: number }> = {}) =>
  ({
    ref,
    name: ref === REF_A ? 'Marko' : 'Ana',
    nameSource: 'counterparty',
    label: 'self-declared',
    status: 'active',
    pairing: 'complete',
    since: 1_800_000_000,
    pairedAt: 1_800_000_000,
    ...over,
  }) as ContactRow;

const picture = (over: Partial<ContactsPicture> = {}): ContactsPicture => ({
  agent: 'default',
  contacts: [],
  connecting: [],
  openInvites: 0,
  ...over,
});

describe('diffContacts: what changed between two reads', () => {
  it('a new contact while an invite was open: accepted', () => {
    const changes = diffContacts(
      picture({ openInvites: 1 }),
      picture({ contacts: [row(REF_A)], openInvites: 0 }),
    );
    expect(changes).toEqual<ContactChange[]>([{ kind: 'accepted', ref: REF_A, name: 'Marko' }]);
  });

  it('a pasted invite that completed: connected', () => {
    const connecting = [
      { ref: REF_A, name: 'Marko', expiresAt: 0, sent: true, again: false },
    ] as const;
    expect(diffContacts(picture({ connecting }), picture({ contacts: [row(REF_A)] }))).toEqual<
      ContactChange[]
    >([{ kind: 'connected', ref: REF_A, name: 'Marko' }]);
  });

  it('a re-pair (a later pairedAt on a contact already there): again, on both sides', () => {
    const before = picture({ contacts: [row(REF_A, { pairedAt: 100 }), row(REF_B)] });
    const after = picture({ contacts: [row(REF_A, { pairedAt: 200 }), row(REF_B)] });
    expect(diffContacts(before, after)).toEqual<ContactChange[]>([
      { kind: 'again', ref: REF_A, name: 'Marko' },
    ]);
  });

  it('nothing on the first read, for another agent, a rename or a removal', () => {
    expect(diffContacts(undefined, picture({ contacts: [row(REF_A)] }))).toEqual([]);
    expect(
      diffContacts(
        picture({ agent: 'default', openInvites: 1 }),
        picture({ agent: 'work', contacts: [row(REF_A)] }),
      ),
    ).toEqual([]);
    expect(
      diffContacts(
        picture({ contacts: [row(REF_A)] }),
        picture({ contacts: [row(REF_A, { name: 'Marko 2' })] }),
      ),
    ).toEqual([]);
    expect(diffContacts(picture({ contacts: [row(REF_A)] }), picture())).toEqual([]);
  });

  it('the pairing role decides, not which rows this page saw (B completes before its row was read)', () => {
    // An open invite of B's own was listed, and B's accept completed before its connecting row
    // was ever seen: B is the invitee of this pairing, so it is "connected".
    expect(
      diffContacts(
        picture({ openInvites: 1 }),
        picture({ contacts: [row(REF_A, { pairedAs: 'invitee' } as never)] }),
      ),
    ).toEqual<ContactChange[]>([{ kind: 'connected', ref: REF_A, name: 'Marko' }]);
    // The inviter's side says "accepted" even with no open invite seen before.
    expect(
      diffContacts(
        picture(),
        picture({ contacts: [row(REF_A, { pairedAs: 'inviter' } as never)] }),
      ),
    ).toEqual<ContactChange[]>([{ kind: 'accepted', ref: REF_A, name: 'Marko' }]);
  });

  it('a contact that is still pending is not a change yet', () => {
    expect(
      diffContacts(
        picture({ openInvites: 1 }),
        picture({ contacts: [row(REF_A, { pairing: 'pending' })] }),
      ),
    ).toEqual([]);
  });
});

describe('the words (11 §5)', () => {
  it('says each change in plain words, with no banned term', () => {
    expect(changeText({ kind: 'accepted', ref: REF_A, name: 'Marko' })).toBe(
      'Marko accepted your invite',
    );
    expect(changeText({ kind: 'connected', ref: REF_A, name: 'Marko' })).toBe(
      "You're connected with Marko",
    );
    expect(changeText({ kind: 'again', ref: REF_A, name: 'Marko' })).toBe(
      'Connected again with Marko. Check the safety code again.',
    );
    expect(F.waitingOnline('Marko')).toBe(
      'Waiting for Marko to come online. This finishes on its own.',
    );
    expect(F.already('Marko')).toBe("You're already connected to Marko. Connect again?");
    for (const s of [
      ...Object.values(F as Record<string, unknown>).filter(
        (v): v is string => typeof v === 'string',
      ),
      F.waitingOnline('x'),
      F.already('x'),
    ]) {
      expect(lintVocabulary(s)).toEqual([]);
    }
  });
});

describe('the toast host', () => {
  it('shows the change as text (a hostile name stays text), and Dismiss closes it', async () => {
    let emit: ((c: ContactChange) => void) | undefined;
    const subscribe = (fn: (c: ContactChange) => void): (() => void) => {
      emit = fn;
      return () => undefined;
    };
    await act(async () => {
      root.render(createElement(ContactToasts, { subscribe }));
    });
    const hostile = '<img src=x onerror=alert(1)>';
    await act(async () => {
      emit?.({ kind: 'accepted', ref: REF_A, name: hostile });
    });
    expect(text()).toContain(`${hostile} accepted your invite`);
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    await click('');
    expect(text()).not.toContain('accepted your invite');
  });

  it('after a re-pair it offers the safety code check', async () => {
    let emit: ((c: ContactChange) => void) | undefined;
    await act(async () => {
      root.render(
        createElement(ContactToasts, {
          subscribe: (fn: (c: ContactChange) => void) => {
            emit = fn;
            return () => undefined;
          },
        }),
      );
    });
    await act(async () => {
      emit?.({ kind: 'again', ref: REF_A, name: 'Marko' });
    });
    expect(text()).toContain('Connected again with Marko');
    expect(button(F.checkAction)).toBeDefined();
  });

  it('CONTACTS_CHANGED is the event name the live store announces', () => {
    expect(CONTACTS_CHANGED).toBe('agentlink:contacts-changed');
  });
});

function fakeInvites(
  check: CheckOutcome,
  accept: AcceptOutcome,
): InviteApi & { checked: string[] } {
  const checked: string[] = [];
  return {
    checked,
    create: () => Promise.resolve({ kind: 'failed' }),
    cancel: () => Promise.resolve({ kind: 'cancelled' }),
    check: (link) => {
      checked.push(link);
      return Promise.resolve(check);
    },
    accept: () => Promise.resolve(accept),
  };
}

async function typeLink(value: string): Promise<void> {
  const el = host.querySelector<HTMLTextAreaElement>('textarea[name="invite-link"]');
  if (el === null) throw new Error(`no field in ${text()}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('re-pair on the paste screen', () => {
  it('asks "Connect again?" before Accept, and hands over sent and again', async () => {
    const invites = fakeInvites(
      {
        kind: 'ok',
        invite: {
          name: 'Marko',
          fingerprint: 'AB12·CD34',
          expiresAt: Date.UTC(2999, 0, 1),
          already: { ref: REF_A, name: 'Marko (work)' },
        },
      },
      { kind: 'pending', sent: false, again: true },
    );
    const connected = vi.fn();
    await act(async () => {
      root.render(
        createElement(PasteInvite, {
          invites,
          passkey: PASSKEY,
          gesture: () => Promise.resolve(PROOF),
          platform: 'mac',
          onConnected: connected,
          startOpen: true,
        }),
      );
    });
    await typeLink(SHORT);
    await click('Continue');
    expect(text()).toContain("You're already connected to Marko (work). Connect again?");
    expect(text()).toContain(F.againResets);
    await click(/Touch ID/);
    // The name rule quotes a self-declared name.
    expect(connected).toHaveBeenCalledWith('Marko', { sent: false, again: true });
  });

  it('a first pairing says nothing about connecting again', async () => {
    const invites = fakeInvites(
      {
        kind: 'ok',
        invite: { name: 'Ana', fingerprint: 'AB12·CD34', expiresAt: Date.UTC(2999, 0, 1) },
      },
      { kind: 'pending', sent: true, again: false },
    );
    await act(async () => {
      root.render(createElement(PasteInvite, { invites, passkey: PASSKEY, startOpen: true }));
    });
    await typeLink(SHORT);
    await click('Continue');
    expect(text()).not.toContain('already connected');
  });
});

describe('W5-PASTE-ENTRY: "Someone invited you? Paste link"', () => {
  it('is a link to the paste screen, with no data in the address', async () => {
    await act(async () => {
      root.render(createElement(PasteEntryLink));
    });
    const a = host.querySelector('a');
    expect(a?.textContent).toBe('Someone invited you? Paste link');
    expect(a?.getAttribute('href')).toBe(PASTE_HREF);
    expect(PASTE_HREF).toBe('/contacts?paste');
  });

  it('the clipboard is read only on a click, and the link stays on this page', async () => {
    const readText = vi.fn(() => Promise.resolve(`Join me: ${SHORT}`));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { readText } });
    const fetchSpy = vi.fn(() => Promise.resolve(answer(404, {})));
    vi.stubGlobal('fetch', fetchSpy);
    const found = vi.fn();
    await act(async () => {
      root.render(createElement(ClipboardOffer, { onFound: found }));
    });
    // Mounting and focus read nothing while the owner has not turned the check on.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();
    expect(readText).not.toHaveBeenCalled();
    await click(F.pasteFromClipboard);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(found).toHaveBeenCalledWith(SHORT);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('on focus only after the one-time opt-in, and then only an AgentLink invite link counts', async () => {
    const readText = vi.fn(() => Promise.resolve('https://evil.example/i#2.AAAA'));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { readText } });
    const found = vi.fn();
    await act(async () => {
      root.render(createElement(ClipboardOffer, { onFound: found }));
    });
    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(box?.checked).toBe(false);
    await act(async () => {
      box?.click();
    });
    expect(localStorage.getItem(CLIPBOARD_OPT_IN_KEY)).toBe('on');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();
    expect(readText).toHaveBeenCalledTimes(1);
    expect(found).not.toHaveBeenCalled();
    readText.mockImplementation(() => Promise.resolve(SHORT));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();
    // An offer the owner chooses; nothing is checked or sent on its own.
    expect(found).not.toHaveBeenCalled();
    expect(text()).toContain(F.clipboardOffer);
    await click(F.useIt);
    expect(found).toHaveBeenCalledWith(SHORT);
  });
});
