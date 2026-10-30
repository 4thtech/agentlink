// @vitest-environment jsdom
// W4-SETTINGS-ADVANCED (S1): Settings (A9), the list of settings with one line each, and the
// Advanced rows. Plain words (11 §5), real data only, no address, key or path of this computer.
import { HoodProvider, lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../../api/client.js';
import { resetPrefsForTests, setPref } from '../../prefs/index.js';
import { SettingsPage } from './index.js';
import { SETTINGS_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  resetPrefsForTests();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });
const answer = (path: string): ApiResult<unknown> =>
  path.includes('credits')
    ? ok({
        status: 'ok',
        proofsLeft: 245,
        balance: '$4.90',
        price: '$0.02',
        test: false,
        partial: false,
      })
    : ok({
        agent: 'running',
        relays: { connected: 2, total: 3 },
        lastSyncAt: 1700000000,
        version: '0.4.6',
      });

async function mount(
  get: (p: string) => Promise<ApiResult<unknown>> = async (p) => answer(p),
): Promise<void> {
  await act(async () => {
    root.render(h(HoodProvider, { value: false }, h(SettingsPage, { get })));
  });
}

describe('Settings', () => {
  it('has one h1 and the settings in the designed order, each a link with a line under it', async () => {
    await mount();
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent).toBe(S.title);
    const rows = [...host.querySelectorAll<HTMLAnchorElement>('a.st-row')];
    expect(rows.map((r) => r.querySelector('.st-row-title')?.textContent)).toEqual([
      S.backup.title,
      S.files.title,
      S.appearance.title,
      S.rules.title,
      S.proofs.title,
      S.notifications.title,
    ]);
    expect(rows.map((r) => r.getAttribute('href'))).toEqual([
      '/settings/backup',
      '/settings/files',
      '/settings/appearance',
      '/settings/rules',
      '/settings/proofs',
      '/settings/notifications',
    ]);
    for (const r of rows) {
      expect(r.querySelector('.st-row-line')?.textContent?.length).toBeGreaterThan(0);
    }
  });

  it('says what the credits are from the read, and does not invent them when it fails', async () => {
    await mount();
    expect(host.textContent).toContain('$4.90 in credits');
    await mount(async () => ({ kind: 'offline' }));
    expect(host.textContent).not.toContain('$');
    expect(host.textContent).toContain(S.proofs.fallback);
  });

  it('follows the theme choice on the Appearance line', async () => {
    await mount();
    expect(host.textContent).toContain(S.appearance.system);
    act(() => setPref('theme', 'dark'));
    await mount();
    expect(host.textContent).toContain(S.appearance.dark);
  });

  it('shows Notifications as not available yet', async () => {
    await mount();
    expect(host.textContent).toContain(S.notifications.line);
  });

  it('opens and closes Advanced in place, with its rows as links or plain facts', async () => {
    await mount();
    const toggle = host.querySelector<HTMLButtonElement>('button.st-row[aria-expanded]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.st-advanced')).toBeNull();
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    const labels = [...host.querySelectorAll('.st-advanced .st-adv-label')].map(
      (e) => e.textContent,
    );
    expect(labels).toEqual([
      S.advanced.activity,
      S.advanced.network,
      S.advanced.relays,
      S.advanced.invites,
    ]);
    expect(host.textContent).toContain('2 of 3 connected');
    await act(async () => toggle?.click());
    expect(host.querySelector('.st-advanced')).toBeNull();
  });

  it('shows nothing private: no relay address, key, token or local path', async () => {
    await mount();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button.st-row[aria-expanded]')?.click(),
    );
    const text = host.textContent ?? '';
    expect(text).not.toMatch(/wss?:\/\/|https?:\/\/|\/Users\/|127\.0\.0\.1|token|0x[0-9a-f]{8}/i);
  });

  it('uses plain words (11 §5)', () => {
    // "Relays" is the Advanced group's own name (spec: Relays & network); nothing else may trip.
    expect(lintVocabulary(JSON.stringify(S)).filter((w) => w !== 'nostr/relay')).toEqual([]);
  });
});
