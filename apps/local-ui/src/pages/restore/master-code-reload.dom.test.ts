// @vitest-environment jsdom
// REL051-CF3 (R1-CLASS-03/04, R1-UI-02): a reload on "Your master code" (Get started step 2) or on
// restore step 4 shows the same code and step again; a code made here and never saved is named as
// lost, with a new one offered and never asked for; restored IDs that wait for their owner go to
// "Finish restoring". The server's answers are checked against the real server in
// packages/node/src/local-ui/owner-setup-route.test.ts and restore-server.test.ts.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppsApi } from '../first-run/apps-api.js';
import { FirstRunPage, type FirstRunPageProps } from '../first-run/index.js';
import type { SetupApi } from '../first-run/setup-api.js';
import { FIRST_RUN } from '../first-run/strings.js';
import { resetAutoShown, resetWizard } from '../start/store.js';
import type { RestoreApi } from './api.js';
import { RestoreWizard, type RestoreWizardProps } from './index.js';
import {
  masterCodeAnswerOf,
  type MasterCodeAnswer,
  type MasterCodeApi,
} from './master-code-api.js';
import { setOutcome, takeFinishRestore } from './outcome.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIRST_CODE = 'ABCD EFGH IJKL MNOP QRST UVWX';
const RESTORE_CODE = 'R4TN-8KQZ-W2MD-6HXA-P9CF-3VQE';

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
  setOutcome(undefined);
  takeFinishRestore();
  host.remove();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
const text = (): string => host.textContent ?? '';
const button = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === label);

function fakeCode(answer: MasterCodeAnswer): MasterCodeApi & { saves: number } {
  const api = {
    saves: 0,
    show: () => Promise.resolve(answer),
    saved: () => {
      api.saves += 1;
      return Promise.resolve();
    },
  };
  return api;
}

const setupApi = (): SetupApi =>
  ({
    status: () => Promise.resolve({ kind: 'ok', owner: 'set_up' }),
    labelCheck: () => Promise.resolve({ kind: 'ok' }),
    begin: () => Promise.reject(new Error('unused')),
    finish: () => Promise.reject(new Error('unused')),
  }) as unknown as SetupApi;

const appsApi = (): AppsApi =>
  ({
    list: () => Promise.resolve({ kind: 'ok', apps: [], desktopRunning: false }),
    currentAgent: () => Promise.resolve({ kind: 'ok', folder: 'default' }),
    preview: () => Promise.resolve({ kind: 'not_available' }),
    passkey: () => Promise.resolve(undefined),
    apply: () => Promise.resolve({ kind: 'failed' }),
  }) as AppsApi;

async function mountFirstRun(code: MasterCodeApi, path = '/start/connect'): Promise<string[]> {
  resetWizard();
  resetAutoShown();
  history.replaceState(null, '', path);
  const went: string[] = [];
  await act(async () => {
    const props: FirstRunPageProps = {
      api: setupApi(),
      appsApi: appsApi(),
      masterCodeApi: code,
      passkeysAvailable: () => true,
      platform: 'mac',
      prfSupport: () => Promise.resolve('yes'),
      upgradeApi: {
        info: () => Promise.resolve({ kind: 'ok', registered: true }),
        register: () => Promise.reject(new Error('unused')),
      } as unknown as NonNullable<FirstRunPageProps['upgradeApi']>,
      go: (p: string) => {
        went.push(p);
        history.replaceState(null, '', p);
        window.dispatchEvent(new Event('agentlink:navigate'));
      },
      goHome: () => undefined,
      readJoin: () => Promise.resolve({ kind: 'failed' }),
    };
    root.render(h(FirstRunPage as ComponentType<FirstRunPageProps>, props));
  });
  await settle();
  return went;
}

describe('Get started: a reload on "Your master code"', () => {
  it('shows the same code again on the same step; "I saved it" tells the server', async () => {
    const code = fakeCode({
      kind: 'shown',
      which: 'first_run',
      code: FIRST_CODE,
      view: { outcome: 'done', passkey: true, fingerprint: '7F3A·19C2', computerName: 'Mac' },
    });
    await mountFirstRun(code);
    expect(host.querySelector('h1')?.textContent).toBe(FIRST_RUN.backupTitle);
    const shown = [...host.querySelectorAll('[data-backup-code] span')]
      .map((s) => s.textContent)
      .join(' ');
    expect(shown).toBe(FIRST_CODE);
    expect(location.pathname).toBe('/start/connect');
    // Never in storage, the URL or an attribute.
    expect(JSON.stringify({ ...localStorage })).not.toContain('ABCD');
    expect(location.href).not.toContain('ABCD');
    await act(async () => {
      button(FIRST_RUN.savedIt)?.click();
    });
    await settle();
    expect(code.saves).toBe(1);
  });

  it('a reload that landed on step 1 goes back to the code step', async () => {
    const code = fakeCode({
      kind: 'shown',
      which: 'first_run',
      code: FIRST_CODE,
      view: { outcome: 'done', passkey: true, fingerprint: '7F3A·19C2' },
    });
    const went = await mountFirstRun(code, '/start/app');
    expect(went).toContain('/start/connect');
    expect(host.querySelector('h1')?.textContent).toBe(FIRST_RUN.backupTitle);
  });

  it('a code made and never saved is named as lost: a new one is offered, never asked for', async () => {
    await mountFirstRun(fakeCode({ kind: 'lost', which: 'first_run', touchId: true }));
    expect(host.querySelector('[data-testid="code-lost"]')).not.toBeNull();
    expect(text()).toContain(FIRST_RUN.lostTitle);
    expect(text()).toContain('Touch ID');
    expect(button(FIRST_RUN.lostNew)).toBeDefined();
    expect(
      host.querySelector('input[type="password"], input[autocomplete="current-password"]'),
    ).toBeNull();
    expect(lintVocabulary(text())).toEqual([]);
  });

  it('restored IDs waiting for their owner go to Finish restoring', async () => {
    const assign = vi.fn();
    const spy = vi.spyOn(history, 'pushState').mockImplementation(assign);
    await mountFirstRun(fakeCode({ kind: 'finish_restore' }), '/start/app');
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls.at(-1)?.[2])).toBe('/restore/kit');
    expect(takeFinishRestore()).toBe(true);
  });
});

describe('Restore step 4: a reload', () => {
  const restoreApi = (): RestoreApi =>
    ({
      found: () => Promise.resolve({ kind: 'ok', kits: [] }),
    }) as unknown as RestoreApi;

  it('shows the same new master code and what came back; "Go to Home" after "I saved it" tells the server', async () => {
    const code = fakeCode({
      kind: 'shown',
      which: 'restore',
      code: RESTORE_CODE,
      touchId: true,
      ids: [{ agentId: 'a', name: 'tali', label: 'Tali', outcome: 'restored' }],
    });
    const left: string[] = [];
    await act(async () => {
      root.render(
        h<RestoreWizardProps>(RestoreWizard, {
          api: restoreApi(),
          appsApi: appsApi(),
          platform: 'mac',
          masterCodeApi: code,
          onLeave: (to: string) => left.push(to),
        }),
      );
    });
    await settle();
    expect(text()).toContain('Tali');
    expect(host.querySelector('[data-master-code]')?.textContent).toBe(RESTORE_CODE);
    const saved = host.querySelector<HTMLInputElement>('.rs-saved input');
    expect(saved).not.toBeNull();
    await act(async () => {
      saved?.click();
    });
    const home = [...host.querySelectorAll('button')].find((b) => /Home/.test(b.textContent ?? ''));
    await act(async () => {
      home?.click();
    });
    await settle();
    expect(code.saves).toBe(1);
    expect(left).toEqual(['/']);
  });
});

describe('the show answer is read in fixed shapes only', () => {
  it('accepts the server shapes and nothing else', () => {
    expect(masterCodeAnswerOf({ status: 'none' })).toEqual({ kind: 'none' });
    expect(masterCodeAnswerOf({ status: 'shown', kind: 'first_run', code: '<b>x</b>' })).toEqual({
      kind: 'none',
    });
    expect(masterCodeAnswerOf({ status: 'lost', kind: 'restore', touchId: true })).toEqual({
      kind: 'lost',
      which: 'restore',
      touchId: true,
    });
    expect(masterCodeAnswerOf({ status: 'finish_restore' })).toEqual({ kind: 'finish_restore' });
    expect(masterCodeAnswerOf('nope')).toEqual({ kind: 'none' });
  });
});
