// @vitest-environment jsdom
// UX1113 WP-A2: the Activity page (design-1112 §7; 08 §1; 11 §5, §6.2; D-116, D-118; I-5).
//
// - It loads `GET /api/ui/activity?limit=20` and names people with `GET /api/ui/contacts`.
// - Every kind renders one plain sentence; a person is named in <bdi>; one this page cannot name gets
//   neutral words; no row has a "—" cell anywhere.
// - A row opens and closes by keyboard (it is a button; Escape closes it).
// - The four counts and the filters agree; search matches names and action words.
// - Empty, error, paging and malformed bodies keep their states.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { ActivityPage } from './index.js';
import { ACTIVITY_COPY as S } from './strings.js';

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
  vi.useRealTimers();
});

type Get = (path: string) => Promise<ApiResult<unknown>>;

const NATASA = `0x${'a'.repeat(40)}`;
const MARKO = `0x${'b'.repeat(40)}`;
const GONE = `0x${'c'.repeat(40)}`;

const contact = (ref: string, name: string): Record<string, unknown> => ({
  ref,
  name,
  nameSource: 'owner',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1_700_000_000,
});
let people: unknown[] = [contact(NATASA, 'Natasa'), contact(MARKO, 'Marko Novak')];

function apiWith(get: Get): ApiClient & { get: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn((path: string) =>
      path.startsWith('/api/ui/contacts')
        ? Promise.resolve(ok({ status: 'ok', contacts: people }))
        : get(path),
    ),
    post: vi.fn(),
  } as unknown as ApiClient & { get: ReturnType<typeof vi.fn> };
}

const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });

async function mount(api: ApiClient): Promise<void> {
  await act(async () => {
    root.render(h(ActivityPage, { api }));
  });
}

const text = (): string => host.textContent ?? '';
const rows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('li.al-act-row')];
const sentenceOf = (row: HTMLElement): string =>
  row.querySelector('.al-act-sentence')?.textContent ?? '';
const click = (el: Element | null | undefined): void => act(() => (el as HTMLElement).click());

const AT = 1_760_000_000;

const ALL_KINDS: Record<string, unknown>[] = [
  {
    kind: 'approval_decided',
    at: AT + 200,
    decision: 'approved',
    action: {
      type: 'send_file',
      contactId: NATASA,
      files: [{ name: 'Q3-plan.pdf', size: 2_100_000 }],
    },
  },
  {
    kind: 'approval_decided',
    at: AT + 190,
    decision: 'approved_by_rules',
    action: { type: 'add_proof', contactId: MARKO, files: [], costUsd: '0.05' },
  },
  {
    kind: 'approval_decided',
    at: AT + 180,
    decision: 'denied',
    action: { type: 'accept_terms', contactId: MARKO, files: [] },
  },
  {
    kind: 'approval_decided',
    at: AT + 170,
    decision: 'cancelled',
    action: { type: 'send_message', contactId: NATASA, files: [] },
  },
  { kind: 'approval_decided', at: AT + 160, decision: 'approved' },
  {
    kind: 'proof',
    at: AT + 150,
    direction: 'sent',
    state: 'recorded',
    contactId: MARKO,
    costUsd: '0.05',
  },
  { kind: 'proof', at: AT + 140, direction: 'sent', state: 'needs_credits', contactId: MARKO },
  { kind: 'proof', at: AT + 130, direction: 'received', state: 'received', contactId: NATASA },
  { kind: 'sender_blocked', at: AT + 120, senderCode: '2B9E·04D1' },
  { kind: 'contact_blocked', at: AT + 110, contactId: MARKO },
  { kind: 'contact_removed', at: AT + 100, contactId: GONE },
  { kind: 'contact_revoked', at: AT + 99, contactId: NATASA },
  {
    kind: 'contact_renamed',
    at: AT + 98,
    contactId: NATASA,
    formerName: 'oc-test',
    newName: 'Natasa K',
  },
  { kind: 'contact_connected', at: AT + 97, contactId: MARKO, via: 'your_invite' },
  { kind: 'contact_connected', at: AT + 96, contactId: NATASA, via: 'their_invite' },
  { kind: 'rules_changed', at: AT + 90 },
  { kind: 'id_created', at: AT + 80 },
  { kind: 'id_removed', at: AT + 79 },
  { kind: 'id_paused', at: AT + 78 },
  { kind: 'id_resumed', at: AT + 77 },
  { kind: 'id_renamed', at: AT + 76, name: 'Tali' },
  { kind: 'id_renamed', at: AT + 75 },
  { kind: 'app_connected', at: AT + 70, app: 'claude-code' },
  { kind: 'app_disconnected', at: AT + 69 },
  { kind: 'backup_saved', at: AT + 60 },
];

describe('Activity page (WP-A2)', () => {
  it('shows the title, the lead and a loading state, then asks for the first page', async () => {
    let resolve: (r: ApiResult<unknown>) => void = () => undefined;
    const api = apiWith(() => new Promise((r) => (resolve = r)));
    await mount(api);
    expect(host.querySelector('h1')?.textContent).toBe('Activity');
    expect(text()).toContain(S.lead);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(S.loading);
    expect(api.get).toHaveBeenCalledWith('/api/ui/activity?limit=20');
    await act(async () => resolve(ok({ items: [] })));
    expect(text()).not.toContain(S.loading);
  });

  it('writes a plain sentence for every kind, naming people from the people read', async () => {
    await mount(apiWith(async () => ok({ items: ALL_KINDS })));
    const sentences = rows().map(sentenceOf);
    expect(sentences).toEqual([
      'You approved sending Q3-plan.pdf to Natasa',
      'Your rules allowed adding proof to a message to Marko Novak',
      'You denied accepting terms from Marko Novak',
      'You cancelled sending a message to Natasa',
      'You approved a request',
      'Proof recorded for your message to Marko Novak',
      'Proof for your message to Marko Novak is waiting for credits',
      'Natasa added proof to a message for you',
      'A message from someone you are not connected with was dropped',
      'You blocked Marko Novak',
      'You removed a contact',
      'Natasa removed the connection',
      'oc-test is now called Natasa K',
      'Marko Novak accepted your invite',
      'You accepted the invite from Natasa',
      'You changed your rules',
      'You created a new ID',
      'You removed an ID',
      'You paused an ID',
      'You resumed an ID',
      'You renamed an ID to Tali',
      'You renamed an ID',
      'You connected Claude Code to AgentLink',
      'You disconnected an AI app from AgentLink',
      'You saved a recovery kit',
    ]);
  });

  it('has no "—" cell and no empty sentence or grey line in any row', async () => {
    await mount(apiWith(async () => ok({ items: ALL_KINDS })));
    expect(text()).not.toContain('—');
    for (const row of rows()) {
      expect(sentenceOf(row).trim().length).toBeGreaterThan(0);
      expect(row.querySelector('.al-act-grey')?.textContent?.trim().length).toBeGreaterThan(0);
      expect(row.querySelector('.al-act-pill')?.textContent?.trim().length).toBeGreaterThan(0);
      expect(row.textContent).not.toMatch(/\{|undefined|null/);
    }
    expect(host.querySelector('table')).toBeNull();
  });

  it('puts a person and a file name in <bdi>, as text', async () => {
    await mount(apiWith(async () => ok({ items: ALL_KINDS.slice(0, 1) })));
    const bdis = [...host.querySelectorAll('li.al-act-row bdi')].map((b) => b.textContent);
    expect(bdis).toEqual(['Q3-plan.pdf', 'Natasa']);
  });

  it('never turns a name or file name from the server into markup or direction marks (I-5)', async () => {
    people = [contact(NATASA, '<img src=x onerror=1>‮evil')];
    try {
      await mount(
        apiWith(async () =>
          ok({
            items: [
              {
                kind: 'approval_decided',
                at: AT,
                decision: 'approved',
                action: {
                  type: 'send_file',
                  contactId: NATASA,
                  files: [{ name: '<b>x</b>.txt', size: 10 }],
                },
              },
            ],
          }),
        ),
      );
      expect(host.querySelector('img')).toBeNull();
      expect(host.querySelector('b')).toBeNull();
      expect(text()).toContain('<img src=x onerror=1>evil');
      expect(text()).toContain('<b>x</b>.txt');
      expect(text()).not.toContain('‮');
      expect(host.querySelectorAll('[style]')).toHaveLength(0);
    } finally {
      people = [contact(NATASA, 'Natasa'), contact(MARKO, 'Marko Novak')];
    }
  });

  it('uses neutral words for a person it cannot name, and when the people read fails', async () => {
    const items = [
      {
        kind: 'approval_decided',
        at: AT + 2,
        decision: 'denied',
        action: { type: 'send_file', contactId: GONE, files: [] },
      },
      { kind: 'proof', at: AT + 1, direction: 'received', state: 'received', contactId: GONE },
    ];
    await mount(apiWith(async () => ok({ items })));
    expect(rows().map(sentenceOf)).toEqual([
      'You denied sending a file',
      'A contact added proof to a message for you',
    ]);
  });

  it('says what the action was in the grey line, with cost and outcome', async () => {
    await mount(apiWith(async () => ok({ items: ALL_KINDS.slice(0, 4) })));
    const greys = rows().map((r) => r.querySelector('.al-act-grey')?.textContent);
    expect(greys).toEqual([
      'Asked by your AI',
      'Asked by your AI · decided by your rules · $0.05',
      'Asked by your AI · nothing was accepted',
      'Asked by your AI · nothing was sent',
    ]);
  });

  it('opens a row in place with what it was, and closes it again, by keyboard', async () => {
    await mount(apiWith(async () => ok({ items: ALL_KINDS.slice(0, 2) })));
    const first = rows()[0] as HTMLElement;
    const button = first.querySelector('button') as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(first.querySelector('dl')).toBeNull();
    click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const facts = first.querySelector('dl')?.textContent ?? '';
    expect(facts).toContain('Send a file');
    expect(facts).toContain('Q3-plan.pdf (2.1 MB)');
    expect(facts).toContain('You');
    expect(facts).not.toContain('—');
    expect(first.querySelector('dl a')?.getAttribute('href')).toBe('/');
    // Escape closes it, from anywhere in the row.
    act(() => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(first.querySelector('dl')).toBeNull();
    // Opening another row closes the first.
    click(button);
    click(rows()[1]?.querySelector('button'));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(rows()[1]?.querySelector('dl')?.textContent).toContain('$0.05');
  });

  it('every kind opens to labelled facts with a link and no empty value', async () => {
    await mount(apiWith(async () => ok({ items: ALL_KINDS })));
    for (const row of rows()) {
      click(row.querySelector('button'));
      const dl = row.querySelector('dl');
      expect(dl, sentenceOf(row)).not.toBeNull();
      for (const dd of dl?.querySelectorAll('dd') ?? []) {
        expect(dd.textContent?.trim().length).toBeGreaterThan(0);
      }
      expect(dl?.querySelector('a')?.getAttribute('href')).toMatch(/^\//);
      click(row.querySelector('button'));
    }
  });
});

describe('counts, filters and search', () => {
  const NOW = (AT + 300) * 1000;

  const counts = (): string[] =>
    [...host.querySelectorAll('.al-act-count')].map((c) => c.textContent ?? '');

  it('shows the four counts of the last 7 days, and each one filters to exactly that many rows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const old = [{ kind: 'approval_decided', at: AT - 30 * 86_400, decision: 'approved' }];
    await mount(apiWith(async () => ok({ items: [...ALL_KINDS, ...old] })));
    // approved: 2 (Natasa file, bare); rules: 1; denied+blocked: denied 1 + sender 1 + contact 1; proofs: recorded + received.
    expect(counts()).toEqual([
      '2approved by youlast 7 days',
      '1allowed by your ruleswithout asking',
      '3denied or blockednothing was sent',
      '2proofs added$0.05 in credits',
    ]);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.al-act-count')];
    for (const [i, n] of [2, 1, 3, 2].entries()) {
      click(buttons[i]);
      expect(rows(), String(i)).toHaveLength(n);
      expect(buttons[i]?.getAttribute('aria-pressed')).toBe('true');
    }
    // Pressing the same one again shows everything.
    click(buttons[3]);
    expect(rows()).toHaveLength(ALL_KINDS.length + old.length);
  });

  it('says "no credits used" when no proof cost anything', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await mount(apiWith(async () => ok({ items: ALL_KINDS.slice(7, 8) })));
    expect(counts()[3]).toContain(S.countProofsNoCredits);
  });

  it('filters by Approvals, Proofs, People & IDs and Safety', async () => {
    await mount(apiWith(async () => ok({ items: ALL_KINDS })));
    const chips = [
      ...host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] button[role="radio"]'),
    ];
    expect(chips.map((c) => c.textContent?.trim())).toEqual([
      'All',
      'Approvals',
      'Proofs',
      'People & IDs',
      'Safety',
    ]);
    const shown = (i: number): number => {
      click(chips[i]);
      return rows().length;
    };
    expect(shown(1)).toBe(5);
    expect(shown(2)).toBe(3);
    // contact_removed/revoked/renamed/connected x2, 6 id and app, backup.
    expect(shown(3)).toBe(14);
    // denied approval, unknown sender, blocked contact, rules.
    expect(shown(4)).toBe(4);
    expect(shown(0)).toBe(ALL_KINDS.length);
  });

  it('searches names and action words', async () => {
    await mount(apiWith(async () => ok({ items: ALL_KINDS })));
    const input = host.querySelector('input[type="search"]') as HTMLInputElement;
    const type = (value: string): void => {
      act(() => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        set?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    type('q3-plan');
    expect(rows()).toHaveLength(1);
    type('marko');
    expect(rows().length).toBeGreaterThan(3);
    type('terms');
    expect(rows().map(sentenceOf)).toEqual(['You denied accepting terms from Marko Novak']);
    type('zzzz');
    expect(rows()).toHaveLength(0);
    expect(text()).toContain(S.searchEmpty);
  });

  it('says so when a filter has no rows', async () => {
    await mount(apiWith(async () => ok({ items: [ALL_KINDS[15]] })));
    click(host.querySelectorAll('[role="radiogroup"] button[role="radio"]')[2]);
    expect(text()).toContain(S.filterEmpty);
  });
});

describe('states', () => {
  it('skips an entry it does not know instead of guessing', async () => {
    await mount(
      apiWith(async () =>
        ok({
          items: [
            { kind: 'something_new', at: AT + 3 },
            { kind: 'approval_decided', at: AT + 2, decision: 'maybe' },
            {
              kind: 'contact_renamed',
              at: AT + 2,
              contactId: NATASA,
              formerName: '',
              newName: 'x',
            },
            { kind: 'rules_changed', at: AT + 1 },
          ],
        }),
      ),
    );
    expect(rows().map(sentenceOf)).toEqual(['You changed your rules']);
  });

  it('drops a bad option of an entry but keeps the entry', async () => {
    await mount(
      apiWith(async () =>
        ok({
          items: [
            {
              kind: 'approval_decided',
              at: AT,
              decision: 'approved',
              action: { type: 'wire_money', contactId: NATASA, files: [] },
            },
            {
              kind: 'proof',
              at: AT - 1,
              direction: 'sent',
              state: 'recorded',
              contactId: 'natasa',
              costUsd: '1e3',
            },
          ],
        }),
      ),
    );
    expect(rows().map(sentenceOf)).toEqual([
      'You approved a request',
      'Proof recorded for your message',
    ]);
  });

  it('shows the empty state in plain words', async () => {
    await mount(apiWith(async () => ok({ items: [] })));
    expect(text()).toContain(S.emptyTitle);
    expect(text()).toContain(S.emptyPrompt);
    expect(rows()).toHaveLength(0);
  });

  it('pages with "Show earlier", sending the next cursor, until there is no more', async () => {
    const api = apiWith(async (path) =>
      path.includes('cursor=')
        ? ok({ items: ALL_KINDS.slice(2, 3) })
        : ok({ items: ALL_KINDS.slice(0, 2), nextCursor: '1760000080~approval_decided:a b' }),
    );
    await mount(api);
    expect(rows()).toHaveLength(2);
    const more = [...host.querySelectorAll('button')].find((b) => b.textContent === S.showMore);
    await act(async () => more?.click());
    expect(api.get).toHaveBeenLastCalledWith(
      `/api/ui/activity?limit=20&cursor=${encodeURIComponent('1760000080~approval_decided:a b')}`,
    );
    expect(rows()).toHaveLength(3);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === S.showMore)).toBe(
      false,
    );
  });

  it('keeps the rows when "Show earlier" fails, and lets the owner try again', async () => {
    let fail = true;
    const api = apiWith(async (path) => {
      if (!path.includes('cursor=')) return ok({ items: ALL_KINDS.slice(0, 2), nextCursor: '1~x' });
      return fail
        ? { kind: 'error', status: 500 }
        : ok({ items: [{ kind: 'rules_changed', at: AT }] });
    });
    await mount(api);
    const click2 = async (label: string): Promise<void> => {
      const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
      expect(button, label).toBeDefined();
      await act(async () => button?.click());
    };
    await click2(S.showMore);
    expect(rows()).toHaveLength(2);
    expect(host.querySelector('.al-banner')?.textContent).toContain(S.errorTitle);
    fail = false;
    await click2(S.tryAgain);
    expect(rows()).toHaveLength(3);
    expect(host.querySelector('.al-banner')).toBeNull();
  });

  it.each([
    [{ kind: 'error', status: 500 }, 'errorTitle'],
    [{ kind: 'offline' }, 'offlineTitle'],
    [{ kind: 'session_expired' }, 'sessionTitle'],
    [{ kind: 'forbidden' }, 'sessionTitle'],
    [{ kind: 'error', status: 409 }, 'notSetUpTitle'],
  ] as const)('says what to do when loading fails (%j)', async (result, key) => {
    await mount(apiWith(async () => result as ApiResult<unknown>));
    expect(text()).toContain(S[key]);
    expect(rows()).toHaveLength(0);
  });

  it('retries a failed first load', async () => {
    let calls = 0;
    const api = apiWith(async () =>
      ++calls === 1 ? { kind: 'error', status: 500 } : ok({ items: ALL_KINDS }),
    );
    await mount(api);
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === S.tryAgain);
    await act(async () => retry?.click());
    expect(rows()).toHaveLength(ALL_KINDS.length);
  });

  it('treats a malformed body as an error, not a crash', async () => {
    await mount(apiWith(async () => ok({ items: 'nope' })));
    expect(text()).toContain(S.errorTitle);
  });

  it('still shows every row, with neutral words, when the people read fails', async () => {
    const api = {
      get: vi.fn(async (path: string) =>
        path.startsWith('/api/ui/contacts')
          ? ({ kind: 'error', status: 500 } as ApiResult<unknown>)
          : ok({ items: ALL_KINDS.slice(0, 1) }),
      ),
      post: vi.fn(),
    } as unknown as ApiClient;
    await mount(api);
    expect(rows().map(sentenceOf)).toEqual(['You approved sending Q3-plan.pdf']);
  });
});
