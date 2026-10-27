// @vitest-environment jsdom
// UI-REFRESH-e (S1): Settings › Appearance (B-11 §16 row 20). Theme, reduce motion, transparency and
// "Show Under the hood by default", with a live preview tile. Route and nav entry come with card f.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPrefs, resetPrefsForTests } from '../../prefs/index.js';
import { AppearancePage } from './index.js';
import { APPEARANCE_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const rootEl = document.documentElement;
let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  for (const a of ['data-motion', 'data-transparency', 'data-theme']) rootEl.removeAttribute(a);
  resetPrefsForTests();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(h(AppearancePage)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const radio = (group: string, label: string): HTMLButtonElement => {
  const g = host.querySelector(`[role="radiogroup"][aria-label="${group}"]`) as HTMLElement;
  return [...g.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((x) =>
    x.textContent?.includes(label),
  ) as HTMLButtonElement;
};

describe('Appearance page', () => {
  it('has a heading, three choice groups, the Under the hood default and a preview tile', () => {
    expect(host.querySelector('h1')?.textContent).toBe(S.title);
    for (const g of [S.theme, S.motion, S.transparency]) {
      expect(host.querySelector(`[role="radiogroup"][aria-label="${g}"]`), g).not.toBeNull();
    }
    expect(host.querySelector('[role="switch"]')).not.toBeNull();
    expect(host.querySelector('.al-preview-tile')).not.toBeNull();
  });

  it('shows the current values (system, system, system, off)', () => {
    expect(radio(S.theme, S.system).getAttribute('aria-checked')).toBe('true');
    expect(radio(S.motion, S.system).getAttribute('aria-checked')).toBe('true');
    expect(radio(S.transparency, S.system).getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
  });

  it('applies each choice at once: root attribute, stored value', () => {
    act(() => radio(S.theme, S.light).click());
    expect(rootEl.getAttribute('data-theme')).toBe('light');
    act(() => radio(S.motion, S.on).click());
    expect(rootEl.getAttribute('data-motion')).toBe('reduced');
    act(() => radio(S.transparency, S.reduce).click());
    expect(rootEl.getAttribute('data-transparency')).toBe('reduced');
    act(() => (host.querySelector('[role="switch"]') as HTMLElement).click());
    expect(getPrefs()).toMatchObject({
      hood: true,
      theme: 'light',
      motion: 'on',
      transparency: 'reduce',
    });
    expect(host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('uses plain words (11 §5)', () => {
    expect(lintVocabulary(Object.values(S).join('\n'))).toEqual([]);
  });
});
