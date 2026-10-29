// @vitest-environment jsdom
// UX2-g (S1): the Home nav dot (B-11 §27.4). While the Start here card is shown, the Home item in
// the sidebar carries a small dot; its accessible name is "Home, setup not finished". It goes with
// the card, and it never appears for a read that failed or for finished setup.
import axe from 'axe-core';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContactRow } from '../pages/contacts/data.js';
import type { StartHereReads } from '../pages/home/start-here.js';
import { Layout } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-motion');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const contact: ContactRow = {
  ref: `0x${'b'.repeat(40)}`,
  name: 'Marko',
  nameSource: 'owner',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1_760_000_000,
};
const reads = (over: Partial<StartHereReads> = {}): StartHereReads => ({
  protect: async () => true,
  contacts: async () => [],
  sent: async () => false,
  kitSaved: () => false,
  agent: async () => ({ named: true, connected: true, appName: 'Claude Code', running: true }),
  replied: async () => false,
  ...over,
});

async function mount(path: string, startHere: StartHereReads): Promise<void> {
  await act(async () => {
    root.render(
      h(Layout, {
        path,
        nextStep: async () => false,
        unseenMessages: async () => 0,
        waitingApprovals: async () => 0,
        readHealth: () => new Promise<never>(() => undefined),
        startHere,
      } as never),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}
const home = (): Element | undefined =>
  [...host.querySelectorAll('nav[aria-label="Main"] a')].find((a) =>
    a.getAttribute('href')?.endsWith('/home'),
  );

describe('Home nav dot', () => {
  it('shows a dot named "Home, setup not finished" while the card is shown', async () => {
    await mount('/settings/home', reads());
    const a = home();
    expect(a?.querySelector('.al-nav-dot')).not.toBeNull();
    expect(a?.getAttribute('aria-label')).toBe('Home, setup not finished');
  });

  it('shows it on other pages too, because setup is not finished anywhere', async () => {
    await mount('/settings/contacts', reads());
    expect(home()?.querySelector('.al-nav-dot')).not.toBeNull();
  });

  it('has no dot and the plain name when setup is finished', async () => {
    await mount(
      '/settings/home',
      reads({
        contacts: async () => [contact],
        sent: async () => true,
        replied: async () => true,
        kitSaved: () => true,
      }),
    );
    expect(home()?.querySelector('.al-nav-dot')).toBeNull();
    expect(home()?.getAttribute('aria-label')).toBeNull();
    expect(home()?.textContent).toContain('Home');
  });

  it('has no dot while the reads fail (nothing alarming, nothing guessed)', async () => {
    await mount(
      '/settings/home',
      reads({
        protect: async () => undefined,
        contacts: async () => undefined,
        sent: async () => undefined,
        agent: async () => undefined,
        replied: async () => undefined,
        kitSaved: () => undefined,
      }),
    );
    expect(home()?.querySelector('.al-nav-dot')).toBeNull();
  });

  it('does not read anything on first run', async () => {
    let called = 0;
    await mount(
      '/first-run',
      reads({
        protect: async () => {
          called += 1;
          return true;
        },
      }),
    );
    expect(called).toBe(0);
  });

  it('the dot is decoration: the name carries the meaning, and axe is clean', async () => {
    await mount('/settings/home', reads());
    expect(home()?.querySelector('.al-nav-dot')?.getAttribute('aria-hidden')).toBe('true');
    const results = await axe.run(host, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
