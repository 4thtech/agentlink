// REL051-SF1: the page side of the presence ceremony (presence-ceremony.ts). The ceremony is asked
// with the request's own headers and no body; its challenge is what the gesture answers; a refusal
// is handed back as the answer; a dismissed gesture sends no proof.
import { describe, expect, it } from 'vitest';
import { ceremonyPublicKeyOf, sendWithProof, type CeremonyPublicKey } from './presence-ceremony.js';

const CEREMONY = 'C'.repeat(22);
const READY = {
  status: 'ready',
  ceremony: CEREMONY,
  expiresInMs: 120000,
  publicKey: {
    rpId: 'localhost',
    challenge: 'AAEC',
    allowCredentials: ['AQID'],
    userVerification: 'required',
    timeoutMs: 120000,
    prfSalt: 'BAUG',
  },
};

interface Sent {
  readonly headers: Headers;
  readonly body: Uint8Array;
}

function fake(...answers: { status: number; body: unknown }[]) {
  const sent: Sent[] = [];
  const fetchFn = ((_path: string, init: RequestInit) => {
    sent.push({
      headers: new Headers(init.headers),
      body: init.body instanceof Uint8Array ? init.body.slice() : new Uint8Array(0),
    });
    const a = answers.shift() ?? { status: 500, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(a.body), {
        status: a.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { sent, fetchFn };
}

const headers = (): Headers => new Headers({ 'X-AgentLink-CSRF': 't', 'X-AgentLink-Input': 'e30' });

describe('the presence ceremony (REL051-SF1)', () => {
  it('asks with the same headers and no body, answers the challenge, sends the proof once', async () => {
    const { sent, fetchFn } = fake({ status: 200, body: READY }, { status: 200, body: { ok: 1 } });
    const seen: CeremonyPublicKey[] = [];
    const res = await sendWithProof(fetchFn, '/api/ui/rules', headers(), {
      kind: 'passkey',
      gesture: (pk) => {
        seen.push(pk);
        return Promise.resolve(new Uint8Array([7, 7]));
      },
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      { challenge: 'AAEC', allowCredentials: ['AQID'], prfSalt: 'BAUG', timeoutMs: 120000 },
    ]);
    const [ask, proof] = sent;
    expect(ask?.headers.get('X-AgentLink-Presence')).toBe('challenge');
    expect(ask?.headers.get('X-AgentLink-Input')).toBe('e30');
    expect(ask?.headers.get('X-AgentLink-Ceremony')).toBeNull();
    expect(ask?.body).toHaveLength(0);
    expect(proof?.headers.get('X-AgentLink-Presence')).toBe('passkey');
    expect(proof?.headers.get('X-AgentLink-Ceremony')).toBe(CEREMONY);
    expect(proof?.headers.get('X-AgentLink-Input')).toBe('e30');
    expect([...(proof?.body ?? [])]).toEqual([7, 7]);
  });

  it('a refused ask is the answer; no gesture, nothing else sent', async () => {
    const { sent, fetchFn } = fake({ status: 429, body: { status: 'wait', retryAfter: 4 } });
    let gestures = 0;
    const res = await sendWithProof(fetchFn, '/api/ui/rules', headers(), {
      kind: 'passkey',
      gesture: () => {
        gestures += 1;
        return Promise.resolve(new Uint8Array([1]));
      },
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ status: 'wait', retryAfter: 4 });
    expect(gestures).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('a dismissed gesture sends no proof and reads as presence_required', async () => {
    const { sent, fetchFn } = fake({ status: 200, body: READY });
    const res = await sendWithProof(fetchFn, '/api/ui/rules', headers(), {
      kind: 'passkey',
      gesture: () => Promise.resolve(undefined),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ status: 'presence_required' });
    expect(sent).toHaveLength(1);
  });

  it('a malformed ready answer is never answered with a gesture', async () => {
    for (const body of [
      { ...READY, ceremony: 'short' },
      { ...READY, publicKey: { ...READY.publicKey, rpId: 'example.com' } },
      { ...READY, publicKey: { ...READY.publicKey, challenge: 'not base64url!' } },
      { ...READY, status: 'done' },
    ]) {
      const { sent, fetchFn } = fake({ status: 200, body });
      let gestures = 0;
      const res = await sendWithProof(fetchFn, '/api/ui/rules', headers(), {
        kind: 'passkey',
        gesture: () => {
          gestures += 1;
          return Promise.resolve(new Uint8Array([1]));
        },
      });
      expect(res.status).toBe(403);
      expect(gestures).toBe(0);
      expect(sent).toHaveLength(1);
    }
  });

  it('the master code is one request, its bytes as the body, no ceremony', async () => {
    const { sent, fetchFn } = fake({ status: 200, body: { status: 'done' } });
    await sendWithProof(fetchFn, '/api/ui/rules', headers(), { kind: 'code', code: 'ABCD' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.get('X-AgentLink-Presence')).toBeNull();
    expect(new TextDecoder().decode(sent[0]?.body)).toBe('ABCD');
  });

  it('reads only well-formed request values', () => {
    expect(ceremonyPublicKeyOf(READY.publicKey)).toBeDefined();
    expect(
      ceremonyPublicKeyOf({ ...READY.publicKey, allowCredentials: ['a', 'b'] }),
    ).toBeUndefined();
    expect(ceremonyPublicKeyOf(null)).toBeUndefined();
  });
});
