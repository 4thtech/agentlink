// @vitest-environment jsdom
// W4-WIZARD (A4): the Home card "Get started · n of 3 done", exported for Home (U3). Ticks come from
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
  it('shows "Get started · 2 of 3 done", ticks for what is done and a link to the next step', async () => {
    await mount(state());
    expect(host.querySelector('h2')?.textContent).toBe(CARD.title(2, 3));
    expect(host.textContent).toContain(CARD.connect);
    expect(host.textContent).toContain(CARD.invite);
    const link = host.querySelector('a');
    expect(link?.textContent).toBe(CARD.check('Denis'));
    const segs = [...host.querySelectorAll('.st-seg')].map((s) => s.getAttribute('data-state'));
    expect(segs).toEqual(['done', 'done', 'current']);
    const result = await axe.run(host, { rules: { region: { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it('links Connect your AI app to Get started while it is not done', async () => {
    await mount(state({ appConnected: false, contacts: [] }));
    expect(host.querySelector('h2')?.textContent).toBe(CARD.title(0, 3));
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/start/app');
  });

  it('hides when the person hides it, and stays hidden in this browser', async () => {
    await mount(state());
    await act(async () => {
      host.querySelector<HTMLButtonElement>(`button[aria-label="${CARD.hide}"]`)?.click();
      await Promise.resolve();
    });
    expect(host.querySelector('section')).toBeNull();
    expect(localStorage.getItem(CARD_HIDDEN_KEY)).toBe('1');
    act(() => root.unmount());
    root = createRoot(host);
    await mount(state());
    expect(host.querySelector('section')).toBeNull();
  });

  it('shows nothing once all three are done, or while a read has no answer', async () => {
    await mount(state({ contacts: [{ ...DENIS, label: 'safety-code-checked' }] }));
    expect(host.querySelector('section')).toBeNull();
    await mount(state({ appConnected: undefined, contacts: undefined }));
    expect(host.querySelector('section')).toBeNull();
  });
});
