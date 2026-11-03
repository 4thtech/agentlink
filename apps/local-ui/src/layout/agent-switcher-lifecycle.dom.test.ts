// @vitest-environment jsdom
// W8-S4 (F16, F20, F21; 04 §2.5 "Finishing a removal"; 11 §5.8 "Unfinished removal"): the ID
// switcher. A half-removed ID says "{label} wasn't fully removed" with Finish removing (the finish
// sheet, no typed name); an ID no AI app uses says "Not used by any AI app" once; an ID with several
// AI apps reads "{label} · {first app} and N more" so the name never cuts mid-word.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLiveForTests } from '../api/live.js';
import { createAgentsApi } from '../pages/agents/api.js';
import type { AppsApi } from '../pages/apps/api.js';
import { AgentSwitcher } from './agent-switcher.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (name: string, label: string, over: Record<string, unknown> = {}) => ({
  name,
  label,
  current: false,
  available: true,
  removing: false,
  contacts: 0,
  running: false,
  state: 'offline',
  apps: [] as unknown[],
  ...over,
});
const LIST = {
  switchable: true,
  generation: 1,
  current: 'tali',
  label: 'Tali',
  agents: [
    row('tali', 'Tali', {
      current: true,
      running: true,
      state: 'ready',
      apps: [
        { app: 'claude-code', state: 'ready' },
        { app: 'claude-desktop', state: 'ready' },
      ],
    }),
    row('notes', 'Notes'),
    row('old', 'Old test', { removing: true }),
  ],
};

const fetchFn = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const body =
    url === '/api/ui/agents'
      ? LIST
      : url === '/api/owner/passkey'
        ? { passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' } }
        : {};
  return new Response(JSON.stringify(body), {
    status: url.startsWith('/api/ui/events') ? 404 : 200,
  });
}) as typeof fetch;

const noApps = {
  list: () => Promise.resolve({ kind: 'ok', list: { apps: [], desktopRunning: false } }),
} as unknown as AppsApi;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  resetLiveForTests();
  vi.stubGlobal('fetch', fetchFn);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetLiveForTests();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function mount(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(AgentSwitcher, {
        api: createAgentsApi({ fetch: fetchFn, token: 't' }),
        appsApi: noApps,
      }),
    );
  });
  await settle();
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button.al-chip')!.click();
  });
  await settle();
}
const plain = (el: Element | null | undefined): string =>
  (el?.textContent ?? '').replace(/[⁨⁩]/g, '');
const rowOf = (label: string): HTMLElement =>
  [...host.querySelectorAll<HTMLElement>('.al-am-row')].find((r) =>
    plain(r.querySelector('.al-am-name')).startsWith(label),
  )!;

describe('W8-S4: the ID switcher', () => {
  it('F20: several AI apps read "{label} · {first} and N more", on the chip and the row', async () => {
    await mount();
    expect(plain(host.querySelector('.al-chip-name'))).toBe('Tali · Claude Code and 1 more');
    expect(plain(rowOf('Tali').querySelector('.al-am-name'))).toBe('Tali · Claude Code and 1 more');
  });

  it('F20: an ID with no AI app says "Not used by any AI app" once', async () => {
    await mount();
    expect(plain(rowOf('Notes')).split('Not used by any AI app').length - 1).toBe(1);
  });

  it('F21: a half-removed ID says it was not fully removed, with Finish removing', async () => {
    await mount();
    const old = rowOf('Old test');
    expect(plain(old)).toContain("Old test wasn't fully removed");
    const finish = [...old.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Finish removing',
    );
    expect(finish).toBeTruthy();
    await act(async () => {
      finish!.click();
    });
    await settle();
    const sheet = document.querySelector('[role="dialog"]');
    expect(plain(sheet)).toContain('Finish removing Old test');
    expect(sheet?.querySelector('input[type="text"]')).toBeNull();
  });
});
