// @vitest-environment jsdom
// REL051-RET1: Settings > Storage. Sizes only: per ID, per person for the open ID, and the Inbox
// folder. No delete control exists; the page says deleting is coming and is local only. Names other
// people chose render as text; a failed read says so and offers a retry; nothing is made up.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { parseStorage, sizeWords } from './data.js';
import { StoragePage } from './index.js';

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

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const HOSTILE = '<img src=x onerror=alert(1)>';
const ANSWER = {
  status: 'ok',
  switchable: true,
  ids: [
    {
      name: 'default',
      label: 'Tali',
      current: true,
      status: 'ok',
      storeBytes: 2_000_000,
      walBytes: 500_000,
      messageBytes: 1_200_000,
      fileCount: 3,
      fileBytes: 45_000_000,
      drop: { usedBytes: 10_000_000, quotaBytes: 1_073_741_824 },
      people: [
        { name: 'Marko Novak', messageBytes: 900_000, fileCount: 2, fileBytes: 40_000_000 },
        { name: HOSTILE, messageBytes: 100_000, fileCount: 1, fileBytes: 5_000_000 },
      ],
      other: { messageBytes: 200_000, fileCount: 0, fileBytes: 0 },
    },
    {
      name: 'second',
      label: 'Second',
      current: false,
      status: 'ok',
      storeBytes: 10_000,
      walBytes: 0,
      messageBytes: 4_000,
      fileCount: 0,
      fileBytes: 0,
    },
    { name: 'third', label: 'Third', current: false, status: 'unavailable' },
  ],
  inbox: { folder: '~/AgentLink/Inbox', files: 12, bytes: 3_500_000_000, truncated: false },
};

const api = (result: ApiResult<unknown>): ApiClient =>
  ({ get: vi.fn(() => Promise.resolve(result)) }) as unknown as ApiClient;

async function mount(client: ApiClient): Promise<void> {
  await act(async () => {
    root.render(h(StoragePage, { api: client }));
  });
  await settle();
}
const text = (): string => host.textContent ?? '';

describe('Settings > Storage', () => {
  it('shows each ID, the people of the open one, and the Inbox, in plain sizes', async () => {
    await mount(api({ kind: 'ok', status: 200, data: ANSWER }));
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    const t = text();
    expect(t).toContain('Tali');
    expect(t).toContain('Open now');
    expect(t).toContain('1.2 MB'); // Tali's messages
    expect(t).toContain('45 MB'); // Tali's saved files
    expect(t).toContain('2.5 MB'); // store plus its working file
    expect(t).toContain('Marko Novak');
    expect(t).toContain('Removed people and setup messages');
    expect(t).toContain('Second');
    expect(t).toContain('Open this ID to see the sizes for each person.');
    expect(t).toContain('The sizes of this ID could not be read just now.');
    expect(t).toContain('~/AgentLink/Inbox');
    // 12 files and 3.5 GB in the folder, less the 3 files (45 MB) the ID still indexes.
    expect(t).toContain('Unassigned files in Inbox');
    expect(t).toContain('9 · 3.5 GB');
    expect(t).toContain(
      'Saved before AgentLink kept track of them. AgentLink never deletes these.',
    );
    expect(t).toContain('What AgentLink keeps on this computer.');
    expect(t).toContain('Encrypted drop this week');
    expect(t).toContain('10 MB of 1.1 GB');
  });

  it('says deleting is coming and is only on this computer; offers no delete control', async () => {
    await mount(api({ kind: 'ok', status: 200, data: ANSWER }));
    expect(text()).toContain('Deleting is coming');
    expect(text()).toContain('only remove them from this computer');
    expect(text()).toContain('the other person keeps their copy and is not told');
    const controls = [...host.querySelectorAll('button, a, input')].map((c) =>
      (c.textContent ?? '').trim().toLowerCase(),
    );
    expect(controls.some((c) => /delete|remove|clear|free up/.test(c))).toBe(false);
  });

  it('renders a name another person chose as plain text', async () => {
    await mount(api({ kind: 'ok', status: 200, data: ANSWER }));
    expect(host.querySelector('img')).toBeNull();
    expect(text()).toContain(HOSTILE);
  });

  it('never uses the banned words', async () => {
    await mount(api({ kind: 'ok', status: 200, data: ANSWER }));
    expect(text()).not.toMatch(/wallet|\bgas\b|seed phrase|transaction/i);
  });

  it('a failed read says so and Try again reads once more', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'error', status: 503 })
      .mockResolvedValueOnce({ kind: 'ok', status: 200, data: ANSWER });
    await mount({ get } as unknown as ApiClient);
    expect(text()).toContain('The sizes could not be read just now.');
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Try again');
    await act(async () => {
      retry?.click();
    });
    await settle();
    expect(get).toHaveBeenCalledTimes(2);
    expect(text()).toContain('Marko Novak');
  });

  it('a Inbox that could not be read says so', async () => {
    await mount(api({ kind: 'ok', status: 200, data: { ...ANSWER, inbox: null } }));
    expect(text()).toContain('The Inbox folder could not be read just now.');
  });
});

describe('parseStorage and sizeWords', () => {
  it('drops anything shaped wrong', () => {
    expect(parseStorage(null)).toBeUndefined();
    expect(parseStorage({ status: 'no' })).toBeUndefined();
    const view = parseStorage({
      status: 'ok',
      ids: [
        { name: 'a', label: 'A', current: true, status: 'ok', storeBytes: -1 },
        { label: 'no name' },
        { name: 'b', label: 'B', current: false, status: 'unavailable' },
      ],
      inbox: { folder: '', files: 1, bytes: 1 },
    });
    expect(view?.ids).toEqual([
      { name: 'a', label: 'A', current: true, unavailable: true },
      { name: 'b', label: 'B', current: false, unavailable: true },
    ]);
    expect(view?.inbox).toBeUndefined();
  });

  it('counts the way the computer does', () => {
    expect(sizeWords(0)).toBe('0 bytes');
    expect(sizeWords(999)).toBe('999 bytes');
    expect(sizeWords(1500)).toBe('1.5 KB');
    expect(sizeWords(2_000_000)).toBe('2 MB');
    expect(sizeWords(3_500_000_000)).toBe('3.5 GB');
  });
});
