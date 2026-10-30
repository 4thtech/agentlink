// @vitest-environment node
// U3-invite CONTRACT, page side: the join screen's client against the shared samples
// (@4thtech-io/types/ui-contract/join). The server side
// (packages/node/src/local-ui/ui-contract-join.test.ts) runs the REAL app host and handlers on the
// same samples. Here the client must build exactly each sample request and read each sample answer
// as the outcome next to it. apps/local-ui never imports packages/node.
import {
  JOIN_ACCEPT,
  JOIN_ACCEPT_PATH,
  JOIN_DISMISS,
  JOIN_DISMISS_PATH,
  JOIN_PATH,
  JOIN_READ,
  JOIN_WORLD,
  OCTET_STREAM,
  type JoinAnswer,
} from '@4thtech-io/types/ui-contract/join';
import { describe, expect, it } from 'vitest';
import {
  JOIN_ACCEPT_PATH as PAGE_ACCEPT_PATH,
  JOIN_DISMISS_PATH as PAGE_DISMISS_PATH,
  JOIN_PATH as PAGE_PATH,
  createJoinApi,
} from './api.js';

interface Sent {
  readonly path: string;
  readonly search: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

function answering(answer: JoinAnswer, headers: Record<string, string> = {}) {
  const sent: Sent[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    const raw = init?.body;
    sent.push({
      path: url.pathname,
      search: url.search,
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
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as typeof fetch;
  return { sent, api: createJoinApi({ fetch: fetchFn, token: 't' }) };
}

const decodeInput = (value: string | null): unknown =>
  JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob((value ?? '').replace(/-/g, '+').replace(/_/g, '/')), (c) =>
        c.charCodeAt(0),
      ),
    ),
  );

describe('contract (page): the join screen client and the shared samples', () => {
  it('uses the sample paths', () => {
    expect([PAGE_PATH, PAGE_ACCEPT_PATH, PAGE_DISMISS_PATH]).toEqual([
      JOIN_PATH,
      JOIN_ACCEPT_PATH,
      JOIN_DISMISS_PATH,
    ]);
  });

  it('GET: reads none and the waiting invite (with the agent label stamp)', async () => {
    const none = answering(JOIN_READ.none.answer);
    expect(await none.api.read()).toEqual({ kind: 'ok', state: 'none' });
    const waiting = answering(JOIN_READ.waiting.answer, { 'X-AgentLink-Agent': 'Personal' });
    const read = await waiting.api.read();
    expect(waiting.sent[0]).toMatchObject({ path: JOIN_PATH, method: 'GET', search: '' });
    expect(read).toEqual({
      kind: 'ok',
      state: JOIN_READ.waiting.outcome,
      agent: 'Personal',
      invite: {
        inviteId: JOIN_WORLD.inviteId,
        name: JOIN_WORLD.inviter.name,
        fingerprint: JOIN_WORLD.inviter.fingerprint,
        expiresAt: JOIN_WORLD.expiresAtSeconds * 1000,
      },
    });
  });

  // W4-PEOPLE-INVITE (IR SEC-1 L3): connected carries the new contact's ref; a malformed one is
  // dropped (the screen then shows no code rather than another contact's).
  it('GET: connected reads the new contact ref; a malformed ref is left out', async () => {
    const read = await answering(JOIN_READ.connected.answer).api.read();
    expect(read).toMatchObject({
      kind: 'ok',
      state: 'connected',
      contactRef: JOIN_WORLD.contactId,
    });
    const bad = await answering({
      status: 200,
      body: { ...JOIN_READ.connected.answer.body, contactRef: '0xNOT/../a-ref' },
    }).api.read();
    expect(bad).toMatchObject({ kind: 'ok', state: 'connected' });
    expect((bad as { contactRef?: string }).contactRef).toBeUndefined();
  });

  it('accept: exactly {inviteId} in X-AgentLink-Input, the proof as the octet-stream body', async () => {
    const { sent, api } = answering(JOIN_ACCEPT.started.answer);
    const outcome = await api.accept(JOIN_ACCEPT.started.input.inviteId, {
      kind: 'code',
      code: 'AAAA-BBBB',
    });
    expect(outcome).toEqual({ kind: JOIN_ACCEPT.started.outcome });
    const [req] = sent;
    expect(req?.path).toBe(JOIN_ACCEPT_PATH);
    expect(req?.method).toBe('POST');
    expect(req?.search).toBe('');
    expect(req?.headers.get('content-type')).toBe(OCTET_STREAM);
    expect(decodeInput(req?.headers.get('X-AgentLink-Input') ?? null)).toEqual(
      JOIN_ACCEPT.started.input,
    );
    expect(req?.body).toBe('AAAA-BBBB');
    expect(req?.headers.get('X-AgentLink-Presence')).toBeNull();
  });

  it('accept: reads invite_changed as its outcome', async () => {
    const { api } = answering(JOIN_ACCEPT.changed.answer);
    expect(
      await api.accept(JOIN_ACCEPT.changed.input.inviteId, {
        kind: 'passkey',
        body: new Uint8Array([1, 2, 3]),
      }),
    ).toEqual({ kind: JOIN_ACCEPT.changed.outcome });
  });

  it('dismiss: octet-stream {} with no input or presence header', async () => {
    const { sent, api } = answering(JOIN_DISMISS.answer);
    expect(await api.dismiss()).toBe(JOIN_DISMISS.outcome);
    const [req] = sent;
    expect(req?.path).toBe(JOIN_DISMISS_PATH);
    expect(req?.method).toBe('POST');
    expect(req?.headers.get('content-type')).toBe(OCTET_STREAM);
    expect(JSON.parse(req?.body ?? '')).toEqual(JOIN_DISMISS.body);
    expect(req?.headers.get('X-AgentLink-Input')).toBeNull();
  });

  it('a malformed waiting answer fails closed (no field is trusted)', async () => {
    for (const body of [
      { state: 'waiting' },
      { ...JOIN_READ.waiting.answer.body, inviteId: 'x' },
      {
        ...JOIN_READ.waiting.answer.body,
        inviter: { name: 'M', label: 'verified', fingerprint: '7F3A·19C2' },
      },
      { ...JOIN_READ.waiting.answer.body, state: 'other' },
      { ...JOIN_READ.waiting.answer.body, link: 'https://agentlink.4thtech.io/i#AAAA' },
    ]) {
      const { api } = answering({ status: 200, body });
      const read = await api.read();
      if ('link' in body) {
        // Unknown fields are never read: the link would not reach the page model.
        expect(JSON.stringify(read)).not.toContain('i#AAAA');
      } else {
        expect(read).toEqual({ kind: 'failed' });
      }
    }
  });
});
