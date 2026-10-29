// @vitest-environment node
// U3-i CONTRACT, page side: the AI apps client against the shared wire samples
// (@4thtech-io/types/ui-contract/apps). The server side
// (packages/node/src/local-ui/ui-contract-apps.test.ts) runs the REAL U3-f handlers on the same
// samples and asserts they answer exactly them. Here the client must build exactly each sample
// request and read each sample answer as the outcome next to it. apps/local-ui never imports
// packages/node (package layering, tools/deps-check).
import {
  APPS_APPLY_PATH,
  APPS_CHANGE,
  APPS_DISCONNECT_PATH,
  APPS_LIST,
  APPS_OCTET_STREAM,
  APPS_PATH,
  APPS_PREVIEW,
  APPS_PREVIEW_PATH,
  type AppsUiAnswer,
} from '@4thtech-io/types/ui-contract/apps';
import { describe, expect, it } from 'vitest';
import { createAppsApi } from './api.js';

interface Sent {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

/** A fetch that records what the page sends and answers with one sample answer. */
function answering(answer: AppsUiAnswer) {
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
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { sent, api: createAppsApi({ fetch: fetchFn, token: 't' }) };
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

describe('contract (page): the AI apps read and preview', () => {
  it('GET /api/ui/apps: the sample answer parses to the apps in order', async () => {
    const t = answering(APPS_LIST.answer);
    const read = await t.api.list();
    const s = only(t.sent);
    expect([s.method, s.path]).toEqual(['GET', APPS_PATH]);
    expect(s.headers.get('X-AgentLink-CSRF')).toBe('t');
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.list.desktopRunning).toBe(true);
    expect(
      read.list.apps.map((a) => [a.app, a.name, a.state, a.agent ?? null, a.quitFirst]),
    ).toEqual(
      APPS_LIST.answer.body.apps.map((a) => [
        a.app,
        a.name,
        a.state,
        'agent' in a ? a.agent : null,
        a.quitFirst,
      ]),
    );
  });

  it.each(['connect', 'move', 'disconnect'] as const)(
    'GET preview (%s): sends {app, agent} and reads the change',
    async (kind) => {
      const sample = APPS_PREVIEW[kind];
      const t = answering(sample.answer);
      const out = await t.api.preview(sample.query.app, sample.query.agent);
      const s = only(t.sent);
      expect([s.method, s.path]).toEqual(['GET', APPS_PREVIEW_PATH]);
      expect([...s.query.keys()].sort()).toEqual(['agent', 'app']);
      expect(s.query.get('app')).toBe(sample.query.app);
      expect(s.query.get('agent')).toBe(sample.query.agent);
      expect(out.kind).toBe('change');
      if (out.kind !== 'change') return;
      expect(out.change.kind).toBe(kind);
      expect(out.change.changeId).toBe(sample.answer.body.changeId);
      expect(out.change.newEntry).toEqual(sample.answer.body.newEntry);
      expect(out.change.oldEntry).toEqual(sample.answer.body.oldEntry);
      expect(out.change.oldAgent).toBe(sample.answer.body.oldAgent);
    },
  );

  it.each(['quitFirst', 'conflict'] as const)(
    'GET preview (%s): reads the status word',
    async (kind) => {
      const sample = APPS_PREVIEW[kind];
      const t = answering(sample.answer);
      const out = await t.api.preview(sample.query.app, sample.query.agent);
      expect(out).toEqual({ kind: 'none', status: sample.answer.body.status });
    },
  );
});

describe('contract (page): apply and disconnect', () => {
  it('apply: octet-stream body is the proof; X-AgentLink-Input is exactly {changeId}', async () => {
    const t = answering(APPS_CHANGE.done.answer);
    const out = await t.api.apply(APPS_CHANGE.applyInput.changeId, proof);
    const s = only(t.sent);
    expect([s.method, s.path]).toEqual(['POST', APPS_APPLY_PATH]);
    expect(s.headers.get('Content-Type')).toBe(APPS_OCTET_STREAM);
    expect(s.headers.get('X-AgentLink-CSRF')).toBe('t');
    expect(input(s)).toEqual(APPS_CHANGE.applyInput);
    expect(s.body).toBe('123456');
    expect(out).toEqual({ kind: APPS_CHANGE.done.outcome });
  });

  it('disconnect goes to its own route with exactly {changeId}', async () => {
    const t = answering(APPS_CHANGE.done.answer);
    await t.api.disconnect(APPS_CHANGE.disconnectInput.changeId, proof);
    const s = only(t.sent);
    expect([s.method, s.path]).toEqual(['POST', APPS_DISCONNECT_PATH]);
    expect(input(s)).toEqual(APPS_CHANGE.disconnectInput);
  });

  it.each(APPS_CHANGE.refusals)('the {error} answer %# is read as its outcome word', async (r) => {
    const t = answering(r.answer);
    const out = await t.api.apply(APPS_CHANGE.applyInput.changeId, proof);
    expect(out).toEqual({ kind: r.outcome });
  });

  it('the presence gate words ({status}) are read too', async () => {
    for (const [status, word, kind] of [
      [403, 'presence_required', 'required'],
      [403, 'presence_rejected', 'rejected'],
      [429, 'wait', 'wait'],
      [409, 'busy', 'busy'],
      [401, 'session', 'session'],
    ] as const) {
      const t = answering({ status, body: { status: word } });
      expect(await t.api.apply(APPS_CHANGE.applyInput.changeId, proof)).toEqual({ kind });
    }
  });
});
