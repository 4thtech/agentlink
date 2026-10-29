// W4-ONE-TOUCH contract (page side; D-140; 08 §1): New agent with one gesture speaks exactly what the
// server parses, against the shared samples (@4thtech-io/types ui-contract/agents.ts AGENTS_OWNER.add;
// the server side is packages/node create-connect-server.test.ts). Begin sends `{label, app}` in
// X-AgentLink-Input with an empty octet-stream body and no presence; finish sends only `{nonce}` with
// the proof: the WebAuthn get with begin's challenge (X-AgentLink-Presence: passkey) or the code.
import { AGENTS_OWNER } from '@4thtech-io/types/ui-contract/agents';
import { describe, expect, it } from 'vitest';
import { CREATE_BEGIN_PATH, CREATE_FINISH_PATH, createAgentApi } from './create-agent-api.js';

interface Sent {
  readonly path: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

function answering(...answers: { status: number; body: unknown }[]) {
  const sent: Sent[] = [];
  const fetch = (path: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    sent.push({
      path: String(path),
      headers: new Headers(init?.headers),
      body: new Uint8Array(init?.body as Uint8Array).slice(),
    });
    const next = answers.shift() ?? { status: 500, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
  return { sent, fetch };
}

const inputOf = (s: Sent): unknown => {
  const raw = s.headers.get('X-AgentLink-Input') ?? '';
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))) as unknown;
};

/** A WebAuthn container that answers one get with fixed bytes (the test does not sign). */
function fakeCredentials(seen: { challenge?: Uint8Array }[]): CredentialsContainer {
  return {
    get: (options?: CredentialRequestOptions) => {
      const pk = options?.publicKey;
      seen.push({ challenge: new Uint8Array(pk?.challenge as ArrayBuffer) });
      const buf = (n: number): ArrayBuffer => new Uint8Array(n).fill(1).buffer;
      return Promise.resolve({
        rawId: buf(16),
        response: {
          authenticatorData: buf(37),
          clientDataJSON: buf(64),
          signature: buf(70),
          userHandle: buf(32),
        },
        getClientExtensionResults: () => ({ prf: { results: { first: buf(32) } } }),
      } as unknown as Credential);
    },
  } as unknown as CredentialsContainer;
}

describe('contract (page): New agent with one gesture (W4-ONE-TOUCH)', () => {
  const sample = AGENTS_OWNER.add;

  it('begin sends exactly {label, app}, an empty octet-stream body and no presence; reads the statement', async () => {
    const t = answering(sample.begin);
    const api = createAgentApi({ fetch: t.fetch, token: 't' });
    const begun = await api.begin(sample.input.label, sample.input.app);
    expect(begun).toMatchObject({
      kind: 'ready',
      nonce: sample.begin.body.nonce,
      statement: {
        label: 'Home',
        folder: 'home',
        app: { id: 'claude-code', name: 'Claude Code', kind: 'connect' },
      },
    });
    const s = t.sent[0] as Sent;
    expect(s.path).toBe(CREATE_BEGIN_PATH);
    expect(sample.beginPath).toBe(CREATE_BEGIN_PATH);
    expect(inputOf(s)).toEqual(sample.input);
    expect(s.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(s.headers.get('X-AgentLink-Presence')).toBeNull();
    expect(s.body).toHaveLength(0);
  });

  it("finish with the passkey: one get with begin's challenge, then only {nonce} and the assertion", async () => {
    const seen: { challenge?: Uint8Array }[] = [];
    const t = answering(sample.begin, sample.answer);
    const api = createAgentApi({
      fetch: t.fetch,
      token: 't',
      credentials: () => fakeCredentials(seen),
    });
    const begun = await api.begin(sample.input.label, sample.input.app);
    if (begun.kind !== 'ready') throw new Error('not ready');
    const done = await api.finishPasskey(begun.nonce, begun.publicKey);
    expect(done).toEqual({ kind: 'done', name: 'home', label: 'Home', app: 'claude-code' });
    expect(seen).toHaveLength(1);
    const s = t.sent[1] as Sent;
    expect(s.path).toBe(CREATE_FINISH_PATH);
    expect(inputOf(s)).toEqual(sample.finishInput);
    expect(s.headers.get('X-AgentLink-Presence')).toBe('passkey');
  });

  it('finish with the backup code sends the code as the body; created_not_connected keeps the agent', async () => {
    const t = answering(sample.notConnected);
    const api = createAgentApi({ fetch: t.fetch, token: 't' });
    const result = await api.finishCode(sample.finishInput.nonce, 'ABCD');
    expect(result).toEqual({
      kind: 'created_not_connected',
      name: 'home',
      label: 'Home',
      app: 'claude-code',
    });
    const s = t.sent[0] as Sent;
    expect(inputOf(s)).toEqual(sample.finishInput);
    expect(s.headers.get('X-AgentLink-Presence')).toBeNull();
  });

  it('maps the refusals: a wrong proof keeps the plan (rejected); the rest are fixed words', async () => {
    const answers = [
      [{ status: 403, body: { status: 'presence_rejected' } }, 'rejected'],
      [{ status: 403, body: { status: 'tries_exhausted' } }, 'tries_exhausted'],
      [{ status: 409, body: { status: 'expired' } }, 'expired'],
      [{ status: 409, body: { status: 'changed' } }, 'changed'],
      [{ status: 409, body: { status: 'not_pending' } }, 'not_pending'],
      [{ status: 429, body: { status: 'wait' } }, 'wait'],
    ] as const;
    for (const [answer, kind] of answers) {
      const t = answering(answer);
      const api = createAgentApi({ fetch: t.fetch, token: 't' });
      expect((await api.finishCode('N'.repeat(43), 'x')).kind).toBe(kind);
    }
  });
});
