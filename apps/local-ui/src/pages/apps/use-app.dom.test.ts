// @vitest-environment jsdom
// WP-D7 (S2; plan 2026-11-12 Decision 2 "AI apps"): "Use the app for …" on the AI apps page. The card
// offers it only for an app connected to the open ID with npx while the AgentLink app is usable; the
// sheet shows the entry before and after (and the `agentlink` command when ticked, previewed again),
// and nothing is sent until the owner confirms with Touch ID or the backup code.
import { APPS_LIST } from '@4thtech-io/types/ui-contract/apps';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentsApi } from '../agents/api.js';
import { createOwnerClient } from '../contacts/owner.js';
import { createAppsApi } from './api.js';
import { AppsPage, type AppsPageProps } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agentsList = {
  switchable: true,
  generation: 3,
  current: 'personal',
  label: 'Personal',
  agents: [
    {
      name: 'personal',
      label: 'Personal',
      current: true,
      available: true,
      removing: false,
      contacts: 1,
      running: false,
      apps: [] as string[],
    },
  ],
};
const NODE = '/Applications/AgentLink.app/Contents/Resources/node/bin/node';
const CLI =
  '/Applications/AgentLink.app/Contents/Resources/core/node_modules/@4thtech-io/agentlink/dist/agentlink.js';
const npxEntry = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@4thtech-io/agentlink', 'mcp', '--agent', 'personal'],
  env: {},
};
const appEntry = {
  type: 'stdio',
  command: NODE,
  args: [CLI, 'mcp', '--agent', 'personal'],
  env: {},
};
const switchAnswer = (launcher: boolean) => ({
  status: 200,
  body: {
    status: 'change',
    kind: 'switch',
    app: 'claude-code',
    name: 'Claude Code',
    path: '~/.claude.json',
    folder: 'personal',
    oldEntry: npxEntry,
    newEntry: appEntry,
    oldAgent: 'personal',
    newAgent: 'personal',
    changeId: (launcher ? 'b' : 'a').repeat(64),
    ...(launcher
      ? {
          launcher: {
            path: '~/.agentlink/bin/agentlink',
            oldText: '#!/bin/sh\nexec npx\n',
            newText: `#!/bin/sh\nexec '${NODE}' '${CLI}' "$@"\n`,
          },
        }
      : { launcherOffer: true }),
  },
});

const claudeRow = APPS_LIST.answer.body.apps.find((a) => a.app === 'claude-code');
const list = (desktopApp: string | undefined, form?: 'app') => ({
  status: 200,
  body: {
    desktopRunning: false,
    apps: [{ ...claudeRow, state: 'connected', agent: 'personal', ...(form ? { form } : {}) }],
    ...(desktopApp === undefined ? {} : { desktopApp }),
  },
});

interface Call {
  url: string;
  method: string;
  headers: Headers;
}
let host: HTMLElement;
let root: Root;
let calls: Call[];
let answers: Record<string, { status: number; body: unknown }>;
const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  calls.push({ url, method, headers: new Headers(init?.headers) });
  const a = answers[`${method} ${url}`] ?? { status: 404, body: {} };
  return new Response(JSON.stringify(a.body), { status: a.status });
}) as typeof fetch;

const PREVIEW = '/api/ui/apps/preview?app=claude-code&agent=personal&form=app';

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  calls = [];
  history.replaceState(null, '', '/settings/apps');
  answers = {
    'GET /api/ui/apps': list('available'),
    'GET /api/ui/agents': { status: 200, body: agentsList },
    'GET /api/owner/passkey': {
      status: 200,
      body: { passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' } },
    },
    [`GET ${PREVIEW}`]: switchAnswer(false),
    [`GET ${PREVIEW}&launcher=1`]: switchAnswer(true),
    'POST /api/ui/apps/apply': { status: 200, body: { status: 'done', app: 'claude-code' } },
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
const card = (): HTMLElement => host.querySelector<HTMLElement>('[data-app="claude-code"]')!;
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
const sheet = (): HTMLElement => document.querySelector<HTMLElement>('[role="dialog"]')!;
async function enterCode(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[name="owner-code"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      '123456',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(button(sheet(), 'Use code') ?? sheet().querySelector('form button[type="submit"]'));
}

describe('"Use the app for …" on a card', () => {
  it('offered for an npx entry of the open ID when the app is usable', async () => {
    await mountPage();
    expect(button(card(), 'Use the app for Claude Code')).toBeDefined();
    expect(button(card(), 'Disconnect')).toBeDefined();
  });

  it('not offered without the app, or when the entry already uses it', async () => {
    answers['GET /api/ui/apps'] = list(undefined);
    await mountPage();
    expect(button(card(), 'Use the app for Claude Code')).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(host);
    answers['GET /api/ui/apps'] = list('available', 'app');
    await mountPage();
    expect(button(card(), 'Use the app for Claude Code')).toBeUndefined();
    expect(card().textContent).toContain('Runs from the AgentLink app');
  });

  it('a translocated app: move it first, no button', async () => {
    answers['GET /api/ui/apps'] = list('move_first');
    await mountPage();
    expect(button(card(), 'Use the app for Claude Code')).toBeUndefined();
    expect(card().textContent).toContain('move it to your Applications folder');
  });
});

describe('the sheet: the diff first, applied only after the owner confirms', () => {
  it('shows the entry before and after; nothing is sent before the gesture', async () => {
    await mountPage();
    await click(button(card(), 'Use the app for Claude Code'));
    const s = sheet();
    expect(calls.some((c) => c.method === 'GET' && c.url === PREVIEW)).toBe(true);
    expect(s.textContent).toContain('Use the AgentLink app for Claude Code');
    expect(s.querySelectorAll('[role="region"]')).toHaveLength(2);
    expect(s.querySelector('.ap-entry-removed')?.textContent).toContain('"npx"');
    expect(s.textContent).toContain(NODE);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('ticking the agentlink command previews again and shows that change too', async () => {
    await mountPage();
    await click(button(card(), 'Use the app for Claude Code'));
    const box = sheet().querySelector<HTMLInputElement>('input[type="checkbox"]');
    await click(box);
    expect(calls.some((c) => c.url === `${PREVIEW}&launcher=1`)).toBe(true);
    const s = sheet();
    expect(s.textContent).toContain('~/.agentlink/bin/agentlink');
    expect(s.querySelectorAll('[role="region"]')).toHaveLength(4);
  });

  it('Apply asks for presence with the statement, then posts the previewed changeId', async () => {
    await mountPage();
    await click(button(card(), 'Use the app for Claude Code'));
    await click(button(sheet(), 'Apply with Touch ID'));
    expect(sheet().textContent).toContain('Claude Code will use the AgentLink app for Personal');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await enterCode();
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/ui/apps/apply');
    expect(post).toBeDefined();
    const sent = post?.headers.get('X-AgentLink-Input') ?? '';
    const json = atob(sent.replace(/-/g, '+').replace(/_/g, '/'));
    expect(JSON.parse(json)).toEqual({ changeId: 'a'.repeat(64) });
    expect(card().textContent).toContain('Restart Claude Code to finish');
  });

  it('the app moved during the gesture: says so and reviews again', async () => {
    answers['POST /api/ui/apps/apply'] = { status: 409, body: { error: 'app_location' } };
    await mountPage();
    await click(button(card(), 'Use the app for Claude Code'));
    await click(button(sheet(), 'Apply with Touch ID'));
    const before = calls.filter((c) => c.url === PREVIEW).length;
    await enterCode();
    expect(sheet().textContent).toContain('The AgentLink app moved');
    expect(calls.filter((c) => c.url === PREVIEW).length).toBe(before + 1);
  });
});
