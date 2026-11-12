// @vitest-environment jsdom
// F25 (owner test of 0.4.10): the app host quit with no word and every page said "Try again in a
// minute". The page now knows the host is gone: the host says "closing" on the live stream before it
// stops, and a host that stops answering after the page had loaded is treated as closed. A page that
// never reached the host is not "closed" (that stays the usual offline words).
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostClosedGate } from '../layout/host-closed-gate.js';
import { createApiClient } from './client.js';
import {
  HOST_CLOSED_TEXT,
  isHostClosed,
  markHostClosed,
  resetHostClosedForTests,
  subscribeHostClosed,
} from './host-closed.js';
import { resetLiveForTests, subscribeLive } from './live.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  resetHostClosedForTests();
  resetLiveForTests();
  document.head.innerHTML = '<meta name="agentlink-csrf" content="page-token" />';
});
afterEach(() => {
  resetLiveForTests();
  resetHostClosedForTests();
  vi.unstubAllGlobals();
});

const ok = (): Response => new Response('{}', { status: 200 });

describe('the page learns the host is gone (F25)', () => {
  it('has the one plain line', () => {
    expect(HOST_CLOSED_TEXT).toBe('AgentLink closed. Open AgentLink again.');
  });

  it('two failed requests in a row after a good one mean closed; a good one in between resets', async () => {
    let up = true;
    const fetch = vi.fn(() => (up ? Promise.resolve(ok()) : Promise.reject(new TypeError('net'))));
    const client = createApiClient({ fetch: fetch as unknown as typeof globalThis.fetch });
    await client.get('/api/ui/agents');
    up = false;
    await expect(client.get('/api/ui/agents')).resolves.toEqual({ kind: 'offline' });
    expect(isHostClosed()).toBe(false);
    up = true;
    await client.get('/api/ui/agents');
    up = false;
    await client.get('/api/ui/agents');
    expect(isHostClosed()).toBe(false);
    await client.get('/api/ui/agents');
    expect(isHostClosed()).toBe(true);
  });

  it('a page that never reached the host is not "closed"', async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('net')));
    const client = createApiClient({ fetch: fetch as unknown as typeof globalThis.fetch });
    for (let i = 0; i < 4; i += 1) await client.get('/api/ui/agents');
    expect(isHostClosed()).toBe(false);
  });

  it('a "closing" event on the live stream marks it closed at once', async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/ui/events') {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(encoder.encode('id: A.1\nevent: closing\ndata: {}\n\n'));
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ switchable: true, generation: 1, agents: [] }), {
          status: 200,
        }),
      );
    });
    const seen: boolean[] = [];
    subscribeHostClosed(() => seen.push(isHostClosed()));
    const stop = subscribeLive(() => undefined);
    await vi.waitFor(() => expect(isHostClosed()).toBe(true));
    expect(seen).toContain(true);
    stop();
  });

  it('the gate replaces the page with the closed line, and nothing else', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(h(HostClosedGate, null, h('p', null, 'the app')));
    });
    expect(host.textContent).toBe('the app');
    await act(async () => {
      markHostClosed();
    });
    expect(host.textContent).toContain(HOST_CLOSED_TEXT);
    expect(host.textContent).not.toContain('the app');
    expect(host.textContent).not.toMatch(/minute/);
    await act(async () => root.unmount());
  });
});
