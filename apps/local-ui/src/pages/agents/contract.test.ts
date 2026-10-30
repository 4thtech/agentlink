// @vitest-environment node
// U3-h CONTRACT, page side: the page's client against the shared Agents wire samples
// (@4thtech-io/types/ui-contract/agents). The server side
// (packages/node/src/local-ui/ui-contract-agents.test.ts) runs the REAL app host and route handlers
// on the same samples and asserts they answer exactly them. Here the client must build exactly each
// sample request and read each sample answer as the outcome word next to it. apps/local-ui never
// imports packages/node (package layering, tools/deps-check).
import {
  AGENTS_LABEL_CHECK,
  AGENTS_LABEL_CHECK_PATH,
  AGENTS_LABEL_PATH,
  AGENTS_LIST,
  AGENTS_OWNER,
  AGENTS_PATH,
  AGENTS_REMOVE,
  AGENTS_REMOVE_PATH,
  AGENTS_SWITCH,
  AGENTS_SWITCH_PATH,
  OCTET_STREAM,
  type AgentsSwitchBody,
  type UiAnswer,
} from '@4thtech-io/types/ui-contract/agents';
import { describe, expect, it } from 'vitest';
import { createAgentsApi } from './api.js';

interface Sent {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

/** A fetch that records what the page sends and answers with one sample answer. */
function answering(answer: UiAnswer<unknown> | { readonly status: number }) {
  const sent: Sent[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    const raw = init?.body;
    sent.push({
      path: url.pathname,
      query: url.searchParams,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body:
        raw === undefined || raw === null
          ? ''
          : ArrayBuffer.isView(raw)
            ? new TextDecoder().decode(raw)
            : String(raw),
    });
    const body = 'body' in answer ? answer.body : {};
    return new Response(JSON.stringify(body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { sent, api: createAgentsApi({ fetch: fetchFn, token: 't' }) };
}

function only(sent: readonly Sent[]): Sent {
  expect(sent).toHaveLength(1);
  return sent[0] as Sent;
}

/** The X-AgentLink-Input JSON, as the server's presence gate decodes it. */
function input(s: Sent): unknown {
  const raw = s.headers.get('X-AgentLink-Input') ?? '';
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

const proof = { kind: 'code', code: '123456' } as const;

describe('contract (page): the Agents list and the switch', () => {
  it('GET /api/ui/agents: the sample answer parses to the agents in order', async () => {
    const t = answering(AGENTS_LIST.answer);
    const read = await t.api.list();
    const s = only(t.sent);
    expect([s.method, s.path, [...s.query.keys()]]).toEqual(['GET', AGENTS_PATH, []]);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') {
      expect(read.list.switchable).toBe(true);
      expect(read.list.generation).toBe(AGENTS_LIST.answer.body.generation);
      expect(read.list.agents.map((a) => a.name)).toEqual(AGENTS_LIST.names);
    }
  });

  it('the switch sends octet-stream {name, generation (a number)} and reads 200 as done', async () => {
    const sample = AGENTS_SWITCH.accepted;
    const t = answering(sample.answer);
    expect(await t.api.switchTo(sample.body.name, sample.body.generation)).toEqual({
      kind: sample.outcome,
    });
    const s = only(t.sent);
    expect([s.method, s.path]).toEqual(['POST', AGENTS_SWITCH_PATH]);
    expect(s.headers.get('Content-Type')).toBe(OCTET_STREAM);
    const body = JSON.parse(s.body) as AgentsSwitchBody;
    expect(body).toEqual(sample.body);
    expect(typeof body.generation).toBe('number');
  });

  it('a stale generation answer is agent_changed', async () => {
    const sample = AGENTS_SWITCH.stale;
    const t = answering(sample.answer);
    expect(await t.api.switchTo(sample.body.name, sample.body.generation)).toEqual({
      kind: sample.outcome,
    });
    expect(JSON.parse(only(t.sent).body)).toEqual(sample.body);
  });
});

describe('contract (page): label-check, Add and Rename (U3-d)', () => {
  it('label-check sends the label as its one query parameter and reads ok and refused', async () => {
    for (const sample of [AGENTS_LABEL_CHECK.ok, AGENTS_LABEL_CHECK.refused]) {
      const t = answering(sample.answer);
      expect(await t.api.labelCheck(sample.label)).toBe(sample.outcome);
      const s = only(t.sent);
      expect([s.method, s.path]).toEqual(['GET', AGENTS_LABEL_CHECK_PATH]);
      expect([...s.query.keys()]).toEqual(['label']);
      expect(s.query.get('label')).toBe(sample.label);
    }
  });

  it('rename sends exactly {name, label} in X-AgentLink-Input and reads done', async () => {
    const sample = AGENTS_OWNER.rename;
    const t = answering(sample.answer);
    expect((await t.api.rename(sample.input, proof)).kind).toBe(sample.outcome);
    const s = only(t.sent);
    expect([s.method, s.path]).toEqual(['POST', AGENTS_LABEL_PATH]);
    expect(s.headers.get('Content-Type')).toBe(OCTET_STREAM);
    expect(input(s)).toEqual(sample.input);
  });

  // W4-ONE-TOUCH: Add is begin + finish with one gesture; its contract test is
  // pages/apps/create-agent.contract.test.ts (the same samples).

  it('the {error} refusals map: label_invalid, and another open agent is agent_changed', async () => {
    for (const sample of AGENTS_OWNER.refusals) {
      const t = answering(sample.answer);
      expect(await t.api.rename(sample.input, proof)).toEqual({ kind: sample.outcome });
      expect(input(only(t.sent))).toEqual(sample.input);
    }
  });
});

describe('contract (page): Remove (U3-e)', () => {
  it('sends {name, typedLabel}; the stub is not_available and every documented code maps', async () => {
    const stub = answering({ status: AGENTS_REMOVE.stub.status });
    expect(await stub.api.remove(AGENTS_REMOVE.input, proof)).toEqual({
      kind: AGENTS_REMOVE.stub.outcome,
    });
    const s = only(stub.sent);
    expect([s.method, s.path]).toEqual(['POST', AGENTS_REMOVE_PATH]);
    expect(input(s)).toEqual(AGENTS_REMOVE.input);
    for (const sample of AGENTS_REMOVE.documented) {
      const t = answering(sample.answer);
      expect(await t.api.remove(AGENTS_REMOVE.input, proof)).toEqual({ kind: sample.outcome });
    }
  });
});
