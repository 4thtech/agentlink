// @vitest-environment jsdom
// UI-REFRESH-t (f), found by the docs review (#623): the three choice groups on Settings › Appearance
// (Theme, Reduce motion, Transparency) carried their names only as aria labels. Each now has a visible
// label, linked to its group, as the B-11 brief shows.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetPrefsForTests } from '../../prefs/index.js';
import { AppearancePage } from './index.js';
import { APPEARANCE_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
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

function labelOf(group: HTMLElement): HTMLElement | null {
  const id = group.getAttribute('aria-labelledby');
  return id === null || id === '' ? null : document.getElementById(id);
}

describe('Appearance: visible labels', () => {
  it.each([
    ['theme', S.theme],
    ['motion', S.motion],
    ['transparency', S.transparency],
  ])('the %s group has a visible label linked to it', (_k, text) => {
    const groups = [...host.querySelectorAll<HTMLElement>('[role="radiogroup"]')];
    const group = groups.find((g) => labelOf(g)?.textContent === text);
    expect(group, `a group labelled by a visible "${text}"`).toBeDefined();
    const label = labelOf(group as HTMLElement) as HTMLElement;
    expect(label.hasAttribute('hidden')).toBe(false);
    expect(label.classList.contains('al-sr-only')).toBe(false);
    expect(host.contains(label)).toBe(true);
  });

  it('the label ids are distinct and the labels come before their groups', () => {
    const groups = [...host.querySelectorAll<HTMLElement>('[role="radiogroup"]')];
    const ids = groups.map((g) => g.getAttribute('aria-labelledby'));
    expect(ids.every((i) => i !== null && i !== '')).toBe(true);
    expect(new Set(ids).size).toBe(3);
    for (const g of groups) {
      const label = labelOf(g) as HTMLElement;
      expect(label.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('keeps the plain-words vocabulary', () => {
    expect(lintVocabulary(host.textContent ?? '')).toEqual([]);
  });
});
