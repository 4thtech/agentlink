// @vitest-environment jsdom
// FIRSTRUN-EXIT (owner, 14 Nov: "You need to be able to come out of the wizard any time, not be
// locked within a wizard"): every Get started step, every restore step and Start over carry a way out
// that needs no owner: "Check for updates" (Settings › Updates) and "Help" (the user guide), in the
// browser and in the desktop app's window alike. Pages that need an owner show "Set up AgentLink
// first" with one button back to Get started; Settings › Updates works with no owner.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { DESKTOP_UA_MARKER } from '../../desktop.js';
import { Layout } from '../../layout/index.js';
import { GUIDE_URL } from '../../layout/top-bar.js';
import { Frame as RestoreFrame } from '../restore/steps.js';
import { UpdatesPage } from '../updates/index.js';
import {
  OWNER_FREE_PATHS,
  SetUpFirstNotice,
  SetupExitLinks,
  WINDOWS_SETUP_URL,
  needsOwner,
  OwnerGate,
} from './setup-exit.js';
import { CONNECT_ONLY_STEP_IDS, SETUP_EXIT, STEP_IDS } from './strings.js';
import { WizardFrame } from './wizard.js';

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
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render(el: ReturnType<typeof h>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  await settle();
}

const links = (): HTMLAnchorElement[] => [...host.querySelectorAll('a')];
const link = (label: string): HTMLAnchorElement | undefined =>
  links().find((a) => a.textContent?.trim() === label);

function expectExit(): void {
  const nav = host.querySelector(`nav[aria-label="${SETUP_EXIT.label}"]`);
  expect(nav).not.toBeNull();
  const updates = link(SETUP_EXIT.updates);
  expect(updates?.getAttribute('href')).toBe('/settings/updates');
  expect(updates?.hidden).toBe(false);
  const help = link(SETUP_EXIT.help);
  expect(help?.getAttribute('href')).toBe(GUIDE_URL);
  expect(help?.getAttribute('target')).toBe('_blank');
  expect(help?.getAttribute('rel')).toBe('noopener noreferrer');
}

describe('FIRSTRUN-EXIT: a way out on every first-run step', () => {
  it('every Get started step has Check for updates and Help, also with no ID yet', async () => {
    for (const steps of [STEP_IDS, CONNECT_ONLY_STEP_IDS]) {
      for (const step of steps) {
        for (const hideSkip of [false, true]) {
          await render(h(WizardFrame, { step, steps, hideSkip }, h('p', null, 'body')));
          expectExit();
        }
      }
    }
  });

  it('the desktop app window shows the same way out (Mac and Windows)', async () => {
    for (const ua of [
      `Mozilla/5.0 (Macintosh) ${DESKTOP_UA_MARKER} (passkey=browser)`,
      `Mozilla/5.0 (Windows NT 10.0) ${DESKTOP_UA_MARKER} (passkey=window)`,
    ]) {
      vi.stubGlobal('navigator', { ...navigator, userAgent: ua });
      for (const step of STEP_IDS) {
        await render(h(WizardFrame, { step, hideSkip: true }, h('p', null, 'body')));
        expectExit();
      }
      vi.unstubAllGlobals();
    }
  });

  it('every restore step has the same way out next to Cancel', async () => {
    for (const step of ['kit', 'code', 'review', 'protect'] as const) {
      await render(h(RestoreFrame, { step, onCancel: () => undefined }, h('p', null, 'body')));
      expectExit();
    }
  });

  it('the links alone render as a labelled nav (Start over uses them too)', async () => {
    await render(h(SetupExitLinks));
    expectExit();
  });
});

describe('FIRSTRUN-EXIT: pages that need an owner', () => {
  it('Settings › Updates, Settings, Appearance and Home need no owner; the rest do', () => {
    for (const path of ['/settings/updates', '/settings', '/settings/appearance', '/']) {
      expect(OWNER_FREE_PATHS).toContain(path);
      expect(needsOwner(path)).toBe(false);
    }
    for (const path of [
      '/contacts',
      '/people',
      '/agents',
      '/agents/work',
      '/ids',
      '/activity',
      '/activity/live',
      '/settings/backup',
      '/settings/rules',
      '/settings/storage',
      '/settings/files',
      '/settings/touch-id',
      '/advanced/network',
      '/approve/abc',
    ]) {
      expect(needsOwner(path)).toBe(true);
    }
  });

  it('the notice: "Set up AgentLink first" with one button back to Get started', async () => {
    await render(h(SetUpFirstNotice));
    expect(host.textContent).toContain(SETUP_EXIT.firstTitle);
    const back = link(SETUP_EXIT.continueSetup);
    expect(back?.getAttribute('href')).toBe('/start/app');
    expect(host.textContent).not.toMatch(/wallet|gas|seed phrase|transaction/i);
  });

  it('OwnerGate: with no owner an owner page shows only the notice', async () => {
    await render(
      h(
        OwnerGate,
        { path: '/contacts', read: () => Promise.resolve('missing' as const) },
        h('p', { id: 'page' }, 'People'),
      ),
    );
    expect(host.querySelector('#page')).toBeNull();
    expect(host.textContent).toContain(SETUP_EXIT.firstTitle);
  });

  it('OwnerGate: Settings › Updates shows the page with no owner, with a way back to setup', async () => {
    await render(
      h(
        OwnerGate,
        { path: '/settings/updates', read: () => Promise.resolve('missing' as const) },
        h('p', { id: 'page' }, 'Updates'),
      ),
    );
    expect(host.querySelector('#page')).not.toBeNull();
    expect(host.textContent).not.toContain(SETUP_EXIT.firstTitle);
    expect(link(SETUP_EXIT.continueSetup)?.getAttribute('href')).toBe('/start/app');
  });

  it('OwnerGate: an owner, or an unanswered read, changes nothing', async () => {
    for (const read of [
      () => Promise.resolve('set_up' as const),
      () => Promise.resolve(undefined),
      () => Promise.reject(new Error('offline')),
    ]) {
      await render(h(OwnerGate, { path: '/contacts', read }, h('p', { id: 'page' }, 'People')));
      expect(host.querySelector('#page')).not.toBeNull();
      expect(host.textContent).not.toContain(SETUP_EXIT.firstTitle);
      expect(link(SETUP_EXIT.continueSetup)).toBeUndefined();
    }
  });
});

describe('FIRSTRUN-EXIT: the shell gates owner pages before setup', () => {
  const shell = (path: string, owner: 'missing' | 'set_up') =>
    h(
      Layout,
      {
        path,
        readOwner: () => Promise.resolve(owner),
        nextStep: () => Promise.resolve(false),
        waitingApprovals: () => Promise.resolve(0),
        readHealth: () => Promise.resolve({ kind: 'offline' } as ApiResult<unknown>),
      },
      h('p', { id: 'page' }, 'Page'),
    );

  beforeEach(() => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 404 })));
  });

  it('no owner: People shows the notice; Settings › Updates shows the page', async () => {
    await render(shell('/contacts', 'missing'));
    expect(host.querySelector('#page')).toBeNull();
    expect(host.textContent).toContain(SETUP_EXIT.firstTitle);
    await render(shell('/settings/updates', 'missing'));
    expect(host.querySelector('#page')).not.toBeNull();
    expect(host.textContent).not.toContain(SETUP_EXIT.firstTitle);
  });

  it('an owner: every page as before', async () => {
    await render(shell('/contacts', 'set_up'));
    expect(host.querySelector('#page')).not.toBeNull();
    expect(host.textContent).not.toContain(SETUP_EXIT.firstTitle);
  });
});

const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });
const view = (state: string, install: string): Record<string, string> => ({
  state,
  current: '0.5.5',
  latest: '',
  download: '',
  install,
});

describe('FIRSTRUN-EXIT: Settings › Updates before an owner exists', () => {
  it('renders the version and checks for updates (the reads need no owner)', async () => {
    const paths: string[] = [];
    const get = (path: string): Promise<ApiResult<unknown>> => {
      paths.push(path);
      return Promise.resolve(ok(view(path.endsWith('/check') ? 'current' : 'idle', 'desktop')));
    };
    await render(h(UpdatesPage, { api: { get } as unknown as ApiClient, pollMs: 0 }));
    expect(host.textContent).toContain('You have AgentLink 0.5.5.');
    const check = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Check for updates',
    );
    await act(async () => {
      check?.click();
    });
    await settle();
    expect(paths).toEqual(['/api/ui/app-update', '/api/ui/app-update/check']);
    expect(host.textContent).toContain('AgentLink is up to date.');
  });

  it('the Windows app: "Download the new version" to the stable latest setup, also when the read fails', async () => {
    expect(WINDOWS_SETUP_URL).toBe(
      'https://github.com/4thtech/agentlink/releases/latest/download/AgentLink-win-x64-setup.exe',
    );
    for (const answer of [ok(view('idle', 'desktop')), { kind: 'offline' } as ApiResult<unknown>]) {
      const get = (): Promise<ApiResult<unknown>> => Promise.resolve(answer);
      await render(
        h(UpdatesPage, { api: { get } as unknown as ApiClient, pollMs: 0, os: 'windows', desktop: true }),
      );
      const dl = link(SETUP_EXIT.windowsDownload);
      expect(dl?.getAttribute('href')).toBe(WINDOWS_SETUP_URL);
      expect(dl?.getAttribute('target')).toBe('_blank');
      expect(dl?.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('the Mac app has no Windows link (it updates in the app)', async () => {
    const get = (): Promise<ApiResult<unknown>> => Promise.resolve(ok(view('idle', 'desktop')));
    await render(
      h(UpdatesPage, { api: { get } as unknown as ApiClient, pollMs: 0, os: 'macos', desktop: true }),
    );
    expect(link(SETUP_EXIT.windowsDownload)).toBeUndefined();
  });

  it('the browser app: how to update, with the npx command, also when the read fails', async () => {
    for (const answer of [ok(view('idle', 'npx')), { kind: 'offline' } as ApiResult<unknown>]) {
      const get = (): Promise<ApiResult<unknown>> => Promise.resolve(answer);
      await render(
        h(UpdatesPage, { api: { get } as unknown as ApiClient, pollMs: 0, os: 'windows', desktop: false }),
      );
      expect(host.textContent).toContain(SETUP_EXIT.browserHowTitle);
      expect(host.textContent).toContain('npx -y @4thtech-io/agentlink@latest');
      expect(link(SETUP_EXIT.windowsDownload)).toBeUndefined();
    }
  });
});
