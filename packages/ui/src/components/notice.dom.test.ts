// @vitest-environment jsdom
// The notice system (UX 2026-11-12, docs/design/notices.md): the page notice, the inline banner's
// close and the toast stack's auto-close. S1: behaviour and a11y only.
import axe from 'axe-core';
import { createElement as h, act, type ReactElement } from 'react';
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
  vi.useRealTimers();
});

const mount = (el: ReactElement): void => act(() => root.render(el));
const click = (el: Element | null): void => {
  if (el === null) throw new Error('missing element');
  act(() => (el as HTMLElement).click());
};

describe('PageNotice', () => {
  it('is a region named by its title, with its action and a labelled close', () => {
    const onDismiss = vi.fn();
    mount(
      h(
        ui.PageNotice,
        {
          tone: 'warning',
          title: 'Save your recovery kit.',
          actions: h('a', { href: '/settings/backup' }, 'Save it'),
          onDismiss,
          dismissLabel: 'Hide this',
        },
        'So you can get your contacts back.',
      ),
    );
    const section = host.querySelector('section.al-notice');
    expect(section).not.toBeNull();
    const id = section?.getAttribute('aria-labelledby') ?? '';
    expect(document.getElementById(id)?.textContent).toBe('Save your recovery kit.');
    // Persistent: not a live region, so it is not announced on every render.
    expect(section?.getAttribute('role')).toBeNull();
    expect(section?.getAttribute('aria-live')).toBeNull();
    expect(host.querySelector('.al-notice-act a')?.textContent).toBe('Save it');
    click(host.querySelector('[aria-label="Hide this"]'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('has no close unless it may be closed', () => {
    mount(h(ui.PageNotice, { title: 'Set up AgentLink' }));
    expect(host.querySelector('.al-notice-x')).toBeNull();
  });

  it('passes axe', async () => {
    mount(
      h(
        ui.PageNotice,
        { title: 'T', actions: h('button', { type: 'button' }, 'Go'), onDismiss: () => undefined },
        'Body',
      ),
    );
    const out = await axe.run(host, { rules: { 'color-contrast': { enabled: false } } });
    expect(out.violations).toEqual([]);
  });
});

describe('Banner close', () => {
  it('shows a close only with onDismiss', () => {
    mount(h(ui.Banner, { tone: 'success' }, 'Renamed.'));
    expect(host.querySelector('.al-banner-x')).toBeNull();
    const onDismiss = vi.fn();
    mount(h(ui.Banner, { tone: 'success', onDismiss }, 'Renamed.'));
    click(host.querySelector('[aria-label="Dismiss"]'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('ToastStack', () => {
  it('renders nothing when empty', () => {
    mount(h(ui.ToastStack, { items: [], onDismiss: () => undefined }));
    expect(host.innerHTML).toBe('');
  });

  it('closes a toast after its time; one with an action stays longer', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    mount(
      h(ui.ToastStack, {
        items: [
          { id: 'a', text: 'Renamed.' },
          { id: 'b', text: 'Connected again.', action: 'Check', onAction: () => undefined },
        ],
        onDismiss,
      }),
    );
    expect(host.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe('Notifications');
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(2);
    act(() => vi.advanceTimersByTime(ui.TOAST_MS));
    expect(onDismiss).toHaveBeenCalledWith('a');
    expect(onDismiss).not.toHaveBeenCalledWith('b');
    act(() => vi.advanceTimersByTime(ui.TOAST_ACTION_MS - ui.TOAST_MS));
    expect(onDismiss).toHaveBeenCalledWith('b');
  });

  it('holds while hovered, and the close and the action both close it', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const onAction = vi.fn();
    mount(
      h(ui.ToastStack, {
        items: [{ id: 1, text: 'Saved', action: 'View', onAction }],
        onDismiss,
      }),
    );
    const slot = host.querySelector('.al-toast-slot');
    act(() => {
      slot?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(ui.TOAST_ACTION_MS * 2));
    expect(onDismiss).not.toHaveBeenCalled();
    click(host.querySelector('.al-toast-act'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(1);
    click(host.querySelector('[aria-label="Dismiss"]'));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
