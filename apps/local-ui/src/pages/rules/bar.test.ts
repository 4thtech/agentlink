// @vitest-environment jsdom
// WP-S3: the unsaved-changes bar names the sensor from the owner-presence read (Touch ID on a Mac,
// the master code without a passkey), never "passkey" on a Mac, and says when a change lets the AI do more.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { RulesPage, type RulesPageProps } from './index.js';
import type { OwnerClient } from './owner.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const RULES = {
  status: 'ok',
  version: 0,
  rules: {
    proofs: {
      notarize: 'approval',
      dailyBudgetUSD: '5',
      perActionMaxUSD: '1',
      allowKeyDisclosure: 'approval',
    },
    contacts: { acceptInvites: 'approval', unknownSenders: 'queue', allowed: 'paired', listed: 0 },
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
};

async function bar(passkey: boolean, widen: boolean): Promise<string> {
  const f = (async (): Promise<Response> =>
    new Response(JSON.stringify(RULES), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  const owner: OwnerClient = {
    passkey: () => Promise.resolve(passkey ? { credentialId: 'AQI', prfSalt: 'AA' } : null),
    save: () => Promise.resolve({ kind: 'failed' }),
  };
  const api = createApiClient({ fetch: f, token: 't' });
  act(() => root.render(createElement<RulesPageProps>(RulesPage, { api, owner })));
  for (let i = 0; i < 8; i += 1) await act(async () => Promise.resolve());
  const label = widen ? 'Connect with someone new' : 'Add a public proof';
  const target = widen ? 'Allowed' : 'Never';
  const group = host.querySelector(`[role="radiogroup"][aria-label="${label}"]`);
  const choice = [...(group?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])].find(
    (b) => b.textContent?.startsWith(target),
  );
  await act(async () => choice?.click());
  return host.querySelector('.rl-unsaved')?.textContent ?? '';
}

describe('the unsaved-changes bar', () => {
  it('names Touch ID on a Mac and says a change lets the AI do more', async () => {
    const t = await bar(true, true);
    expect(t).toContain('1 change');
    expect(t).toContain('lets your AI do more without asking. Saving asks for Touch ID.');
    expect(host.textContent).not.toMatch(/passkey/i);
  });
  it('uses the plain sentence when nothing widens', async () => {
    const t = await bar(true, false);
    expect(t).toContain('Saving asks for Touch ID.');
    expect(t).not.toContain('do more');
  });
  it('names the master code when no Touch ID is set up', async () => {
    const t = await bar(false, true);
    expect(t).toContain('Saving asks for your master code.');
  });
});
