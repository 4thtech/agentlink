// @vitest-environment jsdom
// W4-SHELL (Decision 40, Decision 44 B1; b11 §34.1, §34.2, §34.8, §29.1): the wave-4 shell.
// - The agent switcher sits top-left: first in the sidebar under the mark; at 360 (the sidebar is
//   the bottom bar) at the start of the top bar. Each agent has its letter icon, its name, one
//   status and its AI apps by name; detected AI apps that serve no agent are listed under
//   "Not connected yet" with Connect; then "New agent" and "Manage agents & apps".
// - The top bar's right end is the avatar menu: Settings, Advanced, Under the hood, Go to (Cmd+K).
// - Cmd+K reaches every page by name.
// - A switch never reloads the page: the generation guard hands the change to the app, which swaps
//   its views in place and only then adopts the new generation.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generationGuard, notifyAgentChanged } from '../api/generation.js';
import { resetPrefsForTests, getPrefs } from '../prefs/index.js';
import { AppRoutes } from '../router.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

interface World {
  current: string;
  generation: number;
  switches: string[];
}

const agentsOf = (w: World) => ({
  switchable: true,
  generation: w.generation,
  current: w.current,
  label: w.current === 'default' ? 'Ana' : 'Side project',
  agents: [
    {
      name: 'default',
      label: 'Ana',
      current: w.current === 'default',
      available: true,
      removing: false,
      contacts: 2,
      running: true,
      apps: ['Claude Code'],
    },
    {
      name: 'side',
      label: 'Side project',
      current: w.current === 'side',
      available: true,
      removing: false,
      contacts: 0,
      running: false,
      apps: [],
    },
  ],
});

const APPS = {
  desktopRunning: false,
  apps: [
    {
      app: 'claude-code',
      name: 'Claude Code',
      path: '~/.claude.json',
      state: 'connected',
      agent: 'default',
      quitFirst: false,
    },
    {
      app: 'codex',
      name: 'Codex',
      path: '~/.codex/config.toml',
      state: 'not_connected',
      quitFirst: false,
    },
    {
      app: 'cursor',
      name: 'Cursor',
      path: '~/.cursor/mcp.json',
      state: 'not_connected',
      quitFirst: false,
    },
  ],
};

function serve(w: World, narrow = false): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: narrow && q.includes('max-width'),
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'X-AgentLink-Generation': String(w.generation) },
      });
    if (url.pathname === '/api/ui/agents' && method === 'GET') return json(agentsOf(w));
    if (url.pathname === '/api/ui/apps' && method === 'GET') return json(APPS);
    if (url.pathname === '/api/ui/agents/switch' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { name: string };
      w.switches.push(body.name);
      w.current = body.name;
      w.generation += 1;
      return json({ status: 'ok' });
    }
    return json({}, 404);
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mountAt(path: string): Promise<void> {
  history.replaceState(null, '', path);
  await act(async () => root.render(h(AppRoutes)));
  await settle();
}

const switcher = (): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>('button[aria-label^="Agent: "]');
const menuItems = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const click = async (el: Element | null | undefined): Promise<void> => {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
};

beforeEach(() => {
  window.localStorage.clear();
  resetPrefsForTests();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  resetPrefsForTests();
});

describe('agent switcher (b11 §34.2)', () => {
  it('sits top-left: first in the sidebar under the mark, not in the top bar', async () => {
    serve({ current: 'default', generation: 3, switches: [] });
    await mountAt('/inbox');
    const button = switcher();
    expect(button).not.toBeNull();
    expect(button?.closest('.al-side-top')).not.toBeNull();
    expect(host.querySelector('header.al-topbar button[aria-label^="Agent: "]')).toBeNull();
  });

  it('at 360 it moves to the start of the top bar (the sidebar is the bottom bar)', async () => {
    serve({ current: 'default', generation: 3, switches: [] }, true);
    await mountAt('/inbox');
    expect(switcher()?.closest('.al-topbar-start')).not.toBeNull();
    expect(host.querySelector('.al-side-top')).toBeNull();
  });

  it('shows the open agent with its letter icon, and one status', async () => {
    serve({ current: 'default', generation: 3, switches: [] });
    await mountAt('/inbox');
    const button = switcher();
    expect(button?.getAttribute('aria-label')).toBe(
      'Agent: Ana, Claude Code, Running. Switch agent.',
    );
    expect(button?.querySelector('.al-agent-icon')?.textContent).toBe('A');
    expect(button?.querySelectorAll('.al-live-dot, .al-dot').length).toBeLessThanOrEqual(1);
  });

  it('lists every agent with its letter icon, status and AI apps by name', async () => {
    serve({ current: 'default', generation: 3, switches: [] });
    await mountAt('/inbox');
    await click(switcher());
    const rows = menuItems().filter((m) => m.querySelector('.al-agent-icon') !== null);
    expect(rows.map((r) => r.querySelector('.al-agent-icon')?.textContent)).toEqual(['A', 'S']);
    expect(rows[0]?.textContent).toContain('Ana');
    expect(rows[0]?.textContent).toContain('Claude Code');
    expect(rows[1]?.textContent).toContain('Side project');
    expect(rows[1]?.textContent).toContain('Not connected to an AI app');
    // Each row's text starts with its letter (the check mark is an icon).
    expect(rows[0]?.textContent?.trim().startsWith('A')).toBe(true);
  });

  it('lists the detected AI apps that serve no agent under "Not connected yet", each with Connect', async () => {
    serve({ current: 'default', generation: 3, switches: [] });
    await mountAt('/inbox');
    await click(switcher());
    const menu = host.querySelector('[role="menu"]') as HTMLElement;
    expect(menu.textContent).toContain('Not connected yet');
    const free = [...menu.querySelectorAll('[data-free-app]')].map((e) => e.textContent);
    expect(free).toHaveLength(2);
    expect(free[0]).toContain('Codex');
    expect(free[1]).toContain('Cursor');
    const connect = menuItems().find((m) => m.getAttribute('aria-label') === 'Connect Codex');
    await click(connect);
    expect(location.pathname).toBe('/settings/apps');
  });

  it('ends with New agent and Manage agents & apps', async () => {
    serve({ current: 'default', generation: 3, switches: [] });
    await mountAt('/inbox');
    await click(switcher());
    const words = menuItems().map((m) => m.textContent?.trim());
    expect(words.slice(-2)).toEqual(['New agent', 'Manage agents & apps']);
    await click(menuItems().find((m) => m.textContent?.trim() === 'Manage agents & apps'));
    expect(location.pathname).toBe('/settings/agents');
  });

  it('switching changes the agent in place: no reload, same route, the bar follows', async () => {
    const w: World = { current: 'default', generation: 3, switches: [] };
    serve(w);
    // The app host's guard, as main.tsx installs it, around the stubbed fetch.
    const guarded = generationGuard({
      generation: '3',
      origin: location.origin,
      fetch: window.fetch,
      onChange: (next, adopt) => {
        expect(notifyAgentChanged(next, adopt)).toBe(true);
      },
    });
    vi.stubGlobal('fetch', guarded);
    await mountAt('/contacts');
    const marker = Symbol('page');
    (window as unknown as Record<symbol, boolean>)[marker] = true;
    await click(switcher());
    await click(menuItems().find((m) => m.textContent?.includes('Side project')));
    await settle();
    expect(w.switches).toEqual(['side']);
    expect((window as unknown as Record<symbol, boolean>)[marker]).toBe(true);
    expect(location.pathname).toBe('/contacts');
    expect(switcher()?.getAttribute('aria-label')).toMatch(/^Agent: Side project,/);
    expect(host.querySelector('[role="status"].al-sr-only')?.textContent).toBe(
      'Now showing Side project',
    );
  });
});

describe('avatar menu and Settings (b11 §34.1, §34.6)', () => {
  it('the top bar ends with the avatar menu: Settings, Advanced, Under the hood, Go to', async () => {
    serve({ current: 'default', generation: 3, switches: [] });
    await mountAt('/inbox');
    const bar = host.querySelector('header.al-topbar') as HTMLElement;
    const avatar = bar.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    expect(avatar?.getAttribute('aria-label')).toBe('Settings and more');
    // Under the hood and the theme moved off the bar (B8: a calm top bar).
    expect(bar.querySelector('[role="switch"]')).toBeNull();
    expect(bar.querySelector('.al-topbar-theme')).toBeNull();
    await click(avatar);
    const words = [...host.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')].map(
      (m) => m.textContent?.trim() ?? '',
    );
    expect(words[0]).toBe('Settings');
    expect(words[1]).toBe('Advanced');
    expect(words[2]).toBe('Under the hood');
    expect(words[3]).toMatch(/^Go to/);
    await click(host.querySelector('[role="menuitem"]'));
    expect(location.pathname).toBe('/settings/apps');
  });

  it('Under the hood is a checkbox item in that menu', async () => {
    serve({ current: 'default', generation: 3, switches: [] });
    await mountAt('/inbox');
    await click(host.querySelector('button[aria-label="Settings and more"]'));
    const hood = host.querySelector('[role="menuitemcheckbox"]') as HTMLElement;
    expect(hood.getAttribute('aria-checked')).toBe('false');
    await click(hood);
    expect(getPrefs().hood).toBe(true);
  });
});

describe('Cmd+K (b11 §34.8)', () => {
  const press = async (init: KeyboardEventInit): Promise<void> => {
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    });
    await settle();
  };

  it('opens with Cmd+K or Ctrl+K and reaches a page by name', async () => {
    serve({ current: 'default', generation: 3, switches: [] });
    await mountAt('/inbox');
    await press({ key: 'k', metaKey: true });
    const dialog = host.ownerDocument.querySelector('[role="dialog"][aria-label="Go to"]');
    expect(dialog).not.toBeNull();
    const field = dialog?.querySelector('input') as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    const all = [...(dialog?.querySelectorAll('[role="option"]') ?? [])].map((o) => o.textContent);
    for (const name of [
      'Inbox',
      'Contacts',
      'AI apps',
      'Default rules',
      'Activity log',
      'Manage agents & apps',
      'New agent',
    ]) {
      expect(
        all.some((t) => t?.includes(name)),
        name,
      ).toBe(true);
    }
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(field, 'rules');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const shown = [...(dialog?.querySelectorAll('[role="option"]') ?? [])].map(
      (o) => o.textContent,
    );
    expect(shown).toEqual(['Default rules']);
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(location.pathname).toBe('/settings/rules');
    expect(host.ownerDocument.querySelector('[role="dialog"][aria-label="Go to"]')).toBeNull();
  });

  it('Ctrl+K opens it too, and Escape closes it', async () => {
    serve({ current: 'default', generation: 3, switches: [] });
    await mountAt('/contacts');
    await press({ key: 'k', ctrlKey: true });
    expect(document.querySelector('[role="dialog"][aria-label="Go to"]')).not.toBeNull();
    await press({ key: 'Escape' });
    expect(document.querySelector('[role="dialog"][aria-label="Go to"]')).toBeNull();
    expect(location.pathname).toBe('/contacts');
  });
});
