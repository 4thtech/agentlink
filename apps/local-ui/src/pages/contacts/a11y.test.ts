// @vitest-environment jsdom
// UI-REFRESH-r (b): axe finds no WCAG 2.1 A/AA violation on Contacts: the list, and the detail Sheet
// with Under the hood open. (Colour contrast is a visual check; jsdom has no layout.)
import axe from 'axe-core';
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

const run = (): Promise<axe.AxeResults> =>
  axe.run(host, {
    runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
    rules: { 'color-contrast': { enabled: false } },
  });

async function mount(open: boolean): Promise<void> {
  const routes: Record<string, unknown> = {
    'GET /api/ui/contacts': { status: 'ok', contacts: [contact('7F3A·19C2')] },
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
  if (open) {
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.ct-row')?.click();
    });
    await settle();
  }
}

describe('axe', () => {
  it('finds no violation on the contact list', async () => {
    await mount(false);
    expect(host.querySelector('.ct-row')).not.toBeNull();
    expect((await run()).violations.map((v) => v.id)).toEqual([]);
  });
  it('finds no violation with a contact open in the detail sheet', async () => {
    await mount(true);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect((await run()).violations.map((v) => v.id)).toEqual([]);
  });
});
