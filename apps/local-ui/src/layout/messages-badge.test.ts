// @vitest-environment jsdom
// UI-REFRESH-o-d: the Messages nav badge is the shared tick CountBadge, same as Approvals (11 §5).
// W4-SHELL (b11 §34.1): both live on the Inbox item: approvals waiting first ("3 waiting for you"),
// else the new messages ("3 new").
import axe from 'axe-core';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Layout } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  document.documentElement.removeAttribute('data-motion');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount(unseen: number, waiting = 0): Promise<void> {
  await act(async () => {
    root.render(
      h(Layout, {
        path: '/contacts',
        nextStep: async () => false,
        unseenMessages: async () => unseen,
        waitingApprovals: async () => waiting,
        readHealth: () => new Promise<never>(() => undefined),
      } as never),
    );
  });
}
const link = (name: string): Element | undefined =>
  [...host.querySelectorAll('nav[aria-label="Main"] a')].find((a) => a.textContent?.includes(name));

describe('Inbox nav badge', () => {
  it('uses the shared CountBadge, named for screen readers ("3 new")', async () => {
    await mount(3);
    const badge = link('Inbox')?.querySelector('.al-count');
    expect(badge).not.toBeNull();
    expect(badge?.classList.contains('al-nav-count')).toBe(true);
    expect(badge?.querySelector('.al-count-in')?.textContent).toBe('3');
    expect(badge?.textContent).toContain('3 new');
  });

  it('shows approvals waiting first, with the same component and class', async () => {
    await mount(2, 4);
    const m = link('Inbox')?.querySelector('.al-count');
    expect(m).not.toBeNull();
    expect(m?.textContent).toContain('4 waiting for you');
    expect(host.querySelectorAll('nav[aria-label="Main"] .al-count')).toHaveLength(1);
    await mount(2, 0);
    expect(link('Inbox')?.querySelector('.al-count')?.className).toBe(m?.className);
  });

  it('shows 99+ above 99 and nothing at zero', async () => {
    await mount(150);
    expect(link('Inbox')?.querySelector('.al-count-in')?.textContent).toBe('99+');
    await mount(0);
    expect(host.querySelector('nav[aria-label="Main"] .al-count, .al-nav-count')).toBeNull();
  });

  it('renders without animation under reduced motion', async () => {
    document.documentElement.setAttribute('data-motion', 'reduced');
    await mount(5);
    expect(link('Inbox')?.querySelector('.al-count-in')?.textContent).toBe('5');
    await mount(6);
    expect(link('Inbox')?.querySelector('.al-count-out')).toBeNull();
  });

  it('passes axe', async () => {
    await mount(3);
    const r = await axe.run(host, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(r.violations).toEqual([]);
  });
});
