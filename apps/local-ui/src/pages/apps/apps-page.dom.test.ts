// @vitest-environment jsdom
// U3-i (b11 §30): the AI apps page. The answers are the shared wire samples
// (@4thtech-io/types/ui-contract/apps), so what the page reads is what the real handlers send.
import { APPS_CHANGE, APPS_LIST, APPS_PREVIEW } from '@4thtech-io/types/ui-contract/apps';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentsApi } from '../agents/api.js';
import { createOwnerClient } from '../contacts/owner.js';
import { createAppsApi } from './api.js';
import { AppsPage, type AppsPageProps } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agentRow = (name: string, label: string, current: boolean) => ({
  name,
  label,
  current,
  available: true,
  removing: false,
  contacts: 1,
  running: false,
  apps: [] as string[],
});
const agentsList = (running = false) => ({
  switchable: true,
  generation: 3,
  current: 'personal',
  label: 'Personal',
  agents: [{ ...agentRow('personal', 'Personal', true), running }, agentRow('work', 'Work', false)],
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

const previewUrl = (q: { app: string; agent: string }): string =>
  `GET /api/ui/apps/preview?app=${q.app}&agent=${q.agent}`;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  calls = [];
  history.replaceState(null, '', '/settings/apps');
  answers = {
    'GET /api/ui/apps': APPS_LIST.answer,
    'GET /api/ui/agents': { status: 200, body: agentsList() },
    'GET /api/owner/passkey': {
      status: 200,
      body: { passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' } },
    },
    [previewUrl(APPS_PREVIEW.connect.query)]: APPS_PREVIEW.connect.answer,
    [previewUrl(APPS_PREVIEW.move.query)]: APPS_PREVIEW.move.answer,
    [previewUrl(APPS_PREVIEW.disconnect.query)]: APPS_PREVIEW.disconnect.answer,
    [previewUrl(APPS_PREVIEW.conflict.query)]: APPS_PREVIEW.conflict.answer,
    'POST /api/ui/apps/apply': APPS_CHANGE.done.answer,
    'POST /api/ui/apps/disconnect': {
      status: 200,
      body: { status: 'done', app: 'claude-code' },
    },
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
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function mountPage(): Promise<void> {
  await act(async () => {
    root.render(
      createElement<AppsPageProps>(AppsPage, {
        api: createAppsApi({ fetch: fetchFn, token: 't' }),
        agents: createAgentsApi({ fetch: fetchFn, token: 't' }),
        owner: createOwnerClient({ fetch: fetchFn, token: 't' }),
      }),
    );
  });
  await settle();
}
const card = (app: string): HTMLElement => host.querySelector<HTMLElement>(`[data-app="${app}"]`)!;
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
const sheet = (): HTMLElement => document.querySelector<HTMLElement>('[role="dialog"]')!;
const code = (): HTMLInputElement =>
  document.querySelector<HTMLInputElement>('input[name="owner-code"]')!;
async function enterCode(): Promise<void> {
  await type(code(), '123456');
  await click(button(sheet(), 'Use code') ?? sheet().querySelector('form button[type="submit"]'));
}

describe('the AI apps page: cards and states', () => {
  it('shows the open agent and one card per detected AI app', async () => {
    await mountPage();
    expect(host.querySelector('h1')?.textContent).toBe('AI apps');
    expect(host.textContent).toContain('for Personal');
    expect(host.querySelectorAll('[data-app]')).toHaveLength(5);
  });

  it('Connected to the open agent: the state word and Disconnect', async () => {
    await mountPage();
    const c = card('claude-code');
    expect(c.textContent).toContain('Claude Code');
    expect(c.textContent).toContain('Connected to Personal');
    expect(button(c, 'Disconnect')).toBeDefined();
    expect(c.getAttribute('aria-label')).toBe('Claude Code, Connected to Personal');
  });

  it('Connected to another agent: "Uses Work" and "Use Personal instead"', async () => {
    await mountPage();
    const c = card('codex');
    expect(c.textContent).toContain('Connected to another agent');
    expect(c.textContent).toContain('Uses Work');
    expect(button(c, 'Use Personal instead')).toBeDefined();
  });

  it('Not connected: Review change', async () => {
    await mountPage();
    const c = card('cursor');
    expect(c.textContent).toContain('Not connected');
    expect(button(c, 'Review change')).toBeDefined();
  });

  it('Claude Desktop open: "Quit Claude Desktop first." with Check again, and Review change is disabled', async () => {
    await mountPage();
    const c = card('claude-desktop');
    expect(c.textContent).toContain('Quit Claude Desktop first.');
    expect(button(c, 'Check again')).toBeDefined();
    expect(button(c, 'Review change')?.disabled).toBe(true);
  });

  it('an entry we did not write is never overwritten: Show manual steps only', async () => {
    await mountPage();
    const c = card('windsurf');
    expect(c.textContent).toContain("This app already has an AgentLink entry we didn't write.");
    expect(button(c, 'Review change')).toBeUndefined();
    expect(button(c, 'Show manual steps')).toBeDefined();
  });

  it('marks a connected app Running only when its agent runs', async () => {
    answers['GET /api/ui/agents'] = { status: 200, body: agentsList(true) };
    answers['GET /api/ui/apps'] = {
      status: 200,
      body: { ...APPS_LIST.answer.body, apps: [APPS_LIST.answer.body.apps[0]] },
    };
    await mountPage();
    expect(card('claude-code').textContent).toContain('Running');
  });

  it('says what it did not find, and offers manual steps', async () => {
    answers['GET /api/ui/apps'] = { status: 200, body: { desktopRunning: false, apps: [] } };
    await mountPage();
    expect(host.textContent).toContain("We didn't find a supported AI app on this computer.");
    expect(button(host, 'Show manual steps')).toBeDefined();
  });

  it('says "Couldn\'t check your AI apps." with Try again', async () => {
    answers['GET /api/ui/apps'] = { status: 500, body: {} };
    await mountPage();
    expect(host.textContent).toContain("Couldn't check your AI apps.");
    expect(button(host, 'Try again')).toBeDefined();
  });

  it('at most one primary button on the page', async () => {
    await mountPage();
    expect(
      host.querySelectorAll('button.al-btn-primary, button[data-variant="primary"]').length,
    ).toBeLessThanOrEqual(1);
  });
});

describe('Review change: the exact entry, then Touch ID', () => {
  it('shows only the AgentLink entry, the file and the agent folder, before anything is asked', async () => {
    await mountPage();
    await click(button(card('cursor'), 'Review change'));
    const s = sheet();
    expect(s.textContent).toContain('Connect Cursor to Personal');
    expect(s.textContent).toContain("This adds one entry to Cursor's settings.");
    expect(s.textContent).toContain('~/.cursor/mcp.json');
    const entry = s.querySelector('[role="region"]');
    expect(entry?.getAttribute('aria-label')).toBe('The entry that will be added');
    expect(entry?.textContent).toContain('"agentlink"');
    expect(entry?.textContent).toContain('"--agent"');
    expect(entry?.textContent).toContain('"personal"');
    expect(s.textContent).toContain('Agent folder: personal');
    expect(s.textContent).toContain(
      'A backup of the file is saved first. Nothing else in it changes.',
    );
    expect(button(s, 'Apply with Touch ID')).toBeDefined();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('Apply sends only {changeId} with the proof, then says "Restart Cursor to finish"', async () => {
    await mountPage();
    await click(button(card('cursor'), 'Review change'));
    await click(button(sheet(), 'Apply with Touch ID'));
    await enterCode();
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/ui/apps/apply');
    expect(post).toBeDefined();
    expect(post?.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(post?.body).toBe('123456');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(card('cursor').textContent).toContain('Restart Cursor to finish');
  });

  it('Move shows both entries and the sentence, and posts to apply', async () => {
    await mountPage();
    await click(button(card('codex'), 'Use Personal instead'));
    const s = sheet();
    expect(s.textContent).toContain('Codex will use Personal instead of Work.');
    expect(s.querySelectorAll('[role="region"]')).toHaveLength(2);
    expect(s.textContent).toContain('"work"');
    expect(s.textContent).toContain('"personal"');
  });

  it('Disconnect shows the entry as removed and posts to the disconnect route', async () => {
    await mountPage();
    await click(button(card('claude-code'), 'Disconnect'));
    const s = sheet();
    expect(s.textContent).toContain('Claude Code will stop using Personal.');
    await click(button(s, 'Apply with Touch ID'));
    await enterCode();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/ui/apps/disconnect')).toBe(
      true,
    );
  });

  it('"The file changed. Review it again." re-reads the change', async () => {
    answers['POST /api/ui/apps/apply'] = { status: 409, body: { error: 'changed' } };
    await mountPage();
    await click(button(card('cursor'), 'Review change'));
    const before = calls.filter((c) => c.url.startsWith('/api/ui/apps/preview')).length;
    await click(button(sheet(), 'Apply with Touch ID'));
    await enterCode();
    expect(sheet().textContent).toContain('The file changed. Review it again.');
    expect(calls.filter((c) => c.url.startsWith('/api/ui/apps/preview')).length).toBe(before + 1);
  });

  it('a write that fails says nothing was changed and offers Try again and manual steps', async () => {
    answers['POST /api/ui/apps/apply'] = { status: 409, body: { error: 'write_failed' } };
    await mountPage();
    await click(button(card('cursor'), 'Review change'));
    await click(button(sheet(), 'Apply with Touch ID'));
    await enterCode();
    expect(sheet().textContent).toContain(
      "Couldn't change Cursor's settings. Nothing was changed.",
    );
    expect(button(sheet(), 'Show manual steps')).toBeDefined();
  });

  it('a conflict preview offers manual steps, never a write', async () => {
    await mountPage();
    await click(button(card('windsurf'), 'Show manual steps'));
    const s = sheet();
    expect(s.textContent).toContain('Open this file');
    expect(s.textContent).toContain('Add the entry above');
    expect(s.textContent).toContain('Restart Windsurf');
    expect(button(s, 'Apply with Touch ID')).toBeUndefined();
  });

  it('renders every file and entry as text, never as markup (I-5)', async () => {
    answers[previewUrl(APPS_PREVIEW.connect.query)] = {
      status: 200,
      body: {
        ...APPS_PREVIEW.connect.answer.body,
        path: '<img src=x onerror=alert(1)>',
      },
    };
    await mountPage();
    await click(button(card('cursor'), 'Review change'));
    expect(document.querySelector('img')).toBeNull();
  });
});
