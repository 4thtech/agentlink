// @vitest-environment jsdom
// W4-WIRE-2 (owner Decision 52 (3)): the Invite screen's small "Have an invite link? Paste it". A
// pasted short or long AgentLink link goes to the existing accept path (`POST /api/ui/invites/check`,
// then the friend's card with Accept with Touch ID, `POST /api/ui/invites/accept`); the page then
// shows the Connected moment (People). The pasted text is untrusted (I-5): only the AgentLink invite
// forms go on, nothing is navigated to, and the inviter's name is React text only.
import { lintVocabulary } from '@4thtech-io/ui';
import axe from 'axe-core';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcceptOutcome, CheckOutcome, InviteApi } from '../contacts/invite-api.js';
import type { PasskeyInfo, PresenceProof } from '../contacts/owner.js';
import { InviteScreen } from './invite-screen.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdE';
const SHORT = `https://agentlink.4thtech.io/i#2.${SECRET}`;
const LONG = `https://agentlink.4thtech.io/i#${'q1W2e3R4t5Y6u7I8o9P0_-'.repeat(20)}`;
const PASSKEY: PasskeyInfo = { credentialId: 'AQID', prfSalt: 'BwgJ' } as unknown as PasskeyInfo;
const PROOF: PresenceProof = { kind: 'passkey', body: new Uint8Array([1, 2, 3]) };

interface Fake extends InviteApi {
  checked: string[];
  accepted: { link: string; proof: PresenceProof }[];
}

function fakeInvites(
  check: CheckOutcome = {
    kind: 'ok',
    invite: { name: 'Ana', fingerprint: '7F3A·19C2', expiresAt: Date.UTC(2999, 0, 1) },
  },
  accept: AcceptOutcome = { kind: 'pending' },
): Fake {
  const checked: string[] = [];
  const accepted: { link: string; proof: PresenceProof }[] = [];
  return {
    checked,
    accepted,
    create: () => Promise.resolve({ kind: 'failed' }),
    cancel: () => Promise.resolve({ kind: 'cancelled' }),
    check: (link) => {
      checked.push(link);
      return Promise.resolve(check);
    },
    accept: (link, proof) => {
      accepted.push({ link, proof });
      return Promise.resolve(accept);
    },
  };
}

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  history.replaceState(null, '', '/contacts');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

interface Mounted {
  readonly invites: Fake;
  readonly connected: ReturnType<typeof vi.fn>;
  readonly gesture: ReturnType<typeof vi.fn>;
}

async function mount(
  o: { invites?: Fake; passkey?: PasskeyInfo | undefined; proof?: PresenceProof | undefined } = {},
): Promise<Mounted> {
  const invites = o.invites ?? fakeInvites();
  const connected = vi.fn();
  const gesture = vi.fn(() => Promise.resolve('proof' in o ? o.proof : PROOF));
  await act(async () => {
    root.render(
      createElement(InviteScreen, {
        invites,
        onDone: () => undefined,
        sender: 'Bo',
        paste: {
          passkey: 'passkey' in o ? o.passkey : PASSKEY,
          gesture,
          platform: 'mac',
          onConnected: connected,
        },
      } as Parameters<typeof InviteScreen>[0]),
    );
  });
  await settle();
  return { invites, connected, gesture };
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
function field(): HTMLTextAreaElement {
  const found = host.querySelector<HTMLTextAreaElement>('textarea[name="invite-link"]');
  if (found === null) throw new Error(`no paste field in: ${text()}`);
  return found;
}
async function paste(value: string): Promise<void> {
  const el = field();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function openAndPaste(value: string): Promise<void> {
  await click('Have an invite link? Paste it');
  await paste(value);
  await click('Continue');
}

describe('W4-WIRE-2: "Have an invite link? Paste it" on the Invite screen', () => {
  it('is one small secondary option that opens the field in place', async () => {
    await mount();
    const open = button('Have an invite link? Paste it');
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(open.className).not.toContain('al-btn-primary');
    expect(host.querySelector('textarea[name="invite-link"]')).toBeNull();
    await click('Have an invite link? Paste it');
    expect(button('Have an invite link? Paste it').getAttribute('aria-expanded')).toBe('true');
    const label = host.querySelector(`label[for="${field().id}"]`);
    expect(label?.textContent).toContain('Paste the invite link');
  });

  it.each([
    ['another host', 'https://evil.example/i#AAAA'],
    ['a look-alike host', `https://agentlink.4thtech.io.evil.example/i#2.${SECRET}`],
    ['plain http', `http://agentlink.4thtech.io/i#2.${SECRET}`],
    ['a script address', 'javascript:alert(1)'],
    ['another path', `https://agentlink.4thtech.io/x#2.${SECRET}`],
    ['a short link of the wrong size', `https://agentlink.4thtech.io/i#2.${SECRET}A`],
    ['two different links', `${SHORT} ${LONG}`],
    ['plain words', 'hello there'],
    // IR-W4-WIRE-2X-SEC-1: the same bound as the invite client (8 192 payload characters).
    ['a long link past the bound', `https://agentlink.4thtech.io/i#${'A'.repeat(8193)}`],
  ])('refuses %s here: no request and no navigation', async (_what, value) => {
    const { invites } = await mount();
    const before = location.href;
    vi.spyOn(window, 'open').mockImplementation(() => null);
    await openAndPaste(value);
    expect(invites.checked).toEqual([]);
    expect(location.href).toBe(before);
    expect(window.open).not.toHaveBeenCalled();
    expect(host.querySelector('.inv-paste [role="alert"]')?.textContent).toContain(
      "That isn't an AgentLink invite link.",
    );
  });

  it.each([
    ['the short link', SHORT, SHORT],
    ['the long link', LONG, LONG],
    ['the link without https://', SHORT.replace('https://', ''), SHORT],
    [
      'the whole shared message',
      `Let's connect our AI agents with AgentLink. Open this link and follow the steps; it works once, until 7 Nov 2026: ${SHORT}`,
      SHORT,
    ],
    ['the link with spaces around it', `  \n${SHORT}\n `, SHORT],
  ])('sends %s to the check as the link itself', async (_what, value, link) => {
    const { invites } = await mount();
    await openAndPaste(value);
    expect(invites.checked).toEqual([link]);
  });

  it("checked: the friend's card, then Accept with Touch ID sends the link with one proof", async () => {
    const { invites, connected, gesture } = await mount();
    await openAndPaste(SHORT);
    expect(text()).toContain('invites you to connect your AIs');
    expect(text()).toContain('Ana');
    expect(text()).toContain('7F3A·19C2');
    await click('Accept with Touch ID');
    expect(gesture).toHaveBeenCalledTimes(1);
    expect(invites.accepted).toEqual([{ link: SHORT, proof: PROOF }]);
    expect(connected).toHaveBeenCalledTimes(1);
    expect(String(connected.mock.calls[0]?.[0])).toContain('Ana');
  });

  it('Touch ID cancelled: nothing is sent and the card stays', async () => {
    const { invites, connected } = await mount({ proof: undefined });
    await openAndPaste(SHORT);
    await click('Accept with Touch ID');
    expect(invites.accepted).toEqual([]);
    expect(connected).not.toHaveBeenCalled();
    expect(text()).toContain('invites you to connect your AIs');
  });

  it('without a passkey here, Accept asks for the backup code', async () => {
    await mount({ passkey: undefined });
    await openAndPaste(SHORT);
    await click('Accept with your backup code');
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
  });

  it('a refused invite says why in plain words; Paste another link starts again', async () => {
    await mount({ invites: fakeInvites({ kind: 'refused', why: 'expired' }) });
    await openAndPaste(SHORT);
    expect(text()).toContain('This invite has expired.');
    await click('Paste another link');
    expect(field().value).toBe('');
  });

  it('Not now goes back to the field and sends nothing', async () => {
    const { invites } = await mount();
    await openAndPaste(SHORT);
    await click('Not now');
    expect(invites.accepted).toEqual([]);
    expect(host.querySelector('textarea[name="invite-link"]')).not.toBeNull();
  });

  it("the inviter's name is text only (I-5); the link is never in an attribute", async () => {
    const name = '<img src=x onerror=alert(1)>';
    await mount({
      invites: fakeInvites({
        kind: 'ok',
        invite: { name, fingerprint: '7F3A·19C2', expiresAt: Date.UTC(2999, 0, 1) },
      }),
    });
    await openAndPaste(SHORT);
    expect(host.querySelector('img')).toBeNull();
    // The name rule keeps markup out: the card names the inviter by the fingerprint instead.
    expect(text()).not.toContain('onerror');
    expect(text()).toContain('invites you to connect your AIs');
    for (const el of host.querySelectorAll('*')) {
      for (const attr of el.attributes) expect(attr.value).not.toContain(SECRET);
    }
  });

  it('axe finds nothing; the words pass lintVocabulary; motion only from the U0 kit', async () => {
    await mount();
    await click('Have an invite link? Paste it');
    const seen: string[] = [];
    const check = async (): Promise<void> => {
      const result = await axe.run(host, { rules: { region: { enabled: false } } });
      seen.push(...result.violations.map((v) => v.id));
    };
    await check();
    await paste(SHORT);
    await click('Continue');
    await check();
    expect(seen).toEqual([]);
    expect(lintVocabulary(text())).toEqual([]);
    expect(host.querySelector('[style*="animation"]')).toBeNull();
  });
});
