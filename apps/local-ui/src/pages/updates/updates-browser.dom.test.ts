// @vitest-environment jsdom
// BROWSER-UPDATE: Settings › Updates in the browser app (the local app server): "Update now" →
// Downloading → Checking the new version → "Restart now" → Restarting (the new version opens in a
// new tab), with the fixed "quit and reopen your AI apps" line. A failed update or a global install
// this user cannot write shows the steps and fixed commands instead. Never a link.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { APP_UPDATE_INSTALL_PATH, APP_UPDATE_PATH, APP_UPDATE_RESTART_PATH, parseUpdate } from './data.js';
import { UpdatesPage } from './index.js';
import { UPDATES_STRINGS as S } from './strings.js';

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

const base = {
  current: '0.5.5',
  latest: '0.5.6',
  download: '',
  install: 'npx',
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

async function mount(
  get: (path: string) => Promise<ApiResult<unknown>>,
  post: (path: string) => Promise<ApiResult<unknown>> = () => Promise.resolve(ok(at('available'))),
): Promise<string[]> {
  const posts: string[] = [];
  const api = {
    get,
    post: (path: string) => {
      posts.push(path);
      return post(path);
    },
  } as unknown as ApiClient;
  await act(async () => {
    root.render(h(UpdatesPage, { api, pollMs: 0 }));
  });
  await settle();
  return posts;
}
const text = (): string => host.textContent ?? '';
const button = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);

describe('parseUpdate (BROWSER-UPDATE)', () => {
  it('takes the browser app’s in-app states, never with a link', () => {
    for (const state of ['available', 'downloading', 'verifying', 'ready', 'restarting']) {
      expect(parseUpdate(at(state))).toMatchObject({ state, install: 'npx', installable: true });
      expect(
        parseUpdate(at(state, { download: 'https://github.com/4thtech/agentlink/releases/tag/v0.5.6' })),
      ).toBeUndefined();
    }
    expect(parseUpdate(at('install_failed', { installable: false }))).toMatchObject({
      state: 'install_failed',
      install: 'npx',
    });
  });
});

describe('Settings › Updates in the browser app (BROWSER-UPDATE)', () => {
  it('Update now is one POST with no body, then the page follows the update', async () => {
    let state = 'available';
    const posts = await mount(
      () => Promise.resolve(ok(at(state))),
      (path) => {
        state = path === APP_UPDATE_INSTALL_PATH ? 'ready' : 'restarting';
        return Promise.resolve(ok(at(path === APP_UPDATE_INSTALL_PATH ? 'downloading' : 'restarting')));
      },
    );
    expect(text()).toContain(S.availableTitle('0.5.6'));
    await act(async () => {
      button(S.updateNow)?.click();
    });
    await settle();
    expect(posts).toEqual([APP_UPDATE_INSTALL_PATH]);
    expect(text()).toContain(S.browserReadyLead);
    expect(text()).toContain(S.aiAppsReopen);
    await act(async () => {
      button(S.restartNow)?.click();
    });
    await settle();
    expect(posts).toEqual([APP_UPDATE_INSTALL_PATH, APP_UPDATE_RESTART_PATH]);
    expect(text()).toContain(S.browserRestarting);
    expect(text()).toContain(S.aiAppsReopen);
    expect(host.querySelector('a[href]')).toBeNull();
  });

  it('downloading shows a progress bar without a made-up percentage', async () => {
    await mount(() => Promise.resolve(ok(at('downloading'))));
    expect(text()).toContain(S.downloading);
    expect(text()).not.toContain('0%');
  });

  it('a failed update shows the steps with the fixed command instead', async () => {
    await mount(() => Promise.resolve(ok(at('install_failed', { installable: false }))));
    expect(text()).toContain(S.cantUpdateBrowser);
    expect(text()).toContain(S.npxCommand);
    expect(button(S.updateNow)).toBeUndefined();
  });

  it('a global install this user cannot write: the one update command (no Update now)', async () => {
    await mount((path) =>
      Promise.resolve(
        path === APP_UPDATE_PATH ? ok(at('available', { install: 'global', installable: false })) : ok({}),
      ),
    );
    expect(button(S.updateNow)).toBeUndefined();
    expect(text()).toContain(S.globalCommand);
  });
});
