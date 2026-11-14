// @vitest-environment jsdom
// APP-CONTINUITY (owner requirement 14 Nov; 08 §1 "One AgentLink, browser or app"; 04 §2.5): inside
// the desktop app's window NOTHING falls back to WebAuthn. The app's window can't use a passkey made
// in the browser (and on Windows a WebAuthn call there can end on "Insert your security key"), so
// every owner-presence prompt offers the app's own Touch ID / Windows Hello once it is on, else the
// master code, with a way to turn the native one on. In a browser the passkey stays as it was.
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerClient, PasskeyInfo, PresenceProof } from '../pages/contacts/owner.js';
import { PresenceButton } from '../pages/contacts/presence-button.js';
import { PresencePrompt } from '../pages/contacts/presence-prompt.js';
import { OwnerPanel } from '../pages/approvals/index.js';
import { DESKTOP_MARKER } from './desktop.js';
import type { NativeStatus } from './native-api.js';
import { desktopPresenceOffer } from './offer.js';
import { pageCredentials, webAuthnHere } from './webauthn-here.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAC_APP = `Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/130 ${DESKTOP_MARKER}`;
const WIN_APP = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 ${DESKTOP_MARKER}`;
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/130';
const PASSKEY: PasskeyInfo = { credentialId: 'Y3JlZA', prfSalt: 'c2FsdA' };
const OFF: NativeStatus = { available: true, registered: false };
const ON: NativeStatus = { available: true, registered: true };

let host: HTMLElement;
let root: Root;
let webauthn: { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
let ua = MAC_APP;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  webauthn = {
    create: vi.fn(() => Promise.reject(new DOMException('no', 'NotAllowedError'))),
    get: vi.fn(() => Promise.reject(new DOMException('no', 'NotAllowedError'))),
  };
  Object.defineProperty(navigator, 'credentials', { value: webauthn, configurable: true });
  (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = function PublicKeyCredential() {};
  ua = MAC_APP;
  Object.defineProperty(navigator, 'userAgent', { get: () => ua, configurable: true });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
  await settle();
}
const labels = (): string[] =>
  [...host.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
async function click(label: string): Promise<void> {
  const found = [...host.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label,
  );
  if (found === undefined) throw new Error(`no button "${label}" in: ${labels().join(' | ')}`);
  await act(async () => {
    found.click();
  });
  await settle();
}
const codeFields = (): number => host.querySelectorAll('input[type="password"]').length;
const noWebAuthn = (): void => {
  expect(webauthn.get).not.toHaveBeenCalled();
  expect(webauthn.create).not.toHaveBeenCalled();
};

describe('the page offer inside the desktop app (offer.ts)', () => {
  it('native once it is on; else the master code with plain help; never the passkey', () => {
    expect(desktopPresenceOffer('mac', ON)).toEqual({ kind: 'native' });
    expect(desktopPresenceOffer('windows', ON)).toEqual({ kind: 'native' });
    for (const status of [
      OFF,
      { available: false, registered: false },
      { available: true, registered: true, reason: 'reregister' as const },
      { available: true, registered: true, reason: 'other_owner' as const },
    ]) {
      const offer = desktopPresenceOffer('mac', status);
      expect(offer.kind).toBe('code');
      if (offer.kind === 'code') expect(offer.help).not.toMatch(/passkey|security key/i);
    }
  });

  it('webAuthnHere / pageCredentials: none in the app window, the browser’s otherwise', () => {
    expect(webAuthnHere(MAC_APP)).toBe(false);
    expect(webAuthnHere(WIN_APP)).toBe(false);
    expect(pageCredentials(MAC_APP)).toBeUndefined();
    expect(webAuthnHere(BROWSER)).toBe(true);
    expect(pageCredentials(BROWSER)).toBe(webauthn);
  });
});

describe('presence prompts in the desktop app never call navigator.credentials', () => {
  it('PresencePrompt with a passkey known and Touch ID off: the master code, no passkey button', async () => {
    const sent: PresenceProof[] = [];
    await render(
      h(PresencePrompt, {
        summary: 'Remove Ana',
        passkey: PASSKEY,
        busy: false,
        error: undefined,
        onSubmit: (p: PresenceProof) => sent.push(p),
        onCancel: () => undefined,
        passkeyStatus: () => Promise.resolve({ kind: 'ready', info: PASSKEY }),
        nativeStatus: () => Promise.resolve(OFF),
      }),
    );
    expect(codeFields()).toBe(1);
    expect(labels().some((l) => /passkey/i.test(l))).toBe(false);
    noWebAuthn();
  });

  it('PresencePrompt without a passkey given: the server’s passkey is not used in the app', async () => {
    await render(
      h(PresencePrompt, {
        summary: 'Remove Ana',
        passkey: undefined,
        busy: false,
        error: undefined,
        onSubmit: () => undefined,
        onCancel: () => undefined,
        passkeyStatus: () => Promise.resolve({ kind: 'ready', info: PASSKEY }),
        nativeStatus: () => Promise.resolve(OFF),
      }),
    );
    expect(codeFields()).toBe(1);
    noWebAuthn();
  });

  it('PresencePrompt with Touch ID on: "Use Touch ID" is the confirm (native proof)', async () => {
    const sent: PresenceProof[] = [];
    await render(
      h(PresencePrompt, {
        summary: 'Remove Ana',
        passkey: PASSKEY,
        busy: false,
        error: undefined,
        onSubmit: (p: PresenceProof) => sent.push(p),
        onCancel: () => undefined,
        nativeStatus: () => Promise.resolve(ON),
      }),
    );
    await click('Use Touch ID');
    expect(sent).toEqual([{ kind: 'native' }]);
    noWebAuthn();
  });

  it('PresenceButton (approvals, contacts, settings) with a passkey known and Windows Hello off: the code', async () => {
    ua = WIN_APP;
    const owner: OwnerClient = {
      passkey: () => Promise.resolve(PASSKEY),
      post: () => Promise.reject(new Error('never')),
    };
    const gesture = vi.fn(() => Promise.resolve(undefined));
    await render(
      h(PresenceButton, {
        withSensor: (s: string) => `Save with ${s}`,
        withCode: 'Save with your master code',
        statement: 'Save the rules',
        busy: false,
        notUsed: 'Not used',
        onProof: () => undefined,
        owner,
        gesture,
        nativeStatus: () => Promise.resolve(OFF),
      }),
    );
    expect(labels()).toContain('Save with your master code');
    await click('Save with your master code');
    expect(codeFields()).toBe(1);
    expect(gesture).not.toHaveBeenCalled();
    noWebAuthn();
  });

  it('in a browser the passkey is still offered (no change there)', async () => {
    ua = BROWSER;
    const owner: OwnerClient = {
      passkey: () => Promise.resolve(PASSKEY),
      post: () => Promise.reject(new Error('never')),
    };
    await render(
      h(PresenceButton, {
        withSensor: (s: string) => `Save with ${s}`,
        withCode: 'Save with your master code',
        statement: 'Save the rules',
        busy: false,
        notUsed: 'Not used',
        onProof: () => undefined,
        owner,
        platform: 'mac',
      }),
    );
    expect(labels()).toContain('Save with Touch ID');
  });
});

describe('Home and Approvals in the app: an owner without Touch ID on is offered it once', () => {
  it('OwnerPanel in the app (no slot given) offers "Turn on Touch ID", which opens its setting', async () => {
    history.replaceState(null, '', '/');
    await render(
      h(OwnerPanel, {
        owner: { ready: true, offered: true },
        canPasskey: false,
        desktop: true,
        nativeStatus: () => Promise.resolve(OFF),
      }),
    );
    await click('Turn on Touch ID');
    expect(location.pathname).toBe('/settings/touch-id');
    noWebAuthn();
  });
});
