// @vitest-environment node
// W4-AGENTS CONTRACT, page side: Pause, Resume (K2, W4-PAUSE), the rename limit and the card name
// (#716, D-141) against the shared samples (@4thtech-io/types/ui-contract/agents). The server side
// runs the real routes on the same samples (packages/node ui-contract-agents tests).
import {
  AGENTS_CARD_NAME,
  AGENTS_CARD_NAME_PATH,
  AGENTS_OWNER,
  AGENTS_PAUSE,
  AGENTS_PAUSE_PATH,
  AGENTS_RESUME,
  AGENTS_RESUME_PATH,
  OCTET_STREAM,
  type UiAnswer,
} from '@4thtech-io/types/ui-contract/agents';
import { describe, expect, it } from 'vitest';
import { createAgentsApi } from './api.js';

interface Sent {
  readonly path: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

function answering(answer: UiAnswer<unknown>) {
  const sent: Sent[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    const raw = init?.body;
    sent.push({
      path: url.pathname,
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
  return { sent, api: createAgentsApi({ fetch: fetchFn, token: 't' }) };
}

function only(sent: readonly Sent[]): Sent {
  expect(sent).toHaveLength(1);
  return sent[0] as Sent;
}

function input(s: Sent): unknown {
  const raw = s.headers.get('X-AgentLink-Input') ?? '';
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

const proof = { kind: 'code', code: '123456' } as const;

describe('contract (page): Pause', () => {
  it('posts exactly {generation} as octet-stream, no input and no presence, and reads paused', async () => {
    const t = answering(AGENTS_PAUSE.accepted.answer);
    const out = await t.api.pause(AGENTS_PAUSE.accepted.body.generation);
    const s = only(t.sent);
    expect(s.method).toBe('POST');
    expect(s.path).toBe(AGENTS_PAUSE_PATH);
    expect(s.headers.get('Content-Type')).toBe(OCTET_STREAM);
    expect(s.headers.get('X-AgentLink-CSRF')).toBe('t');
    expect(s.headers.has('X-AgentLink-Input')).toBe(false);
    expect(s.headers.has('X-AgentLink-Presence')).toBe(false);
    expect(JSON.parse(s.body)).toEqual(AGENTS_PAUSE.accepted.body);
    expect(out.kind).toBe('done');
  });
  it('reads agent_changed at a stale generation and invalid as failed', async () => {
    expect((await answering(AGENTS_PAUSE.stale.answer).api.pause(99)).kind).toBe('agent_changed');
    expect((await answering(AGENTS_PAUSE.invalid.answer).api.pause(1)).kind).toBe('failed');
    expect((await answering({ status: 501, body: {} }).api.pause(1)).kind).toBe('not_available');
  });
});

describe('contract (page): Resume with Touch ID', () => {
  it('is a presence route: input {} and the proof as the body; reads resumed as done', async () => {
    const t = answering(AGENTS_RESUME.resumed.answer);
    const out = await t.api.resume(proof);
    const s = only(t.sent);
    expect(s.path).toBe(AGENTS_RESUME_PATH);
    expect(s.method).toBe('POST');
    expect(s.headers.get('Content-Type')).toBe(OCTET_STREAM);
    expect(input(s)).toEqual(AGENTS_RESUME.input);
    expect(s.body).toBe('123456');
    expect(out.kind).toBe('done');
  });
  it('reads not_paused', async () => {
    expect((await answering(AGENTS_RESUME.notPaused.answer).api.resume(proof)).kind).toBe(
      'not_paused',
    );
  });
});

describe('contract (page): Rename reaches contacts (D-141)', () => {
  it('reads how many contacts will be told', async () => {
    const t = answering(AGENTS_OWNER.rename.answer);
    const out = await t.api.rename(AGENTS_OWNER.rename.input, proof);
    expect(out.kind).toBe('done');
    expect(out.contacts).toBe(2);
    const plain = answering(AGENTS_OWNER.renameLabelOnly.answer);
    const quiet = await plain.api.rename(AGENTS_OWNER.renameLabelOnly.input, proof);
    expect(quiet.kind).toBe('done');
    expect(quiet.contacts).toBeUndefined();
  });
  it('reads rename_limited with its time, and rotation_pending', async () => {
    const [limited, pending] = AGENTS_OWNER.renameRefusals;
    const a = await answering(limited.answer).api.rename(limited.input, proof);
    expect(a.kind).toBe(limited.outcome);
    expect(a.retryAt).toBe(1_800_086_400);
    const b = await answering(pending.answer).api.rename(pending.input, proof);
    expect(b.kind).toBe(pending.outcome);
  });
  it('reads the card name of the open agent (a GET, no presence)', async () => {
    const t = answering(AGENTS_CARD_NAME.differs.answer);
    const out = await t.api.cardName();
    const s = only(t.sent);
    expect(s.method).toBe('GET');
    expect(s.path).toBe(AGENTS_CARD_NAME_PATH);
    expect(out).toEqual({ kind: 'differs', cardName: 'My agent' });
    expect(await answering(AGENTS_CARD_NAME.same.answer).api.cardName()).toEqual({ kind: 'same' });
    expect(await answering({ status: 500, body: {} }).api.cardName()).toEqual({
      kind: 'unavailable',
    });
  });
});
