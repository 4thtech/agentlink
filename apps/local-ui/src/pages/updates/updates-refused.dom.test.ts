// @vitest-environment jsdom
// UPD-BUTTON-FIX (0.5.6): when "Update now" or "Restart now" is refused or fails, the page says so in
// one plain line (11 §5) instead of silently drawing the same card again. The card, its button and
// "Your IDs, people and messages stay as they are." stay; a click again clears the line.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
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

const DMG =
  'https://github.com/4thtech/agentlink/releases/download/v0.5.6/AgentLink-0.5.6-mac-arm64.dmg';
const at = (state: string): Record<string, unknown> => ({
  current: '0.5.5',
  latest: '0.5.6',
  download: DMG,
  install: 'desktop',
  installable: true,
  percent: 0,
  busy: false,
  state,
});
const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });

async function mount(
  state: string,
  post: (path: string) => Promise<ApiResult<unknown>>,
): Promise<void> {
  const api = {
    get: () => Promise.resolve(ok(at(state))),
    post: (path: string) => post(path),
  } as unknown as ApiClient;
  await act(async () => {
    root.render(h(UpdatesPage, { api, pollMs: 0 }));
  });
  await settle();
}
const text = (): string => host.textContent ?? '';
const button = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);
const alert = (): string =>
  [...host.querySelectorAll('[role="alert"]')].map((n) => n.textContent ?? '').join(' ');
async function click(label: string): Promise<void> {
  await act(async () => {
    button(label)?.click();
  });
  await settle();
}

describe('Settings › Updates: a refused Update now or Restart now (UPD-BUTTON-FIX)', () => {
  it.each<[string, ApiResult<unknown>]>([
    ['the gate refused it (415)', { kind: 'error', status: 415 }],
    ['the session ended', { kind: 'session_expired' }],
    ['forbidden', { kind: 'forbidden' }],
    ['the desk did not start (the same state again)', ok(at('available'))],
  ])('Update now, %s: a plain error, the card stays', async (_name, answer) => {
    await mount('available', () => Promise.resolve(answer));
    expect(alert()).toBe('');
    await click(S.updateNow);
    expect(alert()).toContain(S.updateFailed);
    expect(button(S.updateNow)).toBeDefined();
    expect(text()).toContain(S.keeps);
  });

  it('Update now when the app does not answer: a plain error', async () => {
    await mount('available', () => Promise.resolve({ kind: 'offline' }));
    await click(S.updateNow);
    expect(alert()).toContain(S.updateFailed);
  });

  it('Update now, a request that throws: a plain error', async () => {
    await mount('available', () => Promise.reject(new Error('boom')));
    await click(S.updateNow);
    expect(alert()).toContain(S.updateFailed);
    expect(alert()).not.toContain('boom');
  });

  it('Restart now refused: a plain error, Restart now stays', async () => {
    await mount('ready', () => Promise.resolve({ kind: 'error', status: 415 }));
    await click(S.restartNow);
    expect(alert()).toContain(S.restartFailed);
    expect(button(S.restartNow)).toBeDefined();
    expect(text()).toContain(S.keeps);
  });

  it('a second click clears the line while it is sent again', async () => {
    let answer: ApiResult<unknown> = { kind: 'error', status: 500 };
    await mount('available', () => Promise.resolve(answer));
    await click(S.updateNow);
    expect(alert()).toContain(S.updateFailed);
    answer = ok(at('downloading'));
    await click(S.updateNow);
    expect(alert()).not.toContain(S.updateFailed);
  });
});
