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

const api = {
  get: async () => {
    reads += 1;
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
});
