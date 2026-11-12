// @vitest-environment jsdom
// WP-I1 (spec §4): the My IDs page: the three card kinds (open, other, no AI app), the name nudge for a
// machine name, the fit strip and its remembered hiding, the hidden kit pill. Labels stay bidi-isolated.
import { HoodProvider } from '@4thtech-io/ui';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLiveForTests } from '../../api/live.js';
import { createOwnerClient } from '../contacts/owner.js';
import { createAgentsApi } from './api.js';
import { FIT_STRIP_HIDDEN_KEY } from './fit-strip.js';
import { resetHistoryForTests } from './history.js';
import { AgentsPage, type AgentsPageProps } from './index.js';
import { machineNamed } from './parts.js';
import { resetAgentsCacheForTests } from './use-agents.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (name: string, label: string, over: Record<string, unknown> = {}) => ({
  name,
  label,
  labelled: true,
  current: false,
  available: true,
  removing: false,
  contacts: 0,
  running: false,
  state: 'offline',
  apps: [] as unknown[],
  ...over,
});
const THREE = () => [
  agent('default', 'Tali', {
    current: true,
    contacts: 3,
    state: 'working',
    running: true,
    apps: [
      { app: 'claude-code', state: 'working' },
      { app: 'claude-desktop', state: 'ready' },
    ],
  }),
  agent('macbook-agent-1', 'macbook-agent-1', {
    contacts: 1,
    state: 'ready',
    apps: [{ app: 'codex', state: 'ready' }],
  }),
  agent('work', 'Work', { apps: [{ app: 'claude-code', state: 'not_set_up' }] }),
];
const list = (agents: unknown[]) => ({
  switchable: true,
  generation: 7,
  current: 'default',
  label: 'Tali',
  agents,
});

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
  resetLiveForTests();
  resetHistoryForTests();
  localStorage.clear();
  history.replaceState(null, '', '/agents');
  answers = {
    'GET /api/ui/agents': { status: 200, body: list(THREE()) },
    'GET /api/ui/agents/card-name': { status: 200, body: { status: 'same' } },
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetLiveForTests();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function mount(props: Partial<AgentsPageProps> = {}): Promise<void> {
  const page = createElement<AgentsPageProps>(AgentsPage, {
    api: createAgentsApi({ fetch: fetchFn, token: 't' }),
    owner: createOwnerClient({ fetch: fetchFn, token: 't' }),
    fetch: fetchFn,
    reload: () => undefined,
    ...props,
  });
  await act(async () => {
    root.render(createElement(HoodProvider, { value: false }, page));
  });
  await settle();
}
const card = (name: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-agent="${name}"]`)!;
const labels = (el: ParentNode, sel: string): string[] =>
  [...el.querySelectorAll(sel)].map((e) => e.textContent?.trim() ?? '');
const foot = (el: ParentNode): string[] => labels(el, '.ag-foot button, .ag-foot a');

describe('My IDs (WP-I1)', () => {
  it('has the title and the lead', async () => {
    await mount();
    expect(host.querySelector('h1')?.textContent).toBe('My IDs');
    expect(host.textContent).toContain(
      'An ID is how one of your AI apps appears on AgentLink. The people you connect with see its name.',
    );
  });

  it('the open card: line, chips, people, Invite / Rename / Pause | Rules / Activity / More', async () => {
    await mount();
    const c = card('default');
    expect(c.textContent).toContain('Working now · this is the ID you are looking at');
    expect(labels(c, '.ag-chip')).toEqual(['CClaude CodeWorking', 'DClaude DesktopReady']);
    expect(c.querySelector('.ag-people')?.textContent).toBe('3people');
    expect(foot(c)).toEqual(['Invite someone', 'Rename', 'Pause', 'Rules', 'Activity', 'More']);
    expect(c.querySelector('[data-nudge]')).toBeNull();
  });

  it('another ID starts with Open and keeps Back up beside More', async () => {
    await mount();
    const c = card('macbook-agent-1');
    expect(c.textContent).toContain('Ready');
    expect(c.textContent).not.toContain('this is the ID you are looking at');
    expect(c.querySelector('.ag-people')?.textContent).toBe('1person');
    expect(foot(c)).toEqual(['Open', 'Invite someone', 'Rename', 'Pause', 'Back up', 'More']);
  });

  it('an ID with no AI app: Connect an AI app, Rename | Remove', async () => {
    await mount();
    const c = card('work');
    expect(c.textContent).toContain('Not used by any AI app yet');
    expect(c.textContent).toContain('No AI app is connected to this ID.');
    expect(foot(c)).toEqual(['Connect an AI app', 'Rename', 'Remove']);
  });

  it('More shows Back up, AI apps and Remove on the open card', async () => {
    await mount();
    const c = card('default');
    await act(async () => {
      [...c.querySelectorAll('button')].find((b) => b.textContent === 'More')!.click();
    });
    expect(labels(c, '[data-more] button')).toEqual(['Back up', 'AI apps', 'Remove']);
  });

  it('the name nudge shows for macbook-agent-1 and not for Tali; Rename opens the editor', async () => {
    // UX1113-QA2 N1: the editor opens in place on the open ID (another one switches first).
    answers['GET /api/ui/agents'] = {
      status: 200,
      body: {
        ...list(THREE().map((a) => ({ ...a, current: a.name === 'macbook-agent-1' }))),
        current: 'macbook-agent-1',
        label: 'macbook-agent-1',
      },
    };
    await mount();
    expect(card('default').querySelector('[data-nudge]')).toBeNull();
    const nudge = card('macbook-agent-1').querySelector<HTMLElement>('[data-nudge]')!;
    expect(nudge.textContent).toContain(
      'People see this ID as macbook-agent-1. Give it a name they will recognise, like your own.',
    );
    expect(nudge.querySelector('strong bdi')?.textContent).toBe('macbook-agent-1');
    await act(async () => {
      nudge.querySelector('button')!.click();
    });
    expect(card('macbook-agent-1').querySelector('[data-nudge]')).toBeNull();
    expect(card('macbook-agent-1').querySelector('input')).not.toBeNull();
  });

  it('UX1113-QA2: two IDs with the same name: the second one asks for a name people can tell apart', async () => {
    answers['GET /api/ui/agents'] = {
      status: 200,
      body: list([
        ...THREE(),
        agent('work-2', 'Work', { state: 'ready', apps: [{ app: 'codex', state: 'ready' }] }),
      ]),
    };
    await mount();
    expect(card('work').querySelector('[data-nudge]')).toBeNull();
    const nudge = card('work-2').querySelector<HTMLElement>('[data-nudge]')!;
    expect(nudge.textContent).toContain(
      'Another of your IDs is also called Work. Give this one a name people can tell apart.',
    );
    expect(nudge.querySelector('strong bdi')?.textContent).toBe('Work');
  });

  it('the machine-name rule', () => {
    expect(machineNamed({ label: 'macbook-agent-1', name: 'x' })).toBe(true);
    expect(machineNamed({ label: 'ci-3', name: 'x' })).toBe(true);
    expect(machineNamed({ label: 'my-agent', name: 'my-agent' })).toBe(true);
    expect(machineNamed({ label: 'Tali', name: 'default' })).toBe(false);
    expect(machineNamed({ label: 'Work 2', name: 'work' })).toBe(false);
    expect(machineNamed({ label: 'agent smith', name: 'work' })).toBe(false);
  });

  it('keeps a hostile label as text in its own bidi run', async () => {
    const rtl = '‮<img src=x onerror=alert(1)>';
    answers['GET /api/ui/agents'] = {
      status: 200,
      body: list([
        agent('x-1', rtl, {
          current: true,
          state: 'ready',
          apps: [{ app: 'codex', state: 'ready' }],
        }),
      ]),
    };
    await mount();
    expect(host.querySelector('img')).toBeNull();
    expect(card('x-1').querySelector('.ag-label bdi')?.textContent).toBe(rtl);
  });

  it('the kit pill stays hidden until the kit record exists', async () => {
    await mount();
    expect(host.querySelector('.ag-kit')).toBeNull();
    expect(host.textContent).not.toContain('Not in a kit');
  });

  it('the fit strip shows, can be hidden (remembered), and is always shown with one ID with no people', async () => {
    await mount();
    const strip = host.querySelector('.ag-fit')!;
    expect(strip.textContent).toContain('Your AI app');
    expect(strip.textContent).toContain('Their AI apps, by invite');
    await act(async () => {
      strip.querySelector<HTMLButtonElement>('.ag-fit-hide')!.click();
    });
    expect(host.querySelector('.ag-fit')).toBeNull();
    expect(localStorage.getItem(FIT_STRIP_HIDDEN_KEY)).toBe('1');
    // Remembered after a reload of the page.
    await act(async () => root.unmount());
    root = createRoot(host);
    resetAgentsCacheForTests();
    await mount();
    expect(host.querySelector('.ag-fit')).toBeNull();
    // One ID, no people: shown anyway, with no way to hide it.
    await act(async () => root.unmount());
    root = createRoot(host);
    resetAgentsCacheForTests();
    answers['GET /api/ui/agents'] = {
      status: 200,
      body: list([
        agent('default', 'Tali', {
          current: true,
          state: 'ready',
          apps: [{ app: 'codex', state: 'ready' }],
        }),
      ]),
    };
    await mount();
    expect(host.querySelector('.ag-fit')).not.toBeNull();
    expect(host.querySelector('.ag-fit-hide')).toBeNull();
  });
});
