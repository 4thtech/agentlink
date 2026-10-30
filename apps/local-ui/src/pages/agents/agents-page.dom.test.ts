// @vitest-environment jsdom
// U3-h (b11 §29.2 to §29.8): the Agents page, the Rename, Add and Remove sheets, and the switcher.
// W4-AGENTS: the cards of the simple layer (agents-v2.dom.test.ts has Pause, the fleet and the page).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { resetLiveForTests } from '../../api/live.js';
import { createOwnerClient } from '../contacts/owner.js';
import { createAgentsApi } from './api.js';
import { AgentsPage, type AgentsPageProps } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (name: string, label: string, over: Record<string, unknown> = {}) => ({
  name,
  label,
  current: false,
  available: true,
  removing: false,
  contacts: 0,
  running: false,
  apps: [] as string[],
  ...over,
});
const FOUR = [
  agent('default', 'Personal', {
    current: true,
    contacts: 4,
    running: true,
    apps: ['claude-code', 'claude-desktop'],
  }),
  agent('work', 'Work', { contacts: 1, apps: ['codex'] }),
  agent('second', 'Second agent'),
  agent('old', 'Old test', { removing: true }),
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
const NO_PASSKEY = {
  passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' },
};

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
  resetLiveForTests();
  history.replaceState(null, '', '/agents');
  answers = {
    'GET /api/ui/agents': { status: 200, body: list(FOUR) },
    'GET /api/owner/passkey': { status: 200, body: NO_PASSKEY },
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
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
const api = () => createAgentsApi({ fetch: fetchFn, token: 't' });
const owner = () => createOwnerClient({ fetch: fetchFn, token: 't' });
async function mountPage(reload = vi.fn<() => void>()): Promise<Mock<() => void>> {
  await act(async () => {
    root.render(createElement<AgentsPageProps>(AgentsPage, { api: api(), owner: owner(), reload }));
  });
  await settle();
  return reload;
}
const rowOf = (name: string): HTMLElement =>
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
}
const code = (): HTMLInputElement =>
  host.querySelector<HTMLInputElement>('input[name="owner-code"]')!;

describe('the Agents page', () => {
  it('lists every agent with its AI apps, contacts and the open one', async () => {
    await mountPage();
    expect(host.querySelector('h1')?.textContent).toBe('Agents');
    expect(host.querySelectorAll('[data-agent]')).toHaveLength(4);
    const personal = rowOf('default');
    expect(personal.textContent).toContain('Open');
    expect(personal.textContent).toContain('Ready in Claude Code and 1 more');
    expect(personal.textContent).toContain('Claude Code');
    expect(personal.textContent).toContain('Claude Desktop');
    expect(personal.textContent).toContain('4 contacts');
    expect(button(personal, 'Switch')).toBeUndefined();
    expect(button(rowOf('work'), 'Switch')).toBeDefined();
    expect(rowOf('work').textContent).toContain('1 contact');
  });
  it('an agent with no AI app reads Offline with its AI apps panel; Removal not finished with Try again', async () => {
    await mountPage();
    const second = rowOf('second');
    expect(second.textContent).toContain('Offline');
    await click(button(second, 'AI apps'));
    expect(rowOf('second').textContent).toContain('No AI app is set up for this agent yet.');
    const old = rowOf('old');
    expect(old.textContent).toContain('Removal not finished');
    expect(old.textContent).toContain('Removing it stopped part-way. Nothing else was affected.');
    expect(button(old, 'Try again')).toBeDefined();
    expect(button(old, 'Switch')).toBeUndefined();
  });
  it('has no List and Map control in the simple layer (it lives Under the hood)', async () => {
    await mountPage();
    expect(button(host, 'Map')).toBeUndefined();
  });
  it('renders a label as text, never as markup', async () => {
    answers['GET /api/ui/agents'] = {
      status: 200,
      body: list([agent('x', '<img src=x onerror=alert(1)>', { current: true })]),
    };
    await mountPage();
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
  });
  it('says what to do with no agents, and offers New agent (Get started)', async () => {
    answers['GET /api/ui/agents'] = {
      status: 200,
      body: list([], { current: null, label: null }),
    };
    await mountPage();
    expect(host.textContent).toContain('No agents left. Add one to keep using AgentLink.');
    const links = [...host.querySelectorAll('a')].filter((a) => a.textContent === 'New agent');
    expect(links.map((a) => a.getAttribute('href'))).toContain('/start/app?add=agent');
  });
  it('says "Couldn\'t load your agents." with Try again when the read fails', async () => {
    answers['GET /api/ui/agents'] = { status: 500, body: {} };
    await mountPage();
    expect(host.textContent).toContain("Couldn't load your agents.");
    expect(button(host, 'Try again')).toBeDefined();
  });
  it('marks the Tidy up agents "No AI app, no contacts"', async () => {
    await mountPage();
    expect(rowOf('second').textContent).toContain('No AI app, no contacts');
    expect(rowOf('work').textContent).not.toContain('No AI app, no contacts');
  });
  it('Switch posts the name and generation, then reloads every page', async () => {
    answers['POST /api/ui/agents/switch'] = {
      status: 200,
      body: { status: 'done', generation: 8, current: 'work' },
    };
    const reload = await mountPage();
    await click(button(rowOf('work'), 'Switch'));
    const post = calls.find((c) => c.url === '/api/ui/agents/switch')!;
    expect(JSON.parse(post.body)).toEqual({ name: 'work', generation: 7 });
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it('says "You switched agents. Nothing was changed." on agent_changed, and re-reads', async () => {
    answers['POST /api/ui/agents/switch'] = { status: 409, body: { status: 'agent_changed' } };
    await mountPage();
    const reads = (): number =>
      calls.filter((c) => c.url === '/api/ui/agents' && c.method === 'GET').length;
    const before = reads();
    await click(button(rowOf('work'), 'Switch'));
    expect(host.textContent).toContain('You switched agents. Nothing was changed.');
    // The page's read and the shared live store's read.
    expect(reads()).toBeGreaterThan(before);
  });
});

describe('Rename', () => {
  it('uses the Touch ID wording, the code, and posts to the label route', async () => {
    answers['POST /api/ui/agents/label'] = { status: 200, body: { status: 'done' } };
    await mountPage();
    await click(button(rowOf('work'), 'Rename'));
    const field = rowOf('work').querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(field.maxLength).toBe(32);
    await type(field, 'Home');
    await click(button(rowOf('work'), 'Rename with Touch ID'));
    expect(host.textContent).toContain('Rename Work to Home');
    await type(code(), '123456');
    await click(button(host, 'Confirm'));
    const post = calls.find((c) => c.url === '/api/ui/agents/label')!;
    expect(post.body).toBe('123456');
    expect(post.headers.get('X-AgentLink-Input')).toBeTruthy();
  });
  it('handles a route that is not available yet without breaking', async () => {
    answers['POST /api/ui/agents/label'] = { status: 501, body: {} };
    await mountPage();
    await click(button(rowOf('work'), 'Rename'));
    await type(rowOf('work').querySelector<HTMLInputElement>('input[type="text"]')!, 'Home');
    await click(button(rowOf('work'), 'Rename with Touch ID'));
    await type(code(), '123456');
    await click(button(host, 'Confirm'));
    expect(host.textContent).toContain('Not renamed yet. Try again.');
    expect(rowOf('work')).toBeTruthy();
  });
});

describe('label check and removal states', () => {
  it('refuses a label the server would not sign, before any Touch ID step', async () => {
    answers['GET /api/ui/agents/label-check?label=Home'] = {
      status: 200,
      body: { status: 'refused', reason: 'label_invalid' },
    };
    await mountPage();
    await click(button(rowOf('work'), 'Rename'));
    await type(rowOf('work').querySelector<HTMLInputElement>('input[type="text"]')!, 'Home');
    await click(button(rowOf('work'), 'Rename with Touch ID'));
    expect(host.textContent).toContain("That name can't be used.");
    expect(host.querySelector('input[name="owner-code"]')).toBeNull();
  });
  it('closes the Remove sheet on agent_removing: the agent shows as Removal not finished', async () => {
    answers['POST /api/ui/agents/remove'] = { status: 409, body: { status: 'agent_removing' } };
    await mountPage();
    await click(button(rowOf('work'), 'Remove'));
    const sheet = host.querySelector<HTMLElement>('[role="dialog"]')!;
    await type(sheet.querySelector<HTMLInputElement>('input[type="text"]')!, 'Work');
    await click(button(sheet, 'Remove with Touch ID'));
    await type(code(), '123456');
    await click(button(host, 'Confirm'));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('Remove', () => {
  const open = async (name: string): Promise<HTMLElement> => {
    await mountPage();
    await click(button(rowOf(name), 'Remove'));
    return host.querySelector<HTMLElement>('[role="dialog"]')!;
  };
  const confirmTyped = async (sheet: HTMLElement): Promise<void> => {
    await type(sheet.querySelector<HTMLInputElement>('input[type="text"]')!, 'Work');
    await click(button(sheet, 'Remove with Touch ID'));
    await type(code(), '123456');
    await click(button(host, 'Confirm'));
  };
  it('names what goes and keeps the button off until the exact label is typed', async () => {
    const sheet = await open('work');
    expect(sheet.textContent).toContain('Remove Work?');
    expect(sheet.textContent).toContain("Work's keys and settings");
    expect(sheet.textContent).toContain('Its entry in Codex');
    expect(sheet.textContent).toContain('Your 1 contact will be told Work is retired.');
    expect(sheet.textContent).toContain("This can't be undone.");
    expect(sheet.textContent).toContain('Agent folder: work');
    expect(button(sheet, 'Export history first')).toBeDefined();
    expect(button(sheet, 'Remove with Touch ID')!.disabled).toBe(true);
    const field = sheet.querySelector<HTMLInputElement>('input[type="text"]')!;
    await type(field, 'work');
    expect(button(sheet, 'Remove with Touch ID')!.disabled).toBe(true);
    await type(field, 'Work');
    expect(button(sheet, 'Remove with Touch ID')!.disabled).toBe(false);
  });
  it('sends the typed label and shows the in_use sentence with Check again', async () => {
    answers['POST /api/ui/agents/remove'] = { status: 409, body: { status: 'in_use' } };
    const sheet = await open('work');
    await confirmTyped(sheet);
    const post = calls.find((c) => c.url === '/api/ui/agents/remove')!;
    const sent = JSON.parse(
      atob(post.headers.get('X-AgentLink-Input')!.replace(/-/g, '+').replace(/_/g, '/')),
    );
    expect(sent).toEqual({ name: 'work', typedLabel: 'Work' });
    expect(host.textContent).toContain('Quit any AI app that uses Work first.');
    expect(button(host, 'Check again')).toBeDefined();
  });
  it('reads "not available" gracefully and never says it was removed', async () => {
    answers['POST /api/ui/agents/remove'] = { status: 501, body: {} };
    const sheet = await open('work');
    await confirmTyped(sheet);
    expect(host.textContent).toContain("Couldn't finish removing Work. Nothing else was changed.");
    expect(host.textContent).not.toContain('Work was removed.');
  });
  it('offers Remove anyway when contacts cannot be told, with Not now', async () => {
    answers['POST /api/ui/agents/remove'] = {
      status: 409,
      body: { status: 'undeliverable' },
    };
    const sheet = await open('work');
    await confirmTyped(sheet);
    expect(host.textContent).toContain("Remove anyway? Contacts can't be told now.");
    expect(button(host, 'Remove anyway')).toBeDefined();
    expect(button(host, 'Not now')).toBeDefined();
  });
  it('says "You switched agents" and closes when the page was for another agent', async () => {
    answers['POST /api/ui/agents/remove'] = { status: 409, body: { status: 'agent_changed' } };
    const sheet = await open('work');
    await confirmTyped(sheet);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain('You switched agents. Nothing was changed.');
  });
  it('after a removal the sheet closes and a note names it', async () => {
    answers['POST /api/ui/agents/remove'] = { status: 200, body: { status: 'done' } };
    const sheet = await open('work');
    await confirmTyped(sheet);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain('Work was removed.');
  });
});

const backupCode = (): HTMLInputElement =>
  host.querySelector<HTMLInputElement>('input[name="backup-code"]')!;

describe('Add', () => {
  // W4-ONE-TOUCH (D-140): one screen and one gesture (pages/apps/create-agent-gate.tsx); its calls go
  // through the page's own fetch.
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchFn);
    answers['GET /api/ui/apps'] = { status: 200, body: { desktopRunning: false, apps: [] } };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const READY = {
    status: 200,
    body: {
      status: 'ready',
      nonce: 'N'.repeat(43),
      statement: {
        label: 'Second agent',
        agentFingerprint: '1A2B·3C4D',
        ownerFingerprint: '7F3A·19C2',
        folder: 'second-agent',
      },
      expiresInMs: 120000,
      publicKey: {
        rpId: 'localhost',
        challenge: 'C'.repeat(43),
        allowCredentials: [],
        userVerification: 'required',
        timeoutMs: 120000,
        prfSalt: 'U2FsdA',
      },
    },
  };
  it('asks for a name (40 characters, prefilled); begin, then the backup code finishes with only the nonce', async () => {
    answers['POST /api/ui/agents/begin'] = READY;
    answers['POST /api/ui/agents'] = {
      status: 200,
      body: { status: 'done', name: 'second-agent', label: 'Second agent' },
    };
    history.replaceState(null, '', '/agents?add=1');
    await mountPage();
    const sheet = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(sheet.textContent).toContain('Add an agent');
    const field = sheet.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(field.maxLength).toBe(32);
    expect(field.value).toBe('Second agent');
    await click(button(sheet, 'Add with Touch ID'));
    await click(button(host, 'Use a backup code instead'));
    await type(backupCode(), '123456');
    await click(button(host, 'Confirm with my backup code'));
    await settle();
    const begin = calls.find((c) => c.url === '/api/ui/agents/begin' && c.method === 'POST');
    const finish = calls.find((c) => c.url === '/api/ui/agents' && c.method === 'POST');
    expect(begin?.body).toBe('');
    expect(finish?.body).toBe('123456');
    expect(finish?.headers.get('X-AgentLink-Input')).not.toContain('123456');
    expect(host.textContent).toContain('Connect an AI app to it?');
  });
  it('a refused begin says why and creates nothing', async () => {
    answers['POST /api/ui/agents/begin'] = { status: 409, body: { status: 'busy' } };
    history.replaceState(null, '', '/agents?add=1');
    await mountPage();
    const sheet = host.querySelector<HTMLElement>('[role="dialog"]')!;
    await click(button(sheet, 'Add with Touch ID'));
    await click(button(host, 'Use a backup code instead'));
    await type(backupCode(), '123456');
    await click(button(host, 'Confirm with my backup code'));
    await settle();
    expect(calls.some((c) => c.url === '/api/ui/agents' && c.method === 'POST')).toBe(false);
    expect(host.textContent).toContain('Another setup or approval is running.');
  });
});

// W4-SHELL-V2: the top-bar agent chip and its live dropdown are tested with the shell
// (layout/w4-shell-v2.dom.test.ts).
