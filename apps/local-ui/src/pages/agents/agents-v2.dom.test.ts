// @vitest-environment jsdom
// W4-AGENTS (W4 UX v2 "Agents", A8 simple and A11 fleet; 08 §1 "Pause an agent", "Live AI-app
// status"; D-141 rename words, 11 §5.8): the simple list, Pause and Resume, the rename limit, the AI
// apps panel, the fleet table Under the hood and one agent's own page. Labels are text only (I-5).
import { HoodProvider } from '@4thtech-io/ui';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLiveForTests } from '../../api/live.js';
import { createOwnerClient } from '../contacts/owner.js';
import { createAgentsApi } from './api.js';
import { resetHistoryForTests } from './history.js';
import { AgentsPage, type AgentsPageProps } from './index.js';
import { INTENT_KEY } from './intent.js';
import { resetAgentsCacheForTests } from './use-agents.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = (): number => Math.floor(Date.now() / 1000);
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
const FLEET = () => [
  agent('default', 'Personal', {
    current: true,
    contacts: 2,
    running: true,
    state: 'working',
    apps: [
      { app: 'claude-code', state: 'working', since: now() - 30 },
      { app: 'codex', state: 'not_running', lastSeenAt: now() - 600 },
    ],
  }),
  agent('work', 'Work', {
    contacts: 1,
    state: 'ready',
    apps: [{ app: 'cursor', state: 'ready' }],
  }),
  agent('research', 'Research', { state: 'offline', lastSeenAt: now() - 300 }),
  agent('invoices', 'Invoices', { state: 'paused', lastSeenAt: now() - 86_400 }),
];
const list = (agents: unknown[], over: Record<string, unknown> = {}) => ({
  switchable: true,
  generation: 7,
  current: 'default',
  label: 'Personal',
  agents,
  ...over,
});

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}
let host: HTMLElement;
let root: Root;
let calls: Call[];
let answers: Record<string, { status: number; body: unknown }>;

const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const raw = init?.body;
  calls.push({
    url,
    method,
    headers: new Headers(init?.headers),
    body:
      raw === undefined || raw === null
        ? ''
        : ArrayBuffer.isView(raw)
          ? new TextDecoder().decode(raw)
          : String(raw),
  });
  const a = answers[`${method} ${url}`] ?? { status: 404, body: {} };
  return new Response(JSON.stringify(a.body), { status: a.status });
}) as typeof fetch;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  calls = [];
  resetAgentsCacheForTests();
  resetLiveForTests();
  resetHistoryForTests();
  sessionStorage.clear();
  history.replaceState(null, '', '/agents');
  answers = {
    'GET /api/ui/agents': { status: 200, body: list(FLEET()) },
    'GET /api/owner/passkey': {
      status: 200,
      body: { passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' } },
    },
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
async function mount(hood = false, props: Partial<AgentsPageProps> = {}): Promise<void> {
  const page = createElement<AgentsPageProps>(AgentsPage, {
    api: createAgentsApi({ fetch: fetchFn, token: 't' }),
    owner: createOwnerClient({ fetch: fetchFn, token: 't' }),
    fetch: fetchFn,
    reload: () => undefined,
    ...props,
  });
  await act(async () => {
    root.render(createElement(HoodProvider, { value: hood }, page));
  });
  await settle();
}
const card = (name: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-agent="${name}"]`)!;
const button = (scope: ParentNode, text: string): HTMLButtonElement | undefined =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  );
async function click(el: Element | undefined | null): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}
async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}
async function choose(el: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}
const code = (): HTMLInputElement =>
  host.querySelector<HTMLInputElement>('input[name="owner-code"]')!;
const posts = (url: string): Call[] => calls.filter((c) => c.method === 'POST' && c.url === url);

describe('Agents, simple (A8)', () => {
  it('lists each agent with its letter icon, its label isolated, and its live line', async () => {
    await mount();
    expect(host.querySelector('h1')?.textContent).toBe('Agents');
    const personal = card('default');
    expect(personal.querySelector('.al-agent-icon')?.textContent).toBe('P');
    expect(personal.querySelector('.al-agent-icon-dot.is-working')).not.toBeNull();
    expect(personal.querySelector('bdi')?.textContent).toBe('Personal');
    expect(personal.textContent).toContain('Working in Claude Code');
    expect(personal.textContent).toContain('Not running · last seen 10 min ago');
    expect(card('work').textContent).toContain('Ready in Cursor');
    expect(card('research').textContent).toContain('Offline · last seen 5 min ago');
    expect(card('invoices').textContent).toContain('Paused');
    const add = [...host.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'New agent');
    expect(add?.getAttribute('href')).toBe('/start/app?add=agent');
  });

  it('renders a hostile label as text only', async () => {
    answers['GET /api/ui/agents'] = {
      status: 200,
      body: list([agent('x', '‮<img src=x onerror=alert(1)>', { current: true })]),
    };
    await mount();
    expect(host.querySelector('img')).toBeNull();
    expect(card('x').querySelector('bdi')?.textContent).toBe('‮<img src=x onerror=alert(1)>');
  });

  it('Pause on the open agent: one sheet, one click, no Touch ID; posts {generation}', async () => {
    answers['POST /api/ui/agents/pause'] = { status: 200, body: { status: 'paused' } };
    await mount();
    await click(button(card('default'), 'Pause'));
    expect(host.textContent).toContain('Pause Personal?');
    expect(host.textContent).toContain(
      "Your AI apps can't send or receive messages as Personal until you resume it. Nothing is deleted.",
    );
    const reads = calls.filter((c) => c.url === '/api/ui/agents').length;
    await click(button(host.querySelector('[role="dialog"]')!, 'Pause'));
    const [post] = posts('/api/ui/agents/pause');
    expect(JSON.parse(post!.body)).toEqual({ generation: 7 });
    expect(post!.headers.has('X-AgentLink-Presence')).toBe(false);
    expect(calls.filter((c) => c.url === '/api/ui/agents').length).toBeGreaterThan(reads);
  });

  it('Pause on another agent switches to it first and remembers what to do next', async () => {
    answers['POST /api/ui/agents/switch'] = { status: 200, body: { status: 'done' } };
    await mount();
    await click(button(card('work'), 'Pause'));
    expect(JSON.parse(posts('/api/ui/agents/switch')[0]!.body)).toEqual({
      name: 'work',
      generation: 7,
    });
    expect(posts('/api/ui/agents/pause')).toHaveLength(0);
    expect(JSON.parse(sessionStorage.getItem(INTENT_KEY) ?? '{}')).toEqual({
      name: 'work',
      action: 'pause',
    });
  });

  it('after the switch, the remembered Pause opens for the agent that is open now, once', async () => {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify({ name: 'work', action: 'pause' }));
    answers['GET /api/ui/agents'] = {
      status: 200,
      body: list(
        FLEET().map((a) => ({ ...a, current: a.name === 'work' })),
        { current: 'work', label: 'Work' },
      ),
    };
    await mount();
    expect(host.textContent).toContain('Pause Work?');
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });

  it('a paused open agent: the banner, and Resume with Touch ID signs agent.resume', async () => {
    answers['GET /api/ui/agents'] = {
      status: 200,
      body: list(FLEET().map((a) => (a.name === 'default' ? { ...a, state: 'paused' } : a))),
    };
    answers['POST /api/ui/agents/resume'] = { status: 200, body: { status: 'resumed' } };
    await mount();
    const banner = host.querySelector<HTMLElement>('[data-paused-banner]')!;
    expect(banner.textContent).toContain('Personal is paused');
    await click(button(banner, 'Resume with Touch ID'));
    expect(host.textContent).toContain('Resume Personal');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        code(),
        '123456',
      );
      code().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button(host, 'Confirm'));
    const [post] = posts('/api/ui/agents/resume');
    expect(post!.body).toBe('123456');
    expect(post!.headers.get('X-AgentLink-Input')).toBe('e30');
  });

  it('Rename: the D-141 words, how many contacts are told, and the limit', async () => {
    answers['POST /api/ui/agents/label'] = {
      status: 200,
      body: { status: 'done', label: 'Home', contacts: 2 },
    };
    await mount();
    await click(button(card('default'), 'Rename'));
    expect(card('default').textContent).toContain('Your contacts will see the new name.');
    await type(card('default').querySelector<HTMLInputElement>('input[type="text"]')!, 'Home');
    await click(button(card('default'), 'Rename with Touch ID'));
    await type(code(), '123456');
    await click(button(host, 'Confirm'));
    expect(host.textContent).toContain("Renamed. Your contacts will see Home next time they're online.");

    answers['POST /api/ui/agents/label'] = {
      status: 409,
      body: { error: 'rename_limited', retryAt: now() + 3600 },
    };
    await click(button(card('work'), 'Rename'));
    await type(card('work').querySelector<HTMLInputElement>('input[type="text"]')!, 'Job');
    await click(button(card('work'), 'Rename with Touch ID'));
    await type(code(), '123456');
    await click(button(host, 'Confirm'));
    expect(host.textContent).toMatch(/You can rename Work again at \S/);
  });

  it('renamed before D-141: "Contacts still see {name}" with Update contacts, once', async () => {
    answers['GET /api/ui/agents/card-name'] = {
      status: 200,
      body: { status: 'differs', cardName: 'My agent' },
    };
    answers['POST /api/ui/agents/label'] = {
      status: 200,
      body: { status: 'done', label: 'Personal', contacts: 2 },
    };
    await mount();
    const personal = card('default');
    expect(personal.textContent).toContain('Contacts still see My agent');
    await click(button(personal, 'Update contacts'));
    await type(code(), '123456');
    await click(button(host, 'Confirm'));
    const [post] = posts('/api/ui/agents/label');
    expect(post).toBeDefined();
  });

  it('AI apps: each app with its word, Connect or Disconnect, and the quit-first guidance', async () => {
    await mount();
    await click(button(card('default'), 'AI apps'));
    const panel = card('default').querySelector<HTMLElement>('[data-panel="apps"]')!;
    expect(panel.textContent).toContain('Claude Code');
    expect(panel.textContent).toContain('Working');
    expect(button(panel, 'Disconnect')).toBeDefined();
    expect(panel.textContent).toContain('Quit the AI app first, then open it again.');
    const manage = [...panel.querySelectorAll('a')].find((a) =>
      a.getAttribute('href')?.startsWith('/settings/apps?agent=default'),
    );
    expect(manage).toBeDefined();
  });

  it('Back up links to the recovery kit in Settings; Remove asks for the name', async () => {
    await mount();
    await click(button(card('work'), 'Back up'));
    const link = [...card('work').querySelectorAll('a')].find(
      (a) => a.textContent?.trim() === 'Back up recovery kit',
    );
    expect(link?.getAttribute('href')).toBe('/settings/backup');
    await click(button(card('work'), 'Remove'));
    expect(host.textContent).toContain('Remove Work?');
    expect(host.textContent).toContain('Type Work to confirm');
  });
});

describe('Agents, Under the hood: the fleet (A11)', () => {
  const rowNames = (): string[] =>
    [...host.querySelectorAll<HTMLElement>('tbody tr[data-agent]')].map((r) => r.dataset['agent']!);

  it('is a table sorted by activity, with a count and a summary', async () => {
    await mount(true);
    expect(host.querySelector('table')).not.toBeNull();
    expect(rowNames()).toEqual(['default', 'work', 'research', 'invoices']);
    expect(host.textContent).toContain('1 working · 1 ready · 2 not running or paused');
  });

  it('searches, filters by status and by AI app, and sorts by name', async () => {
    await mount(true);
    await type(host.querySelector<HTMLInputElement>('input[type="search"]')!, 'cur');
    expect(rowNames()).toEqual(['work']);
    await type(host.querySelector<HTMLInputElement>('input[type="search"]')!, '');
    await choose(host.querySelector<HTMLSelectElement>('select[name="status"]')!, 'paused');
    expect(rowNames()).toEqual(['invoices']);
    await choose(host.querySelector<HTMLSelectElement>('select[name="status"]')!, 'all');
    await choose(host.querySelector<HTMLSelectElement>('select[name="app"]')!, 'codex');
    expect(rowNames()).toEqual(['default']);
    await choose(host.querySelector<HTMLSelectElement>('select[name="app"]')!, 'all');
    await choose(host.querySelector<HTMLSelectElement>('select[name="sort"]')!, 'name');
    expect(rowNames()).toEqual(['invoices', 'default', 'research', 'work']);
    await type(host.querySelector<HTMLInputElement>('input[type="search"]')!, 'nobody');
    expect(host.textContent).toContain('No agents match.');
  });

  it('bulk select: Remove goes one agent at a time, each with its name typed', async () => {
    await mount(true);
    const box = (name: string) =>
      host.querySelector<HTMLInputElement>(`tr[data-agent="${name}"] input[type="checkbox"]`)!;
    await click(box('research'));
    expect(host.textContent).toContain('1 agent selected');
    expect(button(host, 'Pause')).toBeDefined();
    await click(box('invoices'));
    expect(host.textContent).toContain('2 agents selected');
    // Pause applies to the open agent (08 §1): several at once is not offered.
    expect(button(host.querySelector('[data-bulk]')!, 'Pause')).toBeUndefined();
    await click(button(host.querySelector('[data-bulk]')!, 'Remove'));
    expect(host.textContent).toContain('Remove Research?');
  });

  it('a row opens the agent page', async () => {
    await mount(true);
    await click(button(host.querySelector('tr[data-agent="work"]')!, 'Work'));
    expect(location.pathname).toBe('/agents/work');
  });
});

describe("one agent's page (/agents/<name>)", () => {
  it('shows the AI apps, people, rules, activity and backup; no history bars without data', async () => {
    history.replaceState(null, '', '/agents/work');
    await mount(true);
    expect(host.querySelector('h1')?.textContent).toBe('Work');
    for (const h of ['AI apps', 'People', 'Rules', 'Activity', 'Backup']) {
      expect([...host.querySelectorAll('h2')].map((x) => x.textContent)).toContain(h);
    }
    expect(host.textContent).toContain('Ready in Cursor');
    expect(host.querySelector('[data-sparkline]')).toBeNull();
    const back = [...host.querySelectorAll('a')].find(
      (a) => a.textContent?.trim() === 'Back up recovery kit',
    );
    expect(back?.getAttribute('href')).toBe('/settings/backup');
  });

  it('draws the heartbeat bars only from reads seen in this session', async () => {
    history.replaceState(null, '', '/agents/default');
    answers['GET /api/ui/contacts'] = {
      status: 200,
      body: {
        status: 'ok',
        contacts: [
          {
            ref: `0x${'a'.repeat(40)}`,
            name: 'Denis',
            nameSource: 'owner',
            label: 'safety-code-checked',
            status: 'active',
            pairing: 'complete',
            since: now() - 86_400,
          },
        ],
      },
    };
    await mount(true);
    expect(host.textContent).toContain('Denis');
    // A second read of the live store adds a second sample.
    await act(async () => {
      window.dispatchEvent(new Event('agentlink:agents-changed'));
    });
    await settle();
    const spark = host.querySelector('[data-sparkline="claude-code"]');
    expect(spark?.getAttribute('role')).toBe('img');
    expect(spark?.querySelectorAll('span').length).toBeGreaterThanOrEqual(2);
  });

  it('says plainly when there is no such agent', async () => {
    history.replaceState(null, '', '/agents/nobody');
    await mount();
    expect(host.textContent).toContain('No agent called that on this computer.');
  });
});
