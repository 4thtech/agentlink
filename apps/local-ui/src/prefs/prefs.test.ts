// @vitest-environment jsdom
// UI-REFRESH-e (S1): the one preference store (B-11 §7, §14). Per browser, in localStorage inside
// try/catch; storage that throws still works. Each setting sets its root attribute.
import { HoodProvider, UnderTheHood } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREFS,
  getPrefs,
  PREFS_KEY,
  PrefsHood,
  resetPrefsForTests,
  setPref,
  usePrefs,
} from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const rootEl = document.documentElement;
const ATTRS = ['data-motion', 'data-transparency', 'data-theme'];

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  for (const a of ATTRS) rootEl.removeAttribute(a);
  resetPrefsForTests();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('preferences', () => {
  it('defaults: Under the hood off, everything follows the system, Approvals in Grid (UX2-a), no root attribute set', () => {
    expect(DEFAULT_PREFS).toEqual({
      hood: false,
      motion: 'system',
      transparency: 'system',
      theme: 'system',
      approvalsLayout: 'grid',
      activitySort: 'recent',
    });
    expect(getPrefs()).toEqual(DEFAULT_PREFS);
    for (const a of ATTRS) expect(rootEl.hasAttribute(a)).toBe(false);
  });

  it('each setting sets its root attribute and "system" removes it again', () => {
    setPref('motion', 'on');
    expect(rootEl.getAttribute('data-motion')).toBe('reduced');
    setPref('motion', 'off');
    expect(rootEl.getAttribute('data-motion')).toBe('full');
    setPref('motion', 'system');
    expect(rootEl.hasAttribute('data-motion')).toBe(false);
    setPref('transparency', 'reduce');
    expect(rootEl.getAttribute('data-transparency')).toBe('reduced');
    setPref('transparency', 'system');
    expect(rootEl.hasAttribute('data-transparency')).toBe(false);
    setPref('theme', 'light');
    expect(rootEl.getAttribute('data-theme')).toBe('light');
    setPref('theme', 'dark');
    expect(rootEl.getAttribute('data-theme')).toBe('dark');
    setPref('theme', 'system');
    expect(rootEl.hasAttribute('data-theme')).toBe(false);
  });

  it('is remembered per browser and applied again on load', () => {
    setPref('hood', true);
    setPref('theme', 'light');
    setPref('motion', 'on');
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) as string)).toMatchObject({
      hood: true,
      theme: 'light',
      motion: 'on',
    });
    for (const a of ATTRS) rootEl.removeAttribute(a);
    resetPrefsForTests();
    expect(getPrefs()).toMatchObject({ hood: true, theme: 'light', motion: 'on' });
    expect(rootEl.getAttribute('data-theme')).toBe('light');
    expect(rootEl.getAttribute('data-motion')).toBe('reduced');
  });

  it('ignores a damaged or hostile stored value', () => {
    localStorage.setItem(
      PREFS_KEY,
      '{"hood":"yes","motion":"<script>","theme":"neon","approvalsLayout":"masonry","extra":1}',
    );
    resetPrefsForTests();
    expect(getPrefs()).toEqual(DEFAULT_PREFS);
    localStorage.setItem(PREFS_KEY, 'not json');
    resetPrefsForTests();
    expect(getPrefs()).toEqual(DEFAULT_PREFS);
    expect(rootEl.hasAttribute('data-theme')).toBe(false);
  });

  it('works when storage throws on read and write', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    resetPrefsForTests();
    expect(getPrefs()).toEqual(DEFAULT_PREFS);
    expect(() => setPref('hood', true)).not.toThrow();
    expect(getPrefs().hood).toBe(true);
    setPref('theme', 'dark');
    expect(rootEl.getAttribute('data-theme')).toBe('dark');
  });

  it('works when the storage object itself throws', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('denied');
    });
    resetPrefsForTests();
    expect(getPrefs()).toEqual(DEFAULT_PREFS);
    expect(() => setPref('motion', 'on')).not.toThrow();
    expect(rootEl.getAttribute('data-motion')).toBe('reduced');
  });

  it('usePrefs re-renders on change and the panel follows the switch', () => {
    const fields = [{ kind: 'id' as const, label: 'Message ID', value: 'm-12' }];
    function Probe(): ReturnType<typeof h> {
      const p = usePrefs();
      return h('p', { 'data-hood': String(p.hood) }, h(UnderTheHood, { fields }));
    }
    act(() => root.render(h(PrefsHood, null, h(Probe))));
    expect(host.textContent).not.toContain('m-12');
    act(() => setPref('hood', true));
    expect(host.querySelector('p')?.getAttribute('data-hood')).toBe('true');
    expect(host.textContent).toContain('m-12');
    act(() => setPref('hood', false));
    expect(host.textContent).not.toContain('m-12');
  });

  it('HoodProvider is the same context the store feeds', () => {
    act(() => root.render(h(HoodProvider, { value: true }, h(UnderTheHood, { fields: [] }))));
    expect(host.textContent).toContain('Nothing technical');
  });
});
