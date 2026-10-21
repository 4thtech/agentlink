// M1-35b: what the components render (S1, I-5; 11 §5, §8, §9; 08 §4; DESIGN-ADJ-1 C-1…C-10, X-1,
// X-7, X-11). Server-side rendering, no DOM: every assertion is on the markup.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fixtures, XSS } from './components.fixture.js';
import * as ui from './index.js';

const html = (el: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(el);

describe('the 31 components (D-116)', () => {
  const names = [
    'AppShell',
    'ApprovalCard',
    'Banner',
    'Button',
    'CommitmentCard',
    'ContactCard',
    'ContactName',
    'CopyPrompt',
    'CostChip',
    'CreditsMeter',
    'EmptyState',
    'FileCard',
    'Fingerprint',
    'Icon',
    'IdentityLabel',
    'Kbd',
    'Lockup',
    'Mark',
    'ProofBadge',
    'ReceiptTimeline',
    'SafetyCode',
    'SecretDisplay',
    'Segmented',
    'StatusChip',
    'Switch',
    'TermsDiff',
    'TextField',
    'Toast',
    'TrayMenu',
    'UntrustedContent',
    'Wordmark',
  ];
  it.each(names)('exports %s', (name) => {
    expect(typeof (ui as Record<string, unknown>)[name]).toBe('function');
  });
  it('exports the name rule and the icon names', () => {
    expect(typeof ui.formatContactName).toBe('function');
    expect(ui.iconNames).toHaveLength(57);
  });
  it('has a fixture for every component', () => {
    const covered = new Set(Object.keys(fixtures).map((k) => k.split('/')[0]));
    for (const n of names) expect(covered.has(n), n).toBe(true);
  });
});

describe('no inline styles, no scripts, no external URLs (08 §4 CSP)', () => {
  it.each(Object.keys(fixtures))('%s', (key) => {
    const out = html(fixtures[key]!());
    expect(out).not.toMatch(/\sstyle=/i);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/\son[a-z]+=/i);
    expect(out).not.toMatch(/(?:src|href)="https?:/i);
    expect(out).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    expect(out).not.toMatch(/\sautofocus/i);
  });
});

describe('formatContactName: the 11 §5.2 name rule', () => {
  it('uses the alias as is', () => {
    expect(ui.formatContactName({ alias: 'Marko (work)', name: 'x', fingerprint: 'AB' })).toEqual({
      kind: 'alias',
      text: 'Marko (work)',
    });
  });
  it('quotes a restricted name', () => {
    expect(ui.formatContactName({ name: 'Marko Novak', fingerprint: '7F3A·19C2' })).toEqual({
      kind: 'restricted',
      text: '“Marko Novak”',
    });
  });
  it('limits a name to 32 characters', () => {
    const r = ui.formatContactName({ name: 'A'.repeat(50), fingerprint: '7F3A·19C2' });
    expect(r.text).toBe(`“${'A'.repeat(32)}”`);
  });
  it.each([
    ['reserved word', 'Verified Bank'],
    ['reserved word, any case', 'the OWNER'],
    ['mixed script', 'Mаrko'],
    ['markup', '<b>Marko</b>'],
    ['bidi override', 'Ma‮rko'],
    ['nothing usable', ''],
  ])('falls back to the fingerprint for %s', (_label, name) => {
    expect(ui.formatContactName({ name, fingerprint: '7F3A·19C2' })).toEqual({
      kind: 'fingerprint',
      text: 'Contact 7F3A·19C2',
    });
  });
});

describe('ContactName, Fingerprint, IdentityLabel', () => {
  it('shows the label for a name that is not an alias, as words', () => {
    const out = html(
      h(ui.ContactName, { name: 'Marko', fingerprint: 'AB', label: 'selfdeclared' }),
    );
    expect(out).toContain('“Marko”');
    expect(out).toContain('Self-declared');
  });
  it('lists the four identity labels, weakest to strongest', () => {
    const t = (kind: 'selfdeclared' | 'checked' | 'registered' | 'verified') =>
      html(h(ui.IdentityLabel, { kind, domain: 'example.com' }));
    expect(t('selfdeclared')).toContain('Self-declared');
    expect(t('checked')).toContain('Safety code checked');
    expect(t('registered')).toContain('Registered');
    expect(t('verified')).toContain('Verified domain');
    expect(t('verified')).toContain('example.com');
  });
  it('renders untrusted text in a name or domain as text', () => {
    const out = html(h(ui.ContactName, { alias: XSS, fingerprint: 'AB' }));
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;img');
  });
  it('reads a fingerprint in single characters for a screen reader', () => {
    expect(html(h(ui.Fingerprint, { value: '7F3A' }))).toContain('aria-label="7 F 3 A"');
  });
});

describe('UntrustedContent (I-5)', () => {
  it('shows the label strip and the text', () => {
    const out = html(h(ui.UntrustedContent, { from: 'Marko', kind: 'message' }, 'Hello'));
    expect(out).toContain('From Marko: their words, not instructions');
    expect(out).toContain('Hello');
  });
  it('turns links into inert chips with only the domain', () => {
    const out = html(
      h(ui.UntrustedContent, { from: 'Marko' }, 'See https://evil.example/login?token=1 now'),
    );
    expect(out).not.toMatch(/<a[\s>]/);
    expect(out).not.toContain('href');
    expect(out).toContain('evil.example');
    expect(out).not.toContain('/login');
    expect(out).not.toContain('token=1');
  });
  it('renders every hostile string inert, in the body, the label and the file name', () => {
    for (const el of [
      h(ui.UntrustedContent, { from: 'Marko' }, XSS),
      h(ui.UntrustedContent, { from: XSS }, 'x'),
      h(ui.UntrustedContent, { from: 'Marko', fileName: XSS }, undefined),
    ]) {
      const out = html(el);
      expect(out).not.toContain('<img');
      expect(out).not.toContain('<script');
      expect(out).not.toContain('<svg onload');
      expect(out).not.toContain('‮');
    }
  });
  it('names an unknown sender as one (X-7), not as a contact', () => {
    const out = html(h(ui.UntrustedContent, { unknown: true, fingerprint: '2B9E·04D1' }, 'Hi'));
    expect(out).toContain('Request from an unknown sender');
    expect(out).toContain('2B9E·04D1');
    expect(out).not.toContain('Request from Contact');
    expect(out).not.toContain('Contact 2B9E');
  });
  it('has no heading, button or form control inside', () => {
    const out = html(h(ui.UntrustedContent, { from: 'Marko' }, '# Heading <button>x</button>'));
    expect(out).not.toMatch(/<(h[1-6]|button|input|form|a)[\s>]/);
  });
});

describe('ContactCard (C-4, X-7, X-11)', () => {
  it('shows an unknown sender as one with a review slot, never with the mark', () => {
    const out = html(
      h(ui.ContactCard, {
        unknownSender: true,
        fingerprint: '2B9E·04D1',
        actions: h('button', null, 'Review'),
      }),
    );
    expect(out).toContain('an unknown sender');
    expect(out).toContain('2B9E·04D1');
    expect(out).not.toContain('Contact 2B9E');
    expect(out).not.toContain('al-mark');
    expect(out).toContain('Review');
  });
  it('shows last activity, never presence, for a contact', () => {
    const out = html(
      h(ui.ContactCard, { alias: 'Marko', lastActivity: 'Last activity 2 hours ago' }),
    );
    expect(out).toContain('Last activity 2 hours ago');
    expect(out).not.toMatch(/online|offline|last seen/i);
  });
  it('shows the flagged (proof mismatch) and pairing mismatch states with a word', () => {
    expect(html(h(ui.ContactCard, { alias: 'M', state: 'flagged' }))).toContain('Flagged');
    expect(html(h(ui.ContactCard, { alias: 'M', state: 'mismatch' }))).toContain(
      'Safety code did not match',
    );
    expect(html(h(ui.ContactCard, { alias: 'M', state: 'blocked' }))).toContain('Blocked');
  });
  it('does not take an owner-agent presence status for a contact', () => {
    // 'online' stays for the owner's own agents (StatusChip), not for contacts.
    expect(html(h(ui.StatusChip, { status: 'online' }))).toContain('Online');
  });
});

describe('SafetyCode (C-10, 04 §3.6.1)', () => {
  const code = '1234 5678 9012';
  it('reads the digits in groups', () => {
    const out = html(h(ui.SafetyCode, { code, contactName: 'Marko' }));
    expect(out).toContain('1 2 3 4, 5 6 7 8, 9 0 1 2');
    expect(out).toContain('They match');
    expect(out).toContain('They don');
  });
  it('shows the waiting state without the match buttons', () => {
    const out = html(h(ui.SafetyCode, { code, contactName: 'Marko', state: 'waiting' }));
    expect(out).toContain('Waiting for');
    expect(out).not.toContain('They match');
  });
  it('stops pairing calmly on a mismatch: warning, nothing was shared', () => {
    const out = html(h(ui.SafetyCode, { code, state: 'mismatch' }));
    expect(out).toContain('Nothing was shared');
    expect(out).toContain('al-tone-warning');
    expect(out).not.toContain('al-tone-danger');
  });
  it('asks to compare again after a key update', () => {
    expect(html(h(ui.SafetyCode, { code, contactName: 'Marko', state: 'changed' }))).toContain(
      'Safety code changed',
    );
  });
});

describe('StatusChip and ProofBadge (C-8, C-9): a word and an icon, never colour alone', () => {
  it.each([
    ['delivery-requested', 'Delivery requested'],
    ['flagged', 'Flagged'],
    ['waiting-to-post', 'Waiting to post'],
    ['needs-credits', 'Needs credits'],
    ['failed', 'Failed'],
    ['accepted', 'Accepted'],
  ] as const)('%s', (status, word) => {
    const out = html(h(ui.StatusChip, { status }));
    expect(out).toContain(word);
    expect(out).toContain('<svg');
  });
  it.each([
    ['recording', 'Recording proof'],
    ['recorded', 'Proof recorded'],
    ['failed', 'wasn'],
    ['waiting', 'waiting for approval'],
    ['submitted', 'Proof submitted'],
    ['needs-credits', 'credits'],
  ] as const)('ProofBadge %s', (state, word) => {
    const out = html(h(ui.ProofBadge, { state }));
    expect(out).toContain(word);
    expect(out).toContain('<svg');
  });
  it('uses the proof tone, not the success tone, for a recorded proof', () => {
    expect(html(h(ui.ProofBadge, { state: 'recorded' }))).not.toContain('al-tone-success');
  });
});

describe('ReceiptTimeline (C-5)', () => {
  it('shows exact times, pending steps and the new steps', () => {
    const out = html(
      h(ui.ReceiptTimeline, {
        steps: [
          { key: 'recorded', done: true, time: '10:00:01' },
          { key: 'asked', done: true, time: '10:00:05' },
          { key: 'not-confirmed', done: false },
          { key: 'waiting-to-post', done: false },
        ],
      }),
    );
    expect(out).toContain('10:00:01');
    expect(out).toContain('Delivery requested');
    expect(out).toContain('Not confirmed');
    expect(out).toContain('Waiting to post');
    expect(out).toContain('is-pending');
    expect(out).toContain('<ol');
  });
  it('renders a step the recipient gave lighter, with no "free receipt" wording', () => {
    const out = html(
      h(ui.ReceiptTimeline, {
        steps: [{ key: 'delivered', done: true, time: '10:02', byRecipient: true }],
      }),
    );
    expect(out).toContain('is-by-recipient');
    expect(out).not.toMatch(/free receipt/i);
  });
});

describe('CostChip and CreditsMeter (C-6, X-4, X-6)', () => {
  it('shows an exact amount or Free, never an approximation', () => {
    expect(
      html(h(ui.CostChip, { amount: '$0.10', split: 'AgentLink $0.10 · App fee $0.00' })),
    ).toContain('$0.10');
    expect(html(h(ui.CostChip, { free: true }))).toContain('Free');
    expect(html(h(ui.CostChip, { amount: '$0.10' }))).not.toContain('≈');
  });
  const base = { balance: '$1.20', proofsLeft: 12, spentLast24h: 3.4, budget: 5 };
  it('speaks of the last 24 hours, not "today"', () => {
    const out = html(h(ui.CreditsMeter, base));
    expect(out).toContain('in the last 24 hours');
    expect(out).not.toMatch(/today/i);
    expect(out).toContain('$3.40 of $5');
  });
  it('says when budget frees up', () => {
    expect(html(h(ui.CreditsMeter, { ...base, frees: 'Frees up at 14:20' }))).toContain(
      'Frees up at 14:20',
    );
  });
  it('hides Add credits while the pay page is off and says so (X-6)', () => {
    const out = html(h(ui.CreditsMeter, { ...base, state: 'low' }));
    expect(out).not.toContain('Add credits');
    expect(out).toContain('Adding credits is not available yet in this version of AgentLink.');
    expect(out).toContain('Messages and files stay free.');
  });
  it('offers Add credits, primary when low, when the pay page is live', () => {
    const out = html(
      h(ui.CreditsMeter, {
        ...base,
        state: 'low',
        addCredits: { available: true, onAdd: () => {} },
      }),
    );
    expect(out).toContain('Add credits');
    expect(out).toContain('al-btn-primary');
  });
  it('offers free test credits on a testnet', () => {
    expect(html(h(ui.CreditsMeter, { ...base, test: true }))).toContain('Test credits');
  });
  it('draws the bar with a class, never a style attribute', () => {
    const out = html(h(ui.CreditsMeter, base));
    expect(out).not.toMatch(/style=/);
    expect(out).toMatch(/al-pct-\d+/);
    expect(out).toContain('role="meter"');
  });
});

describe('FileCard (C-7)', () => {
  it('sanitizes the name and never uses it as a heading', () => {
    const out = html(h(ui.FileCard, { name: `a‮b\u0000${'x'.repeat(200)}.pdf`, size: '1 MB' }));
    expect(out).not.toContain('‮');
    expect(out).not.toContain('\u0000');
    expect(out).not.toMatch(/<h[1-6]/);
    expect(out.match(/x+/)?.[0].length).toBeLessThanOrEqual(80);
  });
  it('renders a hostile name inert', () => {
    const out = html(h(ui.FileCard, { name: XSS, size: '1 MB' }));
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
  });
  it('shows the integrity failure as danger with the exact words', () => {
    const out = html(h(ui.FileCard, { name: 'a.pdf', size: '1 MB', integrity: 'failed' }));
    expect(out).toContain('Failed its integrity check; not saved.');
  });
  it('shows the removal mode and the removed state', () => {
    expect(html(h(ui.FileCard, { name: 'a.pdf', size: '1 MB', removal: 'receipt' }))).toContain(
      'Removed once delivery is confirmed',
    );
    expect(html(h(ui.FileCard, { name: 'a.pdf', size: '1 MB', removal: 'expiry' }))).toContain(
      'Removed when it expires',
    );
    const gone = html(h(ui.FileCard, { name: 'a.pdf', size: '1 MB', removed: true }));
    expect(gone).toContain('Removed');
    expect(gone).toContain('is-removed');
  });
});

describe('ApprovalCard (C-1, LA-3…LA-9)', () => {
  const base = { agent: 'work-agent', headline: 'Add proof to this file' } as const;
  it('always carries the "your AI can\'t approve" footer', () => {
    for (const state of [
      'pending',
      'waiting',
      'approved',
      'denied',
      'expired',
      'failed',
      'decided-elsewhere',
    ] as const) {
      expect(html(h(ui.ApprovalCard, { ...base, type: 'proof', state }))).toContain(
        "Your AI can't approve this for you.",
      );
    }
  });
  it('names the method on the approve button and has no default button', () => {
    const out = html(h(ui.ApprovalCard, { ...base, type: 'proof', method: 'Touch ID' }));
    expect(out).toContain('Approve with Touch ID');
    expect(out).not.toContain('autofocus');
    expect(out).toContain('tabindex="-1"');
  });
  it('names the owner code and owner passphrase as methods (X-10)', () => {
    expect(html(h(ui.ApprovalCard, { ...base, type: 'proof', method: 'owner code' }))).toContain(
      'Approve with owner code',
    );
  });
  it('has no file-over-limit approval (LA-5)', () => {
    const out = html(h(ui.ApprovalCard, { ...base, type: 'file-over-limit' as never }));
    expect(out).not.toMatch(/over limit/i);
  });
  it('shows a disclosure slot, the receipt request line and the public receipt lines', () => {
    const out = html(
      h(ui.ApprovalCard, {
        ...base,
        type: 'proof',
        disclosure: ['A proof is public. Anyone can see that your agent recorded something.'],
        receiptRequest: { contactName: 'Marko' },
      }),
    );
    expect(out).toContain('A proof is public.');
    expect(out).toContain(
      'Ask Marko to confirm delivery? If they do, anyone can see that this went to their agent.',
    );
  });
  it('offers "Remember for this contact" only for a proof raised by Ask me or the per-proof limit (LA-4)', () => {
    const remember = (reason: string, type: 'proof' | 'new-contact' = 'proof') =>
      html(
        h(ui.ApprovalCard, {
          ...base,
          type,
          remember: {
            reason: reason as never,
            contactName: 'Marko',
            rule: 'Allow proofs up to $1 from Marko',
          },
        }),
      );
    expect(remember('ask-me')).toContain('Remember for this contact');
    expect(remember('ask-me')).toContain('Allow proofs up to $1 from Marko');
    expect(remember('per-proof-limit')).toContain('Remember for this contact');
    for (const r of ['daily-budget', 'new-contact', 'file', 'commitment']) {
      expect(remember(r), r).not.toContain('Remember');
    }
    expect(remember('ask-me', 'new-contact')).not.toContain('Remember');
  });
  it('shows the budget window when the budget triggered the approval (LA-7)', () => {
    const out = html(
      h(ui.ApprovalCard, {
        ...base,
        type: 'proof',
        budget: { used: '$4.90 of $5 used in the last 24 hours', frees: 'Frees up at 14:20' },
      }),
    );
    expect(out).toContain('used in the last 24 hours');
    expect(out).toContain('Frees up at 14:20');
  });
  it('says "decided in your terminal or another window", not "on your phone" (LA-6)', () => {
    const out = html(h(ui.ApprovalCard, { ...base, type: 'proof', state: 'decided-elsewhere' }));
    expect(out).toContain('Already decided in your terminal or another window.');
    expect(out).not.toMatch(/phone/i);
  });
  it('keeps advanced details collapsed on load', () => {
    const out = html(h(ui.ApprovalCard, { ...base, type: 'proof', details: 'record 0xabc' }));
    expect(out).toMatch(/<details(?![^>]*\sopen)/);
  });
  it('renders hostile text in any row inert', () => {
    const out = html(
      h(ui.ApprovalCard, {
        ...base,
        type: 'proof',
        headline: XSS,
        agent: XSS,
        who: XSS,
        what: XSS,
      }),
    );
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
  });
  it('has no batch or receipt-request card yet (B-2, B-1 wait for the redesign)', () => {
    expect((ui as Record<string, unknown>)['ReceiptRequestCard']).toBeUndefined();
    expect((ui as Record<string, unknown>)['ExportProofDialog']).toBeUndefined();
  });
});

describe('TermsDiff and CommitmentCard (C-3, LA-8)', () => {
  it("shows the sign as a word for assistive tech and marks the proposer's words", () => {
    const out = html(
      h(ui.TermsDiff, {
        rows: [
          { field: 'Subject', old: null, new: 'Rush', proposerWords: true },
          { field: 'Price', old: '$1', new: '$2' },
        ],
      }),
    );
    expect(out).toContain('their words');
    expect(out).toContain('aria-label="added"');
    expect(out).toContain('aria-label="changed"');
  });
  it('renders hostile diff values inert', () => {
    const out = html(
      h(ui.TermsDiff, { rows: [{ field: XSS, old: XSS, new: XSS, proposerWords: true }] }),
    );
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
  });
  const card = {
    headline: 'Website redesign',
    who: 'Marko',
    proposer: 'Marko',
    subject: 'Redesign',
    scope: 'Accepts version 3 only',
  } as const;
  it('says AgentLink records the agreement and moves no money, and that the acceptance is public', () => {
    const out = html(h(ui.CommitmentCard, card));
    expect(out).toContain("AgentLink records the agreement. It doesn't move money.");
    expect(out).toContain('This is public: anyone can see that your agent accepted it, and when.');
    expect(out).toContain("Your AI can't approve this for you.");
  });
  it('words the public line for a rejection and uses the danger frame', () => {
    const out = html(h(ui.CommitmentCard, { ...card, mode: 'reject' }));
    expect(out).toContain('anyone can see that your agent rejected it, and when.');
    expect(out).toContain('is-reject');
    expect(out).toContain('Reject with');
  });
  it('never offers remember or always allow', () => {
    const out = html(h(ui.CommitmentCard, card));
    expect(out).not.toMatch(/remember|always allow/i);
  });
  it('renders the subject inside the untrusted container and inert', () => {
    const out = html(h(ui.CommitmentCard, { ...card, subject: XSS, proposer: XSS }));
    expect(out).toContain('al-untrusted');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
  });
  it('keeps the terms fingerprint collapsed under Advanced', () => {
    const out = html(h(ui.CommitmentCard, { ...card, fingerprint: 'AB12CD' }));
    expect(out).toMatch(/<details(?![^>]*\sopen)/);
    expect(out).toContain('Advanced');
  });
});

describe('forms and feedback', () => {
  it('TextField labels, describes and flags an error', () => {
    const out = html(
      h(ui.TextField, { label: 'Owner code', error: 'Too short', mono: true, id: 'f' }),
    );
    expect(out).toContain('for="f"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('aria-describedby="f-d"');
    expect(out).toContain('Too short');
  });
  it('TextField escapes its label, hint and error', () => {
    const out = html(h(ui.TextField, { label: XSS, hint: XSS }));
    expect(out).not.toContain('<img');
  });
  it('Switch shows On and Off in words', () => {
    expect(html(h(ui.Switch, { label: 'x', checked: true }))).toContain('>On<');
    expect(html(h(ui.Switch, { label: 'x', checked: false }))).toContain('>Off<');
  });
  it('Button defaults to type=button and never autofocuses', () => {
    const out = html(h(ui.Button, { autoFocus: true } as never, 'Go'));
    expect(out).toContain('type="button"');
    expect(out).not.toContain('autofocus');
  });
  it('Banner is an alert for danger and warning, a status otherwise', () => {
    expect(html(h(ui.Banner, { tone: 'danger' }, 'x'))).toContain('role="alert"');
    expect(html(h(ui.Banner, { tone: 'info' }, 'x'))).toContain('role="status"');
  });
  it('Toast lives in a polite live region and has a labelled dismiss', () => {
    const out = html(h(ui.Toast, { action: 'Undo' }, 'Saved'));
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain('aria-label="Dismiss"');
    expect(out).toContain('Undo');
  });
  it('EmptyState suggests a prompt to try in your AI', () => {
    expect(html(h(ui.EmptyState, { title: 'None', prompt: 'Send it' }))).toContain('Try:');
  });
  it('CopyPrompt prints a command after a $ and wraps without horizontal scroll', () => {
    const out = html(h(ui.CopyPrompt, { command: 'agentlink ui' }));
    expect(out).toContain('$ ');
    expect(out).toContain('agentlink ui');
  });
  it('SecretDisplay shows the value once, in groups, with Continue disabled', () => {
    const out = html(h(ui.SecretDisplay, { value: 'ABCD EFGH' }));
    expect(out).toContain('Shown once');
    expect(out).toContain("I've saved it");
    expect(out).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Continue/);
  });
});

describe('shell, tray, brand', () => {
  it('AppShell has a labelled nav, a current page, a status bar and no height style', () => {
    const out = html(fixtures['AppShell/default']!());
    expect(out).toContain('aria-label="Main"');
    expect(out).toContain('aria-current="page"');
    expect(out).toContain('Connected');
    expect(out).not.toMatch(/style=/);
  });
  it('TrayMenu lists the approvals waiting', () => {
    const out = html(fixtures['TrayMenu/default']!());
    expect(out).toContain('Approvals waiting');
    expect(out).toContain('role="menu"');
  });
  it('Lockup is endorsed only when asked, and the mark has an accessible name', () => {
    expect(html(h(ui.Lockup, { endorsed: true }))).toContain('by 4thTech');
    expect(html(h(ui.Lockup, {}))).not.toContain('by 4thTech');
    expect(html(h(ui.Mark, { size: 24 }))).toContain('aria-label="AgentLink"');
  });
  it('Mark switches to the pixel-snapped drawing at 20px and below', () => {
    expect(html(h(ui.Mark, { size: 20 }))).toContain('viewBox="0 0 16 16"');
    expect(html(h(ui.Mark, { size: 24 }))).not.toContain('viewBox="0 0 16 16"');
  });
  it('Icon is hidden from screen readers unless labelled, and takes currentColor', () => {
    expect(html(h(ui.Icon, { name: 'check' }))).toContain('aria-hidden="true"');
    expect(html(h(ui.Icon, { name: 'check', label: 'Done' }))).toContain('aria-label="Done"');
    expect(html(h(ui.Icon, { name: 'check' }))).toContain('stroke="currentColor"');
  });
  it('Icon has no link icon and no icon that is a hyperlink', () => {
    expect(ui.iconNames).not.toContain('link');
  });
});

describe('vocabulary (11 §5.1) in every default render', () => {
  const banned = /\b(wallet|gas|seed phrase|transaction|on-chain|blockchain)\b/i;
  it.each(Object.keys(fixtures))('%s', (key) => {
    expect(html(fixtures[key]!())).not.toMatch(banned);
  });
});
