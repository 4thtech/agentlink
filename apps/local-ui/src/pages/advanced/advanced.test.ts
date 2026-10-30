// @vitest-environment jsdom
// W4-SETTINGS-ADVANCED (S1): Advanced › Relays & network. Counts and the last sync only; never a
// relay address (the health answer carries none), never a made-up latency.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../../api/client.js';
import { AdvancedPage, parseRelays } from './index.js';
import { ADVANCED_STRINGS as S } from './strings.js';

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
});

const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });
const mount = (read: () => Promise<ApiResult<unknown>>): Promise<void> =>
  act(async () => root.render(h(AdvancedPage, { read })));

describe('parseRelays', () => {
  it('reads counts and the last sync, and nothing else', () => {
    expect(
      parseRelays(
        ok({ agent: 'running', relays: { connected: 1, total: 2, url: 'wss://x' }, lastSyncAt: 5 }),
      ),
    ).toEqual({ connected: 1, total: 2, lastSyncAt: 5 });
    expect(parseRelays(ok({ agent: 'running', relays: null, lastSyncAt: null }))).toEqual({});
    expect(parseRelays(ok({ relays: { connected: -1, total: 2 } }))).toBeUndefined();
    expect(parseRelays(ok({ relays: { connected: 3, total: 2 } }))).toBeUndefined();
    expect(parseRelays({ kind: 'offline' })).toBeUndefined();
  });
});

describe('Relays & network', () => {
  it('shows how many relays are connected, the sync time and that the network is automatic', async () => {
    await mount(async () =>
      ok({ agent: 'running', relays: { connected: 2, total: 3 }, lastSyncAt: 1700000000 }),
    );
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent).toBe(S.title);
    expect(host.textContent).toContain('2 of 3 connected');
    expect(host.textContent).toContain(S.networkAuto);
    expect(host.querySelector('time')?.getAttribute('datetime')).toBe(
      new Date(1700000000 * 1000).toISOString(),
    );
  });
  it('says so when there is no answer, and never shows an address or a latency', async () => {
    await mount(async () => ({ kind: 'offline' }));
    expect(host.textContent).toContain(S.unknown);
    expect(host.textContent ?? '').not.toMatch(/\bms\b|wss?:|https?:/);
  });
  it('shows neither facts nor a false "no answer" while the first answer is on its way', async () => {
    await mount(() => new Promise(() => undefined));
    expect(host.querySelector('dl')).toBeNull();
    expect(host.textContent).not.toContain(S.unknown);
  });
  it('uses plain words (11 §5)', () => {
    expect(lintVocabulary(JSON.stringify(S))).toEqual([]);
  });
});
