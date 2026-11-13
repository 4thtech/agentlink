// @vitest-environment jsdom
// UPD-5: Settings › Updates in the Mac app with the in-app update on: "Update now" → Downloading
// (progress bar, %) → Checking the new version → "Restart now" → Restarting; "Couldn't update here"
// keeps the download link. Both buttons are POSTs with no body; the page never builds a link.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import {
  APP_UPDATE_INSTALL_PATH,
  APP_UPDATE_PATH,
  APP_UPDATE_RESTART_PATH,
  parseUpdate,
} from './data.js';
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
  'https://github.com/4thtech/agentlink/releases/download/v0.5.3/AgentLink-0.5.3-mac-arm64.dmg';
const base = {
  current: '0.5.2',
  latest: '0.5.3',
  download: DMG,
  install: 'desktop',
  installable: true,
  percent: 0,
  busy: false,
};
const at = (state: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...base,
  state,
  ...extra,
});
const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });

interface Calls {
  posts: { path: string; body: unknown }[];
}
async function mount(
  get: (path: string) => Promise<ApiResult<unknown>>,
  post: (path: string) => Promise<ApiResult<unknown>> = () => Promise.resolve(ok(at('available'))),
): Promise<Calls> {
  const calls: Calls = { posts: [] };
  const api = {
    get,
    post: (path: string, body?: unknown) => {
      calls.posts.push({ path, body });
      return post(path);
    },
  } as unknown as ApiClient;
  await act(async () => {
    root.render(h(UpdatesPage, { api, pollMs: 0 }));
  });
  await settle();
  return calls;
}
const text = (): string => host.textContent ?? '';
const button = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);
const fixed = (state: string, extra: Record<string, unknown> = {}) => () =>
  Promise.resolve(ok(at(state, extra)));

describe('Settings › Updates, in-app update (UPD-5)', () => {
  it('Update available: the version and Update now', async () => {
    await mount(fixed('available'));
    expect(text()).toContain('AgentLink 0.5.3 is available');
    expect(button('Update now')).toBeDefined();
    expect(text()).not.toContain('Drag AgentLink to the Applications folder');
  });

  it('Up to date', async () => {
    await mount(fixed('current', { latest: '', download: '', installable: false }));
    expect(text()).toContain('AgentLink is up to date.');
    expect(button('Update now')).toBeUndefined();
  });

  it('Update now posts once, with no body, and shows Downloading', async () => {
    let state = 'available';
    const calls = await mount(
      () => Promise.resolve(ok(at(state, state === 'downloading' ? { percent: 10 } : {}))),
      () => {
        state = 'downloading';
        return Promise.resolve(ok(at('downloading', { percent: 0 })));
      },
    );
    await act(async () => {
      button('Update now')?.click();
    });
    await settle();
    expect(calls.posts).toEqual([{ path: APP_UPDATE_INSTALL_PATH, body: undefined }]);
    expect(text()).toContain('Downloading');
  });

  it('Downloading: a progress bar with the percentage', async () => {
    await mount(fixed('downloading', { percent: 42 }));
    const bar = host.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('42');
    expect(bar?.getAttribute('aria-valuemax')).toBe('100');
    expect(text()).toContain('42%');
    expect(button('Update now')).toBeUndefined();
  });

  it('Checking the new version', async () => {
    await mount(fixed('verifying'));
    expect(text()).toContain('Checking the new version');
    expect(button('Restart now')).toBeUndefined();
  });

  it('Ready: Restart now posts once, then Restarting', async () => {
    let state = 'ready';
    const calls = await mount(
      () => Promise.resolve(ok(at(state))),
      () => {
        state = 'restarting';
        return Promise.resolve(ok(at('restarting')));
      },
    );
    expect(text()).toContain('AgentLink 0.5.3 is ready');
    expect(text()).not.toContain('waiting for your approval');
    await act(async () => {
      button('Restart now')?.click();
    });
    await settle();
    expect(calls.posts).toEqual([{ path: APP_UPDATE_RESTART_PATH, body: undefined }]);
    expect(text()).toContain('Restarting');
    expect(button('Restart now')).toBeUndefined();
  });

  it('Ready while the AI waits for the owner: says so before Restart now', async () => {
    await mount(fixed('ready', { busy: true }));
    expect(text()).toContain('waiting for your approval');
    expect(button('Restart now')).toBeDefined();
  });

  it('Restarting', async () => {
    await mount(fixed('restarting'));
    expect(text()).toContain('Restarting');
  });

  it('Couldn’t update here: the download link to the exact file, no Update now', async () => {
    await mount(fixed('install_failed', { installable: false }));
    expect(text()).toContain('Couldn’t update here. Download the new version instead.');
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Download update');
    expect(link?.getAttribute('href')).toBe(DMG);
    expect(button('Update now')).toBeUndefined();
  });

  it('updates off (placeholder key): today’s download flow, no Update now', async () => {
    await mount(fixed('available', { installable: false }));
    expect(button('Update now')).toBeUndefined();
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Download update');
    expect(link?.getAttribute('href')).toBe(DMG);
  });

  it('the page reads the in-app fields strictly', () => {
    expect(parseUpdate(at('downloading', { percent: 101 }))).toBeUndefined();
    expect(parseUpdate(at('downloading', { percent: '5' }))).toBeUndefined();
    expect(parseUpdate(at('available', { percent: 5 }))).toBeUndefined();
    expect(parseUpdate(at('ready', { installable: false }))).toBeUndefined();
    expect(parseUpdate(at('install_failed'))).toBeUndefined();
    expect(parseUpdate(at('ready', { download: 'https://evil.example/x.dmg' }))).toBeUndefined();
    expect(parseUpdate(at('ready', { install: 'npx', download: '' }))).toBeUndefined();
    expect(parseUpdate(at('ready', { busy: 'yes' }))).toBeUndefined();
    expect(parseUpdate(at('ready'))).toMatchObject({ state: 'ready', installable: true });
    expect(APP_UPDATE_PATH).toBe('/api/ui/app-update');
  });
});
