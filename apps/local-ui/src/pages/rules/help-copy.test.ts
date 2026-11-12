// @vitest-environment jsdom
// REL051-SF5: each rule's help line says what the rule enforces (06 §3, policy-engine.ts).
// (1) Proofs on "Ask me": every proof asks (evaluateProof step 2), so the line is not the budget
// sentence "Allowed up to … then it asks". (2) Unknown senders on "Hold for me": a held request the
// owner accepts reaches the AI's inbox (D-72), so the line says so; on "Drop" it does not.
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

const rules = (notarize: string, unknownSenders: string): unknown => ({
  status: 'ok',
  version: 0,
  rules: {
    proofs: {
      notarize,
      dailyBudgetUSD: '5',
      perActionMaxUSD: '1',
      allowKeyDisclosure: 'approval',
    },
    contacts: { acceptInvites: 'approval', unknownSenders, allowed: 'paired', listed: 0 },
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

async function pageText(notarize: string, unknownSenders: string): Promise<string> {
  const f = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    return url.startsWith('/api/ui/rules')
      ? new Response(JSON.stringify(rules(notarize, unknownSenders)), {
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
  // Open "More rules", where the unknown-senders row lives.
  const more = host.querySelector<HTMLButtonElement>('.rl-more-btn');
  act(() => more?.click());
  return host.textContent ?? '';
}

describe('Add a public proof: help line', () => {
  it('on "Ask me" says every proof asks, not the budget sentence', async () => {
    const t = await pageText('approval', 'queue');
    expect(t).toContain('Your AI asks before each proof.');
    expect(t).not.toContain('then it asks.');
  });
  it('on "Allowed" keeps the budget sentence', async () => {
    const t = await pageText('allow', 'queue');
    expect(t).toContain('then it asks.');
    expect(t).not.toContain('Your AI asks before each proof.');
  });
  it('on "Never" says the AI never adds proof', async () => {
    const t = await pageText('deny', 'queue');
    expect(t).toContain('Your AI never adds proof.');
  });
});

describe('Messages from someone you have not connected with: help line', () => {
  it('on "Hold for me" says a request you accept reaches your AI', async () => {
    const t = await pageText('allow', 'queue');
    expect(t).toContain("Strangers can't reach your AI unless you accept their request.");
  });
  it('on "Drop" says strangers cannot reach your AI', async () => {
    const t = await pageText('allow', 'drop');
    expect(t).toContain("Strangers can't reach your AI.");
    expect(t).not.toContain('unless you accept their request');
  });
});
