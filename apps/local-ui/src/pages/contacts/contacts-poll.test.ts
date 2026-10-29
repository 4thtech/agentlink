// @vitest-environment jsdom
// HOTFIX-045-CONTACTS-REFRESH: a contact that is still pending while pairing completes must show as
// paired without a reload. The page re-reads the list every 5 s while anything is pending, and on
// tab focus; it stops when nothing is pending.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client.js';
import { ContactsPage, type ContactsPageProps } from './index.js';
import { CONTACTS_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MARKO = '0x7f3a19c200000000000000000000000000000001';
const base = {
  ref: MARKO,
  name: 'Marko Novak',
  nameSource: 'counterparty',
  fingerprint: '7F3A·19C2',
  label: 'self-declared',
  status: 'active',
  since: 1_759_449_600,
};

let host: HTMLElement;
let root: Root;
let pairing: 'pending' | 'complete';
let reads: number;
let mode: 'ok' | 'fail' | 'slow';
let release: (() => void) | undefined;

const api = {
  get: async (path: string) => {
    if (path !== '/api/ui/contacts') return { kind: 'error', status: 404 };
    reads += 1;
    if (mode === 'fail') return { kind: 'error', status: 500 };
    if (mode === 'slow') await new Promise<void>((r) => (release = r));
    return { kind: 'ok', data: { status: 'ok', contacts: [{ ...base, pairing }] } };
  },
  post: async () => ({ kind: 'error', status: 404 }),
} as unknown as ApiClient;

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  pairing = 'pending';
  mode = 'ok';
  release = undefined;
  reads = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement<ContactsPageProps>(ContactsPage, { api }));
  });
  await flush(0);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('HOTFIX-045-CONTACTS-REFRESH', () => {
  it('shows a pending contact as paired after pairing completes, without a reload', async () => {
    expect(host.textContent).toContain(S.waiting);
    pairing = 'complete';
    await flush(5_100);
    expect(host.textContent).not.toContain(S.waiting);
  });

  it('re-reads when the tab becomes visible again while pending', async () => {
    const before = reads;
    pairing = 'complete';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush(0);
    expect(reads).toBeGreaterThan(before);
    expect(host.textContent).not.toContain(S.waiting);
  });

  it('stops polling once nothing is pending', async () => {
    pairing = 'complete';
    await flush(5_100);
    const settled = reads;
    await flush(20_000);
    expect(reads).toBe(settled);
  });

  it('skips a tick while a read is still running', async () => {
    mode = 'slow';
    await flush(5_100);
    const started = reads;
    await flush(20_000);
    expect(reads).toBe(started);
    mode = 'ok';
    release?.();
    await flush(5_100);
    expect(reads).toBeGreaterThan(started);
  });

  it('keeps the last good list and keeps polling when a background read fails', async () => {
    mode = 'fail';
    await flush(5_100);
    expect(host.textContent).toContain(S.waiting);
    const failed = reads;
    mode = 'ok';
    pairing = 'complete';
    await flush(5_100);
    expect(reads).toBeGreaterThan(failed);
    expect(host.textContent).not.toContain(S.waiting);
  });

  it('pauses while the tab is hidden and re-reads once on return', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    const before = reads;
    await flush(20_000);
    expect(reads).toBe(before);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await flush(0);
    expect(reads).toBe(before + 1);
  });
});
