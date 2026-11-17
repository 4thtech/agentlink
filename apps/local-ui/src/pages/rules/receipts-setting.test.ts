// @vitest-environment jsdom
// SEC-RECEIPTS-DEFAULT: the owner's received-receipts rule on the Rules page (06 §3
// `receipts.sendReceived`; 11 §5). On by default; absent from an older server reads as on.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { createPayConfirmClient } from '../../pay-confirm/index.js';
import { checkDraft, draftOf, parseRules } from './data.js';
import { RulesPage, type RulesPageProps } from './index.js';
import { createOwnerClient } from './owner.js';
import { RULES_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rules = (receipts: Record<string, unknown>): Record<string, unknown> => ({
  status: 'ok',
  version: 3,
  rules: {
    proofs: {
      notarize: 'allow',
      dailyBudgetUSD: '5',
      perActionMaxUSD: '1',
      allowKeyDisclosure: 'approval',
    },
    contacts: { acceptInvites: 'approval', unknownSenders: 'queue', allowed: 'paired', listed: 0 },
    files: { maxSendSizeMB: 100, maxReceiveSizeMB: 200, allowedFolders: 0 },
    receipts,
    commitments: {
      accept: 'approval',
      autoAcceptDirection: 'buy',
      autoAcceptMaxUSD: '0',
      autoAcceptMinUSD: null,
      autoAcceptContacts: 0,
    },
    contactRules: 0,
  },
});

describe('receipts.sendReceived in the Rules data', () => {
  it('reads on when the server leaves it out, and the value it sends otherwise', () => {
    const absent = parseRules(rules({ autoDelivered: false }));
    const off = parseRules(rules({ autoDelivered: false, sendReceived: false }));
    if (absent.kind !== 'ok' || off.kind !== 'ok') throw new Error('test: not parsed');
    expect(absent.rules.receipts.sendReceived).toBe(true);
    expect(off.rules.receipts.sendReceived).toBe(false);
    expect(parseRules(rules({ autoDelivered: false, sendReceived: 'no' })).kind).toBe(
      'unavailable',
    );
  });

  it('turning it off is one change, patched as receipts.sendReceived', () => {
    const parsed = parseRules(rules({ autoDelivered: false }));
    if (parsed.kind !== 'ok') throw new Error('test: not parsed');
    const draft = draftOf(parsed.rules);
    expect(draft.sendReceived).toBe(true);
    expect(checkDraft(parsed.rules, draft).changes).toBe(0);
    const check = checkDraft(parsed.rules, { ...draft, sendReceived: false });
    expect(check.changes).toBe(1);
    expect(check.patch).toEqual({ receipts: { sendReceived: false } });
  });

  it('the copy says what it tells contacts, and that it shows the AI app is running', () => {
    // 11 §5.10, exactly.
    expect(S.sendReceivedTitle).toBe('Tell contacts when your AI receives a message');
    expect(S.sendReceivedHelp).toBe(
      'Your contacts see that your AI app received their message. It also shows them that your AI app was open at about that time. Never what you did with it.',
    );
    expect(`${S.sendReceivedTitle} ${S.sendReceivedHelp}`).not.toMatch(
      /wallet|gas|seed phrase|transaction/i,
    );
  });
});

describe('the Rules page switch', () => {
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

  it('shows the received-receipts rule in Everyday, on by default', async () => {
    const f = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      return url.startsWith('/api/ui/rules')
        ? new Response(JSON.stringify(rules({ autoDelivered: false })), {
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
    const group = host.querySelector(
      `section[aria-labelledby="rules-everyday"] [role="radiogroup"][aria-label="${S.sendReceivedTitle}"]`,
    );
    expect(group).not.toBeNull();
    const checked = group?.querySelector('[role="radio"][aria-checked="true"]');
    expect(checked?.textContent).toContain(S.receiptsOn);
    const row = group?.closest('.rl-row');
    expect(row?.textContent).toContain(S.sendReceivedHelp);
  });
});
