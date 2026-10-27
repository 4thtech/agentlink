// @vitest-environment jsdom
// UI-REFRESH-r (d): the invites row of the signed summary says "Allowed", like the other rows.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { createPayConfirmClient } from '../../pay-confirm/index.js';
import { RulesPage, type RulesPageProps } from './index.js';
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

const rules = (acceptInvites: string): unknown => ({
  status: 'ok',
  version: 0,
  rules: {
    proofs: {
      notarize: 'allow',
      dailyBudgetUSD: '5',
      perActionMaxUSD: '1',
      allowKeyDisclosure: 'approval',
    },
    contacts: { acceptInvites, unknownSenders: 'queue', allowed: 'paired', listed: 0 },
    files: { maxSendSizeMB: 100, maxReceiveSizeMB: 200, allowedFolders: 0 },
    receipts: { autoDelivered: false },
    commitments: {
      accept: 'approval',
      autoAcceptDirection: 'buy',
      autoAcceptMaxUSD: '0',
      autoAcceptMinUSD: null,
      autoAcceptContacts: 2,
    },
    contactRules: 0,
  },
});

async function summary(acceptInvites: string): Promise<Record<string, string>> {
  const f = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    return url.startsWith('/api/ui/rules')
      ? new Response(JSON.stringify(rules(acceptInvites)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response('{}', { status: 404 });
  }) as typeof fetch;
  const api = createApiClient({ fetch: f, token: 't' });
  const owner = createOwnerClient({ fetch: f, token: 't' });
  const payConfirm = createPayConfirmClient({ fetch: f, token: 't' });
  act(() => root.render(createElement<RulesPageProps>(RulesPage, { api, owner, payConfirm })));
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  const out: Record<string, string> = {};
  for (const d of host.querySelectorAll('.rl-summary-list > div')) {
    out[d.querySelector('dt')?.textContent ?? ''] = d.querySelector('dd')?.textContent ?? '';
  }
  return out;
}

describe('invites summary', () => {
  it('says "Allowed" when invites are accepted automatically', async () => {
    const rows = await summary('auto');
    expect(rows['New contacts']).toBe('Allowed');
  });
  it('still says "Ask me" when each invite needs approval', async () => {
    const rows = await summary('approval');
    expect(rows['New contacts']).toBe('Ask me');
  });
});
