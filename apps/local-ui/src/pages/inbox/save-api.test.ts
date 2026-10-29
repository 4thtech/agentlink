// W4-FILES-SAVE: the page's Save client against the shared wire contract (types ui-contract/inbox.ts).
// The client builds exactly the request the server parses (the path, octet-stream, `{id}` alone in
// X-AgentLink-Input, the presence in the body), sends nothing for an ID that is not a received item
// ID, and reads each contract answer as its outcome word. The node side runs the real handler against
// the same samples (packages/node src/local-ui/api/files-save.test.ts).
import {
  FILE_SAVE_ANSWERS,
  FILE_SAVE_ITEM_ID,
  FILE_SAVE_PATH,
  FILE_SAVE_SAMPLE_ID,
  type FileSaveOutcome,
} from '@4thtech-io/types/ui-contract/inbox';
import { describe, expect, it } from 'vitest';
import { FILE_SAVE_PATH as PAGE_PATH, createSaveApi, readSaveAnswer } from './save-api.js';

interface Sent {
  url: string;
  init: RequestInit;
}

function fake(status: number, body: unknown) {
  const sent: Sent[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    sent.push({ url, init: { ...init, body: new Uint8Array(init.body as Uint8Array) } });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { sent, fetchFn };
}

const decode = (raw: string): unknown => {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
};

describe('the Save client and the contract (W4-FILES-SAVE)', () => {
  it('uses the contract path and item ID rule', () => {
    expect(PAGE_PATH).toBe(FILE_SAVE_PATH);
    expect(FILE_SAVE_ITEM_ID.test(FILE_SAVE_SAMPLE_ID)).toBe(true);
  });

  it('sends exactly {id}, octet-stream, the code as the body, the session token', async () => {
    const { sent, fetchFn } = fake(200, { status: 'saved' });
    const api = createSaveApi({ fetch: fetchFn, token: 'tok' });
    const out = await api.save(FILE_SAVE_SAMPLE_ID, { kind: 'code', code: 'abc' });
    expect(out).toEqual({ kind: 'outcome', outcome: 'saved' });
    expect(sent).toHaveLength(1);
    const req = sent[0] as Sent;
    expect(req.url).toBe(FILE_SAVE_PATH);
    expect(req.init.method).toBe('POST');
    const headers = new Headers(req.init.headers);
    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('X-AgentLink-CSRF')).toBe('tok');
    expect(headers.get('X-AgentLink-Presence')).toBeNull();
    expect(decode(headers.get('X-AgentLink-Input') ?? '')).toEqual({ id: FILE_SAVE_SAMPLE_ID });
    expect(new TextDecoder().decode(req.init.body as Uint8Array)).toBe('abc');
  });

  it('never sends an ID that is not a received item ID (no name, no path)', async () => {
    const { sent, fetchFn } = fake(200, { status: 'saved' });
    const api = createSaveApi({ fetch: fetchFn, token: 'tok' });
    for (const id of [
      '',
      'brief.txt',
      `../${FILE_SAVE_SAMPLE_ID}`,
      `${FILE_SAVE_SAMPLE_ID}/x`,
      '/etc/passwd',
    ]) {
      expect(await api.save(id, { kind: 'code', code: 'abc' })).toEqual({
        kind: 'outcome',
        outcome: 'bad_request',
      });
    }
    expect(sent).toEqual([]);
  });

  it('a dismissed passkey prompt sends nothing', async () => {
    const { sent, fetchFn } = fake(200, { status: 'saved' });
    const credentials = { get: () => Promise.reject(new Error('NotAllowed')) };
    const api = createSaveApi({
      fetch: fetchFn,
      token: 'tok',
      credentials: credentials as unknown as CredentialsContainer,
    });
    const out = await api.save(FILE_SAVE_SAMPLE_ID, {
      kind: 'passkey',
      passkey: { credentialId: 'AQID', prfSalt: 'BAUG' },
    });
    expect(out).toEqual({ kind: 'dismissed' });
    expect(sent).toEqual([]);
  });

  it('reads every contract answer as its outcome word', () => {
    for (const [outcome, answer] of Object.entries(FILE_SAVE_ANSWERS)) {
      expect(readSaveAnswer(answer.status, answer.body), outcome).toEqual({
        kind: 'outcome',
        outcome: outcome as FileSaveOutcome,
      });
    }
  });

  it("reads the presence gate's own answers", () => {
    expect(readSaveAnswer(403, { status: 'presence_rejected' })).toEqual({
      kind: 'presence_rejected',
    });
    expect(readSaveAnswer(403, { status: 'presence_required' })).toEqual({
      kind: 'presence_required',
    });
    expect(readSaveAnswer(409, { status: 'busy' })).toEqual({ kind: 'busy' });
    expect(readSaveAnswer(429, { status: 'wait', retryAfter: 30 })).toEqual({
      kind: 'wait',
      seconds: 30,
    });
    expect(readSaveAnswer(409, { status: 'refused' })).toEqual({
      kind: 'outcome',
      outcome: 'refused',
    });
    expect(readSaveAnswer(401, {})).toEqual({ kind: 'session_expired' });
  });
});
