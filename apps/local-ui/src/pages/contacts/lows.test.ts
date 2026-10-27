// @vitest-environment jsdom
// UI-REFRESH-r (b): the fingerprint in Under the hood shows in groups (B-11 §7), whatever shape the
// server sends it in. The grouped form stays as it is.
import { HoodProvider } from '@4thtech-io/ui';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { ContactsPage, type ContactsPageProps } from './index.js';
import { createOwnerClient } from './owner.js';

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

const contact = (fingerprint: string): Record<string, unknown> => ({
  ref: '0x7f3a19c200000000000000000000000000000001',
  name: 'Marko Novak',
  nameSource: 'counterparty',
  fingerprint,
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1_759_449_600,
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function fingerprintShown(fingerprint: string): Promise<string | null | undefined> {
  const routes: Record<string, unknown> = {
    'GET /api/ui/contacts': { status: 'ok', contacts: [contact(fingerprint)] },
    'GET /api/owner/passkey': {
      passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' },
    },
  };
  const f = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const found = routes[`${init?.method ?? 'GET'} ${url}`];
    return found === undefined
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify(found), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
  }) as typeof fetch;
  const api = createApiClient({ fetch: f, token: 't' });
  const owner = createOwnerClient({ fetch: f, token: 't' });
  await act(async () => {
    root.render(
      createElement(
        HoodProvider,
        { value: true },
        createElement<ContactsPageProps>(ContactsPage, { api, owner }),
      ),
    );
  });
  await settle();
  await act(async () => {
    host.querySelector<HTMLButtonElement>('.ct-row')?.click();
  });
  await settle();
  const row = [...host.querySelectorAll('.al-hood-row')].find(
    (r) => r.querySelector('dt')?.textContent === 'Fingerprint',
  );
  return row?.querySelector('dd')?.textContent;
}

describe('fingerprint in groups', () => {
  it('groups a run of letters and digits in fours, joined by the middle dot', async () => {
    expect(await fingerprintShown('7F3A19C2')).toBe('7F3A·19C2');
  });
  it('regroups a fingerprint sent with spaces or dashes', async () => {
    expect(await fingerprintShown('7f3a 19c2 0b4d')).toBe('7F3A·19C2·0B4D');
  });
  it('keeps an already grouped fingerprint', async () => {
    expect(await fingerprintShown('7F3A·19C2')).toBe('7F3A·19C2');
  });
});
