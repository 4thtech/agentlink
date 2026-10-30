// @vitest-environment jsdom
// W4-SHELL-V2 (Decisions 49–51; W4 UX v2 "three layers"; prototype v23 A4/A8/A9/A10/A11): the shell.
// - Top bar: the mark, the agent chip (letter icon with a live dot, name, one plain status) and its
//   live dropdown ("Your agents · live": per agent its status and per AI app a dot and a word;
//   "Another AI app" with Connect; Add agent; Manage agents); Go to (Cmd+K); "?" Help (Get started,
//   Keyboard shortcuts, User guide, Report a problem); the "Under the hood" switch, top right.
// - Section menu: a minimized rail (Home, Agents, Activity, Settings) with an arrow that expands it;
//   the Advanced group only while Under the hood is on; on a phone a bar whose arrow opens a sheet.
// - Under the hood is kept by the local app (GET/PUT /api/ui/ui-settings), with a one-time import of
//   this browser's old switch; Cmd+Shift+U toggles it; the live status strip shows while it is on.
// - Same routes in both layers; the gear menu and the Inbox/Contacts destinations are gone.
// - Kept: the status bar (one polite live region), the skip link, Cmd+K, switching without reload.
import { UI_SETTINGS_PATH } from '@4thtech-io/types/ui-contract/ui-settings';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_POLL_MS, resetLiveForTests } from '../api/live.js';
import {
  getPrefs,
  PREFS_KEY,
  resetPrefsForTests,
  resetUiSettingsForTests,
} from '../prefs/index.js';
import { AppRoutes } from '../router.js';
import { setConnectionState } from './index.js';
import { stripItems } from './status-strip.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

interface World {
  /** False: the page is bound to one agent (outside the app host). */
  switchable?: boolean;
  current: string;
  generation: number;
  switches: string[];
  /** What the app holds in ui-settings.json. */
  settings: Record<string, boolean>;
  puts: Record<string, boolean>[];
  agentReads: number;
  /** Claude Code runs for `default`. */
  running: boolean;
  requests: string[];
}

const world = (over: Partial<World> = {}): World => ({
  current: 'default',
  generation: 1,
  switches: [],
  settings: {},
  puts: [],
  agentReads: 0,
  running: true,
  requests: [],
  ...over,
});

const agentsOf = (w: World) => ({
  switchable: true,
  generation: w.generation,
  current: w.current,
  label: w.current === 'default' ? "Tali's agent" : 'Work agent',
  agents: [
    {
      name: 'default',
      label: "Tali's agent",
      current: w.current === 'default',
      available: true,
      removing: false,
      contacts: 2,
      running: w.running,
      apps: ['Claude Code'],
    },
    {
      name: 'work',
      label: 'Work agent',
      current: w.current === 'work',
      available: true,
      removing: false,
      contacts: 0,
      running: false,
      apps: ['Cursor'],
    },
    {
      name: 'notes',
      label: 'Notes',
      current: false,
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
  ],
};

let narrow = false;

function serve(w: World): void {
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
    w.requests.push(`${method} ${url.pathname}`);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'X-AgentLink-Generation': String(w.generation) },
      });
    if (url.pathname === '/api/ui/agents' && method === 'GET') {
      w.agentReads += 1;
      return json(w.switchable === false ? { switchable: false, agents: [] } : agentsOf(w));
    }
    if (url.pathname === '/api/ui/apps' && method === 'GET') return json(APPS);
    if (url.pathname === UI_SETTINGS_PATH && method === 'GET') return json(w.settings);
    if (url.pathname === UI_SETTINGS_PATH && method === 'PUT') {
      const headers = new Headers(init?.headers);
      expect(headers.get('content-type')).toBe('application/octet-stream');
      const body = JSON.parse(String(init?.body)) as Record<string, boolean>;
      w.puts.push(body);
      w.settings = { ...w.settings, ...body };
      return json(w.settings);
    }
    if (url.pathname === '/api/ui/agents/switch' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { name: string };
      w.switches.push(body.name);
      w.current = body.name;
      w.generation += 1;
      return json({ status: 'done', generation: w.generation, current: body.name });
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

const q = <T extends Element = HTMLElement>(sel: string): T | null => host.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string): T[] => [
  ...host.querySelectorAll<T>(sel),
];
const chip = (): HTMLButtonElement | null => q<HTMLButtonElement>('button.al-chip');
const hood = (): HTMLButtonElement | null => q<HTMLButtonElement>('button[role="switch"]');
const rail = (): HTMLElement | null => q('nav.al-rail');
const railLabels = (): string[] =>
  qa<HTMLAnchorElement>('nav.al-rail a').map((a) => a.getAttribute('aria-label') ?? '');
const button = (name: string): HTMLButtonElement | undefined =>
  qa<HTMLButtonElement>('button').find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name,
  );
const menuItems = (): HTMLElement[] => qa('[role="menuitem"]');
const click = async (el: Element | null | undefined): Promise<void> => {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
};
const key = async (init: KeyboardEventInit): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });
  await settle();
};

beforeEach(() => {
  window.localStorage.clear();
  narrow = false;
  resetPrefsForTests();
  resetUiSettingsForTests();
  resetLiveForTests();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetUiSettingsForTests();
  resetLiveForTests();
  resetPrefsForTests();
  act(() => setConnectionState('unknown'));
});

describe('the top bar (A4)', () => {
  it('has, in order: the mark, the agent chip, Go to, Help and the Under the hood switch', async () => {
    serve(world());
    await mountAt('/');
    const bar = q('header.al-top');
    expect(bar).not.toBeNull();
    const order = [
      bar?.querySelector('.al-top-brand'),
      bar?.querySelector('button.al-chip'),
      bar?.querySelector('button.al-goto-btn'),
      bar?.querySelector('button[aria-label="Help"]'),
      bar?.querySelector('button[role="switch"]'),
    ];
    expect(order.every((el) => el !== null && el !== undefined)).toBe(true);
    for (let i = 1; i < order.length; i += 1) {
      const pos = (order[i - 1] as Element).compareDocumentPosition(order[i] as Element);
      expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The gear menu of #715 is gone.
    expect(q('button[aria-label="Settings and more"]')).toBeNull();
  });

  it('the chip shows the open agent, its letter icon with a live dot and one plain status', async () => {
    serve(world());
    await mountAt('/');
    act(() => setConnectionState('connected'));
    await settle();
    expect(chip()?.querySelector('.al-agent-icon')?.textContent).toBe('T');
    expect(chip()?.querySelector('.al-agent-icon-dot.is-ready')).not.toBeNull();
    expect(chip()?.textContent).toContain("Tali's agent");
    expect(chip()?.textContent).toContain('Ready in Claude Code');
    // Its name is its visible text after "Agent:" (WCAG 2.5.3 label in name).
    expect(chip()?.hasAttribute('aria-label')).toBe(false);
    // (The letter icon is aria-hidden: the name is the text beside it.)
    expect(chip()?.querySelector('.al-chip-text')?.textContent).toBe(
      "Agent: Tali's agent Ready in Claude Code",
    );
    expect(q('button.al-goto-btn')?.hasAttribute('aria-label')).toBe(false);
    expect(q('button.al-goto-btn')?.textContent).toContain('Go to…');
  });

  it('says one truthful status: a connection that is not up wins (HOTFIX-045)', async () => {
    serve(world());
    await mountAt('/');
    act(() => setConnectionState('offline'));
    await settle();
    expect(chip()?.textContent).toContain('Not connected');
    expect(chip()?.textContent).not.toContain('Ready');
    act(() => setConnectionState('not_running'));
    await settle();
    expect(chip()?.textContent).toContain('Not running');
  });
});

describe('the live agent dropdown', () => {
  it('lists every agent with its status and, per AI app, a dot and a word', async () => {
    serve(world());
    await mountAt('/');
    await click(chip());
    const menu = q('[role="menu"]');
    expect(menu?.getAttribute('aria-label')).toBe('Agents');
    expect(menu?.textContent).toContain('Your agents · live');
    const rows = qa('.al-am-row');
    expect(rows.map((r) => r.querySelector('.al-am-name')?.textContent)).toEqual([
      "Tali's agent",
      'Work agent',
      'Notes',
    ]);
    expect(rows[0]?.querySelector('[aria-current="true"]')).not.toBeNull();
    expect(rows[0]?.textContent).toContain('Ready in Claude Code');
    expect(rows[0]?.querySelector('.al-am-app')?.textContent).toBe('Claude CodeReady');
    expect(rows[1]?.querySelector('.al-am-app')?.textContent).toBe('CursorNot running');
    expect(rows[1]?.querySelector('.al-ldot.is-off')).not.toBeNull();
    expect(rows[2]?.textContent).toContain('Not set up');
    expect(rows[2]?.querySelector('.al-agent-icon-dot.is-none')).not.toBeNull();
  });

  it('offers detected AI apps with no agent under "Another AI app", then Add agent and Manage agents', async () => {
    serve(world());
    await mountAt('/');
    await click(chip());
    expect(q('[role="menu"]')?.textContent).toContain('Another AI app');
    const free = q('[data-free-app="codex"]');
    expect(free?.textContent).toContain('Codex');
    expect(free?.querySelector('button')?.getAttribute('aria-label')).toBe('Connect Codex');
    const names = menuItems().map((m) => m.textContent?.trim());
    expect(names.slice(-2)).toEqual(['Add agent', 'Manage agents']);
    await click(menuItems().find((m) => m.textContent?.trim() === 'Manage agents'));
    expect(location.pathname).toBe('/agents');
  });

  it('updates by itself: one shared read every 5 s while the tab is visible, none while hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const w = world();
    serve(w);
    await mountAt('/');
    // The pages read the list once on their own; the shell's live store is the only timer.
    const first = w.agentReads;
    expect(first).toBeGreaterThanOrEqual(1);
    w.running = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10);
    });
    await settle();
    expect(w.agentReads).toBe(first + 1);
    expect(chip()?.textContent).toContain('Not running');
    // Hidden tab: no timer reads; visible again: a read at once.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    const hidden = w.agentReads;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_POLL_MS * 3);
    });
    expect(w.agentReads).toBe(hidden);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    expect(w.agentReads).toBeGreaterThan(hidden);
  });

  it('switching needs no Touch ID and never reloads: one POST, the chip follows', async () => {
    const w = world();
    serve(w);
    await mountAt('/activity');
    (globalThis as { __marker?: string }).__marker = 'same-document';
    await click(chip());
    await click(qa('.al-am-row button')[1]);
    expect(w.switches).toEqual(['work']);
    await settle();
    expect(location.pathname).toBe('/activity');
    expect((globalThis as { __marker?: string }).__marker).toBe('same-document');
    expect(chip()?.textContent).toContain('Work agent');
  });
});

describe('the section menu (Decision 48)', () => {
  it('is a minimized rail: Home, Agents, Activity, Settings, the current one marked', async () => {
    serve(world());
    await mountAt('/agents');
    expect(rail()?.getAttribute('aria-label')).toBe('Sections');
    expect(rail()?.dataset['expanded']).toBe('false');
    expect(railLabels()).toEqual(['Home', 'Agents', 'Activity', 'Settings']);
    expect(
      qa('nav.al-rail [aria-current="page"]').map((a) => a.getAttribute('aria-label')),
    ).toEqual(['Agents']);
    // Minimized: icons only; the name is on the link.
    expect(q('nav.al-rail .al-rail-label')).toBeNull();
    // Inbox and Contacts are no destinations any more.
    expect(railLabels()).not.toContain('Inbox');
    expect(railLabels()).not.toContain('Contacts');
  });

  it('the arrow expands it (labels show) and the app keeps the choice', async () => {
    const w = world();
    serve(w);
    await mountAt('/');
    const toggle = button('Expand menu');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await click(toggle);
    expect(rail()?.dataset['expanded']).toBe('true');
    expect(qa('nav.al-rail .al-rail-label').map((l) => l.textContent)).toEqual([
      'Collapse',
      'Home',
      'Agents',
      'Activity',
      'Settings',
    ]);
    expect(w.puts).toContainEqual({ menuExpanded: true });
    await click(button('Collapse menu'));
    expect(rail()?.dataset['expanded']).toBe('false');
  });

  it('opens expanded when the app says so', async () => {
    serve(world({ settings: { menuExpanded: true } }));
    await mountAt('/');
    expect(rail()?.dataset['expanded']).toBe('true');
  });

  it('shows the Advanced group only while Under the hood is on', async () => {
    serve(world());
    await mountAt('/');
    expect(q('nav.al-rail [role="group"]')).toBeNull();
    await click(hood());
    const group = q('nav.al-rail [role="group"]');
    expect(group?.getAttribute('aria-label')).toBe('Advanced');
    expect(
      [...(group?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('aria-label')),
    ).toEqual(['Live activity', 'Rules', 'Proofs & credits', 'Relays & network', 'Diagnostics']);
  });

  it('on a phone: a bar names the page and its arrow opens the sections as a sheet', async () => {
    narrow = true;
    serve(world());
    await mountAt('/activity');
    const bar = q<HTMLButtonElement>('.al-topnav-btn');
    expect(bar?.textContent).toBe('Activity');
    expect(bar?.getAttribute('aria-expanded')).toBe('false');
    await click(bar);
    const sheet = q('#al-section-sheet');
    expect([...(sheet?.querySelectorAll('a') ?? [])].map((a) => a.textContent)).toEqual([
      'Home',
      'Agents',
      'Activity',
      'Settings',
    ]);
    expect(sheet?.querySelector('[aria-current="page"]')?.textContent).toBe('Activity');
    await click([...(sheet?.querySelectorAll('a') ?? [])][0]);
    expect(location.pathname).toBe('/');
    expect(q('#al-section-sheet')).toBeNull();
  });

  it('marks Home on a waiting approval and names it with the count', async () => {
    serve(world());
    await mountAt('/approve/apr_AAAAAAAAAAAAAAAAAAAAAA');
    expect(q('nav.al-rail [aria-current="page"]')?.getAttribute('href')).toBe('/');
  });
});

describe('"?" Help', () => {
  it('opens Get started, Keyboard shortcuts, User guide and Report a problem', async () => {
    serve(world());
    await mountAt('/');
    await click(button('Help'));
    expect(q('[role="menu"]')?.getAttribute('aria-label')).toBe('Help');
    expect(
      menuItems().map((m) => m.textContent?.replace('⌘/', '').replace('Ctrl+/', '').trim()),
    ).toEqual(['Get started', 'Keyboard shortcuts', 'User guide', 'Report a problem']);
    const guide = menuItems()[2] as HTMLAnchorElement;
    expect(guide.getAttribute('href')).toBe('https://wiki.4thtech.io/products/agentlink');
    expect(guide.getAttribute('rel')).toContain('noopener');
    await click(menuItems()[0]);
    expect(location.pathname).toBe('/start/app');
  });

  it('Keyboard shortcuts is a modal dialog (also Cmd+/) that gives focus back on close', async () => {
    serve(world());
    await mountAt('/');
    await key({ key: '/', metaKey: true });
    const dialog = q('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.textContent).toContain('Keyboard shortcuts');
    expect(dialog?.textContent).toContain('Turn Under the hood on or off');
    await key({ key: 'Escape' });
    expect(q('[role="dialog"]')).toBeNull();
  });

  it('Report a problem sends nothing: Copy report puts the text on the clipboard', async () => {
    const w = world();
    serve(w);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mountAt('/');
    await click(button('Help'));
    await click(menuItems()[3]);
    const before = w.requests.length;
    const area = q<HTMLTextAreaElement>('.al-report-text');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      set?.call(area, 'Claude Code shows Not running');
      area?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Copy report'));
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = String((writeText.mock.calls[0] as unknown[])[0]);
    expect(text).toContain('Claude Code shows Not running');
    expect(text).toContain('Under the hood: off');
    expect(text).not.toMatch(/Tali|Work agent|~\/|nsec|0x/);
    expect(w.requests.slice(before).filter((r) => !r.startsWith('GET'))).toEqual([]);
  });
});

describe('Under the hood (kept by the app)', () => {
  it('is a switch top right, off by default, with its tooltip', async () => {
    serve(world());
    await mountAt('/');
    expect(hood()?.getAttribute('aria-checked')).toBe('false');
    expect(hood()?.textContent).toBe('Under the hood');
    expect(hood()?.getAttribute('title')).toBe(
      'Show the technical details. Nothing here changes how the app works.',
    );
    expect(q('[aria-label="Live status"]')).toBeNull();
  });

  it('turning it on saves it in the app and shows the live status strip on the same route', async () => {
    const w = world();
    serve(w);
    await mountAt('/agents');
    act(() => setConnectionState('connected'));
    await click(hood());
    expect(hood()?.getAttribute('aria-checked')).toBe('true');
    expect(getPrefs().hood).toBe(true);
    expect(w.puts).toContainEqual({ underTheHood: true });
    expect(location.pathname).toBe('/agents');
    const strip = q('[aria-label="Live status"]');
    expect(strip?.textContent).toContain('Claude Code');
    expect(strip?.textContent).toContain("Tali's agent ready");
    expect(strip?.textContent).toContain('Relay');
    expect(q('.al-app')?.getAttribute('data-hood')).toBe('on');
  });

  it('Cmd+Shift+U (Ctrl+Shift+U) toggles it', async () => {
    const w = world();
    serve(w);
    await mountAt('/');
    await key({ key: 'U', metaKey: true, shiftKey: true });
    expect(getPrefs().hood).toBe(true);
    await key({ key: 'u', ctrlKey: true, shiftKey: true });
    expect(getPrefs().hood).toBe(false);
    expect(w.puts).toEqual([{ underTheHood: true }, { underTheHood: false }]);
  });

  it("the app's stored value wins over this browser's", async () => {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ hood: false }));
    resetPrefsForTests();
    const w = world({ settings: { underTheHood: true } });
    serve(w);
    await mountAt('/');
    expect(hood()?.getAttribute('aria-checked')).toBe('true');
    expect(w.puts).toEqual([]);
  });

  it('imports this browser’s old switch once when the app has none yet', async () => {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ hood: true }));
    resetPrefsForTests();
    const w = world();
    serve(w);
    await mountAt('/');
    expect(w.puts).toEqual([{ underTheHood: true }]);
    expect(hood()?.getAttribute('aria-checked')).toBe('true');
  });

  it('Settings › Appearance and the switch are one setting (a change anywhere is saved)', async () => {
    const { setPref } = await import('../prefs/index.js');
    const w = world();
    serve(w);
    await mountAt('/settings/appearance');
    act(() => setPref('hood', true));
    await settle();
    expect(w.puts).toEqual([{ underTheHood: true }]);
    expect(hood()?.getAttribute('aria-checked')).toBe('true');
  });
});

describe('Cmd+K (kept from #715), in both modes', () => {
  const open = async () => {
    await key({ key: 'k', metaKey: true });
    return q('[role="dialog"][aria-label="Go to"]');
  };
  const options = (): string[] =>
    qa('[role="option"] .al-goto-label').map((o) => o.textContent ?? '');

  it('reaches the sections, Get started and the shortcuts; Advanced only while Under the hood is on', async () => {
    serve(world());
    await mountAt('/');
    expect(await open()).not.toBeNull();
    expect(options().slice(0, 4)).toEqual(['Home', 'Agents', 'Activity', 'Settings']);
    expect(options()).toContain('Get started');
    expect(options()).toContain('Turn on Under the hood');
    expect(options()).toContain('Keyboard shortcuts');
    expect(options()).not.toContain('Diagnostics');
    await key({ key: 'Escape' });
    await click(hood());
    await open();
    expect(options()).toContain('Turn off Under the hood');
    expect(options()).toContain('Diagnostics');
  });

  it('runs "Turn on Under the hood" as a command', async () => {
    const w = world();
    serve(w);
    await mountAt('/');
    await open();
    await click(
      qa('[role="option"]').find((o) => o.textContent?.includes('Turn on Under the hood')),
    );
    expect(getPrefs().hood).toBe(true);
    expect(w.puts).toEqual([{ underTheHood: true }]);
  });
});

describe('kept from today', () => {
  it('the status bar: one polite live region with the state in words', async () => {
    serve(world());
    await mountAt('/');
    act(() => setConnectionState('connected'));
    await settle();
    const live = qa('footer.al-statusbar [aria-live]');
    expect(live).toHaveLength(1);
    expect(live[0]?.textContent).toBe('Connected');
  });

  it('the skip link is the first tab stop and leads to the page', async () => {
    serve(world());
    await mountAt('/');
    const first = host.querySelector('a, button');
    expect(first?.textContent).toBe('Skip to content');
    expect(q('main#al-main')).not.toBeNull();
  });

  it('Get started and the join screen are a focused column: no top bar, menu or status bar', async () => {
    serve(world());
    await mountAt('/start/app');
    expect(q('header.al-top')).toBeNull();
    expect(rail()).toBeNull();
    expect(q('footer.al-statusbar')).toBeNull();
    expect(q('main.al-first-run')).not.toBeNull();
  });

  it('nothing in the shell carries an inline style (08 §4 CSP)', async () => {
    serve(world());
    await mountAt('/');
    await click(hood());
    await click(chip());
    const shell = [q('header.al-top'), rail(), q('[aria-label="Live status"]'), q('footer')];
    for (const part of shell) {
      expect(part?.querySelector('[style]') ?? null).toBeNull();
      expect(part?.hasAttribute('style')).toBe(false);
    }
  });
});

// ------------------------------------------------------------------------------ IR-W4-SHELL-V2-1

/** Stubs document.startViewTransition and records each call (the U0 kit uses it when present). */
function stubViewTransition(): { calls: number } {
  const seen = { calls: 0 };
  (document as unknown as { startViewTransition?: unknown }).startViewTransition = (
    update: () => void,
  ) => {
    seen.calls += 1;
    update();
    const done = Promise.resolve();
    return { finished: done, ready: done, updateCallbackDone: done, skipTransition: () => undefined };
  };
  return seen;
}
afterEach(() => {
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
});

describe('the live status strip says only what it knows (IR-1, 2)', () => {
  it('names the app\'s own state "AgentLink", never a relay it cannot see', async () => {
    serve(world());
    await mountAt('/');
    act(() => setConnectionState('connected'));
    await click(hood());
    const strip = q('[aria-label="Live status"]');
    expect(strip?.textContent).toContain('AgentLinkrunning');
    expect(strip?.textContent).not.toContain('Relay');
    act(() => setConnectionState('not_running'));
    await settle();
    expect(q('[aria-label="Live status"]')?.textContent).toContain('AgentLinknot running');
  });

  it('uses each state\'s own word (Idle, Not set up), never "not running" for them', () => {
    const agent = (state: 'idle' | 'none' | 'working') => ({
      name: 'a',
      label: 'Ana',
      current: true,
      state,
      statusText: '',
      removing: false,
      apps: [{ app: 'Codex', state, word: '' }],
    });
    expect(stripItems([agent('idle')], 'connected')[0]?.value).toBe('Ana idle');
    expect(stripItems([agent('none')], 'connected')[0]?.value).toBe('not set up');
    expect(stripItems([agent('working')], 'connected')[0]?.value).toBe('Ana working');
  });
});

describe('the agent dropdown as a menu of choices (IR-4, 9)', () => {
  it('each agent is a menuitemradio; the open one is checked; its AI apps describe it', async () => {
    serve(world());
    await mountAt('/');
    await click(chip());
    const radios = qa('[role="menuitemradio"]');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    const described = radios[0]?.getAttribute('aria-describedby') ?? '';
    expect(described).not.toBe('');
    expect(document.getElementById(described)?.textContent).toContain('Claude CodeReady');
    expect(radios[2]?.hasAttribute('aria-describedby')).toBe(false);
  });

  it('arrow keys move between the choices; Escape closes and gives focus back to the chip', async () => {
    serve(world());
    await mountAt('/');
    chip()?.focus();
    await click(chip());
    const radios = qa('[role="menuitemradio"]');
    expect(document.activeElement).toBe(radios[0]);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(radios[1]);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await settle();
    expect(q('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it('outside the app host the chip is plain words, not a menu', async () => {
    serve(world({ switchable: false }));
    await mountAt('/');
    expect(chip()).toBeNull();
    const plain = q('.al-chip.is-static');
    expect(plain?.tagName).toBe('SPAN');
    expect(plain?.textContent).toBe('Open the AgentLink app to see your agents.');
    expect(q('[aria-haspopup="menu"][aria-label^="Agent"]')).toBeNull();
  });
});

describe('the phone sheet (IR-5)', () => {
  it('focus moves in; Escape closes and gives focus back to the bar', async () => {
    narrow = true;
    serve(world());
    await mountAt('/activity');
    const bar = q<HTMLButtonElement>('.al-topnav-btn');
    bar?.focus();
    await click(bar);
    const sheet = q('#al-section-sheet');
    expect(sheet?.contains(document.activeElement)).toBe(true);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await settle();
    expect(q('#al-section-sheet')).toBeNull();
    expect(document.activeElement).toBe(bar);
  });

  it('a click outside closes it', async () => {
    narrow = true;
    serve(world());
    await mountAt('/activity');
    await click(q('.al-topnav-btn'));
    expect(q('#al-section-sheet')).not.toBeNull();
    await act(async () => {
      q('main')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await settle();
    expect(q('#al-section-sheet')).toBeNull();
  });
});

describe('motion through the U0 kit (IR-6, 7, 8)', () => {
  it('expanding the rail is one View Transition; the labels enter with the kit\'s class', async () => {
    serve(world());
    await mountAt('/');
    const vt = stubViewTransition();
    await click(button('Expand menu'));
    expect(vt.calls).toBe(1);
    expect(rail()?.dataset['expanded']).toBe('true');
    const labels = qa('nav.al-rail .al-rail-label');
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) expect(l.classList.contains('al-slide-in')).toBe(true);
  });

  it('turning Under the hood on or off morphs the same screen (one View Transition each)', async () => {
    serve(world());
    await mountAt('/agents');
    const vt = stubViewTransition();
    await click(hood());
    expect(vt.calls).toBe(1);
    await key({ key: 'u', metaKey: true, shiftKey: true });
    expect(vt.calls).toBe(2);
    expect(location.pathname).toBe('/agents');
  });

  it('Settings › Appearance turns it on with the same morph', async () => {
    const w = world();
    serve(w);
    await mountAt('/settings/appearance');
    const vt = stubViewTransition();
    await click(q('main [role="switch"]'));
    expect(vt.calls).toBe(1);
    expect(getPrefs().hood).toBe(true);
    expect(w.puts).toEqual([{ underTheHood: true }]);
  });
});
