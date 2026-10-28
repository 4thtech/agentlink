// @vitest-environment node
// U3-j CONTRACT (S1), page side: the Start here reads against the shared samples
// (@4thtech-io/types/ui-contract/start-here). The server side
// (packages/node/src/local-ui/ui-contract-start-here.test.ts) runs the REAL route handlers on the
// same samples and asserts they answer exactly them. Here the page must ask the sample paths and read
// each sample answer as the signal next to it: a stub (`not_available`) or an empty list is "not
// done", never "done". apps/local-ui never imports packages/node (package layering, tools/deps-check).
import {
  START_HERE_AGENTS_PATH,
  START_HERE_AGENT_CASES,
  START_HERE_APPS_LIST,
  START_HERE_APPS_PATH,
  START_HERE_MESSAGES_PATH,
  START_HERE_REPLY_CASES,
  type UiAnswer,
} from '@4thtech-io/types/ui-contract/start-here';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { parseAgentSignal, readAgentSignal, readReplied } from './start-here-api.js';

/** A fetch that answers each sample path with its sample answer and records what was asked. */
function sampleFetch(answers: Readonly<Record<string, UiAnswer>>) {
  const asked: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    asked.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    const found = answers[url.pathname];
    if (found === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(found.body), {
      status: found.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { asked, client: createApiClient({ fetch: fetchFn, token: 't' }) };
}

describe('contract (page): the agent signal from GET /api/ui/agents and /api/ui/apps', () => {
  for (const sample of START_HERE_AGENT_CASES) {
    it(sample.title, async () => {
      const t = sampleFetch({
        [START_HERE_AGENTS_PATH]: sample.agentsAnswer,
        [START_HERE_APPS_PATH]: sample.appsAnswer,
      });
      const signal = await readAgentSignal(t.client);
      expect(signal ?? null).toEqual(sample.signal);
      expect([...t.asked].sort()).toEqual(
        [`GET ${START_HERE_AGENTS_PATH}`, `GET ${START_HERE_APPS_PATH}`].sort(),
      );
    });
  }

  it('with no answer there is no signal, never "done"', async () => {
    const down = createApiClient({
      fetch: (() => Promise.reject(new Error('offline'))) as typeof fetch,
      token: 't',
    });
    expect(await readAgentSignal(down)).toBeUndefined();
  });
});

describe('the AI apps list shape of GET /api/ui/apps (U3-f, 08 §1) enriches the agent signal', () => {
  const { agents, connected, notDone } = START_HERE_APPS_LIST;

  it('an entry counts only when connected and running THIS agent, with its fixed name', () => {
    expect(parseAgentSignal(agents, connected.apps)).toMatchObject({
      connected: true,
      appName: connected.appName,
    });
  });

  it('not_available, an empty list, or junk is not done', () => {
    for (const apps of notDone) {
      expect(parseAgentSignal(agents, apps)).toMatchObject({ connected: false, appName: null });
    }
  });

  it('an app name or id from anywhere else is plain text, shortened, never markup', () => {
    const first = agents.agents[0];
    const odd = { ...agents, agents: [{ ...first, apps: ['<b>x</b>'.repeat(30)] }] };
    const signal = parseAgentSignal(odd, undefined);
    expect(signal?.connected).toBe(true);
    expect((signal?.appName ?? '').length).toBeLessThanOrEqual(40);
  });
});

describe('contract (page): the reply from GET /api/ui/messages', () => {
  for (const sample of START_HERE_REPLY_CASES) {
    it(`${sample.title}: replied is ${String(sample.replied)}`, async () => {
      const t = sampleFetch({ [START_HERE_MESSAGES_PATH]: sample.answer });
      expect(await readReplied(t.client)).toBe(sample.replied);
      expect(t.asked).toEqual([`GET ${START_HERE_MESSAGES_PATH}`]);
    });
  }

  it('no answer when the read fails', async () => {
    const down = createApiClient({
      fetch: (() => Promise.resolve(new Response('{}', { status: 503 }))) as typeof fetch,
      token: 't',
    });
    expect(await readReplied(down)).toBeUndefined();
  });
});
