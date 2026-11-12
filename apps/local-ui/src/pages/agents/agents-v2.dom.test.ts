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
/** Text without the bidi isolates the page puts around labels (U+2068, U+2069). */
const plain = (el: Element): string => (el.textContent ?? '').replace(/[\u2068\u2069]/g, '');
const posts = (url: string): Call[] => calls.filter((c) => c.method === 'POST' && c.url === url);

describe('Agents, simple (A8)', () => {
  it('lists each agent with its letter icon, its label isolated, and its live line', async () => {
    await mount();
    expect(host.querySelector('h1')?.textContent).toBe('IDs');
    const personal = card('default');
    expect(personal.querySelector('.al-agent-icon')?.textContent).toBe('P');
    expect(personal.querySelector('.al-agent-icon-dot.is-working')).not.toBeNull();
    expect(personal.querySelector('bdi')?.textContent).toBe('Personal');
    expect(personal.textContent).toContain('Working in Claude Code');
    expect(personal.textContent).toContain('Not connected · last seen 10 min ago');
    expect(card('work').textContent).toContain('Connected to Cursor');
    expect(card('research').textContent).toContain('Not used by any AI app');
    expect(card('invoices').textContent).toContain('Paused');
    const add = [...host.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'New ID');
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
    expect(plain(host)).toContain('Pause Personal?');
    expect(plain(host)).toContain(
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
    expect(JSON.parse(sessionStorage.getItem(INTENT_KEY) ?? '{}')).toMatchObject({
      name: 'work',
      action: 'pause',
    });
  });

  it('after the switch, the remembered Pause opens for the agent that is open now, once', async () => {
    sessionStorage.setItem(
      INTENT_KEY,
      JSON.stringify({ name: 'work', action: 'pause', at: Date.now() }),
    );
    answers['GET /api/ui/agents'] = {
      status: 200,
      body: list(
        FLEET().map((a) => ({ ...a, current: a.name === 'work' })),
        { current: 'work', label: 'Work' },
      ),
    };
    await mount();
    expect(plain(host)).toContain('Pause Work?');
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });

  it('keeps the remembered Pause through a stale first read, until its own read shows the agent open', async () => {
    sessionStorage.setItem(
      INTENT_KEY,
      JSON.stringify({ name: 'work', action: 'pause', at: Date.now() }),
    );
    // The router mounts the page again while the shared store still holds the old agent.
    await mount();
    expect(plain(host)).not.toContain('Pause Work?');
    expect(sessionStorage.getItem(INTENT_KEY)).not.toBeNull();
    answers['GET /api/ui/agents'] = {
      status: 200,
      body: list(
        FLEET().map((a) => ({ ...a, current: a.name === 'work' })),
        { current: 'work', label: 'Work' },
      ),
    };
    await act(async () => {
      window.dispatchEvent(new Event('agentlink:agents-changed'));
    });
    await settle();
    expect(plain(host)).toContain('Pause Work?');
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });

  it('the same for Resume: the gate opens once the paused agent is the open one', async () => {
    sessionStorage.setItem(
      INTENT_KEY,
      JSON.stringify({ name: 'invoices', action: 'resume', at: Date.now() }),
    );
    await mount();
    expect(plain(host)).not.toContain('Resume Invoices');
    answers['GET /api/ui/agents'] = {
      status: 200,
      body: list(
        FLEET().map((a) => ({ ...a, current: a.name === 'invoices' })),
        { current: 'invoices', label: 'Invoices' },
      ),
    };
    await act(async () => {
      window.dispatchEvent(new Event('agentlink:agents-changed'));
    });
    await settle();
    expect(plain(host)).toContain('Resume Invoices');
    expect(host.querySelector('input[name="owner-code"]')).not.toBeNull();
  });

  it('isolates the label in the Pause title and body and the Resume statement (U+2068 … U+2069)', async () => {
    const rtl = '\u05e2\u05d1\u05d5\u05d3\u05d4 \u202e1';
    answers['GET /api/ui/agents'] = {
      status: 200,
      body: list([agent('default', rtl, { current: true, state: 'paused' })], { label: rtl }),
    };
    await mount();
    await click(button(card('default'), 'Resume'));
    expect(host.textContent).toContain(`Resume \u2068${rtl}\u2069`);
    answers['GET /api/ui/agents'] = {
      status: 200,
      body: list([agent('default', rtl, { current: true, state: 'ready' })], { label: rtl }),
    };
    await act(async () => {
      window.dispatchEvent(new Event('agentlink:agents-changed'));
    });
    await settle();
    await click(button(card('default'), 'Pause'));
    const sheet = host.querySelector('[role="dialog"]')!;
    expect(sheet.textContent).toContain(`Pause \u2068${rtl}\u2069?`);
    expect(sheet.textContent).toContain(`messages as \u2068${rtl}\u2069 until`);
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
    expect(plain(host)).toContain('Resume Personal');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        code(),
        '123456',
      );
      code().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button(host, 'Confirm with your master code'));
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
    expect(card('default').textContent).toContain('People see this name.');
    await type(card('default').querySelector<HTMLInputElement>('input[type="text"]')!, 'Home');
    await click(button(card('default'), 'Rename with Touch ID'));
    await type(code(), '123456');
    await click(button(host, 'Confirm with your master code'));
    expect(plain(host)).toContain("Renamed. Your contacts will see Home next time they're online.");

    answers['POST /api/ui/agents/label'] = {
      status: 409,
      body: { error: 'rename_limited', retryAt: now() + 3600 },
    };
    await click(button(card('work'), 'Rename'));
    await type(card('work').querySelector<HTMLInputElement>('input[type="text"]')!, 'Job');
    await click(button(card('work'), 'Rename with Touch ID'));
    await type(code(), '123456');
    await click(button(host, 'Confirm with your master code'));
    expect(plain(host)).toMatch(/You can rename Work again at \S/);
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
    await click(button(host, 'Confirm with your master code'));
    const [post] = posts('/api/ui/agents/label');
    expect(post).toBeDefined();
  });

  // WP-1 (R-1): with no contacts the note still shows (every new invite carries the card's name),
  // in words that do not speak of contacts (F23).
  it('F23 / WP-1: no contacts yet: "New invites still show {name}" with Update name', async () => {
    answers['GET /api/ui/agents/card-name'] = {
      status: 200,
      body: { status: 'differs', cardName: 'My agent' },
    };
    answers['GET /api/ui/agents'] = {
      status: 200,
      body: list([agent('default', 'Personal', { current: true, contacts: 0, state: 'ready' })]),
    };
    await mount();
    expect(card('default').textContent).not.toContain('Contacts still see');
    expect(button(card('default'), 'Update contacts')).toBeUndefined();
    expect(card('default').textContent).toContain('New invites still show My agent');
    expect(button(card('default'), 'Update name')).toBeDefined();
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

  it("Back up saves the open ID's kit in place, asks to open another ID first; Remove asks for the name", async () => {
    await mount();
    // WP-11: the open ID saves its recovery kit right here (no link away, no terminal command).
    await click(button(card('default'), 'Back up'));
    expect(button(card('default'), 'Save recovery kit')).toBeDefined();
    // Another ID is opened first: a kit is saved for the open ID.
    await click(button(card('work'), 'Back up'));
    const panel = card('work').querySelector<HTMLElement>('[data-panel="backup"]')!;
    expect(plain(panel)).toContain('to save its recovery kit.');
    expect(button(panel, 'Open this ID')).toBeDefined();
    expect([...panel.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain(
      'Save recovery kit',
    );
    await click(button(card('work'), 'Remove'));
    expect(plain(host)).toContain('Remove Work?');
    expect(host.querySelector('[role="dialog"] input[type="text"]')).not.toBeNull();
  });
});

describe('Agents, Under the hood: the fleet (A11)', () => {
  const rowNames = (): string[] =>
    [...host.querySelectorAll<HTMLElement>('tbody tr[data-agent]')].map((r) => r.dataset['agent']!);

  it('is a table sorted by activity, with a count and a summary', async () => {
    await mount(true);
    expect(host.querySelector('table')).not.toBeNull();
    expect(rowNames()).toEqual(['default', 'work', 'research', 'invoices']);
    expect(plain(host)).toContain('1 working · 1 ready · 2 not running or paused');
  });

  it('labels the AI-app column "AI app (harness)" with the hint', async () => {
    await mount(true);
    expect(host.querySelectorAll('thead th')[2]?.textContent).toBe('AI app (harness)');
    expect(host.querySelector('[data-harness-hint]')?.textContent).toBe(
      'AI apps: developers call them harnesses, the program that runs your AI and connects it to AgentLink.',
    );
  });

  it('keeps "harness" out of the simple list (Under the hood only)', async () => {
    await mount(false);
    expect(plain(host)).not.toMatch(/harness/i);
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
    expect(plain(host)).toContain('No IDs match.');
  });

  it('bulk select: Remove goes one agent at a time, each with its name typed', async () => {
    await mount(true);
    const box = (name: string) =>
      host.querySelector<HTMLInputElement>(`tr[data-agent="${name}"] input[type="checkbox"]`)!;
    await click(box('research'));
    expect(plain(host)).toContain('1 ID selected');
    expect(button(host, 'Pause')).toBeDefined();
    await click(box('invoices'));
    expect(plain(host)).toContain('2 IDs selected');
    // Pause applies to the open agent (08 §1): several at once is not offered.
    expect(button(host.querySelector('[data-bulk]')!, 'Pause')).toBeUndefined();
    await click(button(host.querySelector('[data-bulk]')!, 'Remove'));
    expect(plain(host)).toContain('Remove Research?');
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
    expect(plain(host)).toContain('Connected to Cursor');
    expect(host.querySelector('[data-sparkline]')).toBeNull();
    // WP-11: Work is not the open ID, so its Backup section asks to open it first.
    const backup = host.querySelector<HTMLElement>('[data-panel="backup"]')!;
    expect(plain(backup)).toContain('to save its recovery kit.');
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
    expect(plain(host)).toContain('Denis');
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
    expect(plain(host)).toContain('No ID called that on this computer.');
  });
});
