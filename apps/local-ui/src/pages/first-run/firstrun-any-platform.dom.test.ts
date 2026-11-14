// @vitest-environment jsdom
// FIRSTRUN-ANY-PLATFORM (owner test on real machines, 14 Nov; 08 §1 first run; 04 §2.2, §2.5;
// 11 §5): on a fresh profile, on any platform and in any browser (also Firefox, also the desktop
// app's own window), the person creates the master code in the app, with no terminal, no browser
// hand-off and no USB security key.
// - The master-code-only path makes no WebAuthn call at all (finish carries `presence: 'code'`).
// - Presence upgrades are optional and detected first: the desktop app's own Touch ID / Windows
//   Hello (the native bridge, `/api/owner/native`), else the browser's platform passkey with PRF.
//   Where that can't be told (or Windows can't say PRF), the master code comes first: a request
//   with PRF can end on Windows' "Insert your security key" dialog.
// - A cancelled or failed gesture always leaves the master code there.
// - Platform words come from SENSOR: never "Touch ID" on Windows.
import { act, createElement as h, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeStatus } from '../../presence/native-api.js';
import { DESKTOP_MARKER } from '../../presence/desktop.js';
import { resetAutoShown, resetWizard } from '../start/store.js';
import { CONNECT_STEP } from '../start/strings.js';
import { createAppsApi, type AppsApi } from './apps-api.js';
import { FirstRunPage, type FirstRunPageProps } from './index.js';
import { encodeRegistration, setupChoice, type PrfSupport } from './passkey.js';
import {
  FINISH_PATH,
  createSetupApi,
  type CreationValues,
  type FinishResult,
  type SetupApi,
} from './setup-api.js';
import { FIRST_RUN, NAME, SETUP_MESSAGES, type Platform } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = 'ABCD EFGH IJKL MNOP QRST UVWX';
const VALUES: CreationValues = {
  rpId: 'localhost',
  rpName: 'AgentLink',
  userId: 'AQID',
  userName: 'AgentLink owner',
  challenge: 'BAUG',
  prfSalt: 'BwgJ',
};
const BODY = encodeRegistration([
  new Uint8Array([1, 2]),
  new Uint8Array(55),
  new Uint8Array([123, 125]),
  new Uint8Array(32).fill(9),
]);
const MAC_APP = `Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/130 ${DESKTOP_MARKER}`;
const WIN_APP = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 ${DESKTOP_MARKER}`;

function done(passkey: boolean): FinishResult {
  return {
    kind: 'done',
    confirmed: true,
    passkey,
    ownerCode: CODE,
    fingerprint: '7F3A·19C2',
    sendFolder: 'allowed',
    computerName: 'Surface',
  };
}

interface Calls {
  finished: number;
  codeOnly: string[];
}

function fakeApi(): SetupApi & Calls {
  const calls: Calls = { finished: 0, codeOnly: [] };
  return Object.assign(calls, {
    status: () => Promise.resolve({ kind: 'ok', owner: 'missing' } as const),
    labelCheck: () => Promise.resolve({ kind: 'ok' } as const),
    begin: () =>
      Promise.resolve({ kind: 'ready', publicKey: VALUES, nonce: 'N'.repeat(43) } as const),
    finish: () => {
      calls.finished += 1;
      return Promise.resolve(done(true));
    },
    finishCode: (nonce: string) => {
      calls.codeOnly.push(nonce);
      return Promise.resolve(done(false));
    },
  });
}

const NO_APPS: AppsApi = {
  ...createAppsApi({ fetch: () => Promise.reject(new TypeError('not used')), token: 't' }),
  list: () => Promise.resolve({ kind: 'ok', apps: [], desktopRunning: false }),
  currentAgent: () => Promise.resolve({ kind: 'none' }),
};

let host: HTMLElement;
let root: Root;
/** navigator.credentials as the page would reach it: every call is recorded. */
let webauthn: { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };

beforeEach(() => {
  localStorage.clear();
  resetWizard();
  resetAutoShown();
  history.replaceState(null, '', '/start/app');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  webauthn = {
    create: vi.fn(() => Promise.reject(new DOMException('no', 'NotAllowedError'))),
    get: vi.fn(() => Promise.reject(new DOMException('no', 'NotAllowedError'))),
  };
  Object.defineProperty(navigator, 'credentials', { value: webauthn, configurable: true });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
const text = (): string => host.textContent ?? '';
const h1 = (): string => host.querySelector('h1')?.textContent ?? '';
const buttons = (): string[] =>
  [...host.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
function button(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  if (found === undefined) throw new Error(`no button ${name}: ${text()}`);
  return found;
}
async function click(name: string): Promise<void> {
  await act(async () => {
    button(name).click();
    await Promise.resolve();
  });
  await settle();
}
async function nameIt(value = 'Ana'): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[name="agent-name"]');
  if (input === null || input.value !== '') return;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Mounts first run and goes on to step 2 ("Confirm it's you") with a name typed. */
async function mount(
  extra: Partial<FirstRunPageProps> & { platform: Platform },
): Promise<{ api: SetupApi & Calls; passkeys: { platform: boolean }[] }> {
  const api = fakeApi();
  const passkeys: { platform: boolean }[] = [];
  await act(async () => {
    const props: FirstRunPageProps = {
      api,
      appsApi: NO_APPS,
      goHome: vi.fn(),
      createPasskey: (_v, options) => {
        passkeys.push({ platform: options.platform });
        return Promise.resolve({ kind: 'ok', body: BODY.slice() });
      },
      passkeysAvailable: () => true,
      prfSupport: () => Promise.resolve('yes'),
      readJoin: () => Promise.resolve({ kind: 'failed' }),
      native: { userAgent: 'Mozilla/5.0 (browser)' },
      ...extra,
    };
    root.render(h(FirstRunPage as ComponentType<FirstRunPageProps>, props));
  });
  await settle();
  const next = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.trim().startsWith('Continue with'),
  );
  if (next !== undefined) {
    await act(async () => {
      next.click();
      await Promise.resolve();
    });
    await settle();
    await nameIt();
  }
  return { api, passkeys };
}

describe('FIRSTRUN-ANY-PLATFORM: what is offered, decided before anything is asked', () => {
  it('setupChoice: native first; a platform passkey with PRF next; else the master code', () => {
    const c = (platform: Platform, prf: PrfSupport, passkeys = true, native = false) =>
      setupChoice({ platform, prf, passkeys, native });
    // The desktop app's own Touch ID / Windows Hello: the master code now, the bridge right after.
    expect(c('mac', 'yes', false, true)).toEqual({ primary: 'native', passkeyOffered: false });
    expect(c('windows', 'no', false, true)).toEqual({ primary: 'native', passkeyOffered: false });
    // Mac: Touch ID in the browser when it says (or can't say) PRF; never without passkeys.
    expect(c('mac', 'yes')).toEqual({ primary: 'passkey', passkeyOffered: true });
    expect(c('mac', 'unknown')).toEqual({ primary: 'passkey', passkeyOffered: true });
    expect(c('mac', 'no')).toEqual({ primary: 'code', passkeyOffered: false });
    expect(c('mac', 'yes', false)).toEqual({ primary: 'code', passkeyOffered: false });
    // Windows: the master code first (a PRF request can end on the USB-key dialog); Windows Hello
    // in the browser only as the alternative, and only when the browser says PRF works.
    expect(c('windows', 'yes')).toEqual({ primary: 'code', passkeyOffered: true });
    expect(c('windows', 'unknown')).toEqual({ primary: 'code', passkeyOffered: false });
    expect(c('windows', 'no')).toEqual({ primary: 'code', passkeyOffered: false });
    // Linux and the rest: a passkey only when the browser says it works here.
    expect(c('other', 'yes')).toEqual({ primary: 'passkey', passkeyOffered: true });
    expect(c('other', 'unknown')).toEqual({ primary: 'code', passkeyOffered: false });
  });
});

describe('FIRSTRUN-ANY-PLATFORM: the master code path makes no WebAuthn call', () => {
  it('Windows without Windows Hello for AgentLink (no PRF): master code, no passkey, no create', async () => {
    const { api, passkeys } = await mount({
      platform: 'windows',
      prfSupport: () => Promise.resolve('no'),
    });
    expect(text()).not.toContain('Touch ID');
    expect(host.querySelectorAll('.al-btn-primary')).toHaveLength(1);
    await click(FIRST_RUN.backupOnly);
    expect(passkeys).toEqual([]);
    expect(webauthn.create).not.toHaveBeenCalled();
    expect(webauthn.get).not.toHaveBeenCalled();
    expect(api.finished).toBe(0);
    expect(api.codeOnly).toEqual(['N'.repeat(43)]);
    expect(h1()).toBe(FIRST_RUN.backupTitle);
    expect(text()).toContain(FIRST_RUN.doneNoPasskeyBody);
  });

  it('Windows where PRF is unknown: the master code is the default, no security-key dialog', async () => {
    const { api, passkeys } = await mount({
      platform: 'windows',
      prfSupport: () => Promise.resolve('unknown'),
    });
    expect(button(FIRST_RUN.backupOnly).className).toContain('al-btn-primary');
    expect(buttons()).not.toContain(FIRST_RUN.passkeyInstead('Windows Hello'));
    await click(FIRST_RUN.backupOnly);
    expect(passkeys).toEqual([]);
    expect(api.codeOnly).toHaveLength(1);
  });

  it('Windows where the browser says PRF works: Windows Hello is offered, never the default', async () => {
    const { api, passkeys } = await mount({ platform: 'windows' });
    expect(button(FIRST_RUN.backupOnly).className).toContain('al-btn-primary');
    await click(FIRST_RUN.passkeyInstead('Windows Hello'));
    // Only ever the platform authenticator: never "any passkey" (the USB security key).
    expect(passkeys).toEqual([{ platform: true }]);
    expect(api.finished).toBe(1);
    expect(api.codeOnly).toEqual([]);
  });

  it('the real browser detection and passkey helper: no platform authenticator, no create call', async () => {
    (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = Object.assign(
      function PublicKeyCredential() {},
      { isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(false) },
    );
    const props: Partial<FirstRunPageProps> = { platform: 'windows' };
    // The defaults: passkeysAvailable, prfSupport and createSetupPasskey of the browser.
    const { api } = await mount({
      ...props,
      platform: 'windows',
      passkeysAvailable: undefined as never,
      prfSupport: undefined as never,
      createPasskey: undefined as never,
    });
    await click(FIRST_RUN.backupOnly);
    expect(webauthn.create).not.toHaveBeenCalled();
    expect(webauthn.get).not.toHaveBeenCalled();
    expect(api.codeOnly).toHaveLength(1);
  });

  it('Mac with Touch ID in the browser: "Use your master code instead" sends no passkey', async () => {
    const { api, passkeys } = await mount({ platform: 'mac' });
    expect(button(CONNECT_STEP.connect('Touch ID')).className).toContain('al-btn-primary');
    await click(NAME.backupInstead);
    expect(passkeys).toEqual([]);
    expect(webauthn.create).not.toHaveBeenCalled();
    expect(api.codeOnly).toHaveLength(1);
    expect(h1()).toBe(FIRST_RUN.backupTitle);
  });

  it('a browser that cannot make a passkey (Firefox profile, the app window): master code, no terminal', async () => {
    const { api } = await mount({ platform: 'other', passkeysAvailable: () => false });
    expect(h1()).toBe(CONNECT_STEP.title);
    expect(text()).not.toContain("can't make a passkey");
    expect(text()).not.toMatch(/owner init|terminal|Chrome, Edge or Safari/);
    await click(FIRST_RUN.backupOnly);
    expect(api.codeOnly).toHaveLength(1);
    expect(h1()).toBe(FIRST_RUN.backupTitle);
  });

  it('a cancelled passkey keeps both ways: Try again, and the master code (no second create)', async () => {
    const api = fakeApi();
    let asked = 0;
    await mount({
      platform: 'mac',
      api,
      createPasskey: () => {
        asked += 1;
        return Promise.resolve({ kind: 'cancelled' });
      },
    });
    await click(CONNECT_STEP.connect('Touch ID'));
    expect(text()).toContain(SETUP_MESSAGES.cancelled);
    expect(buttons()).toContain(FIRST_RUN.tryAgain);
    expect(buttons()).toContain(NAME.backupInstead);
    expect(buttons()).toContain(CONNECT_STEP.back);
    await click(NAME.backupInstead);
    expect(asked).toBe(1);
    expect(api.codeOnly).toHaveLength(1);
    expect(h1()).toBe(FIRST_RUN.backupTitle);
  });

  it('a passkey the browser refuses (unsupported) falls back to the master code, never a dead end', async () => {
    const { api } = await mount({
      platform: 'mac',
      createPasskey: () => Promise.resolve({ kind: 'unsupported' }),
    });
    await click(CONNECT_STEP.connect('Touch ID'));
    expect(text()).not.toContain("can't make a passkey");
    expect(button(FIRST_RUN.backupOnly).className).toContain('al-btn-primary');
    await click(FIRST_RUN.backupOnly);
    expect(api.codeOnly).toHaveLength(1);
  });
});

describe('FIRSTRUN-ANY-PLATFORM: the desktop app uses its own Touch ID / Windows Hello', () => {
  it('Mac app: master code first, then "Turn on Touch ID for approvals" through the bridge', async () => {
    const registered: string[] = [];
    const status = vi.fn((): Promise<NativeStatus> =>
      Promise.resolve({ available: true, registered: false }),
    );
    const { api, passkeys } = await mount({
      platform: 'mac',
      passkeysAvailable: () => false,
      prfSupport: () => Promise.resolve('no'),
      native: {
        userAgent: MAC_APP,
        status,
        register: (code) => {
          registered.push(code);
          return Promise.resolve({ kind: 'registered' });
        },
      },
    });
    // No "doesn't work in this browser" in the app's own window.
    expect(text()).not.toContain(FIRST_RUN.noPrf('Touch ID', 'Safari'));
    expect(text()).toContain(FIRST_RUN.nativeNext('Touch ID'));
    await click(FIRST_RUN.backupOnly);
    expect(passkeys).toEqual([]);
    expect(webauthn.create).not.toHaveBeenCalled();
    expect(api.codeOnly).toHaveLength(1);
    expect(h1()).toBe(FIRST_RUN.backupTitle);
    await click('Turn on Touch ID for approvals');
    expect(registered).toEqual([CODE]);
    expect(status).toHaveBeenCalled();
  });

  it('regression (owner, 14 Nov): desktop shell, no owner, WebAuthn unavailable → master-code step, no dead end', async () => {
    // The app's own window: no PublicKeyCredential, and the helper not reachable either.
    for (const native of [
      {
        userAgent: MAC_APP,
        status: () => Promise.resolve({ available: false, registered: false }),
      },
      { userAgent: MAC_APP, status: () => Promise.resolve({ available: true, registered: false }) },
    ]) {
      const { api } = await mount({
        platform: 'mac',
        passkeysAvailable: undefined as never,
        prfSupport: undefined as never,
        createPasskey: undefined as never,
        native,
      });
      expect(h1()).toBe(CONNECT_STEP.title);
      expect(text()).not.toContain("can't make a passkey");
      expect(text()).not.toMatch(/Chrome, Edge or Safari|owner init|terminal/);
      // No owner yet: there is no Home to skip to.
      expect(host.querySelector('a.st-skip')).toBeNull();
      expect(buttons()).toContain(CONNECT_STEP.back);
      await click(FIRST_RUN.backupOnly);
      expect(webauthn.create).not.toHaveBeenCalled();
      expect(api.codeOnly).toHaveLength(1);
      expect(h1()).toBe(FIRST_RUN.backupTitle);
      act(() => root.unmount());
      root = createRoot(host);
      resetWizard();
      history.replaceState(null, '', '/start/app');
    }
  });

  it('no owner: step 1 has no "Skip to Home" either, also before the platform check answers', async () => {
    let answer: (value: PrfSupport) => void = () => undefined;
    await act(async () => {
      root.render(
        h(FirstRunPage as ComponentType<FirstRunPageProps>, {
          api: fakeApi(),
          appsApi: NO_APPS,
          platform: 'mac',
          passkeysAvailable: () => true,
          prfSupport: () => new Promise<PrfSupport>((resolve) => (answer = resolve)),
          native: {
            userAgent: MAC_APP,
            status: () => Promise.resolve({ available: false, registered: false }),
          },
          readJoin: () => Promise.resolve({ kind: 'failed' } as const),
        }),
      );
    });
    await settle();
    // The link is not there to use (its room is kept, hidden from everyone).
    expect(host.querySelector('a.st-skip')).toBeNull();
    answer('no');
    await settle();
    expect(host.querySelector('a.st-skip')).toBeNull();
  });

  it('Windows app with the helper unavailable: master code, no Touch ID word, no USB key', async () => {
    const { api, passkeys } = await mount({
      platform: 'windows',
      prfSupport: () => Promise.resolve('unknown'),
      native: {
        userAgent: WIN_APP,
        status: () => Promise.resolve({ available: false, registered: false }),
      },
    });
    expect(text()).not.toContain('Touch ID');
    await click(FIRST_RUN.backupOnly);
    expect(passkeys).toEqual([]);
    expect(api.codeOnly).toHaveLength(1);
    expect(text()).not.toContain('Turn on Windows Hello for approvals');
  });
});

describe('FIRSTRUN-ANY-PLATFORM: platform words', () => {
  it('the step text names the platform sensor (SENSOR), never Touch ID on Windows', () => {
    expect(CONNECT_STEP.body('Claude Code', 'Windows Hello')).toContain('Windows Hello');
    expect(CONNECT_STEP.body('Claude Code', 'Windows Hello')).not.toContain('Touch ID');
    expect(CONNECT_STEP.bodyConnect('Cursor', 'work', 'your passkey')).not.toContain('Touch ID');
    expect(CONNECT_STEP.body('Claude Code', 'Touch ID')).toContain('Touch ID');
  });

  it('a Windows first run never says Touch ID, on the step or after setup', async () => {
    await mount({ platform: 'windows', prfSupport: () => Promise.resolve('no') });
    expect(text()).not.toContain('Touch ID');
    await click(FIRST_RUN.backupOnly);
    expect(text()).not.toContain('Touch ID');
  });
});

describe('FIRSTRUN-ANY-PLATFORM: the setup API', () => {
  it('finishCode sends {nonce, presence: "code"} with an empty body to finish', async () => {
    const seen: { path: string; input: unknown; size: number }[] = [];
    const api = createSetupApi({
      token: 't',
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        const raw = headers.get('X-AgentLink-Input') ?? '';
        const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
        const json = new TextDecoder().decode(
          Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) =>
            c.charCodeAt(0),
          ),
        );
        seen.push({
          path: String(input),
          input: JSON.parse(json),
          size: (init?.body as Uint8Array | undefined)?.length ?? -1,
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: 'done',
              passkey: false,
              ownerCode: CODE,
              fingerprint: '7F3A·19C2',
              computerName: 'Surface',
            }),
            { status: 200 },
          ),
        );
      },
    });
    const result = await api.finishCode('N'.repeat(43));
    expect(seen).toEqual([
      { path: FINISH_PATH, input: { nonce: 'N'.repeat(43), presence: 'code' }, size: 0 },
    ]);
    expect(result.kind).toBe('done');
  });
});
