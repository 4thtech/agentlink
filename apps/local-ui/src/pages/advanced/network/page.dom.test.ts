// @vitest-environment jsdom
// NET-UI-A: the page shows the live view only under the hood; without it nothing is new, and the
// strip's servers item (shown only under the hood) leads to the page.
import { HoodProvider } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../../../api/client.js';
import { serverFacts } from '../../../layout/status-strip.js';
import { AdvancedPage } from '../index.js';
import { NETWORK_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const health = async (): Promise<ApiResult<unknown>> => ({
  kind: 'ok',
  status: 200,
  data: { agent: 'running', relays: { connected: 2, total: 3 }, lastSyncAt: 1_700_000_000 },
});

describe('Advanced › Message network', () => {
  it('is named Message network, and without Under the hood shows no server list or request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await act(async () =>
      root.render(h(HoodProvider, { value: false }, h(AdvancedPage, { read: health }))),
    );
    expect(host.querySelector('h1')?.textContent).toBe(S.title);
    expect(host.querySelector('.nw')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(host.textContent).toContain('2 of 3 connected');
  });

  it('under the hood the live view is added below', async () => {
    const fetchSpy = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchSpy);
    await act(async () =>
      root.render(h(HoodProvider, { value: true }, h(AdvancedPage, { read: health }))),
    );
    expect(host.querySelector('.nw')).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalled();
    // The old summary card is left out there: the live view says it (and never "Relays").
    expect(host.querySelector('.ad-list')).toBeNull();
    expect(host.textContent).not.toContain('Relays');
  });
});

describe('the status strip servers item', () => {
  it('links to Advanced › Message network', () => {
    const facts = serverFacts(
      { kind: 'ok', status: 200, data: { agent: 'running', relays: { connected: 2, total: 3 } } },
      '48123',
    );
    const item = facts.find((f) => f.label === 'Servers');
    expect(item?.value).toBe('2 of 3 connected');
    expect(item?.href).toBe('/advanced/network');
    expect(facts.filter((f) => f.href !== undefined)).toHaveLength(1);
  });
});
