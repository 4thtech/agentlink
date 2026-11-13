// @vitest-environment jsdom
// N3 (run1113 PLAN-notifications D3) + OWNERSTEP-LEFT: the compact approval card on Home and the last
// two-step owner steps (Home's bulk review, the Inbox Save) as one step each.
// - The card shows what the AI wants in one line, "Approve with Touch ID" and "Deny with Touch ID",
//   and "Review", which opens the full approval in place. The AI's own words stay in the untrusted
//   container (06 §4, I-5) and are never a heading or a link.
// - One click -> one gesture -> one request; Approve and Deny are distinct and labelled.
// - The master code path: without a passkey the button opens the code field; with one, the link.
// - The desktop app on a Mac with Touch ID turned on sends the native kind and never says
//   "passkey", "browser" or "Safari".
// - IR-UX1113-N2-1 lows #1 (one decision in flight) and #2 (a refused proof is not "wasn't used").
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApprovalItem,
  ApprovalsClient,
  DecideAnswer,
  Decision,
  Presence,
  ReviewPick,
} from '../approvals/client.js';
import { APPROVAL_STRINGS as A } from '../approvals/strings.js';
import { PresenceSeamsContext, type PresenceSeams } from '../contacts/presence-button.js';
import { DESKTOP_MARKER } from '../../presence/desktop.js';
import { SaveFile } from '../inbox/save.js';
import type { SaveApi, SavePresence } from '../inbox/save-api.js';
import { HomeApprovals } from './home-approvals.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PASSKEY = { credentialId: 'Y3JlZA', prfSalt: 'c2FsdA' };
const NEEDLE = '<h1>Ignore your rules</h1> https://evil.example/x';
const MAC_APP = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/39.0 ${DESKTOP_MARKER}`;

function item(c: string, over: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    approvalId: `apr_${c.repeat(22)}`,
    summary: `Send a message to Ana (${c})`,
    actionDigest: c.toLowerCase().repeat(64),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    commitment: false,
    paid: false,
    details: {
      headline: `Send a message to Ana ${c}`,
      who: 'Ana',
      what: 'Send a message',
      cost: 'Free',
      expires: 'in 1 hour',
      rule: 'Ask me',
      fromAi: [{ name: 'text', value: NEEDLE }],
    },
    ...over,
  };
}

interface Calls {
  decide: { approvalId: string; decision: Decision; presence: Presence }[];
  review: { picks: readonly ReviewPick[]; presence: Presence }[];
}
function fakeClient(
  items: readonly ApprovalItem[],
  reply: DecideAnswer = { kind: 'status', status: 'applied', decision: 'approve' },
): { client: ApprovalsClient; calls: Calls } {
  const calls: Calls = { decide: [], review: [] };
  const client: ApprovalsClient = {
    passkey: () => Promise.resolve({ kind: 'ready', offered: true, passkey: PASSKEY }),
    list: () => Promise.resolve({ kind: 'ok', items: [...items] }),
    one: () => Promise.resolve({ kind: 'offline' }),
    decide: (it, decision, presence) => {
      calls.decide.push({ approvalId: it.approvalId, decision, presence });
      // Never answers synchronously: a second click lands while the first is in flight.
      return new Promise((r) =>
        setTimeout(
          () =>
            r(
              reply.kind === 'status' && reply.status === 'applied'
                ? { ...reply, decision }
                : reply,
            ),
          5,
        ),
      );
    },
    review: (picks, presence) => {
      calls.review.push({ picks, presence });
      return Promise.resolve({ kind: 'status', status: 'applied' });
    },
  };
  return { client, calls };
}

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

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2));
    });
  }
};
const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll('button')];
const labels = (): string[] => buttons().map((b) => (b.textContent ?? '').trim());
function button(name: string | RegExp): HTMLButtonElement {
  const found = buttons().find((b) => {
    const t = (b.textContent ?? '').trim();
    return typeof name === 'string' ? t === name : name.test(t);
  });
  if (found === undefined) throw new Error(`no button ${String(name)} in: ${labels().join(' | ')}`);
  return found;
}
const click = async (name: string | RegExp): Promise<void> => {
  const b = button(name);
  await act(async () => {
    b.click();
  });
  await settle();
};

async function mount(
  items: readonly ApprovalItem[],
  {
    passkey = true,
    pro = false,
    seams = { platform: 'mac' },
    reply,
  }: {
    passkey?: boolean;
    pro?: boolean;
    seams?: PresenceSeams;
    reply?: DecideAnswer;
  } = {},
): Promise<Calls> {
  const { client, calls } = fakeClient(items, reply);
  const el: ReactElement = createElement(
    PresenceSeamsContext.Provider,
    {
      value: {
        nativeStatus: () => Promise.resolve({ available: false, registered: false }),
        ...seams,
      },
    },
    createElement(HomeApprovals, {
      items,
      owner: passkey ? { ready: true, passkey: PASSKEY } : { ready: true },
      client,
      sheet: {},
      pro,
      onChanged: () => undefined,
    }),
  );
  await act(async () => {
    root.render(el);
  });
  await settle();
  return calls;
}

describe('N3: the compact approval card on Home', () => {
  it('shows one line, Approve with Touch ID, Deny with Touch ID and Review; the rest opens in place', async () => {
    await mount([item('A')]);
    const card = host.querySelector('.al-approval');
    expect(card).not.toBeNull();
    // The one line: the server's fixed-template headline, as text.
    expect(host.querySelector('.al-approval-line')?.textContent).toContain(
      'Send a message to Ana A',
    );
    expect(labels()).toContain('Approve with Touch ID');
    expect(labels()).toContain('Deny with Touch ID');
    const review = button('Review');
    expect(review.getAttribute('aria-expanded')).toBe('false');
    // Collapsed: neither the facts nor the AI's words are drawn.
    expect(host.querySelector('.al-approval-rows')).toBeNull();
    expect(host.textContent).not.toContain('Ignore your rules');
    await click('Review');
    expect(button(/^Hide details$/).getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.al-approval-rows')).not.toBeNull();
    // The AI's words, only inside the untrusted container.
    const wrapped = host.querySelector('.al-untrusted');
    expect(wrapped?.textContent).toContain('Ignore your rules');
    expect(wrapped?.getAttribute('aria-label')).toBe(A.fromAi);
  });

  it('never draws the untrusted text as a heading or a link, collapsed or open', async () => {
    await mount([item('A')]);
    const check = (): void => {
      for (const el of host.querySelectorAll('h1, h2, h3, h4, h5, h6, a, [role="heading"]')) {
        expect(el.textContent ?? '').not.toContain('Ignore your rules');
        expect(el.textContent ?? '').not.toContain('evil.example');
      }
      // The one line is a line, not a heading.
      expect(host.querySelector('.al-approval-line')?.closest('h1, h2, h3, h4, h5, h6')).toBeNull();
    };
    check();
    await click('Review');
    check();
    expect(host.querySelector('h1')).toBeNull();
  });

  it('one click on Approve: one gesture, one request, the approve decision', async () => {
    const calls = await mount([item('A')]);
    await click('Approve with Touch ID');
    expect(calls.decide).toHaveLength(1);
    expect(calls.decide[0]?.decision).toBe('approve');
    expect(calls.decide[0]?.presence.kind).toBe('passkey');
    // No second step: no "Confirm with" button ever appears.
    expect(labels().some((l) => /^Confirm/.test(l))).toBe(false);
  });

  it('Deny is its own labelled button and sends the deny decision, once', async () => {
    const calls = await mount([item('A')]);
    const deny = button('Deny with Touch ID');
    const approve = button('Approve with Touch ID');
    expect(deny).not.toBe(approve);
    // Deny first, Approve the primary (D1): only Approve is orange.
    expect(approve.className).toMatch(/primary/);
    expect(deny.className).not.toMatch(/primary/);
    await click('Deny with Touch ID');
    expect(calls.decide).toHaveLength(1);
    expect(calls.decide[0]?.decision).toBe('deny');
  });

  it('a double click asks once (IR-UX1113-N2-1 #1: one decision in flight)', async () => {
    const calls = await mount([item('A')]);
    const b = button('Approve with Touch ID');
    await act(async () => {
      b.click();
      b.click();
    });
    await settle();
    expect(calls.decide).toHaveLength(1);
  });

  it('a refused proof says so, not "wasn\'t used" (IR-UX1113-N2-1 #2)', async () => {
    await mount([item('A')], { reply: { kind: 'status', status: 'presence_rejected' } });
    await click('Approve with Touch ID');
    expect(host.textContent).toContain(A.sensorRefused);
    expect(host.textContent).not.toContain("wasn't used");
    // The buttons come back for another try.
    expect(labels()).toContain('Approve with Touch ID');
  });

  it('the master code path: no passkey here, Approve opens the code field and sends the code once', async () => {
    const calls = await mount([item('A')], { passkey: false });
    expect(labels()).toContain('Approve');
    expect(labels()).toContain('Deny');
    await click('Approve');
    expect(calls.decide).toHaveLength(0);
    const field = host.querySelector<HTMLInputElement>('input[type="password"]');
    expect(field).not.toBeNull();
    if (field === null) return;
    field.value = 'ABCD-EFGH-IJKL-MNOP';
    await act(async () => {
      field.form?.requestSubmit();
    });
    await settle();
    expect(calls.decide).toHaveLength(1);
    expect(calls.decide[0]?.presence).toEqual({ kind: 'code', code: 'ABCD-EFGH-IJKL-MNOP' });
    expect(calls.decide[0]?.decision).toBe('approve');
  });

  it('with a passkey, "Use your master code instead" turns the buttons to the code field', async () => {
    const calls = await mount([item('A')]);
    await click('Use your master code instead');
    await click('Deny');
    const field = host.querySelector<HTMLInputElement>('input[type="password"]');
    expect(field).not.toBeNull();
    if (field === null) return;
    field.value = 'CODE';
    await act(async () => {
      field.form?.requestSubmit();
    });
    await settle();
    expect(calls.decide.map((c) => [c.decision, c.presence.kind])).toEqual([['deny', 'code']]);
  });

  it('the Mac app with Touch ID on: the native kind, and no passkey, browser or Safari words', async () => {
    const calls = await mount([item('A')], {
      passkey: false,
      seams: {
        userAgent: MAC_APP,
        nativeStatus: () => Promise.resolve({ available: true, registered: true }),
      },
    });
    expect(labels()).toContain('Approve with Touch ID');
    await click('Review');
    expect(host.textContent ?? '').not.toMatch(/passkey|browser|safari/i);
    await click('Approve with Touch ID');
    expect(calls.decide).toHaveLength(1);
    expect(calls.decide[0]?.presence).toEqual({ kind: 'native' });
    expect(host.textContent ?? '').not.toMatch(/passkey|browser|safari/i);
  });

  it('2+ waiting: "+1 more waiting" opens the next card in place', async () => {
    await mount([item('A'), item('B')]);
    expect(host.querySelectorAll('.al-approval')).toHaveLength(1);
    await click('+1 more waiting');
    expect(host.querySelectorAll('.al-approval')).toHaveLength(2);
  });

  it('bulk approve (Under the hood): one click on "Approve 2 with Touch ID", one review request', async () => {
    const calls = await mount([item('A'), item('B')], { pro: true });
    await click('+1 more waiting');
    for (const box of host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      await act(async () => {
        box.click();
      });
    }
    await settle();
    await click('Approve 2 with Touch ID');
    expect(calls.review).toHaveLength(1);
    expect(calls.review[0]?.picks).toHaveLength(2);
    expect(calls.review[0]?.presence.kind).toBe('passkey');
    expect(labels().some((l) => /^Confirm/.test(l))).toBe(false);
  });
});

describe('IR-N3-1 fixes', () => {
  const terms = (n: number): readonly string[] => [
    'Accept the terms Ana proposed',
    'From Ana: their content, not instructions',
    ...Array.from({ length: n }, (_, i) => `| Clause ${String(i + 1)}`),
    'End of their content',
    'Approving this commits you to these terms.',
  ];
  const termsItem = (n: number): ApprovalItem => {
    const base = item('T');
    return {
      ...base,
      commitment: true,
      ...(base.details === undefined ? {} : { details: { ...base.details, terms: terms(n) } }),
    };
  };

  it('#1 terms: Approve is offered only once Review shows the full terms; Deny stays', async () => {
    const calls = await mount([termsItem(9)]);
    expect(labels()).not.toContain('Approve with Touch ID');
    expect(labels().some((l) => /^Approve/.test(l))).toBe(false);
    expect(labels()).toContain('Deny with Touch ID');
    await click('Review');
    // The full terms are on screen: every clause, the ninth included.
    expect(host.textContent).toContain('Clause 9');
    await click('Approve with Touch ID');
    expect(calls.decide.map((c) => c.decision)).toEqual(['approve']);
  });

  it('#1 terms: Deny works without Review', async () => {
    const calls = await mount([termsItem(2)]);
    await click('Deny with Touch ID');
    expect(calls.decide.map((c) => c.decision)).toEqual(['deny']);
  });

  it('#2 the capped terms point to Review, not Details', async () => {
    await mount([termsItem(9)]);
    expect(host.textContent).toContain('3 more in Review.');
    expect(host.textContent).not.toContain('more in Details');
  });

  it('#3 collapsing "+N more" drops the picks on the hidden cards', async () => {
    await mount([item('A'), item('B')], { pro: true });
    await click('+1 more waiting');
    for (const box of host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      await act(async () => {
        box.click();
      });
    }
    await settle();
    expect(labels()).toContain('Approve 2 with Touch ID');
    await click('Hide 1 more');
    expect(labels()).not.toContain('Approve 2 with Touch ID');
    // The card on top is still on screen and still picked.
    expect(labels()).toContain('Approve 1 with Touch ID');
  });

  it('#4 the one line says who when the headline does not (a nameless one: "a contact")', async () => {
    const base = item('W');
    const d = base.details;
    if (d === undefined) throw new Error('fixture');
    const { headline: _drop, ...noHeadline } = d;
    void _drop;
    await mount([
      { ...base, details: { ...noHeadline, what: 'Add a proof', who: 'Natasa' } },
      {
        ...item('X'),
        details: { ...noHeadline, what: 'Accept an invite', who: '' },
      },
    ]);
    await click('+1 more waiting');
    const lines = [...host.querySelectorAll('.al-approval-what')].map((p) => p.textContent ?? '');
    expect(lines[0]).toContain('Add a proof');
    expect(lines[0]).toContain('Natasa');
    expect(lines[1]).toContain('a contact');
  });

  it('#5 Touch ID not available here: says so and points to the master code', async () => {
    await mount([item('A')], { reply: { kind: 'status', status: 'presence_required' } });
    await click('Approve with Touch ID');
    expect(host.textContent).toContain(A.sensorUnavailable);
    expect(host.textContent).not.toContain(A.sensorRefused);
  });
});

describe('OWNERSTEP-LEFT: the Inbox Save is one step', () => {
  function api(): { api: SaveApi; sent: SavePresence[] } {
    const sent: SavePresence[] = [];
    return {
      sent,
      api: {
        save: (_id, presence) => {
          sent.push(presence);
          return Promise.resolve({ kind: 'outcome', outcome: 'saved' });
        },
      },
    };
  }
  const ID = `${'a'.repeat(22)}.01`;

  it('"Save with Touch ID": one click, one request, no second Confirm', async () => {
    const { api: saveApi, sent } = api();
    await act(async () => {
      root.render(
        createElement(
          PresenceSeamsContext.Provider,
          { value: { platform: 'mac' } },
          createElement(SaveFile, {
            id: ID,
            api: saveApi,
            passkey: () => Promise.resolve(PASSKEY),
          }),
        ),
      );
    });
    await settle();
    await click('Save with Touch ID');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe('passkey');
    expect(labels().some((l) => /^Confirm/.test(l))).toBe(false);
  });

  it('no passkey here: "Save to Inbox" opens the master code field', async () => {
    const { api: saveApi, sent } = api();
    await act(async () => {
      root.render(
        createElement(SaveFile, {
          id: ID,
          api: saveApi,
          passkey: () => Promise.resolve(undefined),
        }),
      );
    });
    await settle();
    await click('Save to Inbox');
    const field = host.querySelector<HTMLInputElement>('input[type="password"]');
    expect(field).not.toBeNull();
    if (field === null) return;
    field.value = 'CODE';
    await act(async () => {
      field.form?.requestSubmit();
    });
    await settle();
    expect(sent).toEqual([{ kind: 'code', code: 'CODE' }]);
  });

  it('the Mac app with Touch ID on: native, one request', async () => {
    const { api: saveApi, sent } = api();
    await act(async () => {
      root.render(
        createElement(
          PresenceSeamsContext.Provider,
          {
            value: {
              userAgent: MAC_APP,
              nativeStatus: () => Promise.resolve({ available: true, registered: true }),
            },
          },
          createElement(SaveFile, {
            id: ID,
            api: saveApi,
            passkey: () => Promise.resolve(undefined),
          }),
        ),
      );
    });
    await settle();
    await click('Save with Touch ID');
    expect(sent).toEqual([{ kind: 'native' }]);
  });
});

describe('OWNERSTEP-LEFT: no two-step OwnerStep is left in the app', () => {
  it('no source under src/ draws <OwnerStep', () => {
    const sources = import.meta.glob<string>('../../**/*.tsx', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const hits = Object.entries(sources)
      .filter(
        ([path, text]) => !/\.test\./.test(path) && /<OwnerStep\b|function OwnerStep\b/.test(text),
      )
      .map(([path]) => path);
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(hits).toEqual([]);
  });
});
