// @vitest-environment jsdom
// UX1113-QA-UTH (spec §2.3, layer 3): Under the hood is the same screen with more facts. Each fact
// shown here comes from a read the page already makes; none shows in Simple mode.
import { HoodProvider } from '@4thtech-io/ui';
import { APPS_LIST } from '@4thtech-io/types/ui-contract/apps';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { createAgentsApi } from './agents/api.js';
import { AgentsPage, type AgentsPageProps } from './agents/index.js';
import { tildePath } from './apps/tilde.js';
import { resetAgentsCacheForTests } from './agents/use-agents.js';
import { AdvancedPage } from './advanced/index.js';
import { createAppsApi } from './apps/api.js';
import { AppsPage } from './apps/index.js';
import { BackupPage } from './backup/index.js';
import { createOwnerClient } from './contacts/owner.js';
import { ConnectionsMapPage } from './advanced/map.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let answers: Record<string, { status: number; body: unknown }>;
const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const a = answers[`${init?.method ?? 'GET'} ${String(input)}`] ?? { status: 404, body: {} };
  return new Response(JSON.stringify(a.body), { status: a.status });
}) as typeof fetch;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  resetAgentsCacheForTests();
  localStorage.clear();
  answers = {
    'GET /api/ui/agents': {
      status: 200,
      body: {
        switchable: true,
        generation: 3,
        current: 'personal',
        label: 'Personal',
        agents: [
          {
            name: 'personal',
            label: 'Personal',
            labelled: true,
            current: true,
            available: true,
            removing: false,
            contacts: 1,
            running: false,
            state: 'offline',
            apps: [],
          },
        ],
      },
    },
    'GET /api/ui/apps': APPS_LIST.answer,
    'GET /api/ui/agents/card-name': { status: 200, body: { status: 'same' } },
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function mount(page: ReactElement, hood: boolean): Promise<void> {
  await act(async () => {
    root.render(createElement(HoodProvider, { value: hood }, page));
  });
  await settle();
}

describe('My IDs: folder name (Under the hood only)', () => {
  const page = (): ReactElement =>
    createElement<AgentsPageProps>(AgentsPage, {
      api: createAgentsApi({ fetch: fetchFn, token: 't' }),
      owner: createOwnerClient({ fetch: fetchFn, token: 't' }),
      fetch: fetchFn,
      reload: () => undefined,
    });
  it('the table has a Folder column with the folder name', async () => {
    await mount(page(), true);
    const cell = host.querySelector('[data-hood-fact="folder"]');
    expect(cell?.textContent).toBe('personal');
    expect(host.textContent).toContain('Folder');
  });
  it('Simple mode shows no folder fact', async () => {
    await mount(page(), false);
    expect(host.querySelector('[data-hood-fact]')).toBeNull();
  });
});

describe('Relays & network', () => {
  const read = (): Promise<ApiResult<unknown>> =>
    Promise.resolve({
      kind: 'ok',
      status: 200,
      data: { relays: { connected: 2, total: 5 }, lastSyncAt: 1_759_449_600 },
    });
  it('adds counts and the exact time with the switch on', async () => {
    await mount(createElement(AdvancedPage, { read }), true);
    expect(host.querySelector('[data-hood-fact="relays-connected"] dd')?.textContent).toBe('2');
    expect(host.querySelector('[data-hood-fact="relays-known"] dd')?.textContent).toBe('5');
    expect(host.querySelector('[data-hood-fact="last-update-time"] dd')?.textContent).toBe(
      '2025-10-03T00:00:00.000Z',
    );
  });
  it('shows none of it in Simple mode', async () => {
    await mount(createElement(AdvancedPage, { read }), false);
    expect(host.querySelector('[data-hood-fact]')).toBeNull();
  });
});

describe('AI apps', () => {
  const page = (): ReactElement =>
    createElement(AppsPage, {
      api: createAppsApi({ fetch: fetchFn, token: 't' }),
      agents: createAgentsApi({ fetch: fetchFn, token: 't' }),
      owner: createOwnerClient({ fetch: fetchFn, token: 't' }),
    });
  it('lists the app id and the settings file as plain text with the switch on', async () => {
    await mount(page(), true);
    const facts = [...host.querySelectorAll('[data-hood-facts]')];
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0]?.textContent).toContain('App id');
    expect(facts[0]?.textContent).toContain('File');
  });
  it('shows none of it in Simple mode', async () => {
    await mount(page(), false);
    expect(host.querySelector('[data-hood-facts]')).toBeNull();
  });
});

describe('Backup', () => {
  it('names the kit format only with the switch on', async () => {
    await mount(createElement(BackupPage), true);
    expect(host.querySelector('[data-hood-facts]')?.textContent).toContain('ALKK v1');
    act(() => root.unmount());
    root = createRoot(host);
    await mount(createElement(BackupPage), false);
    expect(host.textContent).not.toContain('ALKK');
  });
});

describe('Connections map', () => {
  it('is the live map, not a "Coming next" stub', async () => {
    await mount(createElement(ConnectionsMapPage), true);
    expect(host.textContent).not.toContain('Coming next');
    expect(host.querySelector('h1')?.textContent).toBe('Connections map');
  });
  it('shows paths with the home folder as ~', () => {
    expect(
      tildePath('/Users/jane/Library/Application Support/Claude/claude_desktop_config.json'),
    ).toBe('~/Library/Application Support/Claude/claude_desktop_config.json');
    expect(tildePath('/home/jane/.codex/config.toml')).toBe('~/.codex/config.toml');
    expect(tildePath('C:\\Users\\jane\\x.json')).toBe('~\\x.json');
    expect(tildePath('~/.claude.json')).toBe('~/.claude.json');
  });
});
