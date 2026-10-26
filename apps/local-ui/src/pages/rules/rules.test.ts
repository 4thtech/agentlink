// @vitest-environment jsdom
// M1-11c-a5: the Rules page (d1 Local-rules with DESIGN-ADJ-1 RU-2…RU-6; UX audit 6a–6c; 06 §3;
// 11 §5, §6.2; D-118, D-119).
//
// - Two groups: "Everyday" (proofs, new contacts, accepting terms) and a collapsed "More rules",
//   plus the limits for accepting terms. Each row shows its current value.
// - The selling warning shows only while the owner turns selling on, with the amount filled in.
// - An unsaved-changes bar counts the changes and offers Save and Discard.
// - Saving asks the server to prepare the edit, lists every warning in plain words, and the owner
//   ticks each one before the save button works (D-119). The browser never signs: the save is one
//   POST to the presence gate with the passkey assertion or the typed owner code as its body.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { RulesPage, type RulesPageProps } from './index.js';
import { createOwnerClient } from './owner.js';
import { RULES_STRINGS as S } from './strings.js';
import { warningText } from './warnings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NEVER_SAY =
  /\b(wallet|address|private key|seed phrase|transactions?|tx|gas|mint|notari[sz]e|smart contract|on-chain|blockchain|base|gnosis|chains?|usdc|usdt|tokens?|deposit|faucet|hash|nostr|relays?|encryption key|decrypt|polic(y|ies)|harness|envelopes?|agent card|mcp|owner key|signature|keystore|contract|legally binding|commitments?|password)\b/i;

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

// --- a scripted server -----------------------------------------------------------------------------

class Answer {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body?: Uint8Array;
}

type Handler = (call: Call) => unknown;

function server(routes: Record<string, unknown | Handler>) {
  const calls: Call[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const body: Uint8Array | undefined =
      raw instanceof Uint8Array ? new Uint8Array(raw) : undefined;
    const call: Call = { url, method: init?.method ?? 'GET', headers, ...(body ? { body } : {}) };
    calls.push(call);
    const key = `${call.method} ${url.split('?')[0] ?? ''}`;
    let answer = routes[key];
    if (typeof answer === 'function') answer = (answer as Handler)(call);
    if (answer === undefined) return new Response('{}', { status: 404 });
    const a = answer instanceof Answer ? answer : new Answer(200, answer);
    return new Response(JSON.stringify(a.body), {
      status: a.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetch: fetchFn as typeof fetch };
}

const DEFAULTS = {
  proofs: {
    notarize: 'allow',
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
};

const RULES = (rules: unknown = DEFAULTS, version = 0) => ({ status: 'ok', version, rules });
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

async function mount(routes: Record<string, unknown>, credentials?: CredentialsContainer) {
  const srv = server(routes);
  const api = createApiClient({ fetch: srv.fetch, token: 't0ken' });
  const owner = createOwnerClient({
    fetch: srv.fetch,
    token: 't0ken',
    ...(credentials ? { credentials } : {}),
  });
  act(() => root.render(createElement<RulesPageProps>(RulesPage, { api, owner })));
  await flush();
  return srv;
}

const text = (): string => host.textContent ?? '';
const buttonByText = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const radio = (group: string, label: string): HTMLButtonElement | undefined => {
  const g = host.querySelector(`[role="radiogroup"][aria-label="${group}"]`);
  return [...(g?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])].find((b) =>
    b.textContent?.startsWith(label),
  );
};
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
const moreToggle = (): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>('button[aria-controls="rules-more"]');
const expandMore = async (): Promise<void> => {
  if (moreToggle()?.getAttribute('aria-expanded') !== 'true') await click(moreToggle());
};
const switchNamed = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>('button[role="switch"]')].find(
    (b) => document.getElementById(b.getAttribute('aria-labelledby') ?? '')?.textContent === label,
  );
const inputLabelled = (label: string): HTMLInputElement | null => {
  const l = [...host.querySelectorAll('label')].find((x) => x.textContent === label);
  const id = l?.getAttribute('for');
  return id ? (document.getElementById(id) as HTMLInputElement | null) : null;
};
const decodeInput = (call: Call | undefined): unknown => {
  const raw = call?.headers.get('x-agentlink-input') ?? '';
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
};
const editOf = (call: Call | undefined): unknown => {
  const url = new URL(call?.url ?? '', 'http://localhost');
  const raw = url.searchParams.get('edit') ?? '';
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
};

// --- the page --------------------------------------------------------------------------------------

describe('Rules: two groups, current values (UX audit 6a; RU-2…RU-6)', () => {
  it('Everyday shows three rules; More rules starts collapsed', async () => {
    await mount({ 'GET /api/ui/rules': RULES() });
    expect(host.querySelector('h1')?.textContent).toBe('Rules');
    const everyday = host.querySelector('section[aria-labelledby="rules-everyday"]');
    expect(everyday?.querySelectorAll('.rl-row')).toHaveLength(3);
    expect(everyday?.textContent).toContain(S.proofTitle);
    expect(everyday?.textContent).toContain(S.invitesTitle);
    expect(everyday?.textContent).toContain(S.termsTitle);
    expect(moreToggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('#rules-more')).toBeNull();
    expect(radio(S.proofTitle, S.allowed)?.getAttribute('aria-checked')).toBe('true');
    expect(inputLabelled(S.budget)?.value).toBe('5');
    expect(inputLabelled(S.askOver)?.value).toBe('1');
    expect(radio(S.termsTitle, S.askEveryTime)?.getAttribute('aria-checked')).toBe('true');
  });

  it('More rules: unknown senders, who can message, files, exports, auto-accept and the limits', async () => {
    await mount({ 'GET /api/ui/rules': RULES() });
    await expandMore();
    const more = host.querySelector('#rules-more');
    expect(more).not.toBeNull();
    for (const t of [S.unknownTitle, S.whoTitle, S.filesTitle, S.exportsTitle, S.limitsTitle]) {
      expect(more?.textContent).toContain(t);
    }
    expect(radio(S.unknownTitle, S.hold)?.getAttribute('aria-checked')).toBe('true');
    expect(more?.textContent).toContain(S.whoPaired);
    expect(inputLabelled(S.sendLabel)?.value).toBe('100');
    expect(inputLabelled(S.receiveLabel)?.value).toBe('200');
    expect(switchNamed(S.buyTitle)?.getAttribute('aria-checked')).toBe('false');
    expect(switchNamed(S.sellTitle)?.getAttribute('aria-checked')).toBe('false');
  });

  it('no 11 §5.1 words in the default or the expanded view', async () => {
    await mount({ 'GET /api/ui/rules': RULES() });
    expect(text()).not.toMatch(NEVER_SAY);
    await expandMore();
    expect(text()).not.toMatch(NEVER_SAY);
  });

  it('the fail-closed state shows the recover step (LS-1)', async () => {
    await mount({ 'GET /api/ui/rules': { status: 'not_valid' } });
    expect(text()).toContain(S.notValid);
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it('not set up and unavailable show their states', async () => {
    await mount({ 'GET /api/ui/rules': new Answer(409, { error: 'not_set_up' }) });
    expect(text()).toContain(S.notSetUp);
    act(() => root.unmount());
    root = createRoot(host);
    await mount({ 'GET /api/ui/rules': new Answer(503, { error: 'unavailable' }) });
    expect(text()).toContain(S.unavailable);
  });

  it('auto-accept switches are off and explained when no contacts are listed', async () => {
    await mount({
      'GET /api/ui/rules': RULES({
        ...DEFAULTS,
        commitments: { ...DEFAULTS.commitments, autoAcceptContacts: 0 },
      }),
    });
    await expandMore();
    expect(switchNamed(S.buyTitle)?.disabled).toBe(true);
    expect(switchNamed(S.sellTitle)?.disabled).toBe(true);
    expect(text()).toContain(S.noListed);
  });
});

describe('the selling warning shows only while turning it on (UX audit 6b; 06 §3)', () => {
  it('hidden while off, shown with the amount while turning it on, hidden again when off', async () => {
    await mount({ 'GET /api/ui/rules': RULES() });
    await expandMore();
    expect(text()).not.toContain(S.sellWarningTitle);
    await click(switchNamed(S.sellTitle));
    expect(text()).toContain(S.sellWarningTitle);
    await type(inputLabelled(S.sellMin), '50');
    expect(text()).toContain(S.sellWarning('$50.00'));
    await click(switchNamed(S.sellTitle));
    expect(text()).not.toContain(S.sellWarningTitle);
  });

  it('not shown when selling is already on', async () => {
    await mount({
      'GET /api/ui/rules': RULES({
        ...DEFAULTS,
        commitments: {
          ...DEFAULTS.commitments,
          autoAcceptDirection: 'sell',
          autoAcceptMinUSD: '50',
        },
      }),
    });
    await expandMore();
    expect(switchNamed(S.sellTitle)?.getAttribute('aria-checked')).toBe('true');
    expect(text()).not.toContain(S.sellWarningTitle);
  });
});

describe('unsaved changes (UX audit 6c)', () => {
  it('counts changes; Discard puts the current rules back', async () => {
    await mount({ 'GET /api/ui/rules': RULES() });
    expect(host.querySelector('.rl-unsaved')).toBeNull();
    await click(radio(S.proofTitle, S.askMe));
    await type(inputLabelled(S.budget), '10');
    expect(host.querySelector('.rl-unsaved')?.textContent).toContain(S.changes(2));
    await click(buttonByText(S.discard));
    expect(host.querySelector('.rl-unsaved')).toBeNull();
    expect(radio(S.proofTitle, S.allowed)?.getAttribute('aria-checked')).toBe('true');
    expect(inputLabelled(S.budget)?.value).toBe('5');
  });

  it('an amount that is not dollars blocks saving and says why', async () => {
    await mount({ 'GET /api/ui/rules': RULES() });
    await type(inputLabelled(S.budget), 'five');
    expect(text()).toContain(S.invalidAmount);
    expect(buttonByText(S.reviewSave)?.disabled).toBe(true);
  });
});

describe('saving: review every warning, then one owner operation (D-119; I-4)', () => {
  it('sends only the changed fields, normalised, with the version the page showed', async () => {
    const srv = await mount({
      'GET /api/ui/rules': RULES(DEFAULTS, 3),
      'GET /api/ui/rules/review': REVIEW_OK,
      'GET /api/owner/passkey': NO_PASSKEY,
    });
    await click(radio(S.proofTitle, S.askMe));
    await type(inputLabelled(S.budget), '10.50');
    await click(buttonByText(S.reviewSave));
    const reviewCall = srv.calls.find((c) => c.url.startsWith('/api/ui/rules/review?'));
    expect(editOf(reviewCall)).toEqual({
      base: 3,
      patch: { proofs: { notarize: 'approval', dailyBudgetUSD: '10.5' } },
    });
  });

  it('lists each warning in plain words; save works only after every one is ticked', async () => {
    const srv = await mount({
      'GET /api/ui/rules': RULES(),
      'GET /api/ui/rules/review': {
        ...REVIEW_OK,
        warnings: [{ code: 'proofs_spend_raised' }, { code: 'commitments_allow' }],
      },
      'GET /api/owner/passkey': NO_PASSKEY,
      'POST /api/ui/rules': { status: 'saved', version: 1 },
    });
    await type(inputLabelled(S.budget), '20');
    await click(radio(S.termsTitle, S.allow));
    await click(buttonByText(S.reviewSave));
    const confirm = host.querySelector('section[aria-labelledby="rules-confirm"]');
    expect(confirm).not.toBeNull();
    const boxes = [
      ...(confirm?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []),
    ];
    expect(boxes).toHaveLength(2);
    expect(confirm?.textContent).toContain(warningText('proofs_spend_raised'));
    expect(confirm?.textContent).toContain(warningText('commitments_allow'));
    await type(inputLabelled(S.codeLabel), 'ABCD-EFGH');
    expect(buttonByText(S.saveCode)?.disabled).toBe(true);
    await click(boxes[0]);
    expect(buttonByText(S.saveCode)?.disabled).toBe(true);
    await click(boxes[1]);
    expect(buttonByText(S.saveCode)?.disabled).toBe(false);
    await click(buttonByText(S.saveCode));

    const post = srv.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/ui/rules');
    expect(decodeInput(post)).toEqual({
      review: 'ab'.repeat(32),
      acknowledged: ['proofs_spend_raised', 'commitments_allow'],
    });
    expect(post?.headers.get('content-type')).toBe('application/octet-stream');
    expect(post?.headers.get('x-agentlink-csrf')).toBe('t0ken');
    expect(post?.headers.get('x-agentlink-presence')).toBeNull();
    expect(new TextDecoder().decode(post?.body)).toBe('ABCD-EFGH');
    expect(text()).toContain(S.saved);
    // The page reloads the rules from the server after a save.
    expect(srv.calls.filter((c) => c.url === '/api/ui/rules' && c.method === 'GET')).toHaveLength(
      2,
    );
  });

  it('no warnings: says so, and saves without ticking anything', async () => {
    const srv = await mount({
      'GET /api/ui/rules': RULES(),
      'GET /api/ui/rules/review': REVIEW_OK,
      'GET /api/owner/passkey': NO_PASSKEY,
      'POST /api/ui/rules': { status: 'saved', version: 1 },
    });
    await click(radio(S.proofTitle, S.never));
    await click(buttonByText(S.reviewSave));
    expect(text()).toContain(S.noWarnings);
    await type(inputLabelled(S.codeLabel), 'ABCD-EFGH');
    await click(buttonByText(S.saveCode));
    expect(decodeInput(srv.calls.find((c) => c.method === 'POST'))).toEqual({
      review: 'ab'.repeat(32),
      acknowledged: [],
    });
  });

  it('the sell warning on the confirm screen names the amount', async () => {
    await mount({
      'GET /api/ui/rules': RULES(),
      'GET /api/ui/rules/review': { ...REVIEW_OK, warnings: [{ code: 'sell_auto_accept' }] },
      'GET /api/owner/passkey': NO_PASSKEY,
    });
    await expandMore();
    await click(switchNamed(S.sellTitle));
    await type(inputLabelled(S.sellMin), '50');
    await click(buttonByText(S.reviewSave));
    const confirm = host.querySelector('section[aria-labelledby="rules-confirm"]');
    expect(confirm?.textContent).toContain(warningText('sell_auto_accept', { amount: '$50.00' }));
  });

  it('with a passkey: the passkey prompt only after the click, its assertion is the body', async () => {
    let asked = 0;
    const credentials = {
      get: () => {
        asked += 1;
        return Promise.resolve({
          rawId: new Uint8Array([1, 2]).buffer,
          response: {
            authenticatorData: new Uint8Array(37).buffer,
            userHandle: new Uint8Array([9]).buffer,
          },
          getClientExtensionResults: () => ({
            prf: { results: { first: new Uint8Array(32).fill(7).buffer } },
          }),
        });
      },
    } as unknown as CredentialsContainer;
    const srv = await mount(
      {
        'GET /api/ui/rules': RULES(),
        'GET /api/ui/rules/review': REVIEW_OK,
        'GET /api/owner/passkey': {
          passkey: {
            registered: true,
            rpId: 'localhost',
            userId: 'AA',
            prfSalt: 'AA',
            credentialId: 'AQI',
          },
        },
        'POST /api/ui/rules': { status: 'saved', version: 1 },
      },
      credentials,
    );
    await click(radio(S.proofTitle, S.never));
    await click(buttonByText(S.reviewSave));
    expect(asked).toBe(0);
    expect(inputLabelled(S.codeLabel)).toBeNull();
    await click(buttonByText(S.save));
    expect(asked).toBe(1);
    const post = srv.calls.find((c) => c.method === 'POST');
    expect(post?.headers.get('x-agentlink-presence')).toBe('passkey');
    // credentialId, authenticatorData, userHandle, PRF output: each with a 16-bit length first.
    expect(post?.body?.length).toBe(2 + 2 + 2 + 37 + 2 + 1 + 2 + 32);
    expect(text()).toContain(S.saved);
  });

  it('delivery receipts on from an older default: the page asks, the answer prepares again', async () => {
    const srv = await mount({
      'GET /api/ui/rules': RULES(),
      'GET /api/ui/rules/review': (call: Call) => {
        const edit = editOf(call) as { keepDeliveryReceipts?: boolean };
        return {
          ...REVIEW_OK,
          review: edit.keepDeliveryReceipts === true ? 'cd'.repeat(32) : 'ab'.repeat(32),
          askKeepDeliveryReceipts: true,
          warnings: edit.keepDeliveryReceipts === true ? [] : [],
        };
      },
      'GET /api/owner/passkey': NO_PASSKEY,
      'POST /api/ui/rules': { status: 'saved', version: 1 },
    });
    await click(radio(S.proofTitle, S.never));
    await click(buttonByText(S.reviewSave));
    expect(text()).toContain(S.keepText);
    expect(switchNamed(S.keepTitle)?.getAttribute('aria-checked')).toBe('false');
    await click(switchNamed(S.keepTitle));
    const reviews = srv.calls.filter((c) => c.url.startsWith('/api/ui/rules/review?'));
    expect(reviews).toHaveLength(2);
    expect(editOf(reviews[1])).toMatchObject({ keepDeliveryReceipts: true });
    await type(inputLabelled(S.codeLabel), 'ABCD-EFGH');
    await click(buttonByText(S.saveCode));
    expect(decodeInput(srv.calls.find((c) => c.method === 'POST'))).toMatchObject({
      review: 'cd'.repeat(32),
    });
  });

  const outcomes: [string, Answer, string][] = [
    ['a wrong owner code', new Answer(403, { status: 'presence_rejected' }), S.wrongCode],
    ['too many tries', new Answer(429, { status: 'wait', retryAfter: 30 }), S.wait(30)],
    ['a refused save', new Answer(409, { status: 'refused' }), S.refused],
    ['rules changed elsewhere', new Answer(409, { error: 'stale' }), S.stale],
    ['another approval in progress', new Answer(409, { status: 'busy' }), S.busy],
    ['a server failure', new Answer(500, { status: 'failed' }), S.failed],
  ];
  for (const [name, answer, message] of outcomes) {
    it(`${name}: says so in plain words`, async () => {
      await mount({
        'GET /api/ui/rules': RULES(),
        'GET /api/ui/rules/review': REVIEW_OK,
        'GET /api/owner/passkey': NO_PASSKEY,
        'POST /api/ui/rules': answer,
      });
      await click(radio(S.proofTitle, S.never));
      await click(buttonByText(S.reviewSave));
      await type(inputLabelled(S.codeLabel), 'ABCD-EFGH');
      await click(buttonByText(S.saveCode));
      expect(text()).toContain(message);
      expect(text()).not.toContain(S.saved);
    });
  }

  it('Back to editing keeps the changes and sends nothing', async () => {
    const srv = await mount({
      'GET /api/ui/rules': RULES(),
      'GET /api/ui/rules/review': REVIEW_OK,
      'GET /api/owner/passkey': NO_PASSKEY,
    });
    await click(radio(S.proofTitle, S.never));
    await click(buttonByText(S.reviewSave));
    await click(buttonByText(S.back));
    expect(radio(S.proofTitle, S.never)?.getAttribute('aria-checked')).toBe('true');
    expect(srv.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
