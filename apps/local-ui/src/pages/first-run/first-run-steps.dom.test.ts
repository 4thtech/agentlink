// @vitest-environment jsdom
// FILES-ONB-1 (D-152; 08 §1; 11 §5.7): Get started has five steps with Files fourth. Only Connect
// another AI app has four and skips Files. Each step is its own page mount, so on Files and Invite
// the owner and ID already exist: the page must still know this is the first run.
import { act, createElement as h, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rememberWizard, resetAutoShown, resetWizard } from '../start/store.js';
import { createAppsApi, type AppsApi } from './apps-api.js';
import { FirstRunPage, type FirstRunPageProps } from './index.js';
import type { SetupApi } from './setup-api.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = {
  status: () => Promise.resolve({ kind: 'ok', owner: 'set_up' } as const),
} as unknown as SetupApi;

const apps: AppsApi = {
  ...createAppsApi({ fetch: () => Promise.reject(new TypeError('not used')), token: 't' }),
  list: () => Promise.resolve({ kind: 'ok', apps: [], desktopRunning: false }),
  // The ID exists (this run just made it).
  currentAgent: () => Promise.resolve({ kind: 'ok', folder: 'default' }),
};

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  resetWizard();
  resetAutoShown();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function mountAt(path: string): Promise<void> {
  history.replaceState(null, '', path);
  await act(async () => {
    const props: FirstRunPageProps = {
      api,
      appsApi: apps,
      goHome: vi.fn(),
      passkeysAvailable: () => true,
      prfSupport: () => Promise.resolve('yes'),
      upgradeApi: { info: () => Promise.resolve({ kind: 'ok', registered: true }) } as never,
      readJoin: () => Promise.resolve({ kind: 'failed' }),
      native: { userAgent: 'Mozilla/5.0 (browser)' },
    };
    root.render(h(FirstRunPage as ComponentType<FirstRunPageProps>, props));
  });
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe('FILES-ONB-1: a first run keeps five steps after its ID exists', () => {
  it('Files opens as step 4 of 5 for the run that made the ID (a fresh mount of the step)', async () => {
    rememberWizard({
      connectOnly: false,
      outcome: {
        label: 'Home base',
        app: { id: 'claude-code', name: 'Claude Code', connected: true },
      },
    });
    await mountAt('/start/files');
    expect(location.pathname).toBe('/start/files');
    expect(host.textContent).toContain('Step 4 of 5');
    expect(host.querySelector('h1')?.textContent).toBe('Sending and receiving files');
  });

  it('Connect another AI app (an ID and no run here) has four steps and skips Files', async () => {
    await mountAt('/start/files');
    expect(location.pathname).toBe('/start/invite');
    expect(host.textContent).toContain('Step 4 of 4');
  });
});
