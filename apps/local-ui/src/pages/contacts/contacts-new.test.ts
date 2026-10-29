// @vitest-environment jsdom
// HOTFIX-045-CONTACTS-NEW: a NEW contact (no row was pending) must appear without a reload while the
// page has an open invite. E2E proof: e2e/test/journey/02-invite.test.ts (wave-4 journey, chapter 2).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client.js';
import { ContactsPage, type ContactsPageProps } from './index.js';
import { addPendingInvite, forgetPendingInvites } from './pending-invites.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MARKO = '0x7f3a19c200000000000000000000000000000001';
const ANA = '0x4c21a0f700000000000000000000000000000002';
const row = (ref: string, name: string) => ({
  ref,
  name,
  nameSource: 'counterparty',
  fingerprint: '7F3A·19C2',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1_759_449_600,
});

let host: HTMLElement;
let root: Root;
let contacts: ReturnType<typeof row>[];
let reads: number;

const api = {
  get: async (path: string) => {
    if (path !== '/api/ui/contacts') return { kind: 'error', status: 404 };
    reads += 1;
    return { kind: 'ok', data: { status: 'ok', contacts } };
  },
  post: async () => ({ kind: 'error', status: 404 }),
} as unknown as ApiClient;

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement<ContactsPageProps>(ContactsPage, { api }));
  });
  await flush(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  forgetPendingInvites();
  contacts = [row(ANA, 'Ana')];
  reads = 0;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  forgetPendingInvites();
  vi.useRealTimers();
});

describe('HOTFIX-045-CONTACTS-NEW', () => {
  it('shows a new contact while an invite is open and no row was pending', async () => {
    addPendingInvite('Marko', Date.now() + 86_400_000);
    await mount();
    expect(host.textContent).not.toContain('Marko Novak');
    contacts = [row(ANA, 'Ana'), row(MARKO, 'Marko Novak')];
    await flush(5_100);
    expect(host.textContent).toContain('Marko Novak');
  });

  it('does not poll when nothing is pending and no invite is open', async () => {
    await mount();
    const settled = reads;
    await flush(20_000);
    expect(reads).toBe(settled);
  });
});
