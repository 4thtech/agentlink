// @vitest-environment jsdom
// W4-SHELL-LIVE (U1-b; W4 UX v2 "Live status", Layer 2 agent dropdown and Layer 3 status strip;
// 08 §1 words): the owner's bug, in the app. Quitting Claude Code shows "Not running · last seen …"
// in the agent dropdown and the chip without a reload; starting it shows "Ready", and a tool call
// "Working" with the U0 pulse. The status strip names, per AI app, its heartbeat and the agent in it,
// and nothing it cannot know (no latency, queue, credits or last proof without a read).
import { EVENTS_PATH, type LiveAgentRecord } from '@4thtech-io/types/ui-contract/live';
import { UI_SETTINGS_PATH } from '@4thtech-io/types/ui-contract/ui-settings';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLiveForTests } from '../api/live.js';
import { resetPrefsForTests, resetUiSettingsForTests } from '../prefs/index.js';
import { AppRoutes } from '../router.js';
import { setConnectionState } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Math.floor(Date.now() / 1000);

let host: HTMLElement;
let root: Root;
let push: ((text: string) => void) | undefined;
let documents = 0;

const tali = (over: Partial<LiveAgentRecord> = {}): LiveAgentRecord => ({
  name: 'default',
  label: "Tali's agent",
  current: true,
  removing: false,
  state: 'ready',
  apps: [
    { app: 'claude-code', state: 'ready', since: NOW - 30 },
    { app: 'codex', state: 'not_set_up' },
  ],
  ...over,
});
const work = (over: Partial<LiveAgentRecord> = {}): LiveAgentRecord => ({
  name: 'work',
  label: 'Work agent',
  current: false,
  removing: false,
  state: 'offline',
  apps: [{ app: 'codex', state: 'not_running' }],
  ...over,
});

function serve(settings: Record<string, boolean> = {}): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
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
        headers: { 'X-AgentLink-Generation': '1' },
      });
    if (url.pathname === '/api/ui/agents' && method === 'GET') {
      return json({
        switchable: true,
        generation: 1,
        current: 'default',
        label: "Tali's agent",
        agents: [tali(), work()].map((r) => ({
          ...r,
          labelled: true,
          available: true,
          contacts: 1,
          running: r.state === 'ready',
        })),
      });
    }
    if (url.pathname === '/api/ui/apps' && method === 'GET') {
      return json({
        desktopRunning: false,
        apps: [
          { app: 'claude-code', name: 'Claude Code', state: 'connected', agent: 'default' },
          { app: 'codex', name: 'Codex', state: 'connected', agent: 'work' },
        ],
      });
    }
    if (url.pathname === UI_SETTINGS_PATH) return json(settings);
    if (url.pathname === EVENTS_PATH) {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          push = (text) => c.enqueue(encoder.encode(text));
        },
      });
      return new Response(body, { status: 200, headers: { 'X-AgentLink-Generation': '1' } });
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

async function send(event: string, data: unknown, id: string): Promise<void> {
  expect(push, 'the events stream is open').toBeDefined();
  await act(async () => {
    push?.(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
  await settle();
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => host.querySelector<T>(sel);
const qa = (sel: string): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(sel)];
const chip = (): HTMLButtonElement | null => q<HTMLButtonElement>('button.al-chip');
const appLines = (row: number): string[] =>
  (qa('.al-am-row')[row]?.querySelectorAll('.al-am-app') ?? []).length === 0
    ? []
    : [...(qa('.al-am-row')[row]?.querySelectorAll<HTMLElement>('.al-am-app') ?? [])].map(
        (l) => l.textContent ?? '',
      );

beforeEach(() => {
  window.localStorage.clear();
  resetPrefsForTests();
  resetUiSettingsForTests();
  resetLiveForTests();
  push = undefined;
  documents = 0;
  window.addEventListener('beforeunload', () => {
    documents += 1;
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  resetUiSettingsForTests();
  resetLiveForTests();
  resetPrefsForTests();
  act(() => setConnectionState('unknown'));
});

async function mount(path = '/'): Promise<void> {
  history.replaceState(null, '', path);
  await act(async () => root.render(h(AppRoutes)));
  await settle();
  act(() => setConnectionState('connected'));
  await settle();
  (globalThis as { __marker?: string }).__marker = 'same-document';
}

describe('the agent dropdown follows the events stream (the owner’s bug)', () => {
  it('Claude Code quits: Not running · last seen, without a reload; it starts: Ready; a tool call: Working with the pulse', async () => {
    serve();
    await mount('/activity');
    await act(async () => chip()?.click());
    await settle();
    // Only the AI apps set up for an agent are listed under it (Codex is not set up for Tali's).
    expect(appLines(0)).toEqual(['Claude CodeReady']);
    expect(appLines(1)).toEqual(['CodexNot running']);

    await send(
      'agents',
      {
        agents: [
          tali({
            state: 'offline',
            lastSeenAt: NOW - 3 * 60,
            apps: [
              {
                app: 'claude-code',
                state: 'not_running',
                since: NOW - 3 * 60,
                lastSeenAt: NOW - 3 * 60,
              },
            ],
          }),
        ],
        at: NOW,
      },
      'B.1',
    );
    expect(q('[role="menu"]'), 'the dropdown stays open').not.toBeNull();
    expect(appLines(0)).toEqual(['Claude CodeNot running · last seen 3 min ago']);
    expect(qa('.al-am-row')[0]?.textContent).toContain('Offline · last seen 3 min ago');
    expect(chip()?.textContent).toContain('Offline · last seen 3 min ago');

    await send(
      'agents',
      { agents: [tali({ apps: [{ app: 'claude-code', state: 'ready', since: NOW }] })], at: NOW },
      'B.2',
    );
    expect(appLines(0)).toEqual(['Claude CodeReady']);
    expect(chip()?.textContent).toContain('Ready in Claude Code');

    await send(
      'agents',
      {
        agents: [
          tali({ state: 'working', apps: [{ app: 'claude-code', state: 'working', since: NOW }] }),
        ],
        at: NOW,
      },
      'B.3',
    );
    expect(appLines(0)).toEqual(['Claude CodeWorking']);
    expect(qa('.al-am-row')[0]?.querySelector('.al-am-app .al-pulse')).not.toBeNull();
    expect(chip()?.textContent).toContain('Working in Claude Code');

    expect(location.pathname).toBe('/activity');
    expect((globalThis as { __marker?: string }).__marker).toBe('same-document');
    expect(documents).toBe(0);
  });

  it('an AI app outside the table reads "Another AI app"', async () => {
    serve();
    await mount();
    await send(
      'agents',
      {
        agents: [work({ state: 'idle', apps: [{ app: 'other', state: 'idle', since: NOW }] })],
        at: NOW,
      },
      'B.1',
    );
    await act(async () => chip()?.click());
    await settle();
    expect(appLines(1)).toEqual(['Another AI appIdle']);
  });
});

describe('the live status strip (Under the hood)', () => {
  it('per AI app its heartbeat and the agent in it, live; nothing it has no read for', async () => {
    serve({ underTheHood: true });
    await mount();
    const strip = (): string => q('[aria-label="Live status"]')?.textContent ?? '';
    expect(strip()).toContain("Claude CodeTali's agent ready");
    await send(
      'agents',
      {
        agents: [
          tali({ state: 'working', apps: [{ app: 'claude-code', state: 'working', since: NOW }] }),
        ],
        at: NOW,
      },
      'B.1',
    );
    expect(strip()).toContain("Claude CodeTali's agent working");
    expect(q('[aria-label="Live status"] .al-pulse')).not.toBeNull();
    // No read carries relay latency, the outgoing queue, credits or the last proof yet: not shown.
    expect(strip()).not.toMatch(/ms\b|queue|credit|proof|relay/i);
  });

  it('keeps its items in place while the first answer arrives (no items before it)', async () => {
    serve({ underTheHood: true });
    // Hold the agents read: the strip shows its (fixed height) region, but no item yet that the AI
    // apps would push along when they arrive (a layout shift).
    const real = globalThis.fetch;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/ui/agents')) await held;
      return real(input, init);
    });
    await mount();
    expect(q('[aria-label="Live status"]')).not.toBeNull();
    expect(qa('[aria-label="Live status"] li')).toEqual([]);
    release();
    await settle();
    const items = qa('[aria-label="Live status"] li').map((li) => li.textContent);
    // The AI apps come first, then AgentLink; never AgentLink alone that the apps then push along.
    expect(items[items.length - 1]).toContain('AgentLink');
    expect(items[0]).toContain('Claude Code');
  });
});
