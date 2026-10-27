// @vitest-environment jsdom
// UI-REFRESH-f (S1): while a Sheet or dialog is open, everything behind it is inert (follow-up from
// the review of #598). Walking from the frame up to <body>, every sibling along the way gets the
// `inert` attribute; the frame and its ancestors never do; closing restores the page exactly, and a
// second layer keeps the background inert until the last one closes.
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DialogFrame, Sheet } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let outside: HTMLElement;
let host: HTMLElement;
let root: Root;
beforeEach(() => {
  outside = document.createElement('div');
  outside.id = 'outside';
  document.body.append(outside);
  host = document.createElement('div');
  host.id = 'host';
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  outside.remove();
});

function page(sheetOpen: boolean, dialogOpen = false): ReactNode {
  return h(
    'div',
    { id: 'app' },
    h('nav', { id: 'side' }, h('a', { href: '/x' }, 'x')),
    h(
      'div',
      { id: 'col' },
      h('header', { id: 'bar' }, 'bar'),
      h(
        'main',
        { id: 'content' },
        h('button', { id: 'opener' }, 'open'),
        h(Sheet, { open: sheetOpen, title: 'Detail', onClose: () => undefined }, 'body'),
        h(DialogFrame, { open: dialogOpen, title: 'Sure?', onClose: () => undefined }, 'ok'),
      ),
    ),
  );
}
const inert = (id: string): boolean => document.getElementById(id)?.hasAttribute('inert') === true;

describe('modal background is inert', () => {
  it('is not inert while nothing is open', () => {
    act(() => root.render(page(false)));
    for (const id of ['side', 'bar', 'opener', 'outside']) expect(inert(id), id).toBe(false);
  });

  it('makes the sidebar, the top bar, the rest of the page and the outside inert when a Sheet opens', () => {
    act(() => root.render(page(true)));
    for (const id of ['side', 'bar', 'opener', 'outside']) expect(inert(id), id).toBe(true);
  });

  it('never makes the Sheet or its ancestors inert', () => {
    act(() => root.render(page(true)));
    const sheet = document.querySelector('.al-sheet') as HTMLElement;
    for (let el: HTMLElement | null = sheet; el !== null; el = el.parentElement) {
      expect(el.hasAttribute('inert'), el.tagName + '#' + el.id).toBe(false);
    }
    expect(sheet.querySelector('[inert]')).toBeNull();
  });

  it('restores the page when the Sheet closes (nothing left inert)', () => {
    act(() => root.render(page(true)));
    act(() => root.render(page(false)));
    expect(document.querySelectorAll('[inert]').length).toBe(0);
  });

  it('does the same for the level-4 dialog', () => {
    act(() => root.render(page(false, true)));
    for (const id of ['side', 'bar', 'opener', 'outside']) expect(inert(id), id).toBe(true);
    expect(document.querySelector('.al-dialog')?.closest('[inert]')).toBeNull();
    act(() => root.render(page(false, false)));
    expect(document.querySelectorAll('[inert]').length).toBe(0);
  });

  it('keeps the page inert until the last of two layers closes', () => {
    act(() => root.render(page(true, true)));
    expect(inert('side')).toBe(true);
    act(() => root.render(page(true, false)));
    expect(inert('side')).toBe(true);
    act(() => root.render(page(false, false)));
    expect(document.querySelectorAll('[inert]').length).toBe(0);
  });

  it('leaves an element that was already inert before the layer as it was', () => {
    outside.setAttribute('inert', '');
    act(() => root.render(page(true)));
    act(() => root.render(page(false)));
    expect(outside.hasAttribute('inert')).toBe(true);
  });

  it('removes inert when the whole tree unmounts while open', () => {
    act(() => root.render(page(true)));
    act(() => root.render(null));
    expect(document.querySelectorAll('[inert]').length).toBe(0);
  });
});
