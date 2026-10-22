// @vitest-environment jsdom
// M1-11b-1 acceptance (D-120; 08 §1; d1 Local-firstrun with DESIGN-ADJ-1 (a)):
// - passkey-first setup: begin, one browser passkey gesture, finish; the browser never signs;
// - after setup: the owner fingerprint, the owner code collapsed as the backup way to approve (open
//   and confirmed when the passkey can't protect approvals), and `done_unconfirmed` still shows the
//   code plus the restart line;
// - every fixed reason code in plain words; nothing from the server or the browser is shown;
// - the recovery kit's "Later" path is remembered for the persistent banner;
// - "Ready" hands back to the AI with a prompt to copy;
// - the default views use no web3 or key words (11 §5.1; UX north star).
import { act, createElement as h, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_KIT_LATER_KEY, recoveryKitPending } from '../../states/index.js';
import { FirstRunPage, setupMessage, type FirstRunPageProps } from './index.js';
import { encodeRegistration, type PasskeyResult } from './passkey.js';
import {
  BEGIN_PATH,
  FINISH_PATH,
  STATUS_PATH,
  createSetupApi,
  type BeginResult,
  type CreationValues,
  type FinishResult,
  type SetupApi,
  type SetupProblem,
  type StatusResult,
} from './setup-api.js';
import { FIRST_RUN, SETUP_MESSAGES } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = 'ABCD EFGH IJKL MNOP QRST UVWX';
const FP = '7F3A·19C2';
const VALUES: CreationValues = {
  rpId: 'localhost',
  rpName: 'AgentLink',
  userId: 'AQID',
  userName: 'AgentLink owner',
  challenge: 'BAUG',
  prfSalt: 'BwgJ',
};

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function fakeApi(
  options: {
    status?: StatusResult;
    begin?: BeginResult;
    finish?: FinishResult;
  } = {},
): SetupApi & { finished: Uint8Array[] } {
  const finished: Uint8Array[] = [];
  return {
    finished,
    status: () => Promise.resolve(options.status ?? { kind: 'ok', owner: 'missing' }),
    begin: () => Promise.resolve(options.begin ?? { kind: 'ready', publicKey: VALUES }),
    finish: (body) => {
      finished.push(body.slice());
      return Promise.resolve(
        options.finish ?? {
          kind: 'done',
          confirmed: true,
          passkey: true,
          ownerCode: CODE,
          fingerprint: FP,
        },
      );
    },
  };
}

const BODY = encodeRegistration([
  new Uint8Array([1, 2]),
  new Uint8Array(55),
  new Uint8Array([123, 125]),
  new Uint8Array(32).fill(9),
]);

async function mount(
  api: SetupApi,
  passkey: (v: CreationValues) => Promise<PasskeyResult> = () =>
    Promise.resolve({ kind: 'ok', body: BODY.slice() }),
  available = true,
): Promise<void> {
  await act(async () => {
    const props: FirstRunPageProps = {
      api,
      createPasskey: passkey,
      passkeysAvailable: () => available,
    };
    root.render(h(FirstRunPage as ComponentType<FirstRunPageProps>, props));
  });
}

function button(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  if (found === undefined) throw new Error(`no button ${name}: ${host.textContent ?? ''}`);
  return found;
}

async function click(name: string): Promise<void> {
  await act(async () => {
    button(name).click();
    await Promise.resolve();
  });
}

const text = (): string => host.textContent ?? '';

// 11 §5.1 and the UX north star: no web3 or key words in the default views.
const BANNED =
  /\b(wallet|gas|seed|transaction|chain|blockchain|hash|private key|owner key|address|0x[0-9a-f]+|localhost|prf|webauthn)\b/i;

describe('first run: protect approvals (D-120 (1))', () => {
  it('starts on step 1 with the LF-1 body, one primary action and the LF-3 list', async () => {
    await mount(fakeApi());
    expect(host.querySelector('h1')?.textContent).toBe(FIRST_RUN.protectTitle);
    expect(text()).toContain(FIRST_RUN.protectBody);
    expect(text()).toContain(FIRST_RUN.stepOf(1));
    expect(text()).toContain(FIRST_RUN.untilBody);
    expect(text()).toContain(FIRST_RUN.desktopTip);
    expect(host.querySelectorAll('.al-btn-primary')).toHaveLength(1);
    expect(button(FIRST_RUN.createPasskey).className).toContain('al-btn-primary');
    expect(text()).not.toMatch(BANNED);
  });

  it('runs begin, one passkey gesture and finish; the browser sends the creation response only', async () => {
    const api = fakeApi();
    const seen: CreationValues[] = [];
    await mount(api, (v) => {
      seen.push(v);
      return Promise.resolve({ kind: 'ok', body: BODY.slice() });
    });
    await click(FIRST_RUN.createPasskey);
    expect(seen).toEqual([VALUES]);
    expect(api.finished).toHaveLength(1);
    expect(api.finished[0]).toEqual(BODY);
  });

  it('shows the fingerprint and keeps the owner code collapsed as the backup way to approve', async () => {
    await mount(fakeApi());
    await click(FIRST_RUN.createPasskey);
    expect(host.querySelector('h1')?.textContent).toBe(FIRST_RUN.doneTitle);
    expect(text()).toContain(FIRST_RUN.fingerprintLabel);
    expect(host.querySelector('.al-fp')?.textContent).toContain(FP);
    const details = host.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe(FIRST_RUN.backupSummary);
    expect(details?.textContent).toContain('ABCD');
    expect(text()).not.toMatch(BANNED);
  });

  it('done_unconfirmed still shows the code, with the restart line', async () => {
    await mount(
      fakeApi({
        finish: { kind: 'done', confirmed: false, passkey: true, ownerCode: CODE, fingerprint: FP },
      }),
    );
    await click(FIRST_RUN.createPasskey);
    expect(text()).toContain(
      "Setup finished, but we couldn't confirm one step. Your agent may need a restart.",
    );
    expect(host.querySelector('details')?.textContent).toContain('UVWX');
    expect(host.querySelector('.al-fp')?.textContent).toContain(FP);
  });

  it('without a passkey that protects approvals, the code is shown open and must be saved first', async () => {
    await mount(
      fakeApi({
        finish: { kind: 'done', confirmed: true, passkey: false, ownerCode: CODE, fingerprint: FP },
      }),
    );
    await click(FIRST_RUN.createPasskey);
    expect(text()).toContain(FIRST_RUN.doneNoPasskeyBody);
    expect(host.querySelector('details')).toBeNull();
    expect(host.querySelector('.al-secret-val')?.textContent).toContain('ABCD');
    expect(button(FIRST_RUN.continue).disabled).toBe(true);
  });

  it('owner already set up: says so and never offers setup', async () => {
    await mount(fakeApi({ status: { kind: 'ok', owner: 'set_up' } }));
    expect(host.querySelector('h1')?.textContent).toBe(FIRST_RUN.alreadyTitle);
    expect(text()).toContain('agentlink doctor');
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
      FIRST_RUN.createPasskey,
    );
  });

  it('a race lost at begin or finish shows the same "already protected" state', async () => {
    await mount(fakeApi({ finish: { kind: 'owner_exists' } }));
    await click(FIRST_RUN.createPasskey);
    expect(host.querySelector('h1')?.textContent).toBe(FIRST_RUN.alreadyTitle);
  });

  it('a cancelled passkey dialog changes nothing and offers to try again', async () => {
    const api = fakeApi();
    await mount(api, () => Promise.resolve({ kind: 'cancelled' }));
    await click(FIRST_RUN.createPasskey);
    expect(text()).toContain(SETUP_MESSAGES.cancelled);
    expect(api.finished).toHaveLength(0);
    expect(button(FIRST_RUN.tryAgain)).toBeDefined();
  });

  it('a browser without passkeys gets the terminal fallback', async () => {
    await mount(fakeApi(), undefined, false);
    expect(host.querySelector('h1')?.textContent).toBe(FIRST_RUN.unsupportedTitle);
    expect(text()).toContain('agentlink owner init');
  });

  it('an expired link and a stopped agent show the shared states', async () => {
    await mount(fakeApi({ status: { kind: 'error', problem: 'session_expired' } }));
    expect(text()).toContain('This link has expired');
    act(() => root.unmount());
    root = createRoot(host);
    await mount(fakeApi({ status: { kind: 'error', problem: 'offline' } }));
    expect(text()).toContain("AgentLink isn't running");
  });

  it('after a failure that may have kept something, it never offers to start again', async () => {
    await mount(fakeApi({ finish: { kind: 'error', problem: 'keychain' } }));
    await click(FIRST_RUN.createPasskey);
    expect(text()).toContain(SETUP_MESSAGES.keychain);
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it('rolled_back offers to start again', async () => {
    await mount(fakeApi({ finish: { kind: 'error', problem: 'rolled_back' } }));
    await click(FIRST_RUN.createPasskey);
    expect(text()).toContain(SETUP_MESSAGES.rolled_back);
    expect(button(FIRST_RUN.tryAgain)).toBeDefined();
  });
});

describe('every fixed reason code has plain words', () => {
  const problems: SetupProblem[] = [
    'expired',
    'not_pending',
    'busy',
    'presence_required',
    'presence_rejected',
    'invalid',
    'unavailable',
    'rolled_back',
    'keychain',
    'check_failed',
    'internal',
    'offline',
    'session_expired',
    'forbidden',
    'unknown',
  ];
  it.each(problems)('%s', (problem) => {
    const message = setupMessage({ kind: 'error', problem });
    expect(message.length).toBeGreaterThan(10);
    expect(message).not.toContain(problem.includes('_') ? problem : '\u0000');
    expect(message).not.toMatch(BANNED);
  });
  it('wait names the seconds', () => {
    expect(setupMessage({ kind: 'error', problem: 'wait', retryAfter: 8 })).toContain('8 seconds');
  });
});

describe('recovery kit "Later" and Ready (D-120 (2); UX audit 1c, 1d)', () => {
  it('Later is remembered for the banner, then Ready hands back to the AI with a prompt to copy', async () => {
    await mount(fakeApi());
    await click(FIRST_RUN.createPasskey);
    await click(FIRST_RUN.continue);
    expect(host.querySelector('h1')?.textContent).toBe(FIRST_RUN.kitTitle);
    expect(host.querySelector('details')).toBeNull();
    expect(text()).not.toContain('ABCD');
    expect(recoveryKitPending()).toBe(false);
    await click(FIRST_RUN.later);
    expect(recoveryKitPending()).toBe(true);
    expect(localStorage.getItem(RECOVERY_KIT_LATER_KEY)).toMatch(/^[0-9]+$/);
    expect(host.querySelector('h1')?.textContent).toBe(FIRST_RUN.readyTitle);
    expect(host.querySelector('.al-copy.is-hero')?.textContent).toContain(FIRST_RUN.readyPrompt);
    expect(text()).toContain(FIRST_RUN.stepOf(3));
    expect(text()).not.toMatch(BANNED);
    expect(text()).not.toContain('ABCD');
  });
});

describe('the setup calls (setup-api.ts)', () => {
  function recorder(answers: Record<string, { status: number; body: unknown }>) {
    const calls: { path: string; init: RequestInit }[] = [];
    const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      calls.push({ path, init: init ?? {} });
      const a = answers[path];
      if (a === undefined) return Promise.reject(new TypeError('network'));
      return Promise.resolve(new Response(JSON.stringify(a.body), { status: a.status }));
    };
    return { calls, fetch: fetch as typeof globalThis.fetch };
  }

  it('posts octet-stream bodies with the CSRF token, same-origin, and reads the fixed answers', async () => {
    const r = recorder({
      [BEGIN_PATH]: {
        status: 200,
        body: { status: 'ready', expiresInMs: 120000, fingerprint: FP, publicKey: VALUES },
      },
      [FINISH_PATH]: {
        status: 200,
        body: { status: 'done', passkey: true, ownerCode: CODE, fingerprint: FP },
      },
    });
    const api = createSetupApi({ fetch: r.fetch, token: 'tok' });
    expect(await api.begin()).toEqual({ kind: 'ready', publicKey: VALUES });
    expect(await api.finish(BODY)).toEqual({
      kind: 'done',
      confirmed: true,
      passkey: true,
      ownerCode: CODE,
      fingerprint: FP,
    });
    for (const call of r.calls) {
      const headers = new Headers(call.init.headers);
      expect(call.init.method).toBe('POST');
      expect(headers.get('content-type')).toBe('application/octet-stream');
      expect(headers.get('x-agentlink-csrf')).toBe('tok');
      expect(call.init.credentials).toBe('same-origin');
    }
    expect((r.calls[0]?.init.body as Uint8Array).length).toBe(0);
    expect(r.calls[1]?.init.body).toEqual(BODY);
  });

  it('maps done_unconfirmed, owner_exists, failed reasons, wait and 401', async () => {
    const answer = (status: number, body: unknown) =>
      createSetupApi({ fetch: recorder({ [FINISH_PATH]: { status, body } }).fetch, token: 't' });
    expect(
      await answer(200, {
        status: 'done_unconfirmed',
        passkey: false,
        ownerCode: CODE,
        fingerprint: FP,
      }).finish(BODY),
    ).toEqual({ kind: 'done', confirmed: false, passkey: false, ownerCode: CODE, fingerprint: FP });
    expect(await answer(409, { status: 'owner_exists' }).finish(BODY)).toEqual({
      kind: 'owner_exists',
    });
    for (const reason of ['rolled_back', 'keychain', 'check_failed', 'internal']) {
      expect(await answer(500, { status: 'failed', reason }).finish(BODY)).toEqual({
        kind: 'error',
        problem: reason,
      });
    }
    expect(await answer(500, { status: 'failed', reason: '<b>x</b>' }).finish(BODY)).toEqual({
      kind: 'error',
      problem: 'internal',
    });
    expect(await answer(429, { status: 'wait', retryAfter: 4 }).finish(BODY)).toEqual({
      kind: 'error',
      problem: 'wait',
      retryAfter: 4,
    });
    expect(await answer(401, { status: 'rejected' }).finish(BODY)).toEqual({
      kind: 'error',
      problem: 'session_expired',
    });
    // A done answer whose values don't have the expected shape is never shown.
    expect(
      await answer(200, {
        status: 'done',
        passkey: true,
        ownerCode: '<img>',
        fingerprint: FP,
      }).finish(BODY),
    ).toEqual({ kind: 'error', problem: 'unknown' });
  });

  it('reads the status word and treats no answer as offline', async () => {
    const ok = createSetupApi({
      fetch: recorder({ [STATUS_PATH]: { status: 200, body: { owner: 'set_up' } } }).fetch,
      token: 't',
    });
    expect(await ok.status()).toEqual({ kind: 'ok', owner: 'set_up' });
    const down = createSetupApi({ fetch: recorder({}).fetch, token: 't' });
    expect(await down.status()).toEqual({ kind: 'error', problem: 'offline' });
  });
});

describe('the finish body (passkey.ts)', () => {
  it('is the four fields, each after its 16-bit big-endian length (owner-setup.ts)', () => {
    const body = encodeRegistration([
      new Uint8Array([7]),
      new Uint8Array([1, 2]),
      new Uint8Array(0),
      new Uint8Array([3]),
    ]);
    expect([...body]).toEqual([0, 1, 7, 0, 2, 1, 2, 0, 0, 0, 1, 3]);
  });
});
