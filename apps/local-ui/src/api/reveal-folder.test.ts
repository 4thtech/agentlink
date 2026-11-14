import { describe, expect, it } from 'vitest';
import { createRevealApi } from './reveal-folder.js';

const respond = (status: number) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response('{}', { status }));
  }) as unknown as typeof fetch;
  return { calls, api: createRevealApi({ fetch: fetchImpl, token: 'tok' }) };
};

describe('FILES-REVEAL: the page helper', () => {
  it('posts an empty octet-stream body with only the CSRF header, to the fixed paths', async () => {
    const { calls, api } = respond(200);
    expect(await api.revealSendFolder()).toBe('shown');
    expect(await api.revealInbox()).toBe('shown');
    expect(calls.map((c) => c.url)).toEqual([
      '/api/ui/files/send-folder/reveal',
      '/api/ui/storage/inbox/reveal',
    ]);
    for (const c of calls) {
      expect(c.init.method).toBe('POST');
      expect((c.init.body as Uint8Array).length).toBe(0);
      const h = c.init.headers as Headers;
      expect(h.get('X-AgentLink-CSRF')).toBe('tok');
      expect(h.get('content-type')).toBe('application/octet-stream');
    }
  });

  it('maps a 404 to not_found and anything else to failed', async () => {
    expect(await respond(404).api.revealSendFolder()).toBe('not_found');
    expect(await respond(503).api.revealSendFolder()).toBe('failed');
    const down = createRevealApi({
      fetch: (() => Promise.reject(new Error('x'))) as unknown as typeof fetch,
    });
    expect(await down.revealInbox()).toBe('failed');
  });
});
