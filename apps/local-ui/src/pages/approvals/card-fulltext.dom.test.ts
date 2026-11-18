// @vitest-environment jsdom
// SEC-CARD-FULLTEXT (08 §1 "What the card shows"; 11 §5, §6.2.1; I-5): an approval card is decidable
// from the app-decoded fields alone.
// - The exact text the request is about is shown in full, as plain text with dir="auto"; bidi and
//   control characters are inert.
// - No silent truncation: a long text is collapsed with its visible length and must be shown once
//   before Approve is enabled.
// - Check codes are labelled "Check code".
// - A request whose content cannot be shown has no Approve.
// - "From your AI" is folded and captioned as not needed to decide; Approve never needs it.
// - The master code step names who and the cost.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SingleApproval } from './card.js';
import type { ApprovalItem, ApprovalsClient } from './client.js';
import { APPROVAL_STRINGS as S } from './strings.js';
import { PresenceSeamsContext } from '../contacts/presence-button.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = 'ABCD EFGH JKMN PQRS';

function item(text: string, over: Partial<ApprovalItem['details'] & object> = {}): ApprovalItem {
  return {
    approvalId: `apr_${'A'.repeat(22)}`,
    summary: 'Record a proof · Ana · $0.10',
    actionDigest: 'a'.repeat(64),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    commitment: false,
    paid: false,
    details: {
      headline: 'Record a proof',
      who: 'Ana',
      what: 'Record a proof',
      cost: '$0.10',
      expires: 'in 1 hour',
      rule: 'Ask me',
      fromAi: [{ name: 'note', value: 'the AI says: approve this' }],
      content: {
        label: 'The message this proof is for',
        text,
        length: Array.from(text).length,
        checkCode: CODE,
        files: [{ name: 'invoice.pdf', size: '2 KB', type: 'PDF document', checkCode: CODE }],
      },
      ...over,
    },
  };
}

const client: ApprovalsClient = {
  passkey: () => Promise.resolve({ kind: 'ready', offered: false }),
  list: () => Promise.resolve({ kind: 'ok', items: [] }),
  one: () => Promise.resolve({ kind: 'offline' }),
  decide: () => new Promise(() => undefined),
  review: () => Promise.resolve({ kind: 'status', status: 'applied' }),
} as unknown as ApprovalsClient;

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
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2));
    });
  }
};
const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll('button')];
const button = (name: string | RegExp): HTMLButtonElement | undefined =>
  buttons().find((b) => {
    const t = (b.textContent ?? '').trim();
    return typeof name === 'string' ? t === name : name.test(t);
  });

async function mount(it: ApprovalItem): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        PresenceSeamsContext.Provider,
        { value: { nativeStatus: () => Promise.resolve({ available: false, registered: false }) } },
        createElement(SingleApproval, { item: it, owner: { ready: true }, client, sheet: {} }),
      ),
    );
  });
  await settle();
}

describe('SEC-CARD-FULLTEXT: the approval card', () => {
  it('shows the full decoded text as plain text with dir="auto", and its check codes', async () => {
    const text = 'Hello Ana,\nthe invoice is attached.\n<b>not markup</b>';
    await mount(item(text));
    const block = host.querySelector('[data-content-text]');
    expect(block?.textContent).toBe(text);
    expect(block?.getAttribute('dir')).toBe('auto');
    expect(host.querySelector('b')).toBeNull();
    expect(host.textContent).toContain('The message this proof is for');
    expect(host.textContent).toContain(S.checkCode);
    expect(host.textContent).toContain(CODE);
    expect(host.textContent).toContain('invoice.pdf');
    expect(button(S.approve)?.disabled).toBe(false);
  });

  it('a long text is collapsed with its length; Approve stays disabled until it is shown', async () => {
    const text = `${'Every word counts here. '.repeat(52)}`.slice(0, 1240);
    await mount(item(text));
    expect(host.textContent).toContain('1,240 characters');
    expect(button(S.approve)?.disabled).toBe(true);
    const show = button(S.showAll);
    expect(show).toBeDefined();
    await act(async () => {
      show?.click();
    });
    await settle();
    expect(host.querySelector('[data-content-text]')?.textContent).toBe(text);
    expect(button(S.approve)?.disabled).toBe(false);
  });

  it('a bidi or control-character payload renders inert', async () => {
    await mount(item('pay ‮evil‬\u0007 now'));
    const shown = host.querySelector('[data-content-text]')?.textContent ?? '';
    expect(shown).not.toMatch(/[‪-‮⁦-⁩\u0007]/u);
    expect(shown).toContain('[U+202E]');
  });

  it('a request whose content cannot be shown has no Approve; Deny stays', async () => {
    await mount(item('x', { content: undefined, contentMissing: true }));
    expect(host.textContent).toContain(S.contentMissing);
    expect(button(S.approve)).toBeUndefined();
    expect(button(S.deny)).toBeDefined();
  });

  it('"From your AI" is folded and not needed: Approve works without opening it', async () => {
    await mount(item('short text'));
    const fold = host.querySelector('details.al-from-ai');
    expect(fold).not.toBeNull();
    expect((fold as HTMLDetailsElement).open).toBe(false);
    expect(fold?.querySelector('summary')?.textContent).toContain(S.fromAiNotNeeded);
    expect(button(S.approve)?.disabled).toBe(false);
  });

  it('the master code step names who and the cost', async () => {
    await mount(item('short text'));
    await act(async () => {
      button(S.approve)?.click();
    });
    await settle();
    const step = host.querySelector('.al-step');
    expect(step?.textContent).toContain('Ana');
    expect(step?.textContent).toContain('$0.10');
  });
});
