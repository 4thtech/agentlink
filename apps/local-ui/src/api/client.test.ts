// @vitest-environment jsdom
// M1-11s-a: the API client sends the session token on every call, maps statuses to typed results
// and never logs a body.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createApiClient', () => {
  it('sends the token, same-origin and no-store, and returns the parsed body', async () => {
    const fetchMock = vi.fn(async () => json(200, { items: [1, 2] }));
    const api = createApiClient({ fetch: fetchMock, token: 'tok-1' });
    const result = await api.get<{ items: number[] }>('/api/activity');
    expect(result).toEqual({ kind: 'ok', status: 200, data: { items: [1, 2] } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/activity');
    expect(new Headers(init.headers).get('X-AgentLink-CSRF')).toBe('tok-1');
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    expect(init.method).toBe('GET');
  });

  it('reads the token from the page meta tag by default', async () => {
    document.head.innerHTML = '<meta name="agentlink-csrf" content="from-meta">';
    const fetchMock = vi.fn(async () => json(200, {}));
    await createApiClient({ fetch: fetchMock }).get('/api/x');
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get('X-AgentLink-CSRF')).toBe('from-meta');
    document.head.innerHTML = '';
  });

  it('sends a JSON body on post', async () => {
    const fetchMock = vi.fn(async () => json(200, { ok: true }));
    const api = createApiClient({ fetch: fetchMock, token: 't' });
    await api.post('/api/contacts/block', { id: 'c1' });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"id":"c1"}');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it.each([
    [401, { kind: 'session_expired' }],
    [403, { kind: 'forbidden' }],
    [501, { kind: 'not_available' }],
    [500, { kind: 'error', status: 500 }],
    [404, { kind: 'error', status: 404 }],
  ])('maps HTTP %i to %j', async (status, expected) => {
    const api = createApiClient({ fetch: async () => json(status, { detail: 'x' }), token: 't' });
    expect(await api.get('/api/x')).toEqual(expected);
  });

  it('maps a presence_required body to its own result, whatever the status', async () => {
    for (const status of [200, 401, 403, 409]) {
      const api = createApiClient({
        fetch: async () => json(status, { status: 'presence_required' }),
        token: 't',
      });
      expect(await api.post('/api/x', {})).toEqual({ kind: 'presence_required' });
    }
  });

  it('maps a network failure to offline', async () => {
    const api = createApiClient({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
      token: 't',
    });
    expect(await api.get('/api/x')).toEqual({ kind: 'offline' });
  });

  it('treats a non-JSON success body as an error, not a crash', async () => {
    const api = createApiClient({
      fetch: async () => new Response('<html>', { status: 200 }),
      token: 't',
    });
    expect(await api.get('/api/x')).toEqual({ kind: 'error', status: 200 });
  });

  it('refuses a path outside /api/ before any request', async () => {
    const fetchMock = vi.fn();
    const api = createApiClient({ fetch: fetchMock, token: 't' });
    for (const bad of ['/settings', 'https://evil.example/api/x', '//evil.example/api/x', 'api/x']) {
      await expect(api.get(bad)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never logs a request or response body', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const api = createApiClient({
      fetch: async () => json(500, { secret: 'SECRET-BODY' }),
      token: 'SECRET-TOKEN',
    });
    await api.post('/api/x', { secret: 'SECRET-REQUEST' });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
