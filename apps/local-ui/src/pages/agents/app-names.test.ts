// @vitest-environment node
// U3-i: GET /api/ui/agents holds each agent's AI apps as app IDS ("claude-code"); the switcher, the
// Agents page and Start here show NAMES ("Claude Code"). The Agents client maps them through
// GET /api/ui/apps (the fixed names the server sends), with the fixed table as the fallback.
import { AGENTS_LIST } from '@4thtech-io/types/ui-contract/agents';
import { APPS_LIST } from '@4thtech-io/types/ui-contract/apps';
import { describe, expect, it } from 'vitest';
import { createAgentsApi } from './api.js';
import { appNameOf } from './app-names.js';

const withApps = (apps: string[]) => ({
  ...AGENTS_LIST.answer.body,
  agents: AGENTS_LIST.answer.body.agents.map((a, i) => (i === 0 ? { ...a, apps } : a)),
});

function api(answers: Record<string, { status: number; body: unknown }>) {
  const urls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://127.0.0.1').pathname;
    urls.push(url);
    const a = answers[url] ?? { status: 404, body: {} };
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as typeof fetch;
  return { urls, agents: createAgentsApi({ fetch: fetchFn, token: 't' }) };
}

describe('app ids become app names in the Agents list', () => {
  it('maps ids through GET /api/ui/apps', async () => {
    const t = api({
      '/api/ui/agents': { status: 200, body: withApps(['claude-code', 'codex']) },
      '/api/ui/apps': APPS_LIST.answer,
    });
    const read = await t.agents.list();
    expect(read.kind === 'ok' && read.list.agents[0]?.apps).toEqual(['Claude Code', 'Codex']);
  });

  it('falls back to the fixed names when the apps read fails, and keeps an unknown id as it is', async () => {
    const t = api({
      '/api/ui/agents': { status: 200, body: withApps(['claude-desktop', 'something-new']) },
      '/api/ui/apps': { status: 500, body: {} },
    });
    const read = await t.agents.list();
    expect(read.kind === 'ok' && read.list.agents[0]?.apps).toEqual([
      'Claude Desktop',
      'something-new',
    ]);
  });

  it('does not read the apps when no agent has an app', async () => {
    const t = api({ '/api/ui/agents': AGENTS_LIST.answer });
    await t.agents.list();
    expect(t.urls).toEqual(['/api/ui/agents']);
  });
});

describe('W4-LIVE-STATUS: an AI app outside the fixed table (Q-143-4, Decision 50)', () => {
  it('shows `other` as "Another AI app", never the raw id', () => {
    expect(appNameOf('other')).toBe('Another AI app');
    expect(appNameOf('other', new Map([['codex', 'Codex']]))).toBe('Another AI app');
  });
});
