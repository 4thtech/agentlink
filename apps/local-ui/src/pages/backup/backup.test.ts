// @vitest-environment jsdom
// W4-SETTINGS-ADVANCED (S1): Settings › Backup & Touch ID. WP-11: the recovery kit is saved here
// (export-kit.dom.test.ts); where it can't be, the page says so and offers no button that does nothing.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../../api/client.js';
import { rememberRecoveryKitLater } from '../../states/index.js';
import { BackupPage } from './index.js';
import { BACKUP_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
});

describe('Backup & Touch ID', () => {
  it('has one h1 and a section for the recovery kit and one for Touch ID', async () => {
    await act(async () => root.render(h(BackupPage)));
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent).toBe(S.title);
    expect([...host.querySelectorAll('h2')].map((e) => e.textContent)).toEqual([
      S.kitTitle,
      S.touchTitle,
    ]);
  });
  const record = (lastKit: unknown) => () =>
    Promise.resolve({ kind: 'ok', status: 200, data: { lastKit } } as never);
  it('reminds you only while the put-off flag is set and no kit is on record', async () => {
    await act(async () => root.render(h(BackupPage, { read: record(null) })));
    expect(host.textContent).not.toContain(S.kitPending);
    act(() => root.unmount());
    root = createRoot(host);
    rememberRecoveryKitLater();
    await act(async () => root.render(h(BackupPage, { read: record(null) })));
    expect(host.textContent).toContain(S.kitPending);
  });
  it('a kit on record ends the reminder, clears the flag and says when it was saved', async () => {
    rememberRecoveryKitLater();
    const saved = record({ at: 1_760_000_000, covers: ['Work'] });
    await act(async () => root.render(h(BackupPage, { read: saved })));
    expect(host.textContent).not.toContain(S.kitPending);
    expect(host.textContent).toContain('Last recovery kit saved on');
    expect(localStorage.length).toBe(0);
  });
  it('has no button that does nothing', async () => {
    const api: ApiClient = {
      get: () =>
        Promise.resolve({ kind: 'ok', status: 200, data: { export: 'not_available' } } as never),
      post: () => Promise.resolve({ kind: 'error', status: 404 }),
      owner: () => Promise.resolve({ kind: 'error', status: 404 }),
    };
    await act(async () =>
      root.render(h(BackupPage, { api, passkey: () => Promise.resolve(undefined) })),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelector('button')).toBeNull();
  });
  it('uses plain words (11 §5)', () => {
    expect(lintVocabulary(JSON.stringify(S))).toEqual([]);
  });
});
