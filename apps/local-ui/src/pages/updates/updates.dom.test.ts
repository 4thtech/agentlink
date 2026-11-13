// @vitest-environment jsdom
// DESK051-UPD: Settings > Updates (desktop app only). The version, "Check for updates", and when a
// newer version is ready: "AgentLink <v> is ready", "Download update" to the exact release file, and
// three short steps. Every answer is checked again; a link in any other form is never shown.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { settingsPages, SETTINGS_PAGES } from '../../nav.js';
import { APP_UPDATE_CHECK_PATH, APP_UPDATE_PATH, parseUpdate } from './data.js';
import { UpdatesPage } from './index.js';

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
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const DMG =
  'https://github.com/4thtech/agentlink/releases/download/v0.5.2/AgentLink-0.5.2-mac-arm64.dmg';
const PAGE = 'https://github.com/4thtech/agentlink/releases/tag/v0.5.2';
const AVAILABLE = {
  state: 'available',
  current: '0.5.1',
  latest: '0.5.2',
  download: DMG,
  install: 'desktop',
};
const view = (state: string, install = 'desktop'): Record<string, string> => ({
  state,
  current: '0.5.1',
  latest: '',
  download: '',
  install,
});
const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });

async function mount(get: (path: string) => Promise<ApiResult<unknown>>): Promise<void> {
  await act(async () => {
    root.render(h(UpdatesPage, { api: { get } as unknown as ApiClient, pollMs: 0 }));
  });
  await settle();
}
const text = (): string => host.textContent ?? '';
const button = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);

describe('Settings > Updates', () => {
  it('shows the version and offers a check', async () => {
    await mount(() => Promise.resolve(ok(view('idle'))));
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(text()).toContain('You have AgentLink 0.5.1.');
    expect(text()).toContain('AgentLink looks for a newer version once a day.');
    expect(button('Check for updates')).toBeDefined();
    expect(host.querySelector('a')).toBeNull();
  });

  it('a newer version: "is ready", Download update to the exact file, and the steps', async () => {
    await mount(() => Promise.resolve(ok(AVAILABLE)));
    expect(text()).toContain('AgentLink 0.5.2 is ready');
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Download update');
    expect(link?.getAttribute('href')).toBe(DMG);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(text()).toContain('Open the file you downloaded.');
    expect(text()).toContain(
      'Quit AgentLink: click its icon in the menu bar and choose Quit AgentLink.',
    );
    expect(text()).toContain('Drag AgentLink to the Applications folder and choose Replace.');
    expect(host.querySelectorAll('ol li')).toHaveLength(4);
    expect(text()).toContain('Open AgentLink again.');
    expect(text()).toContain('Your IDs, people and messages stay as they are.');
  });

  it('the release page (not a Mac file) gets its own steps', async () => {
    await mount(() => Promise.resolve(ok({ ...AVAILABLE, download: PAGE })));
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Download update');
    expect(link?.getAttribute('href')).toBe(PAGE);
    expect(text()).toContain('download AgentLink for your computer');
    expect(text()).not.toContain('Applications folder');
  });

  it('Check for updates asks once, then follows "checking" until it ends', async () => {
    const answers = [ok(view('checking')), ok(view('checking')), ok(AVAILABLE)];
    const get = vi.fn((path: string) => {
      if (path === APP_UPDATE_CHECK_PATH) return Promise.resolve(ok(view('checking')));
      return Promise.resolve(
        answers.length > 1 ? (answers.shift() as never) : (answers[0] as never),
      );
    });
    await mount((path) =>
      path === APP_UPDATE_PATH ? Promise.resolve(ok(view('current'))) : get(path),
    );
    expect(text()).toContain('AgentLink is up to date.');
    await act(async () => {
      button('Check for updates')?.click();
    });
    await settle();
    expect(get.mock.calls.filter(([p]) => p === APP_UPDATE_CHECK_PATH)).toHaveLength(1);
  });

  it('follows a check to its end', async () => {
    let reads = 0;
    const get = (path: string): Promise<ApiResult<unknown>> => {
      if (path === APP_UPDATE_CHECK_PATH) return Promise.resolve(ok(view('checking')));
      reads += 1;
      return Promise.resolve(
        ok(reads === 1 ? view('current') : reads === 2 ? view('checking') : AVAILABLE),
      );
    };
    await mount(get);
    await act(async () => {
      button('Check for updates')?.click();
    });
    await settle();
    expect(text()).toContain('AgentLink 0.5.2 is ready');
  });

  it.each([
    ['failed', 'Couldn’t check for updates just now. Try again later.'],
    ['offline', 'You’re offline. Connect to the internet, then check again.'],
    ['current', 'AgentLink is up to date.'],
  ])('%s says so in plain words', async (state, words) => {
    await mount(() => Promise.resolve(ok(view(state))));
    expect(text()).toContain(words);
    expect(button('Check for updates')).toBeDefined();
  });

  it('turned off: says so and offers no check', async () => {
    await mount(() => Promise.resolve(ok(view('off'))));
    expect(text()).toContain('Checking for updates is turned off on this computer.');
    expect(button('Check for updates')).toBeUndefined();
  });

  it('an answer in any other form is not shown (no link), and Try again reads again', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(ok({ ...AVAILABLE, download: 'https://evil.example/AgentLink.dmg' }))
      .mockResolvedValueOnce(ok(view('current')));
    await mount(get);
    expect(text()).toContain('Couldn’t read this just now.');
    expect(host.querySelector('a')).toBeNull();
    await act(async () => {
      button('Try again')?.click();
    });
    await settle();
    expect(text()).toContain('AgentLink is up to date.');
  });

  it('never uses the banned words', async () => {
    await mount(() => Promise.resolve(ok(AVAILABLE)));
    expect(text()).not.toMatch(/wallet|\bgas\b|seed phrase|transaction/i);
  });
});

describe('parseUpdate', () => {
  it.each([
    ['not an object', 'x'],
    ['an unknown state', { ...AVAILABLE, state: 'installing' }],
    ['a link for another version', { ...AVAILABLE, download: DMG.replaceAll('0.5.2', '0.5.3') }],
    ['a javascript link', { ...AVAILABLE, download: 'javascript:alert(1)' }],
    ['not newer', { ...AVAILABLE, current: '0.5.2' }],
    ['a link while not available', { ...view('current'), download: DMG }],
    ['markup in the version', { ...view('current'), current: '<img src=x>' }],
  ])('refuses %s', (_label, data) => {
    expect(parseUpdate(data)).toBeUndefined();
  });
});

describe('one Updates page in Settings, in the desktop app and in the browser', () => {
  it('is listed once, before Advanced (the same list in both)', () => {
    const paths = settingsPages().map((p) => p.path);
    expect(paths.filter((p) => p === '/settings/updates')).toHaveLength(1);
    expect(paths.slice(-2)).toEqual(['/settings/updates', '/settings/advanced']);
    expect(SETTINGS_PAGES.filter((p) => p.path === '/settings/updates')).toHaveLength(1);
  });
});

// REL051-UPD2: the browser app (the local app server from `agentlink` or npx). There is no file to
// download: the page says how to get the new version for how this copy was installed.
describe('Settings > Updates in the browser app', () => {
  const BROWSER = (install: string): Record<string, string> => ({
    ...AVAILABLE,
    download: '',
    install,
  });
  const code = (): string[] => [...host.querySelectorAll('code')].map((c) => c.textContent ?? '');

  it('the installer’s agentlink command: a restart is the update', async () => {
    await mount(() => Promise.resolve(ok(BROWSER('installer'))));
    expect(text()).toContain('AgentLink 0.5.2 is ready');
    expect(text()).toContain('Restart AgentLink to update');
    expect(text()).toContain('press Ctrl+C');
    expect(code()).toEqual(['agentlink']);
    expect(host.querySelector('a')).toBeNull();
    expect(button('Download update')).toBeUndefined();
    expect(text()).toContain('Your IDs, people and messages stay as they are.');
  });

  it('npx: a restart with the npx command is the update', async () => {
    await mount(() => Promise.resolve(ok(BROWSER('npx'))));
    expect(text()).toContain('Restart AgentLink to update');
    expect(code()).toEqual(['npx -y @4thtech-io/agentlink@latest']);
  });

  it('a global install: the one update command, then start it again', async () => {
    await mount(() => Promise.resolve(ok(BROWSER('global'))));
    expect(text()).toContain('Update with one command');
    expect(text()).not.toContain('Restart AgentLink to update');
    expect(code()).toEqual(['npm install -g @4thtech-io/agentlink@latest', 'agentlink']);
  });

  it('Copy puts the exact command on the clipboard and says Copied', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mount(() => Promise.resolve(ok(BROWSER('global'))));
    const copies = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Copy');
    expect(copies).toHaveLength(2);
    await act(async () => {
      copies[0]?.click();
    });
    await settle();
    expect(writeText).toHaveBeenCalledWith('npm install -g @4thtech-io/agentlink@latest');
    expect(text()).toContain('Copied');
  });

  it('idle in the browser: the same version line and check button', async () => {
    await mount(() => Promise.resolve(ok(view('idle', 'npx'))));
    expect(text()).toContain('You have AgentLink 0.5.1.');
    expect(button('Check for updates')).toBeDefined();
  });

  it('a window with no update check (501) says so, without an error', async () => {
    await mount(() => Promise.resolve({ kind: 'not_available' } as ApiResult<unknown>));
    expect(text()).toContain('Checking for updates isn’t available in this window.');
    expect(button('Check for updates')).toBeUndefined();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    ['a link in the browser app', { ...BROWSER('npx'), download: DMG }],
    ['no link in the desktop app', BROWSER('desktop')],
    ['an unknown install', BROWSER('brew')],
    ['no install', { state: 'idle', current: '0.5.1', latest: '', download: '' }],
  ])('parseUpdate refuses %s', (_label, data) => {
    expect(parseUpdate(data)).toBeUndefined();
  });

  it('never uses the banned words', async () => {
    for (const install of ['installer', 'npx', 'global']) {
      await mount(() => Promise.resolve(ok(BROWSER(install))));
      expect(text()).not.toMatch(/wallet|\bgas\b|seed phrase|transaction/i);
    }
  });
});
