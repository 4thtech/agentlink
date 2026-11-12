// @vitest-environment jsdom
// W4-WIZARD (A4): the Home card "Get started · n of 2 done", exported for Home (U3). Ticks come from
// real reads; hiding it is remembered in this browser; done or unknown shows nothing.
import axe from 'axe-core';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContactRow } from '../contacts/data.js';
import { CARD_HIDDEN_KEY, GetStartedCard } from './get-started-card.js';
import type { SetupState } from './setup-state.js';
import { CARD } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DENIS: ContactRow = {
  ref: `0x${'1'.repeat(40)}`,
  name: 'Denis',
  nameSource: 'owner',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1,
};
const state = (over: Partial<SetupState> = {}): SetupState => ({
  owner: 'set_up',
  agent: true,
  appConnected: true,
  contacts: [DENIS],
  ...over,
});

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

async function mount(s: SetupState | Promise<SetupState>): Promise<void> {
  await act(async () => {
    root.render(h(GetStartedCard, { read: () => Promise.resolve(s) }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('W4-WIZARD: the Get started card (A4)', () => {
  it('shows "Get started · 1 of 2 done", ticks for what is done, a link to the next step and the 12 digits as a suggestion', async () => {
    await mount(state({ appConnected: false }));
    expect(host.querySelector('h2')?.textContent).toBe(CARD.title(1, 2));
    expect(host.textContent).toContain(CARD.connect);
    expect(host.textContent).toContain(CARD.invite);
    expect(host.querySelector('a')?.textContent).toBe(CARD.connect);
    const suggest = host.querySelector('.st-card-suggest');
    expect(suggest?.textContent).toContain(CARD.check('Denis'));
    expect(host.querySelector('ul')?.textContent).not.toContain('Contact check');
    const segs = [...host.querySelectorAll('.st-seg')].map((s) => s.getAttribute('data-state'));
    expect(segs).toEqual(['current', 'done']);
    const result = await axe.run(host, { rules: { region: { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it('links Connect your AI app to Get started while it is not done', async () => {
    await mount(state({ appConnected: false, contacts: [] }));
    expect(host.querySelector('h2')?.textContent).toBe(CARD.title(0, 2));
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/start/app');
  });

  it('W4-WIRE: links Invite someone to the Invite screen (/contacts?invite)', async () => {
    await mount(state({ contacts: [] }));
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent === CARD.invite);
    expect(link?.getAttribute('href')).toBe('/contacts?invite');
  });

  it('hides when the person hides it, and stays hidden in this browser', async () => {
    await mount(state({ contacts: [] }));
    await act(async () => {
      host.querySelector<HTMLButtonElement>(`button[aria-label="${CARD.hide}"]`)?.click();
      await Promise.resolve();
    });
    expect(host.querySelector('section')).toBeNull();
    expect(localStorage.getItem(CARD_HIDDEN_KEY)).toBe('1');
    act(() => root.unmount());
    root = createRoot(host);
    await mount(state({ contacts: [] }));
    expect(host.querySelector('section')).toBeNull();
  });

  it('shows nothing once connected with someone (the 12 digits are only a suggestion), or while a read has no answer', async () => {
    await mount(state());
    expect(host.querySelector('section')).toBeNull();
    await mount(state({ appConnected: undefined, contacts: undefined }));
    expect(host.querySelector('section')).toBeNull();
  });
});
