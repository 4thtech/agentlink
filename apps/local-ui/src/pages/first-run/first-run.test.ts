// @vitest-environment jsdom
// M1-11b-1 acceptance (D-120; 08 §1; d1 Local-firstrun with DESIGN-ADJ-1 (a)):
// - passkey-first setup: begin, one browser passkey gesture, finish; the browser never signs;
// - after setup: the owner fingerprint, the owner code collapsed as the backup way to approve (open
//   and confirmed when the passkey can't protect approvals), and `done_unconfirmed` still shows the
//   code plus the restart line;
// - every fixed reason code in plain words; nothing from the server or the browser is shown;
// - the recovery kit stays "Later" (remembered for the persistent banner) when the backup code is saved;
// - W4-WIZARD (W4 UX v2 layer 1): the setup page is Get started: these tests pick the app on step 1
//   (start/wizard.dom.test.ts covers the steps), run step 2 and end on step 3, Connected;
// - the default views use no web3 or key words (11 §5.1; UX north star).
import { act, createElement as h, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_KIT_LATER_KEY, recoveryKitPending } from '../../states/index.js';
import { createAppsApi, type AppsApi } from './apps-api.js';
import { FirstRunPage, setupMessage, type FirstRunPageProps } from './index.js';
import { encodeRegistration } from './passkey.js';
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
import { lintVocabulary } from '@4thtech-io/ui';
import { FIRST_RUN, SETUP_MESSAGES } from './strings.js';
import { resetAutoShown, resetWizard } from '../start/store.js';
import { CONNECTED_STEP, CONNECT_STEP } from '../start/strings.js';

/** W4-WIZARD: the one button of step 2, by platform. */
const GO = {
  mac: CONNECT_STEP.connect('Touch ID'),
  windows: CONNECT_STEP.connect('Windows Hello'),
  other: CONNECT_STEP.connect('your passkey'),
} as const;
/** Step 3 after a first run with no AI app found (the pick was "Claude Code", not found yet). */
const READY = CONNECTED_STEP.notConnectedTitle('Claude Code agent');

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

/** A finish answer: done, passkey, Send allowed, unless overridden. */
function done(overrides: Partial<Extract<FinishResult, { kind: 'done' }>> = {}): FinishResult {
  return {
    kind: 'done',
    confirmed: true,
    passkey: true,
    ownerCode: CODE,
    fingerprint: FP,
    sendFolder: 'allowed',
    computerName: 'Talis-MacBook-Pro',
    ...overrides,
  };
}

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
    /** What the status re-check answers after the first status call. */
    statusAfter?: StatusResult;
  } = {},
): SetupApi & { finished: Uint8Array[] } {
  const finished: Uint8Array[] = [];
  let statusCalls = 0;
  return {
    finished,
    status: () => {
      statusCalls += 1;
      const first = options.status ?? { kind: 'ok', owner: 'missing' };
      return Promise.resolve(statusCalls > 1 ? (options.statusAfter ?? first) : first);
    },
    labelCheck: () => Promise.resolve({ kind: 'ok' }),
    begin: () =>
      Promise.resolve(options.begin ?? { kind: 'ready', publicKey: VALUES, nonce: 'N'.repeat(43) }),
    finish: (body) => {
      finished.push(body.slice());
      return Promise.resolve(options.finish ?? done());
    },
  };
}

const BODY = encodeRegistration([
  new Uint8Array([1, 2]),
  new Uint8Array(55),
  new Uint8Array([123, 125]),
  new Uint8Array(32).fill(9),
]);

/** No AI app found: the pick screen goes straight on (first-run-v3.test.ts covers the apps). */
const NO_APPS: AppsApi = {
  ...createAppsApi({ fetch: () => Promise.reject(new TypeError('not used')), token: 't' }),
  list: () => Promise.resolve({ kind: 'ok', apps: [], desktopRunning: false }),
  currentAgent: () => Promise.resolve({ kind: 'none' }),
};
let goHome = vi.fn();

async function mount(
  api: SetupApi,
  passkey: FirstRunPageProps['createPasskey'] = () =>
    Promise.resolve({ kind: 'ok', body: BODY.slice() }),
  available = true,
  extra: Partial<FirstRunPageProps> = {},
): Promise<void> {
  goHome = vi.fn();
  resetWizard();
  resetAutoShown();
  history.replaceState(null, '', '/start/app');
  await act(async () => {
    const props: FirstRunPageProps = {
      api,
      appsApi: NO_APPS,
      goHome,
      createPasskey: passkey,
      passkeysAvailable: () => available,
      platform: 'other',
      prfSupport: () => Promise.resolve('yes'),
      readJoin: () => Promise.resolve({ kind: 'failed' }),
      ...extra,
    };
    root.render(h(FirstRunPage as ComponentType<FirstRunPageProps>, props));
  });
  // W4-WIZARD: setup starts on step 1 (pick the AI app); go on to step 2.
  await settleAll();
  const next = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.trim().startsWith('Continue with'),
  );
  if (next !== undefined) {
    await act(async () => {
      next.click();
      await Promise.resolve();
    });
    await settleAll();
  }
}

async function settleAll(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
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
  await settleAll();
}

const text = (): string => host.textContent ?? '';

// 11 §5.1 and the UX north star: no web3 or key words in the default views.
const BANNED =
  /\b(wallet|gas|seed|transaction|chain|blockchain|hash|private key|owner key|address|0x[0-9a-f]+|localhost|prf|webauthn)\b/i;

describe('first run: protect approvals (D-120 (1))', () => {
  it('starts on "Confirm it\'s you" with one primary action and says what one confirmation does', async () => {
    await mount(fakeApi());
    expect(host.querySelector('h1')?.textContent).toBe(CONNECT_STEP.title);
    expect(text()).toContain(FIRST_RUN.foldersNote);
    expect(host.querySelectorAll('.al-btn-primary')).toHaveLength(1);
    expect(button(GO.other).className).toContain('al-btn-primary');
    expect(text()).not.toMatch(BANNED);
  });

  it('runs begin, one passkey gesture and finish; the browser sends the creation response only', async () => {
    const api = fakeApi();
    const seen: CreationValues[] = [];
    await mount(api, (v) => {
      seen.push(v);
      return Promise.resolve({ kind: 'ok', body: BODY.slice() });
    });
    await click(GO.other);
    expect(seen).toEqual([VALUES]);
    expect(api.finished).toHaveLength(1);
    expect(api.finished[0]).toEqual(BODY);
  });

  it('M1-UX-FIRSTRUN-V2: shows "Your backup code" once, in a save form, with the fingerprint', async () => {
    await mount(fakeApi());
    await click(GO.other);
    expect(host.querySelector('h1')?.textContent).toBe(FIRST_RUN.backupTitle);
    expect(text()).toContain(FIRST_RUN.fingerprintLabel);
    expect(host.querySelector('.al-fp')?.textContent).toContain(FP);
    // The code is plain, readable text on the page (Q-130-1 stays open), never collapsed.
    expect(host.querySelector('details')).toBeNull();
    expect(host.querySelector('.al-secret-val')?.textContent?.replace(/\s/g, '')).toBe(
      CODE.replace(/\s/g, ''),
    );
    expect(text()).not.toMatch(BANNED);
  });

  it('done_unconfirmed still shows the code, with the restart line', async () => {
    await mount(
      fakeApi({
        finish: done({ confirmed: false }),
      }),
    );
    await click(GO.other);
    expect(text()).toContain(
      "Setup finished, but we couldn't confirm one step. Your agent may need a restart.",
    );
    expect(host.querySelector('.al-secret-val')?.textContent).toContain('UVWX');
    expect(host.querySelector('.al-fp')?.textContent).toContain(FP);
  });

  it('without a passkey that protects approvals, the backup code is the way to approve here', async () => {
    await mount(fakeApi({ finish: done({ passkey: false }) }));
    await click(GO.other);
    expect(text()).toContain(FIRST_RUN.doneNoPasskeyBody);
    expect(host.querySelector('.al-secret-val')?.textContent).toContain('ABCD');
    expect(button(FIRST_RUN.savedIt)).toBeDefined();
  });

  it('owner already set up: Get started goes on for that owner (New agent) and never offers setup', async () => {
    const api = fakeApi({ status: { kind: 'ok', owner: 'set_up' } });
    await mount(api);
    // For an owner: New agent (no agent is open here), never owner setup. W4-WIRE-2: New agent
    // starts with "Name your agent" (Decision 52 (2)).
    expect(host.querySelector('h1')?.textContent).toBe('Name your agent');
    expect(text()).not.toContain(FIRST_RUN.foldersNote);
    expect(api.finished).toHaveLength(0);
  });

  it('IR-M1-11b-1-1 L-1: an unknown status sends the owner to agentlink doctor, not to setup', async () => {
    await mount(fakeApi({ status: { kind: 'ok', owner: 'unknown' } }));
    expect(text()).toContain(SETUP_MESSAGES.unknown);
    expect(text()).toContain('agentlink doctor');
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it('IR-M1-11b-1-1 L-2: finish offline, owner now set up: no retry, use the passkey or doctor', async () => {
    const api = fakeApi({
      finish: { kind: 'error', problem: 'offline' },
      statusAfter: { kind: 'ok', owner: 'set_up' },
    });
    await mount(api);
    await click(GO.other);
    expect(text()).toContain(SETUP_MESSAGES.finishedNoCode);
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(api.finished).toHaveLength(1);
  });

  it('IR-M1-11b-1-1 L-2: finish offline, still no owner: offers to try again', async () => {
    const api = fakeApi({
      finish: { kind: 'error', problem: 'offline' },
      statusAfter: { kind: 'ok', owner: 'missing' },
    });
    await mount(api);
    await click(GO.other);
    expect(text()).toContain(SETUP_MESSAGES.notFinished);
    expect(button(FIRST_RUN.tryAgain)).toBeDefined();
  });

  it('IR-M1-11b-1-1 L-2: finish offline and the re-check fails: no retry', async () => {
    await mount(
      fakeApi({
        finish: { kind: 'error', problem: 'offline' },
        statusAfter: { kind: 'error', problem: 'offline' },
      }),
    );
    await click(GO.other);
    expect(text()).toContain("AgentLink isn't running");
    expect([...host.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain(
      FIRST_RUN.tryAgain,
    );
  });

  it('a race lost at begin or finish shows the same "already protected" state', async () => {
    await mount(fakeApi({ finish: { kind: 'owner_exists' } }));
    await click(GO.other);
    expect(host.querySelector('h1')?.textContent).toBe(FIRST_RUN.alreadyTitle);
  });

  it('a cancelled passkey dialog changes nothing and offers to try again', async () => {
    const api = fakeApi();
    await mount(api, () => Promise.resolve({ kind: 'cancelled' }));
    await click(GO.other);
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
    await click(GO.other);
    expect(text()).toContain(SETUP_MESSAGES.keychain);
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it('rolled_back offers to start again', async () => {
    await mount(fakeApi({ finish: { kind: 'error', problem: 'rolled_back' } }));
    await click(GO.other);
    expect(text()).toContain(SETUP_MESSAGES.rolled_back);
    expect(button(FIRST_RUN.tryAgain)).toBeDefined();
  });
});

// M1-UX-FIRSTRUN-V2 acceptance (D-130 (1), (2); 08 §1 first run v2; 11 §5.5, §6.2.1).
describe('M1-UX-FIRSTRUN-V2: passkey-first first run', () => {
  const buttons = (): string[] =>
    [...host.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');

  it('shows the folders setup creates before the gesture, and one button named for the platform', async () => {
    for (const [platform, label] of [
      ['mac', GO.mac],
      ['windows', GO.windows],
      ['other', GO.other],
    ] as const) {
      await mount(fakeApi(), undefined, true, { platform });
      expect(text()).toContain('~/AgentLink/Send');
      expect(text()).toContain('~/AgentLink/Inbox');
      expect(text()).toContain('~/AgentLink/Proofs');
      expect(text()).toContain(FIRST_RUN.foldersNote);
      expect(host.querySelectorAll('.al-btn-primary')).toHaveLength(1);
      expect(button(label).className).toContain('al-btn-primary');
      expect(text()).not.toMatch(BANNED);
      act(() => root.unmount());
      root = createRoot(host);
    }
  });

  it('asks for a platform passkey (Touch ID, Windows Hello) by default', async () => {
    const asked: unknown[] = [];
    await mount(fakeApi(), (_v, options) => {
      asked.push(options);
      return Promise.resolve({ kind: 'ok', body: BODY.slice() });
    });
    await click(GO.other);
    expect(asked).toEqual([{ platform: true }]);
  });

  it('the backup code sits in a real save form; Copy is secondary with the clipboard warning', async () => {
    await mount(fakeApi(), undefined, true, { platform: 'mac' });
    await click(GO.mac);
    const form = host.querySelector('form');
    expect(form).not.toBeNull();
    const user = form?.querySelector<HTMLInputElement>('input[autocomplete="username"]');
    const secret = form?.querySelector<HTMLInputElement>('input[autocomplete="new-password"]');
    expect(user?.value).toBe('AgentLink backup code – Talis-MacBook-Pro');
    expect(secret?.type).toBe('password');
    expect(secret?.value).toBe(CODE);
    const save = button(FIRST_RUN.saveToManager);
    expect(save.type).toBe('submit');
    expect(save.form).toBe(form);
    expect(save.className).toContain('al-btn-primary');
    expect(button(FIRST_RUN.copy).className).not.toContain('al-btn-primary');
    expect(text()).toContain(FIRST_RUN.clipboardWarning);
    expect(text()).toContain(FIRST_RUN.backupBody('Touch ID'));
    expect(text()).toContain(FIRST_RUN.backupLost);
    expect(text()).not.toMatch(/password\b(?! manager)/i);
  });

  it('continues only after "I saved it": saving or copying never moves on', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mount(fakeApi());
    await click(GO.other);
    expect(buttons()).toEqual([FIRST_RUN.saveToManager, FIRST_RUN.copy, FIRST_RUN.savedIt]);
    await act(async () => {
      host.querySelector('form')?.requestSubmit();
      await Promise.resolve();
    });
    await click(FIRST_RUN.copy);
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(host.querySelector('h1')?.textContent).toBe(FIRST_RUN.backupTitle);
    await click(FIRST_RUN.savedIt);
    // U3-g: with no AI app chosen the end of first run is Home; the kit stays "Later".
    // W4-WIZARD: first run goes on to step 3 (Connected); Home is one click away there.
    expect(host.querySelector('h1')?.textContent).toBe(READY);
    expect(host.querySelector('h1')?.textContent).not.toBe(FIRST_RUN.backupTitle);
    // The code is gone from the page once the owner moves on.
    expect(text()).not.toContain('ABCD');
    expect(host.querySelector('input[autocomplete="new-password"]')).toBeNull();
  });

  // M1-UX-FIRSTRUN-V2-b L-3 (IR-M1-UX-FIRSTRUN-V2-1): after "I saved it" the backup code is in no
  // node, attribute or field value of the whole document (not only the page's visible text).
  it('L-3: the backup code leaves the DOM after "I saved it"', async () => {
    await mount(fakeApi());
    await click(GO.other);
    const fields = (): string[] =>
      [...document.querySelectorAll('input, textarea')].map(
        (f) => (f as HTMLInputElement | HTMLTextAreaElement).value,
      );
    const compact = CODE.replaceAll(' ', '');
    // Shown while the backup-code step is open (the save form holds it).
    expect(fields().some((v) => v.replaceAll(' ', '') === compact)).toBe(true);
    await click(FIRST_RUN.savedIt);
    // W4-WIZARD: first run goes on to step 3 (Connected); Home is one click away there.
    expect(host.querySelector('h1')?.textContent).toBe(READY);
    const html = document.documentElement.outerHTML;
    for (const part of [CODE, compact, ...CODE.split(' ')]) {
      expect(html).not.toContain(part);
      expect(document.body.textContent ?? '').not.toContain(part);
      for (const value of fields()) expect(value).not.toContain(part);
    }
  });

  it('says the Send folder is allowed, or why not, in plain words', async () => {
    await mount(fakeApi());
    await click(GO.other);
    expect(text()).toContain(FIRST_RUN.sendAllowed);
    act(() => root.unmount());
    root = createRoot(host);
    await mount(fakeApi({ finish: done({ sendFolder: 'not_allowed' }) }));
    await click(GO.other);
    expect(text()).toContain(FIRST_RUN.sendNotAllowed);
    expect(text()).not.toMatch(BANNED);
  });

  it('no PRF in this browser: names a browser that works, or continues with a backup code only', async () => {
    const asked: unknown[] = [];
    await mount(
      fakeApi({ finish: done({ passkey: false }) }),
      (_v, options) => {
        asked.push(options);
        return Promise.resolve({ kind: 'ok', body: BODY.slice() });
      },
      true,
      { platform: 'mac', prfSupport: () => Promise.resolve('no') },
    );
    expect(text()).toContain(FIRST_RUN.noPrf('Touch ID', 'Safari'));
    expect(host.querySelectorAll('.al-btn-primary')).toHaveLength(1);
    await click(FIRST_RUN.backupOnly);
    expect(asked).toEqual([{ platform: false }]);
    expect(host.querySelector('h1')?.textContent).toBe(FIRST_RUN.backupTitle);
    expect(text()).toContain(FIRST_RUN.doneNoPasskeyBody);
    expect(button(FIRST_RUN.savedIt)).toBeDefined();
  });

  it('a Send folder refused before the gesture: plain words, no passkey asked, try again', async () => {
    for (const problem of ['folder_not_empty', 'folder_unavailable'] as const) {
      let asked = 0;
      await mount(fakeApi({ begin: { kind: 'error', problem } }), () => {
        asked += 1;
        return Promise.resolve({ kind: 'ok', body: BODY.slice() });
      });
      await click(GO.other);
      expect(asked).toBe(0);
      expect(text()).toContain(SETUP_MESSAGES[problem]);
      expect(button(FIRST_RUN.tryAgain)).toBeDefined();
      act(() => root.unmount());
      root = createRoot(host);
    }
  });

  it('the setup calls read the Send folder outcome, the computer name and a folder refusal', async () => {
    const answers: Record<string, { status: number; body: unknown }> = {
      [BEGIN_PATH]: { status: 409, body: { status: 'folder_refused', reason: 'folder_not_empty' } },
      [FINISH_PATH]: {
        status: 200,
        body: {
          status: 'done',
          passkey: true,
          ownerCode: CODE,
          fingerprint: FP,
          sendFolder: 'allowed',
          computerName: 'Talis-MacBook-Pro',
        },
      },
    };
    const api = createSetupApi({
      token: 't',
      fetch: (input) => {
        const a = answers[String(input)] ?? { status: 404, body: {} };
        return Promise.resolve(new Response(JSON.stringify(a.body), { status: a.status }));
      },
    });
    expect(await api.begin()).toEqual({ kind: 'error', problem: 'folder_not_empty' });
    expect(await api.finish(new Uint8Array(1), 'N'.repeat(43))).toEqual(done());
    answers[BEGIN_PATH] = {
      status: 409,
      body: { status: 'folder_refused', reason: 'folder_unavailable' },
    };
    expect(await api.begin()).toEqual({ kind: 'error', problem: 'folder_unavailable' });
    // Anything unexpected is never shown: an odd name becomes "this computer", no outcome is "none".
    answers[FINISH_PATH] = {
      status: 200,
      body: {
        status: 'done',
        passkey: true,
        ownerCode: CODE,
        fingerprint: FP,
        computerName: '<b>',
      },
    };
    expect(await api.finish(new Uint8Array(1), 'N'.repeat(43))).toEqual(
      done({ sendFolder: 'none', computerName: 'this computer' }),
    );
  });
});

describe('M1-UX-FIRSTRUN-V2: the first-run copy passes lintVocabulary (11 §5.1)', () => {
  it('every string, filled in for each platform', () => {
    const texts: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') texts.push(value);
      else if (typeof value === 'function') {
        for (const [sensor, browser] of [
          ['Touch ID', 'Safari'],
          ['Windows Hello', 'Chrome or Edge'],
          ['your passkey', 'Chrome'],
        ] as const) {
          texts.push(String((value as (a: string, b: string) => string)(sensor, browser)));
        }
      } else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
    };
    walk(FIRST_RUN);
    walk(SETUP_MESSAGES);
    for (const t of texts) {
      // 11 §5.5 names the action "Save in my password manager": the browser's tool, never the code.
      // Only that phrase is excused; the code is never called a password.
      const managerOnly = /password manager/i.test(t) && !/password\b(?! manager)/i.test(t);
      const found = lintVocabulary(t, managerOnly ? { allow: ['password'] } : {});
      expect([t, found]).toEqual([t, []]);
    }
  });
});

describe('every fixed reason code has plain words', () => {
  const problems: SetupProblem[] = [
    'folder_not_empty',
    'folder_unavailable',
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

describe('recovery kit "Later" and the end on Home (D-120 (2); U3-a, D-138; U3-g)', () => {
  it('"I saved it" remembers the kit as later for the banner and lands on Home', async () => {
    await mount(fakeApi());
    await click(GO.other);
    expect(recoveryKitPending()).toBe(false);
    await click(FIRST_RUN.savedIt);
    expect(recoveryKitPending()).toBe(true);
    expect(localStorage.getItem(RECOVERY_KIT_LATER_KEY)).toMatch(/^[0-9]+$/);
    // W4-WIZARD: first run goes on to step 3 (Connected); Home is one click away there.
    expect(host.querySelector('h1')?.textContent).toBe(READY);
    expect(host.querySelector('details')).toBeNull();
    expect(text()).not.toContain('ABCD');
    expect(text()).not.toMatch(BANNED);
  });
});

describe('the setup calls (setup-api.ts)', () => {
  function recorder(answers: Record<string, { status: number; body: unknown }>) {
    const calls: { path: string; init: RequestInit }[] = [];
    const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      // A copy as sent: the client zeroes its own copy afterwards (L-3).
      const body = init?.body instanceof Uint8Array ? init.body.slice() : init?.body;
      calls.push({ path, init: { ...init, ...(body === undefined ? {} : { body }) } });
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
        body: {
          status: 'ready',
          expiresInMs: 120000,
          fingerprint: FP,
          publicKey: VALUES,
          nonce: 'N'.repeat(43),
        },
      },
      [FINISH_PATH]: {
        status: 200,
        body: { status: 'done', passkey: true, ownerCode: CODE, fingerprint: FP },
      },
    });
    const api = createSetupApi({ fetch: r.fetch, token: 'tok' });
    expect(await api.begin()).toEqual({ kind: 'ready', publicKey: VALUES, nonce: 'N'.repeat(43) });
    expect(await api.finish(BODY, 'N'.repeat(43))).toEqual(
      done({ sendFolder: 'none', computerName: 'this computer' }),
    );
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

  it('IR-M1-11b-1-1 L-3: zeroes its copy of the finish body once sent', async () => {
    const sent: Uint8Array[] = [];
    const fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(init?.body as Uint8Array);
      return Promise.resolve(new Response(JSON.stringify({ status: 'busy' }), { status: 409 }));
    }) as typeof globalThis.fetch;
    await createSetupApi({ fetch, token: 't' }).finish(BODY, 'N'.repeat(43));
    expect(sent[0]).not.toBe(BODY);
    expect(sent[0]?.length).toBe(BODY.length);
    expect(sent[0]?.every((b) => b === 0)).toBe(true);
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
      }).finish(BODY, 'N'.repeat(43)),
    ).toEqual(
      done({ confirmed: false, passkey: false, sendFolder: 'none', computerName: 'this computer' }),
    );
    expect(await answer(409, { status: 'owner_exists' }).finish(BODY, 'N'.repeat(43))).toEqual({
      kind: 'owner_exists',
    });
    for (const reason of ['rolled_back', 'keychain', 'check_failed', 'internal']) {
      expect(await answer(500, { status: 'failed', reason }).finish(BODY, 'N'.repeat(43))).toEqual({
        kind: 'error',
        problem: reason,
      });
    }
    expect(
      await answer(500, { status: 'failed', reason: '<b>x</b>' }).finish(BODY, 'N'.repeat(43)),
    ).toEqual({
      kind: 'error',
      problem: 'internal',
    });
    expect(
      await answer(429, { status: 'wait', retryAfter: 4 }).finish(BODY, 'N'.repeat(43)),
    ).toEqual({
      kind: 'error',
      problem: 'wait',
      retryAfter: 4,
    });
    expect(await answer(401, { status: 'rejected' }).finish(BODY, 'N'.repeat(43))).toEqual({
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
      }).finish(BODY, 'N'.repeat(43)),
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
