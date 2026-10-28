// @vitest-environment jsdom
// UI-REFRESH-t (d): at 360 px the proofs table scrolls sideways inside its wrapper. A scroll region
// must be reachable with Tab and have a name (axe: scrollable-region-focusable).
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { ProofsPage, type ProofsPageProps } from './index.js';
import { PROOFS_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const T = Date.UTC(2026, 9, 12, 14, 2) / 1000;
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('Proofs table scroll region', () => {
  it('can be focused with Tab and is named', async () => {
    const api = createApiClient({
      fetch: ((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('/api/ui/proofs/credits'))
          return Promise.resolve(
            json({
              status: 'ok',
              proofsLeft: 48,
              balance: '$4.80',
              price: '$0.25',
              test: true,
              partial: false,
            }),
          );
        if (url.startsWith('/api/ui/proofs?'))
          return Promise.resolve(
            json({ status: 'ok', items: [{ direction: 'sent', state: 'recorded', createdAt: T }] }),
          );
        return Promise.resolve(json({}));
      }) as typeof fetch,
      token: 't',
    });
    await act(async () => {
      root.render(h<ProofsPageProps>(ProofsPage, { api }));
      await vi.advanceTimersByTimeAsync(0);
    });
    const wrap = host.querySelector('.pf-table-wrap') as HTMLElement;
    expect(wrap).not.toBeNull();
    expect(wrap.getAttribute('tabindex')).toBe('0');
    expect(wrap.getAttribute('role')).toBe('region');
    expect(wrap.getAttribute('aria-label')).toBe(S.listCaption);
  });
});
