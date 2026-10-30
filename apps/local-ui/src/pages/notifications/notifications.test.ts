// @vitest-environment jsdom
// W4-SETTINGS-ADVANCED (S0): Settings › Notifications is a "not yet" page, honest about it.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotificationsPage } from './index.js';
import { NOTIFICATIONS_STRINGS as S } from './strings.js';

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

describe('Notifications', () => {
  it('has one h1, says it is not available yet and offers nothing to switch', async () => {
    await act(async () => root.render(h(NotificationsPage)));
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent).toBe(S.title);
    expect(host.textContent).toContain(S.notYet);
    expect(host.querySelector('input, button[role="switch"]')).toBeNull();
  });
  it('uses plain words (11 §5)', () => {
    expect(lintVocabulary(JSON.stringify(S))).toEqual([]);
  });
});
