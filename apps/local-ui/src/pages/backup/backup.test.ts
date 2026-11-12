// @vitest-environment jsdom
// W4-SETTINGS-ADVANCED (S1): Settings › Backup & Touch ID. WP-11: the recovery kit is saved here
// (export-kit.dom.test.ts); where it can't be, the page says so and offers no button that does nothing.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../../api/client.js';
import { rememberRecoveryKitLater } from '../../states/index.js';
import { FIRST_RUN as FIRST_RUN_STRINGS } from '../first-run/strings.js';
import { START_STRINGS as HOME_STRINGS } from '../home/strings.js';
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
  it('claims no restore until restore ships (WP-0)', async () => {
    await act(async () => root.render(h(BackupPage)));
    expect(S.kitBody).toContain('Restoring from it arrives in the next update');
    expect(S.kitBody).toContain('keep the file and the code safe');
    expect(S.codeBody).toContain('Keep them apart');
    const all = JSON.stringify([S, FIRST_RUN_STRINGS.backupLost, HOME_STRINGS.kitBody]);
    expect(all).not.toMatch(/gets you back|get back in|new computer|restores everything/i);
    expect(host.textContent).not.toMatch(/gets you back|new computer/i);
  });
  it('has one h1 and a section for the recovery kit and one for Touch ID', async () => {
    await act(async () => root.render(h(BackupPage)));
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent).toBe(S.title);
    expect([...host.querySelectorAll('h2')].map((e) => e.textContent)).toEqual([
      S.kitTitle,
      S.touchTitle,
    ]);
  });
  it('reminds you when you put the recovery kit off, and not otherwise', async () => {
    await act(async () => root.render(h(BackupPage)));
    expect(host.textContent).not.toContain(S.kitPending);
    act(() => root.unmount());
    root = createRoot(host);
    rememberRecoveryKitLater();
    await act(async () => root.render(h(BackupPage)));
    expect(host.textContent).toContain(S.kitPending);
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
