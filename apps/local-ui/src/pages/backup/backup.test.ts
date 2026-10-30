// @vitest-environment jsdom
// W4-SETTINGS-ADVANCED (S1): Settings › Backup & Touch ID. The recovery kit export is its own card,
// so this page says what is true today and never offers a button that does nothing.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    await act(async () => root.render(h(BackupPage)));
    expect(host.querySelector('button')).toBeNull();
  });
  it('uses plain words (11 §5)', () => {
    expect(lintVocabulary(JSON.stringify(S))).toEqual([]);
  });
});
