// @vitest-environment jsdom
// WP-1 Rename truth (S2; D-141, Decision 46; 08 §1; 11 §5.8): an ID whose label differs from the
// name in its card (made in the terminal, renamed before D-141) shows the note wherever the owner
// looks: the Simple card, Under the hood, the ID's own page and Home, also with no contacts yet. The
// Rename editor takes the same name when only the card differs. An invite made while the names
// differ asks for the update first. Labels and card names are text only (I-5).
import { HoodProvider } from '@4thtech-io/ui';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLiveForTests } from '../../api/live.js';
import { createInviteApi } from '../contacts/invite-api.js';
import { createOwnerClient } from '../contacts/owner.js';
import { InvitePanel } from '../invite/invite-panel.js';
import { RenameBanner } from '../home/rename-banner.js';
import { createAgentsApi } from './api.js';
import type { AgentRow } from './data.js';
import { resetHistoryForTests } from './history.js';
import { AgentsPage, type AgentsPageProps } from './index.js';
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
  state: 'ready',
  apps: [] as unknown[],
  ...over,
});
const list = (agents: unknown[]) => ({
  switchable: true,
  generation: 7,
  current: 'cc-test',
  label: 'macbook-agent-1',
  agents,
});

interface Call {
  url: string;
  method: string;
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

const LINK = `https://agentlink.4thtech.io/i#2.${'A'.repeat(43)}`;
const MADE = {
  status: 'ok',
  inviteUrl: LINK,
  shareText: `Hi: ${LINK}`,
  ownerFingerprint: 'ABCD·EF01',
  expiresAt: '2026-11-19T10:00:00Z',
  format: 'short',
  inviteId: 'f4MLjTryzNowEdJnh_RH4Q',
};

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
    'GET /api/ui/agents': {
      status: 200,
      body: list([agent('cc-test', 'macbook-agent-1', { current: true, contacts: 1 })]),
    },
    'GET /api/owner/passkey': {
      status: 200,
      body: { passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' } },
    },
    'GET /api/ui/agents/card-name': {
      status: 200,
      body: { status: 'differs', cardName: 'cc-test' },
    },
    'POST /api/ui/agents/label': {
      status: 200,
      body: { status: 'done', label: 'macbook-agent-1', contacts: 1 },
    },
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
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function render(el: ReturnType<typeof createElement>, hood = false): Promise<void> {
  await act(async () => {
    root.render(createElement(HoodProvider, { value: hood }, el));
  });
  await settle();
}
async function mountAgents(hood = false): Promise<void> {
  await render(
    createElement<AgentsPageProps>(AgentsPage, {
      api: createAgentsApi({ fetch: fetchFn, token: 't' }),
      owner: createOwnerClient({ fetch: fetchFn, token: 't' }),
      fetch: fetchFn,
      reload: () => undefined,
    }),
    hood,
  );
}
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
const code = (): HTMLInputElement =>
  host.querySelector<HTMLInputElement>('input[name="owner-code"]')!;
const plain = (el: Element): string => (el.textContent ?? '').replace(/[⁨⁩]/g, '');
const posts = (url: string): Call[] => calls.filter((c) => c.method === 'POST' && c.url === url);

async function confirmWithCode(): Promise<void> {
  await type(code(), '123456');
  await click(button(host, 'Confirm with your backup code'));
}

describe('WP-1: the note shows wherever the owner looks', () => {
  it('Simple: on the open card, and one gesture posts the same rename with the current label', async () => {
    await mountAgents();
    expect(plain(host)).toContain('Contacts still see cc-test');
    await click(button(host, 'Update contacts'));
    await confirmWithCode();
    const [post] = posts('/api/ui/agents/label');
    expect(post).toBeDefined();
    expect(plain(host)).not.toContain('still see cc-test');
  });

  it('Simple, no contacts yet: "New invites still show {cardName}" with Update name', async () => {
    answers['GET /api/ui/agents'] = {
      status: 200,
      body: list([agent('cc-test', 'macbook-agent-1', { current: true, contacts: 0 })]),
    };
    await mountAgents();
    expect(plain(host)).toContain('New invites still show cc-test');
    expect(button(host, 'Update name')).toBeDefined();
    expect(plain(host)).not.toContain('Contacts still see');
  });

  it('Under the hood: the fleet shows the note for the open ID', async () => {
    await mountAgents(true);
    expect(plain(host)).toContain('Contacts still see cc-test');
    expect(button(host, 'Update contacts')).toBeDefined();
  });

  it("the ID's own page shows the note", async () => {
    history.replaceState(null, '', '/agents/cc-test');
    await mountAgents(true);
    expect(plain(host)).toContain('Contacts still see cc-test');
  });

  it('Home: a banner with the note and one gesture', async () => {
    const row: AgentRow = {
      name: 'cc-test',
      label: 'macbook-agent-1',
      current: true,
      available: true,
      removing: false,
      contacts: 1,
      running: false,
      apps: [],
    };
    await render(
      createElement(RenameBanner, {
        api: createAgentsApi({ fetch: fetchFn, token: 't' }),
        owner: createOwnerClient({ fetch: fetchFn, token: 't' }),
        row,
      }),
    );
    expect(plain(host)).toContain('Contacts still see cc-test');
    await click(button(host, 'Update contacts'));
    await confirmWithCode();
    expect(posts('/api/ui/agents/label')).toHaveLength(1);
    expect(plain(host)).not.toContain('still see cc-test');
  });

  it('nothing shows when the card already has the label', async () => {
    answers['GET /api/ui/agents/card-name'] = { status: 200, body: { status: 'same' } };
    await mountAgents();
    expect(plain(host)).not.toContain('still see');
    expect(plain(host)).not.toContain('still show');
  });
});

describe('WP-1 R-5: Rename takes the same name when only the card differs', () => {
  it('Save is enabled for the unchanged label and posts it', async () => {
    await mountAgents();
    const card = host.querySelector<HTMLElement>('[data-agent="cc-test"]')!;
    await click(button(card, 'Rename'));
    const submit = button(card, 'Rename with Touch ID');
    expect(submit?.disabled).toBe(false);
    await click(submit);
    await confirmWithCode();
    expect(posts('/api/ui/agents/label')).toHaveLength(1);
  });
});

describe('WP-1 R-2: an invite while the names differ asks for the update first', () => {
  async function mountPanel(): Promise<void> {
    await render(
      createElement(InvitePanel, {
        invites: createInviteApi({ fetch: fetchFn, token: 't' }),
        agents: createAgentsApi({ fetch: fetchFn, token: 't' }),
        owner: createOwnerClient({ fetch: fetchFn, token: 't' }),
      }),
    );
  }

  it('Update name, one gesture, then the invite is made', async () => {
    answers['POST /api/ui/invites'] = {
      status: 409,
      body: { error: 'name_update_needed', cardName: 'cc-test', label: 'macbook-agent-1' },
    };
    await mountPanel();
    expect(plain(host)).toContain('Your invites still show cc-test');
    expect(plain(host)).not.toContain(LINK);
    answers['POST /api/ui/invites'] = { status: 200, body: MADE };
    await click(button(host, 'Update name'));
    await confirmWithCode();
    expect(posts('/api/ui/agents/label')).toHaveLength(1);
    expect(posts('/api/ui/invites').length).toBe(2);
    expect(plain(host)).toContain(LINK);
  });

  it('"Invite as {cardName}" makes it under the old name (oldName: true)', async () => {
    answers['POST /api/ui/invites'] = {
      status: 409,
      body: { error: 'name_update_needed', cardName: 'cc-test', label: 'macbook-agent-1' },
    };
    await mountPanel();
    answers['POST /api/ui/invites'] = { status: 200, body: MADE };
    await click(button(host, 'Invite as cc-test'));
    const last = posts('/api/ui/invites').at(-1);
    expect(JSON.parse(last?.body ?? '{}')).toEqual({ oldName: true });
    expect(posts('/api/ui/agents/label')).toHaveLength(0);
    expect(plain(host)).toContain(LINK);
  });
});
