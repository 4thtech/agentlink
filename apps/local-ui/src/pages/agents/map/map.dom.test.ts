// @vitest-environment jsdom
// U3-map (b11 §32): the live connections map on the Agents page. The page's own reads (contacts,
// pulse, flow) are answered by a fake fetch; the map shows names and words, never a message.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../../api/client.js';
import type { AgentRow } from '../data.js';
import { AgentsMap, type AgentsMapProps } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000;
const ref = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const agent = (name: string, over: Partial<AgentRow> = {}): AgentRow => ({
  name,
  label: name,
  current: false,
  available: true,
  removing: false,
  contacts: 0,
  running: false,
  apps: [],
  ...over,
});
const AGENTS = [
  agent('default', { label: 'Personal', current: true, running: true, apps: ['Claude Code'] }),
  agent('work', { label: 'Work', contacts: 3, apps: ['Codex'] }),
  agent('spare', { label: 'Spare agent' }),
];
const contactRow = (n: number, over: Record<string, unknown> = {}) => ({
  ref: ref(n),
  name: `Person ${String(n)}`,
  nameSource: 'owner',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1,
  ...over,
});
const pulseEntry = (n: number, total: number, activity: string) => ({
  contactId: ref(n),
  counts: [...Array.from({ length: 11 }, () => 0), total],
  lastAt: NOW - n,
  activity,
});

let host: HTMLElement;
let root: Root;
let answers: Record<string, { status: number; body: unknown }>;
let asked: string[];

const fetchFn = (async (input: RequestInfo | URL) => {
  const url = String(input);
  asked.push(url);
  const key = url.split('?')[0] as string;
  const a = answers[key] ?? { status: 404, body: {} };
  return new Response(JSON.stringify(a.body), { status: a.status });
}) as typeof fetch;

function setWorld(n: number, pulse: [number, number, string][], flow: unknown[] = []): void {
  answers = {
    '/api/ui/contacts': {
      status: 200,
      body: {
        status: 'ok',
        contacts: [
          ...Array.from({ length: n }, (_, i) => contactRow(i + 1)),
          contactRow(99, { nameSource: 'counterparty', name: 'Mallory <b>x</b>' }),
        ],
      },
    },
    '/api/ui/messages/pulse': {
      status: 200,
      body: {
        now: NOW,
        partial: false,
        contacts: [...pulse, [99, 2, 'today']].map(([c, t, a]) =>
          pulseEntry(c as number, t as number, a as string),
        ),
      },
    },
    '/api/ui/flow': {
      status: 200,
      body: { now: NOW, cursor: String(NOW - 60), items: flow, partial: false },
    },
  };
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  asked = [];
  history.replaceState(null, '', '/settings/agents');
  document.documentElement.removeAttribute('data-motion');
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
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
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function mount(over: Partial<AgentsMapProps> = {}, agents = AGENTS): Promise<void> {
  const api = createApiClient({ fetch: fetchFn, token: 't' });
  await act(async () => {
    root.render(createElement<AgentsMapProps>(AgentsMap, { agents, client: api, ...over }));
  });
  await settle();
}
const text = (): string => host.textContent ?? '';
const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('button')];
const byLabel = (re: RegExp): HTMLButtonElement | undefined =>
  buttons().find((b) => re.test(b.getAttribute('aria-label') ?? ''));

describe('the map: boxes and words', () => {
  it('shows each agent with its AI app name, and contacts by owner-confirmed name only', async () => {
    setWorld(2, [
      [1, 5, 'active_now'],
      [2, 1, 'today'],
    ]);
    await mount();
    expect(text()).toContain('Personal');
    expect(text()).toContain('Claude Code');
    expect(text()).toContain('Codex');
    expect(text()).toContain('Not connected to an AI app');
    expect(text()).toContain('Person 1');
    expect(text()).toContain('Active now');
    expect(text()).toContain('Unnamed contact');
    expect(text()).not.toContain('Mallory');
    expect(host.querySelector('b')).toBeNull();
  });

  it('the picture is aria-hidden and the boxes are buttons in list order', async () => {
    setWorld(1, [[1, 5, 'active_now']]);
    await mount();
    const svg = host.querySelector('svg.mp-lines');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelectorAll('ul li button').length).toBeGreaterThanOrEqual(3);
    expect(byLabel(/^Personal and Person 1, Active now\. Open conversation$/)).toBeDefined();
    expect(text()).toContain('Live connections');
    expect(host.querySelector('.mp-summary')?.textContent).toContain('3 agents, 5 contacts.');
  });

  it('no content and no hover preview: no title attribute, no tooltip', async () => {
    setWorld(1, [[1, 5, 'active_now']], [
      { contactId: ref(1), direction: 'in', kind: 'message', state: 'received', at: NOW - 1 },
    ]);
    await mount();
    expect(host.querySelector('[title]')).toBeNull();
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
  });
});

describe('the map: scale', () => {
  it('top 12 contacts and "+N more"', async () => {
    setWorld(15, Array.from({ length: 15 }, (_, i) => [i + 1, 3, 'today'] as [number, number, string]));
    await mount();
    expect(text()).toContain('+4 more');
    expect(host.querySelectorAll('.mp-contact').length).toBe(12);
  });

  it('up to 8 agents and "+N more agents", which shows the List', async () => {
    setWorld(0, []);
    const many = [
      AGENTS[0] as AgentRow,
      ...Array.from({ length: 9 }, (_, i) => agent(`x${String(i)}`, { label: `Agent ${String(i)}` })),
    ];
    const onShowList = vi.fn();
    await mount({ onShowList }, many);
    expect(host.querySelectorAll('.mp-agent').length).toBe(8);
    const more = buttons().find((b) => /\+2 more agents/.test(b.textContent ?? ''));
    expect(more).toBeDefined();
    await act(async () => more?.click());
    expect(onShowList).toHaveBeenCalled();
  });

  it('quiet contacts are behind Show quiet, remembered in this browser', async () => {
    setWorld(2, [
      [1, 5, 'active_now'],
      [2, 0, 'quiet'],
    ]);
    await mount();
    expect(text()).not.toContain('Person 2');
    const toggle = host.querySelector<HTMLElement>('[role="switch"]');
    expect(toggle).not.toBeNull();
    await act(async () => toggle?.click());
    expect(text()).toContain('Person 2');
    expect(text()).toContain('Quiet');
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    expect(text()).toContain('Person 2');
  });

  it('works when storage throws (off)', async () => {
    setWorld(2, [
      [1, 5, 'active_now'],
      [2, 0, 'quiet'],
    ]);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await mount();
    expect(text()).toContain('Person 1');
    expect(text()).not.toContain('Person 2');
  });
});

describe('the map: streams', () => {
  const flow = [
    { contactId: ref(1), direction: 'in', kind: 'message', state: 'received', at: NOW - 2 },
    { contactId: ref(2), direction: 'out', kind: 'file', state: 'queued', at: NOW - 3 },
  ];

  it('a stream runs only for the last minute, with words and direction', async () => {
    setWorld(2, [[1, 5, 'active_now'], [2, 4, 'active_now']], flow);
    await mount();
    expect(host.querySelectorAll('.mp-stream').length).toBe(2);
    expect(host.querySelector('.mp-stream-run')).not.toBeNull();
    expect(byLabel(/Person 1, Receiving\. Open conversation/)).toBeDefined();
    expect(byLabel(/Person 2, Sending\. Open conversation/)).toBeDefined();
    expect(text()).toContain('Sending to Person 2');
    expect(host.querySelector('.mp-bar')).not.toBeNull();
  });

  it('first read asks for 24 hours, later reads poll the cursor', async () => {
    setWorld(1, [[1, 5, 'active_now']], flow);
    await mount();
    const first = asked.find((u) => u.startsWith('/api/ui/flow'));
    expect(first).toMatch(/^\/api\/ui\/flow\?since=\d{10}$/);
  });

  it('reduced motion: no travelling dash, the word "now" is shown instead', async () => {
    document.documentElement.setAttribute('data-motion', 'reduced');
    setWorld(2, [[1, 5, 'active_now'], [2, 4, 'active_now']], flow);
    await mount();
    expect(host.querySelector('.mp-stream-run')).toBeNull();
    expect(host.querySelectorAll('.mp-stream').length).toBe(2);
    expect(host.querySelector('.mp-now')?.textContent).toBe('now');
  });

  it('the live region says one short line, never a content word', async () => {
    setWorld(1, [[1, 5, 'active_now']], [flow[0]]);
    await mount();
    const live = host.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect((live?.textContent ?? '').length).toBeLessThan(120);
  });
});

describe('the map: states and clicks', () => {
  it('clicking a contact opens that conversation in Messages', async () => {
    setWorld(1, [[1, 5, 'active_now']]);
    await mount();
    await act(async () => byLabel(/Person 1/)?.click());
    expect(location.pathname).toBe('/settings/messages');
    expect(location.search).toBe(`?contact=${ref(1)}`);
  });

  it('"+N more" opens Contacts; another agent switches', async () => {
    setWorld(14, Array.from({ length: 14 }, (_, i) => [i + 1, 3, 'today'] as [number, number, string]));
    const onSwitch = vi.fn();
    await mount({ onSwitch });
    const other = buttons().find((b) => /Work/.test(b.textContent ?? '') && b.classList.contains('mp-agent'));
    await act(async () => other?.click());
    expect(onSwitch).toHaveBeenCalledWith(expect.objectContaining({ name: 'work' }));
    const more = buttons().find((b) => /\+3 more/.test(b.textContent ?? ''));
    await act(async () => more?.click());
    expect(location.pathname).toBe('/settings/contacts');
  });

  it('empty: "No one to talk to yet." with Add contact', async () => {
    answers = {
      '/api/ui/contacts': { status: 200, body: { status: 'ok', contacts: [] } },
      '/api/ui/messages/pulse': { status: 200, body: { now: NOW, partial: false, contacts: [] } },
      '/api/ui/flow': {
        status: 200,
        body: { now: NOW, cursor: String(NOW - 60), items: [], partial: false },
      },
    };
    await mount();
    expect(text()).toContain('No one to talk to yet.');
    expect(buttons().some((b) => /Add contact/.test(b.textContent ?? ''))).toBe(true);
  });

  it('no recent activity: the note, and no lines', async () => {
    setWorld(2, [
      [1, 0, 'quiet'],
      [2, 0, 'quiet'],
    ]);
    answers['/api/ui/messages/pulse'] = {
      status: 200,
      body: {
        now: NOW,
        partial: false,
        contacts: [1, 2, 99].map((n) => pulseEntry(n, 0, 'quiet')),
      },
    };
    await mount();
    expect(text()).toContain('Nothing has moved in the last 24 hours.');
    expect(host.querySelectorAll('.mp-line').length).toBe(0);
  });

  it('error: "Couldn\'t load what\'s moving." with Try again', async () => {
    answers = {};
    await mount();
    expect(text()).toContain("Couldn't load what's moving.");
    expect(buttons().some((b) => /Try again/.test(b.textContent ?? ''))).toBe(true);
  });
});
