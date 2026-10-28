// @vitest-environment jsdom
// UX2-b (S1; b11 §22): the Segmented control in the switch's visual language, with radiogroup
// semantics for values, filters and layouts, and tab semantics (ARIA APG tabs) for views that swap
// the panel below. The switch gets a quiet "Unsaved" note for draft settings (§22.5).
import axe from 'axe-core';
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ui from './index.js';

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

const mount = (el: ReactElement): void => act(() => root.render(el));
const key = (el: Element, k: string): void =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
const all = (sel: string): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(sel)];
const AXE = {
  runOnly: { type: 'tag' as const, values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
  rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
};

const OPTIONS = [
  { value: 'in', label: 'Inbox' },
  { value: 'out', label: 'Sent' },
];
const THREE = [
  { value: 'a', label: 'Received', badge: h('span', { className: 'al-count' }, '2') },
  { value: 'b', label: 'Sent' },
  { value: 'c', label: 'Send folders' },
];
const tabs = (extra: Record<string, unknown> = {}): ReactElement =>
  h(ui.Segmented, {
    label: 'Messages shown',
    variant: 'tabs',
    idPrefix: 'ms',
    panelId: 'ms-panel',
    options: OPTIONS,
    defaultValue: 'in',
    ...extra,
  });

describe('Segmented with tab semantics', () => {
  it('is a tablist of tabs with aria-selected, ids and aria-controls', () => {
    mount(tabs());
    const list = host.querySelector('[role="tablist"]');
    expect(list?.getAttribute('aria-label')).toBe('Messages shown');
    expect(list?.classList.contains('al-seg')).toBe(true);
    const t = all('[role="tab"]');
    expect(t.map((x) => x.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(t.map((x) => x.id)).toEqual(['ms-tab-in', 'ms-tab-out']);
    expect(t.every((x) => x.getAttribute('aria-controls') === 'ms-panel')).toBe(true);
    expect(host.querySelector('[role="radio"], [role="radiogroup"]')).toBeNull();
    expect(host.querySelectorAll('[role="tab"] svg')).toHaveLength(1); // the check icon, chosen only
  });

  it('has one tab stop; arrows wrap and select; Home and End jump; focus follows', () => {
    const onChange = vi.fn();
    mount(
      h(ui.Segmented, {
        label: 'Files',
        variant: 'tabs',
        idPrefix: 'fl',
        panelId: 'fl-p',
        options: THREE,
        defaultValue: 'a',
        onChange,
      }),
    );
    const t = all('[role="tab"]');
    expect(t.map((x) => x.tabIndex)).toEqual([0, -1, -1]);
    key(t[0]!, 'ArrowLeft');
    expect(onChange).toHaveBeenLastCalledWith('c');
    expect(document.activeElement).toBe(t[2]);
    expect(t[2]!.getAttribute('aria-selected')).toBe('true');
    key(t[2]!, 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('a');
    key(t[0]!, 'End');
    expect(onChange).toHaveBeenLastCalledWith('c');
    key(t[2]!, 'Home');
    expect(onChange).toHaveBeenLastCalledWith('a');
    expect(document.activeElement).toBe(t[0]);
    expect(t.map((x) => x.tabIndex)).toEqual([0, -1, -1]);
  });

  it('keeps a badge inside its option', () => {
    mount(
      h(ui.Segmented, {
        label: 'Files',
        variant: 'tabs',
        idPrefix: 'fl',
        panelId: 'fl-p',
        options: THREE,
        defaultValue: 'b',
      }),
    );
    expect(all('[role="tab"]')[0]!.querySelector('.al-count')?.textContent).toBe('2');
  });

  it('has no axe violation next to its panel', async () => {
    mount(
      h(
        'main',
        null,
        tabs(),
        h('div', { id: 'ms-panel', role: 'tabpanel', 'aria-labelledby': 'ms-tab-in' }, 'Panel'),
      ),
    );
    expect((await axe.run(host, AXE)).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe('Segmented with radiogroup semantics (values, filters, layouts)', () => {
  it('stays a radiogroup by default and also gets Home and End', () => {
    const onChange = vi.fn();
    mount(h(ui.Segmented, { label: 'Filter', options: THREE, defaultValue: 'b', onChange }));
    expect(host.querySelector('[role="radiogroup"].al-seg')).not.toBeNull();
    const r = all('[role="radio"]');
    key(r[1]!, 'End');
    expect(onChange).toHaveBeenLastCalledWith('c');
    key(r[2]!, 'Home');
    expect(onChange).toHaveBeenLastCalledWith('a');
  });

  it('shows the choice with a check icon on the chosen option only, never by tint alone', () => {
    mount(h(ui.Segmented, { label: 'Filter', options: THREE, defaultValue: 'b' }));
    const r = all('[role="radio"]');
    expect(r.map((x) => x.querySelectorAll('svg').length)).toEqual([0, 1, 0]);
    expect(r.map((x) => x.classList.contains('is-on'))).toEqual([false, true, false]);
  });

  it('tells the stylesheet how many options there are and which one is chosen', () => {
    mount(h(ui.Segmented, { label: 'Filter', options: THREE, defaultValue: 'c' }));
    const seg = host.querySelector<HTMLElement>('.al-seg')!;
    expect(seg.dataset['count']).toBe('3');
    expect(seg.dataset['index']).toBe('2');
    key(all('[role="radio"]')[2]!, 'ArrowRight');
    expect(seg.dataset['index']).toBe('0');
    expect(seg.getAttribute('style')).toBeNull(); // CSP: no inline styles
  });

  it('has no axe violation', async () => {
    mount(h('main', null, h(ui.Segmented, { label: 'Filter', options: THREE, defaultValue: 'a' })));
    expect((await axe.run(host, AXE)).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe('Switch note (Unsaved)', () => {
  it('shows the note beside the switch and describes the switch with it', () => {
    mount(
      h(ui.Switch, {
        label: 'Auto-accept',
        description: 'Off by default.',
        checked: true,
        note: 'Unsaved',
      }),
    );
    const sw = host.querySelector('[role="switch"]')!;
    const note = host.querySelector('.al-switch-note')!;
    expect(note.textContent).toBe('Unsaved');
    expect(note.classList.contains('al-text-caption')).toBe(true);
    expect(sw.getAttribute('aria-describedby')).toContain(note.id);
  });
  it('shows nothing when there is no note', () => {
    mount(h(ui.Switch, { label: 'Auto-accept', checked: false }));
    expect(host.querySelector('.al-switch-note')).toBeNull();
  });
  it('has no axe violation with a note', async () => {
    mount(h('main', null, h(ui.Switch, { label: 'Auto-accept', checked: true, note: 'Unsaved' })));
    expect((await axe.run(host, AXE)).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
