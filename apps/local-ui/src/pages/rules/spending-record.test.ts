// @vitest-environment jsdom
// BUDGET-RECOVER (07 §3.5; 11 §5.11): when the spending record needs a fresh save, Rules says so and
// offers "Save again", which works with nothing changed. The save is the ordinary rules save: the
// server prepares the body and the owner confirms with presence (the browser never signs, D-118).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { createPayConfirmClient } from '../../pay-confirm/index.js';
import { RulesPage, type RulesPageProps } from './index.js';
import { createOwnerClient } from './owner.js';
import { RULES_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NEVER_SAY =
  /\b(wallet|ledger|epoch|private key|seed phrase|transactions?|gas|blockchain|chains?|tokens?|polic(y|ies)|signature|contract)\b/i;

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

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
}

function server(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const call: Call = { url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) };
    calls.push(call);
    let answer = routes[`${call.method} ${url.split('?')[0] ?? ''}`];
    if (typeof answer === 'function') answer = (answer as () => unknown)();
    if (answer === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetch: fetchFn as typeof fetch };
}

const DEFAULTS = {
  proofs: {
    notarize: 'allow',
    dailyBudgetUSD: '5',
    perActionMaxUSD: '0.2',
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
};
const NO_PASSKEY = {
  passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' },
};
const REVIEW_OK = {
  status: 'review',
  review: 'ab'.repeat(32),
  warnings: [],
  askKeepDeliveryReceipts: false,
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

async function mount(routes: Record<string, unknown>) {
  const srv = server(routes);
  const api = createApiClient({ fetch: srv.fetch, token: 't0ken' });
  const owner = createOwnerClient({ fetch: srv.fetch, token: 't0ken' });
  const payConfirm = createPayConfirmClient({ fetch: srv.fetch, token: 't0ken' });
  act(() => root.render(createElement<RulesPageProps>(RulesPage, { api, owner, payConfirm })));
  await flush();
  return srv;
}

const text = (): string => host.textContent ?? '';
const buttonByText = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const click = async (el: Element | null | undefined): Promise<void> => {
  expect(el).toBeTruthy();
  act(() => {
    (el as HTMLElement).click();
  });
  await flush();
};
const type = async (input: HTMLInputElement | null, value: string): Promise<void> => {
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
};
const inputLabelled = (label: string): HTMLInputElement | null => {
  const l = [...host.querySelectorAll('label')].find((x) => x.textContent === label);
  const id = l?.getAttribute('for');
  return id ? (document.getElementById(id) as HTMLInputElement | null) : null;
};
const editOf = (call: Call | undefined): unknown => {
  const url = new URL(call?.url ?? '', 'http://localhost');
  const raw = url.searchParams.get('edit') ?? '';
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
};

describe('BUDGET-RECOVER: Rules offers "Save again" when the spending record needs it', () => {
  it('no notice and no Save again when the record is fine (or an older server says nothing)', async () => {
    await mount({ 'GET /api/ui/rules': { status: 'ok', version: 2, rules: DEFAULTS } });
    expect(text()).not.toContain(S.spendingRecordTitle);
    expect(buttonByText(S.saveAgain)).toBeUndefined();
  });

  it('shows the notice; Save again prepares the same rules and saves with presence', async () => {
    let needsSave = true;
    const srv = await mount({
      'GET /api/ui/rules': () => ({
        status: 'ok',
        version: 2,
        rules: DEFAULTS,
        ...(needsSave ? { spendingRecord: 'needs_save' } : {}),
      }),
      'GET /api/ui/rules/review': REVIEW_OK,
      'GET /api/owner/passkey': NO_PASSKEY,
      'POST /api/ui/rules': () => {
        needsSave = false;
        return { status: 'saved', version: 3 };
      },
    });
    expect(text()).toContain(S.spendingRecordTitle);
    expect(text()).toContain(S.spendingRecordBody);
    expect(text()).not.toMatch(NEVER_SAY);
    // Nothing changed: no unsaved-changes bar, but Save again is there.
    expect(host.querySelector('.rl-unsaved')).toBeNull();
    await click(buttonByText(S.saveAgain));
    const review = srv.calls.find((c) => c.url.startsWith('/api/ui/rules/review'));
    // The same value restated: the server builds the whole document at a newer version.
    expect(editOf(review)).toEqual({ base: 2, patch: { files: { maxSendSizeMB: 100 } } });
    expect(host.querySelector('section[aria-labelledby="rules-confirm"]')).not.toBeNull();
    await type(inputLabelled(S.codeLabel), 'ABCD-EFGH');
    await click(buttonByText(S.saveCode));
    expect(srv.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(text()).toContain(S.saved);
    expect(text()).not.toContain(S.spendingRecordTitle);
  });
});
