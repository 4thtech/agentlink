// @vitest-environment jsdom
// M1-UX-FIRSTRUN-V2-c acceptance, page side (B-9; 08 §1 first run v2; 04 §2.5; 11 §5.5, §6.2.1):
// - an owner set up before 0.3.0 (owner exists, no passkey) gets "Switch to Touch ID" on the
//   first-run page: the backup code once, then one passkey gesture; never owner setup again;
// - the code goes only into the one registration body (`/api/owner/passkey`, the existing owner
//   operation that checks it); never into a URL, the page text, a log or another request;
// - a wrong code, a wait, a cancelled gesture and a passkey without PRF are explained in plain
//   words and change nothing; the backup code keeps working afterwards (the copy says so);
// - every app page shows the "Switch to Touch ID" next step until a passkey is registered.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Layout } from '../../layout/index.js';
import { SwitchToPasskeyBanner } from '../../states/index.js';
import { EARLIER_OWNER_CODE_HINT } from '../../strings.js';
import { FirstRunPage, type FirstRunPageProps } from './index.js';
import { encodeRegistration, encodeUpgradeBody } from './passkey.js';
import {
  PASSKEY_PATH,
  createUpgradeApi,
  type PasskeyInfoResult,
  type SetupApi,
  type UpgradeApi,
  type UpgradeResult,
  type UpgradeValues,
} from './setup-api.js';
import { UPGRADE, UPGRADE_MESSAGES } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = 'ABCD EFGH IJKL MNOP QRST UVWX';
const VALUES: UpgradeValues = { rpId: 'localhost', userId: 'AQID', prfSalt: 'BwgJ' };
/** An assertion body as the passkey helper returns it (credential, auth data, handle, PRF). */
const ASSERTION = encodeRegistration([
  new Uint8Array([1, 2]),
  new Uint8Array(37).fill(5),
  new Uint8Array([1, 2, 3]),
  new Uint8Array(32).fill(9),
]);

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
  vi.restoreAllMocks();
});

/** The setup API of an owner who exists already: setup itself must never be called. */
function existingOwner(): SetupApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    status: () => Promise.resolve({ kind: 'ok', owner: 'set_up' }),
    begin: () => {
      calls.push('begin');
      return Promise.resolve({ kind: 'owner_exists' });
    },
    finish: () => {
      calls.push('finish');
      return Promise.resolve({ kind: 'owner_exists' });
    },
  };
}

function fakeUpgrade(
  options: { info?: PasskeyInfoResult; answers?: UpgradeResult[] } = {},
): UpgradeApi & { bodies: Uint8Array[]; originals: Uint8Array[] } {
  const bodies: Uint8Array[] = [];
  const originals: Uint8Array[] = [];
  const answers = [...(options.answers ?? [{ kind: 'registered' }])];
  return {
    bodies,
    originals,
    info: () => Promise.resolve(options.info ?? { kind: 'ok', registered: false, values: VALUES }),
    register: (body) => {
      originals.push(body);
      bodies.push(body.slice());
      return Promise.resolve(answers.shift() ?? { kind: 'registered' });
    },
  };
}

type Made = Awaited<ReturnType<NonNullable<FirstRunPageProps['createUpgradePasskey']>>>;

async function mount(
  upgrade: UpgradeApi,
  extra: Partial<FirstRunPageProps> = {},
  made: () => Made = () => ({ kind: 'ok', body: ASSERTION.slice() }),
): Promise<{ api: ReturnType<typeof existingOwner>; gestures: { platform: boolean }[] }> {
  const api = existingOwner();
  const gestures: { platform: boolean }[] = [];
  await act(async () => {
    const props: FirstRunPageProps = {
      api,
      upgradeApi: upgrade,
      createUpgradePasskey: (_values, options) => {
        gestures.push({ platform: options.platform });
        return Promise.resolve(made());
      },
      createPasskey: () => Promise.reject(new Error('setup must not run for an existing owner')),
      passkeysAvailable: () => true,
      platform: 'mac',
      prfSupport: () => Promise.resolve('yes'),
      ...extra,
    };
    root.render(h(FirstRunPage as ComponentType<FirstRunPageProps>, props));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { api, gestures };
}

function codeInput(): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>('input[name="backup-code"]');
  if (input === null) throw new Error(`no backup code field: ${host.textContent ?? ''}`);
  return input;
}

function typeCode(value: string): void {
  const input = codeInput();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(): Promise<void> {
  const form = codeInput().form;
  if (form === null) throw new Error('the backup code field is not in a form');
  await act(async () => {
    form.requestSubmit();
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const heading = (): string => host.querySelector('h1')?.textContent ?? '';
const text = (): string => host.textContent ?? '';

describe('switch to Touch ID on the first-run page (M1-UX-FIRSTRUN-V2-c, B-9)', () => {
  it('offers the switch to an owner without a passkey, never owner setup', async () => {
    const { api } = await mount(fakeUpgrade());
    expect(heading()).toBe(UPGRADE.title('mac'));
    expect(text()).toContain(UPGRADE.body('Touch ID'));
    const input = codeInput();
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('current-password');
    expect(host.querySelector('label')?.textContent).toContain(UPGRADE.codeLabel);
    expect(host.querySelector('button[type="submit"]')?.textContent).toBe('Use Touch ID');
    expect(api.calls).toEqual([]);
  });

  it('shows "already protected" when a passkey is registered', async () => {
    await mount(fakeUpgrade({ info: { kind: 'ok', registered: true, values: VALUES } }));
    expect(heading()).toBe('Approvals are already protected on this computer');
    expect(host.querySelector('input[name="backup-code"]')).toBeNull();
  });

  it('names the platform: Windows Hello, or a passkey elsewhere', async () => {
    await mount(fakeUpgrade(), { platform: 'windows' });
    expect(heading()).toBe('Switch to Windows Hello');
    expect(host.querySelector('button[type="submit"]')?.textContent).toBe('Use Windows Hello');
    act(() => root.unmount());
    root = createRoot(host);
    await mount(fakeUpgrade(), { platform: 'other' });
    expect(heading()).toBe('Switch to a passkey');
  });

  it('asks for the code before the gesture: an empty field starts nothing', async () => {
    const upgrade = fakeUpgrade();
    const { gestures } = await mount(upgrade);
    await submit();
    expect(text()).toContain(UPGRADE_MESSAGES.empty);
    expect(gestures).toEqual([]);
    expect(upgrade.bodies).toEqual([]);
  });

  it('one code entry and one gesture register the passkey; the code leaves the page', async () => {
    const upgrade = fakeUpgrade();
    const { api, gestures } = await mount(upgrade);
    typeCode(CODE);
    await submit();
    expect(gestures).toEqual([{ platform: true }]);
    expect(upgrade.bodies).toHaveLength(1);
    // The body: the code (16-bit length first), then the assertion, as the server parses it.
    const code = new TextEncoder().encode(CODE);
    expect(upgrade.bodies[0]).toEqual(encodeUpgradeBody(code, ASSERTION));
    // The page zeroes its own copy once it is sent.
    expect(upgrade.originals[0]?.every((b) => b === 0)).toBe(true);
    expect(heading()).toBe(UPGRADE.doneTitle('mac'));
    expect(text()).toContain(UPGRADE.doneBody('Touch ID'));
    // The backup code keeps working; the page says so, and the code is gone from the DOM.
    expect(host.querySelector('input')).toBeNull();
    expect(text()).not.toContain(CODE);
    expect(host.innerHTML).not.toContain(CODE);
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent === UPGRADE.toApprovals);
    expect(link?.getAttribute('href')).toBe('/');
    expect(api.calls).toEqual([]);
  });

  it('a wrong code changes nothing, clears the field and lets the owner try again', async () => {
    const upgrade = fakeUpgrade({
      answers: [{ kind: 'error', problem: 'presence_rejected' }, { kind: 'registered' }],
    });
    await mount(upgrade);
    typeCode('WRONG CODE');
    await submit();
    expect(text()).toContain(UPGRADE_MESSAGES.presence_rejected);
    expect(heading()).toBe(UPGRADE.title('mac'));
    expect(codeInput().value).toBe('');
    typeCode(CODE);
    await submit();
    expect(heading()).toBe(UPGRADE.doneTitle('mac'));
  });

  it('after too many wrong codes the owner is asked to wait (the server backoff)', async () => {
    await mount(fakeUpgrade({ answers: [{ kind: 'error', problem: 'wait', retryAfter: 30 }] }));
    typeCode(CODE);
    await submit();
    expect(text()).toContain(UPGRADE_MESSAGES.wait(30));
    expect(codeInput().value).toBe('');
  });

  it('a cancelled gesture sends nothing and keeps the typed code for another try', async () => {
    const upgrade = fakeUpgrade();
    await mount(upgrade, {}, () => ({ kind: 'cancelled' }));
    typeCode(CODE);
    await submit();
    expect(upgrade.bodies).toEqual([]);
    expect(text()).toContain(UPGRADE_MESSAGES.cancelled);
    expect(codeInput().value).toBe(CODE);
  });

  it('a passkey without PRF sends nothing and says the backup code keeps working', async () => {
    const upgrade = fakeUpgrade();
    await mount(upgrade, {}, () => ({ kind: 'unsupported' }));
    typeCode(CODE);
    await submit();
    expect(upgrade.bodies).toEqual([]);
    expect(text()).toContain(UPGRADE_MESSAGES.unsupported('Safari'));
    expect(codeInput().value).toBe('');
  });

  it('where the browser reports no PRF it names a browser that works, and asks any passkey', async () => {
    const upgrade = fakeUpgrade();
    const { gestures } = await mount(upgrade, { prfSupport: () => Promise.resolve('no') });
    expect(text()).toContain(UPGRADE.noPrf('Touch ID', 'Safari'));
    expect(host.querySelector('button[type="submit"]')?.textContent).toBe('Use a passkey');
    typeCode(CODE);
    await submit();
    expect(gestures).toEqual([{ platform: false }]);
  });

  it('a passkey registered meanwhile shows "already protected"', async () => {
    await mount(fakeUpgrade({ answers: [{ kind: 'error', problem: 'passkey_exists' }] }));
    typeCode(CODE);
    await submit();
    expect(heading()).toBe('Approvals are already protected on this computer');
  });

  it('uses only plain words (11 §5.1) and never calls the code a password', async () => {
    await mount(fakeUpgrade());
    expect(lintVocabulary(text())).toEqual([]);
    const all = [
      UPGRADE.title('mac'),
      UPGRADE.body('Touch ID'),
      UPGRADE.codeLabel,
      UPGRADE.noPrf('Touch ID', 'Safari'),
      UPGRADE.doneTitle('mac'),
      UPGRADE.doneBody('Touch ID'),
      UPGRADE.toApprovals,
      UPGRADE.bannerTitle('mac'),
      UPGRADE.bannerBody,
      UPGRADE.bannerAction('mac'),
      UPGRADE_MESSAGES.empty,
      UPGRADE_MESSAGES.presence_rejected,
      UPGRADE_MESSAGES.presence_required,
      UPGRADE_MESSAGES.cancelled,
      UPGRADE_MESSAGES.unsupported('Safari'),
      UPGRADE_MESSAGES.failed,
      UPGRADE_MESSAGES.wait(5),
    ].join('\n');
    expect(lintVocabulary(all)).toEqual([]);
    expect(all.toLowerCase()).not.toContain('password');
    expect(all).not.toMatch(/owner code/i);
    // The one exception: the field hint names the terminal's "owner code", for 0.2.0 owners, and
    // is the app's one shared hint (quickwins.test.ts).
    expect(UPGRADE.codeHint).toBe(EARLIER_OWNER_CODE_HINT);
    expect(lintVocabulary(UPGRADE.codeHint)).toEqual([]);
    expect(text()).toContain(EARLIER_OWNER_CODE_HINT);
  });
});

describe('the upgrade API (existing /api/owner/passkey owner operation)', () => {
  function recorder(answers: Record<string, { status: number; body: unknown }>): {
    fetch: typeof fetch;
    calls: { url: string; init: RequestInit; sent?: Uint8Array }[];
  } {
    const calls: { url: string; init: RequestInit; sent?: Uint8Array }[] = [];
    return {
      calls,
      fetch: (input, init) => {
        const url = String(input);
        const body = init?.body;
        calls.push({
          url,
          init: init ?? {},
          ...(body instanceof Uint8Array ? { sent: (body as Uint8Array).slice() } : {}),
        });
        const answer = answers[`${init?.method ?? 'GET'} ${url}`] ?? { status: 500, body: {} };
        return Promise.resolve(
          new Response(JSON.stringify(answer.body), {
            status: answer.status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    };
  }

  it('reads whether a passkey is registered and the public values for the gesture', async () => {
    const r = recorder({
      [`GET ${PASSKEY_PATH}`]: {
        status: 200,
        body: {
          passkey: { registered: false, rpId: 'localhost', userId: 'AQID', prfSalt: 'BwgJ' },
        },
      },
    });
    const api = createUpgradeApi({ fetch: r.fetch, token: 'tok' });
    expect(await api.info()).toEqual({ kind: 'ok', registered: false, values: VALUES });
    const headers = new Headers(r.calls[0]?.init.headers);
    expect(headers.get('X-AgentLink-CSRF')).toBe('tok');
    expect(r.calls[0]?.init.credentials).toBe('same-origin');
  });

  it('refuses values that are not the localhost passkey (fail closed)', async () => {
    const bad = recorder({
      [`GET ${PASSKEY_PATH}`]: {
        status: 200,
        body: {
          passkey: { registered: false, rpId: 'evil.test', userId: 'AQID', prfSalt: 'BwgJ' },
        },
      },
    });
    expect(await createUpgradeApi({ fetch: bad.fetch, token: 't' }).info()).toEqual({
      kind: 'error',
      problem: 'unknown',
    });
    const none = recorder({
      [`GET ${PASSKEY_PATH}`]: { status: 503, body: { status: 'needs_setup' } },
    });
    expect(await createUpgradeApi({ fetch: none.fetch, token: 't' }).info()).toEqual({
      kind: 'needs_setup',
    });
    const gone = recorder({ [`GET ${PASSKEY_PATH}`]: { status: 401, body: {} } });
    expect(await createUpgradeApi({ fetch: gone.fetch, token: 't' }).info()).toEqual({
      kind: 'error',
      problem: 'session_expired',
    });
  });

  it('posts the body once as octet-stream to the passkey route, never in the URL, and zeroes its copy', async () => {
    const r = recorder({
      [`POST ${PASSKEY_PATH}`]: { status: 200, body: { status: 'registered' } },
    });
    const api = createUpgradeApi({ fetch: r.fetch, token: 'tok' });
    const code = new TextEncoder().encode(CODE);
    const body = encodeUpgradeBody(code, ASSERTION);
    expect(await api.register(body)).toEqual({ kind: 'registered' });
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0];
    expect(call?.url).toBe(PASSKEY_PATH);
    expect(call?.url).not.toContain('?');
    expect(call?.init.method).toBe('POST');
    const headers = new Headers(call?.init.headers);
    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('X-AgentLink-CSRF')).toBe('tok');
    expect(call?.sent).toEqual(body);
    expect((call?.init.body as Uint8Array).every((b) => b === 0)).toBe(true);
  });

  it('maps every answer to a fixed problem (never the server text)', async () => {
    const answer = (status: number, body: unknown): UpgradeApi =>
      createUpgradeApi({
        fetch: recorder({ [`POST ${PASSKEY_PATH}`]: { status, body } }).fetch,
        token: 't',
      });
    const b = new Uint8Array([0, 1, 65]);
    expect(await answer(403, { status: 'presence_rejected' }).register(b)).toEqual({
      kind: 'error',
      problem: 'presence_rejected',
    });
    expect(await answer(429, { status: 'wait', retryAfter: 12 }).register(b)).toEqual({
      kind: 'error',
      problem: 'wait',
      retryAfter: 12,
    });
    expect(await answer(409, { status: 'passkey_exists' }).register(b)).toEqual({
      kind: 'error',
      problem: 'passkey_exists',
    });
    expect(await answer(422, { status: 'passkey_unsupported' }).register(b)).toEqual({
      kind: 'error',
      problem: 'passkey_unsupported',
    });
    expect(await answer(409, { status: 'busy' }).register(b)).toEqual({
      kind: 'error',
      problem: 'busy',
    });
    expect(await answer(500, { status: 'failed', detail: 'x' }).register(b)).toEqual({
      kind: 'error',
      problem: 'failed',
    });
    expect(await answer(200, { status: 'something' }).register(b)).toEqual({
      kind: 'error',
      problem: 'unknown',
    });
  });

  it('encodes the registration body as the server parses it (16-bit code length first)', () => {
    const code = new Uint8Array([65, 66, 67]);
    const out = encodeUpgradeBody(code, new Uint8Array([9, 9]));
    expect([...out]).toEqual([0, 3, 65, 66, 67, 9, 9]);
  });
});

describe('the "Switch to Touch ID" next step on every app page', () => {
  it('links to the first-run page and names the platform', () => {
    act(() => root.render(h(SwitchToPasskeyBanner, { platform: 'mac' })));
    expect(text()).toContain(UPGRADE.bannerTitle('mac'));
    expect(text()).toContain(UPGRADE.bannerBody);
    const link = host.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/first-run');
    expect(link?.textContent).toBe(UPGRADE.bannerAction('mac'));
    // A fixed same-origin path: no token, no code, no query.
    expect(link?.getAttribute('href')).not.toContain('?');
  });

  it('shows on app pages while the owner has no passkey, never on first run', async () => {
    const needed = (): Promise<boolean> => Promise.resolve(true);
    await act(async () => {
      root.render(
        h(Layout, { path: '/settings/activity', nextStep: needed, platform: 'mac' }, 'page'),
      );
      await Promise.resolve();
    });
    expect(text()).toContain(UPGRADE.bannerTitle('mac'));
    await act(async () => {
      root.render(h(Layout, { path: '/first-run', nextStep: needed, platform: 'mac' }, 'page'));
      await Promise.resolve();
    });
    expect(text()).not.toContain(UPGRADE.bannerTitle('mac'));
  });

  it('is gone once a passkey is registered (or the check fails)', async () => {
    await act(async () => {
      root.render(
        h(
          Layout,
          { path: '/settings/rules', nextStep: () => Promise.resolve(false), platform: 'mac' },
          'page',
        ),
      );
      await Promise.resolve();
    });
    expect(text()).not.toContain(UPGRADE.bannerTitle('mac'));
    await act(async () => {
      root.render(
        h(
          Layout,
          {
            path: '/settings/files',
            nextStep: () => Promise.reject(new Error('offline')),
            platform: 'mac',
          },
          'page',
        ),
      );
      await Promise.resolve();
    });
    expect(text()).not.toContain(UPGRADE.bannerTitle('mac'));
  });
});
