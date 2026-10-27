// @vitest-environment jsdom
// M1-PAY-CONFIRM-b: the paid-action confirmation sheet (b11 §19, §20; 04 §2.5.3; 08 §1; 11 §5;
// D-132). The sheet renders only the statement the server returned, names the platform's check,
// never focuses Confirm by default, announces each state in one live region, closes itself about
// 1.2 s after Done (and waits for Close with reduced motion), and its copy passes the 11 §5 lint.
import { act, createElement as h, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lintVocabulary } from '../strings/lint.js';
import {
  PAY_CONFIRM_STRINGS as P,
  PayConfirmSheet,
  detectPayPlatform,
  formatUsd,
  parsePayStatement,
  payConfirmView,
  platformLabels,
  type PayConfirmSheetProps,
  type PayStatement,
} from './index.js';

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

const PROOF: PayStatement = {
  v: 1,
  kind: 'proof',
  amountUsd: '0.1',
  purpose: 'proof',
  counterparty: '“Ana” (self-declared)',
  changes: [],
};
const REMEMBER: PayStatement = {
  ...PROOF,
  kind: 'proof_remember',
  amountUsd: '0.123',
  changes: [
    {
      field: 'contactRules.proofs.perActionMaxUSD',
      contact: `0x${'12'.repeat(20)}`,
      old: null,
      new: '0.13',
    },
  ],
};
const LIMITS: PayStatement = {
  v: 1,
  kind: 'limits',
  amountUsd: null,
  purpose: 'limits_change',
  counterparty: null,
  changes: [
    { field: 'proofs.dailyBudgetUSD', old: '5', new: '10' },
    { field: 'proofs.notarize', old: 'allow', new: 'approval' },
  ],
};

function props(over: Partial<PayConfirmSheetProps> = {}): PayConfirmSheetProps {
  const view = payConfirmView(PROOF);
  return {
    view,
    platform: 'mac',
    phase: 'ready',
    canPasskey: true,
    backup: true,
    reducedMotion: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    onUseBackup: vi.fn(),
    onCode: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
}
const mount = (p: PayConfirmSheetProps): void => {
  act(() => root.render(h(PayConfirmSheet, p)));
};
const dialog = (): HTMLElement => {
  const d = document.querySelector<HTMLElement>('[role="dialog"]');
  if (d === null) throw new Error('no dialog');
  return d;
};
const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
const press = (k: string): void => {
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
    );
  });
};

describe('the statement the server returned, and nothing else', () => {
  it('a proof: title, the amount large, For, Paid from, and the trust lines', () => {
    const v = payConfirmView(PROOF);
    expect(v.title).toBe('Record proof');
    expect(v.amount).toBe('$0.10');
    expect(v.amountSpoken).toBe('10 cents');
    expect(v.rows).toEqual([
      { label: 'For', value: 'A proof with “Ana” (self-declared)' },
      { label: 'Paid from', value: 'Your credits' },
    ]);
    expect(v.changes).toEqual([]);
  });

  it('"Remember for this contact": the fee and the contact rule, old and new, by name', () => {
    const v = payConfirmView(REMEMBER);
    expect(v.amount).toBe('$0.123');
    expect(v.changes).toEqual([
      { label: 'Per-proof limit for “Ana” (self-declared)', old: 'Not set', new: '$0.13' },
    ]);
    expect(JSON.stringify(v)).not.toContain('0x1212');
  });

  it('a limits change: no amount, each spending field old → new in plain words', () => {
    const v = payConfirmView(LIMITS);
    expect(v.title).toBe('Change your spending limits');
    expect(v.amount).toBeNull();
    expect(v.changes).toEqual([
      { label: '24-hour budget', old: '$5', new: '$10' },
      { label: 'Proofs', old: 'Automatic', new: 'Ask me' },
    ]);
  });

  it('refuses anything that is not a statement (unknown key, kind, field or amount)', () => {
    expect(parsePayStatement(PROOF)).toEqual(PROOF);
    expect(parsePayStatement({ ...PROOF, extra: 1 })).toBeUndefined();
    expect(parsePayStatement({ ...PROOF, kind: 'register' })).toBeUndefined();
    expect(parsePayStatement({ ...PROOF, amountUsd: '1e3' })).toBeUndefined();
    expect(
      parsePayStatement({ ...LIMITS, changes: [{ field: 'files.max', old: '1', new: '2' }] }),
    ).toBeUndefined();
    expect(parsePayStatement(null)).toBeUndefined();
  });

  it('formats dollars with at least two decimals and never rounds', () => {
    expect(formatUsd('0.1')).toBe('$0.10');
    expect(formatUsd('5')).toBe('$5');
    expect(formatUsd('5.5')).toBe('$5.50');
    expect(formatUsd('0.123')).toBe('$0.123');
  });

  it('never takes an amount or a name from the page address', () => {
    history.replaceState(null, '', '/?amount=99.99&name=Mallory');
    mount(props());
    expect(dialog().textContent).not.toContain('99.99');
    expect(dialog().textContent).not.toContain('Mallory');
    history.replaceState(null, '', '/');
  });
});

describe('platform wording (08 §1; b11 §19.2)', () => {
  it('names Touch ID on a Mac, Windows Hello on Windows, otherwise your passkey', () => {
    expect(platformLabels('mac')).toEqual({
      confirm: 'Confirm with Touch ID',
      waiting: 'Waiting for Touch ID',
    });
    expect(platformLabels('windows').confirm).toBe('Confirm with Windows Hello');
    expect(platformLabels('other')).toEqual({
      confirm: 'Confirm with your passkey',
      waiting: 'Waiting for your passkey',
    });
    expect(detectPayPlatform('macOS')).toBe('mac');
    expect(detectPayPlatform('MacIntel')).toBe('mac');
    expect(detectPayPlatform('Win32')).toBe('windows');
    expect(detectPayPlatform('Linux x86_64')).toBe('other');
  });
});

describe('the sheet: a modal dialog (b11 §19.5)', () => {
  it('is labelled by its title, described by the amount and For, and focus starts on the title', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    mount(props());
    const d = dialog();
    expect(d.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(d.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe('Record proof');
    const described = (d.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(described).toContain('$0.10');
    expect(described).toContain('A proof with “Ana” (self-declared)');
    expect(document.activeElement).toBe(title);
    expect(document.activeElement?.textContent).not.toBe('Confirm with Touch ID');
    expect(buttonNamed('Confirm with Touch ID')?.autofocus).toBe(false);
    expect(d.querySelector('[aria-label="10 cents"]')?.textContent).toBe('$0.10');
    expect(d.textContent).toContain(P.trustCredits);
    expect(d.textContent).toContain(P.trustAi);
    // Focus returns to the control that opened it.
    act(() => root.render(h('div')));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('traps focus: Tab from the last control goes to the first', () => {
    mount(props());
    const focusables = [...dialog().querySelectorAll<HTMLElement>('button, input, a[href]')];
    const last = focusables[focusables.length - 1];
    act(() => last?.focus());
    press('Tab');
    expect(document.activeElement).toBe(focusables[0]);
  });

  it('Escape cancels, except while recording', () => {
    const p = props();
    mount(p);
    press('Escape');
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    const q = props({ phase: 'recording' });
    mount(q);
    act(() => dialog().focus());
    press('Escape');
    expect(q.onCancel).not.toHaveBeenCalled();
  });

  it('no passkey here: the backup code is the way, and Confirm is not offered', () => {
    mount(props({ canPasskey: false, phase: 'backup' }));
    expect(buttonNamed('Confirm with Touch ID')).toBeUndefined();
    const input = dialog().querySelector<HTMLInputElement>('input');
    expect(input?.type).toBe('password');
    expect(input?.autocomplete).toBe('off');
    const label = document.querySelector(`label[for="${input?.id ?? ''}"]`);
    expect(label?.textContent).toBe(P.codeLabel);
  });

  it('offers the backup code as a small secondary link', () => {
    const p = props();
    mount(p);
    const link = buttonNamed(P.useBackup);
    expect(link?.className).toContain('al-pay-link');
    act(() => link?.click());
    expect(p.onUseBackup).toHaveBeenCalled();
    mount(props({ backup: false }));
    expect(buttonNamed(P.useBackup)).toBeUndefined();
  });

  it('"Remember for this contact" is a checkbox named for the contact', () => {
    const onChange = vi.fn();
    mount(props({ remember: { checked: false, onChange } }));
    const box = dialog().querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(box?.closest('label')?.textContent).toContain(P.remember);
    act(() => box?.click());
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('every state, one live region (b11 §19.3, §19.5)', () => {
  const live = (): string =>
    document.querySelector('[role="dialog"] [aria-live="polite"]')?.textContent ?? '';

  it('Ready, Waiting, Recording and Done each say their word', () => {
    mount(props());
    expect(buttonNamed('Confirm with Touch ID')).toBeDefined();
    mount(props({ phase: 'waiting' }));
    expect(live()).toBe('Waiting for Touch ID');
    expect(dialog().querySelector('.al-pay-ring[data-state="waiting"]')).not.toBeNull();
    expect(buttonNamed('Confirm with Touch ID')).toBeUndefined();
    expect(buttonNamed(P.cancel)).toBeDefined();
    mount(props({ phase: 'recording' }));
    expect(live()).toBe(P.recordingProof);
    mount(props({ phase: 'done' }));
    expect(live()).toBe(P.doneProof);
    expect(dialog().querySelector('.al-pay-ring[data-state="done"] .al-pay-check')).not.toBeNull();
  });

  it('a limits change says its own words', () => {
    mount(props({ view: payConfirmView(LIMITS), phase: 'recording' }));
    expect(live()).toBe(P.recordingLimits);
    mount(props({ view: payConfirmView(LIMITS), phase: 'done' }));
    expect(live()).toBe(P.doneLimits);
  });

  it('a notice is polite; an error is assertive (role=alert)', () => {
    mount(props({ notice: { tone: 'info', text: P.cancelled } }));
    expect(live()).toBe(P.cancelled);
    mount(props({ notice: { tone: 'error', text: P.notVerified } }));
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(P.notVerified);
  });

  it('a closed state offers only Close', () => {
    const p = props({ closed: true, notice: { tone: 'info', text: P.expired } });
    mount(p);
    expect(buttonNamed('Confirm with Touch ID')).toBeUndefined();
    expect(buttonNamed(P.useBackup)).toBeUndefined();
    act(() => buttonNamed(P.close)?.click());
    expect(p.onClose).toHaveBeenCalled();
  });

  it('Done closes itself after about 1.2 s (D-132 decision 3)', () => {
    vi.useFakeTimers();
    const p = props({ phase: 'done' });
    mount(p);
    act(() => vi.advanceTimersByTime(1100));
    expect(p.onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('with reduced motion, Done waits for Close and nothing animates', () => {
    vi.useFakeTimers();
    const p = props({ phase: 'done', reducedMotion: true });
    mount(p);
    act(() => vi.advanceTimersByTime(5000));
    expect(p.onClose).not.toHaveBeenCalled();
    expect(dialog().getAttribute('data-motion')).toBe('reduced');
    act(() => buttonNamed(P.close)?.click());
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('copy (11 §5; b11 §19.6)', () => {
  const all = (): string[] => {
    const out: string[] = [];
    for (const value of Object.values(P)) {
      if (typeof value === 'string') out.push(value);
      else if (typeof value === 'function') out.push((value as (a: string) => string)('$0.10'));
    }
    for (const p of ['mac', 'windows', 'other'] as const) {
      out.push(platformLabels(p).confirm, platformLabels(p).waiting);
    }
    return out;
  };

  it('passes the vocabulary lint, and never says bank, deposit or payment method', () => {
    for (const text of all()) {
      expect(lintVocabulary(text), text).toEqual([]);
      expect(text).not.toMatch(
        /\b(wallet|bank|transaction|gas|deposit|payment method|balance top-up)\b/i,
      );
    }
  });

  it('has the owner-approved lines', () => {
    expect(P.trustCredits).toBe('Your credits stay yours; 4thTech never holds them.');
    expect(P.trustAi).toBe("Your AI can't confirm this for you.");
    expect(P.cancelled).toBe('Not confirmed. Nothing was paid.');
    expect(P.useBackup).toBe('Use backup code instead');
  });

  // M1-11b-2c: the server-rendered approval page, which drew this sheet without React and copied
  // these words, is gone; the local app renders this component, so there is no copy to compare.
});

// UI-REFRESH-f-b (S2): while the sheet is open, the page behind it is inert (no click, no Tab, no
// focus moved by script reaches it), so nothing on the page can act while the owner reads the
// amount and confirms. The hold is released whenever the sheet goes: closed, unmounted, after Done
// closes itself, after an error is closed, and with reduced motion after Close. jsdom does not
// enforce `inert`; the browser does, so these tests pin the attribute and its timing.
describe('the page behind the open sheet is inert (UI-REFRESH-f-b)', () => {
  let page: HTMLElement;
  let pageButton: HTMLButtonElement;
  beforeEach(() => {
    page = document.createElement('main');
    pageButton = document.createElement('button');
    pageButton.textContent = 'Something on the page';
    page.append(pageButton);
    document.body.prepend(page);
  });
  afterEach(() => {
    page.remove();
  });

  const inertNow = (): Element[] => [...document.querySelectorAll('[inert]')];

  /** A host that shows the sheet until its onClose runs, like the local app does. */
  function Host(p: { sheet: PayConfirmSheetProps }): ReactElement {
    const [open, setOpen] = useState(true);
    return open
      ? h(PayConfirmSheet, {
          ...p.sheet,
          onClose: () => {
            p.sheet.onClose();
            setOpen(false);
          },
        })
      : h('div');
  }

  it('holds the page inert while open; the sheet, its ancestors and the focus stay live', () => {
    mount(props());
    expect(page.hasAttribute('inert')).toBe(true);
    expect(dialog().closest('[inert]')).toBeNull();
    expect(host.hasAttribute('inert')).toBe(false);
    expect(document.activeElement?.closest('[inert]') ?? null).toBeNull();
  });

  it('keeps the hold across every phase (ready, waiting, recording, done, backup)', () => {
    for (const phase of ['ready', 'waiting', 'recording', 'done', 'backup'] as const) {
      mount(props({ phase, reducedMotion: true }));
      expect(page.hasAttribute('inert')).toBe(true);
    }
    act(() => root.render(h('div')));
    expect(inertNow()).toEqual([]);
  });

  it('releases the page when the sheet closes (the host stops rendering it)', () => {
    mount(props());
    act(() => root.render(h('div')));
    expect(page.hasAttribute('inert')).toBe(false);
    expect(inertNow()).toEqual([]);
  });

  it('releases the page when the sheet is unmounted', () => {
    mount(props());
    act(() => root.unmount());
    expect(page.hasAttribute('inert')).toBe(false);
    root = createRoot(host);
  });

  it('releases the page after Done closes itself (about 1.2 s, D-132)', () => {
    vi.useFakeTimers();
    const p = props({ phase: 'done' });
    act(() => root.render(h(Host, { sheet: p })));
    act(() => vi.advanceTimersByTime(1100));
    expect(page.hasAttribute('inert')).toBe(true);
    act(() => vi.advanceTimersByTime(200));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(page.hasAttribute('inert')).toBe(false);
  });

  it('stays inert while an error shows, and releases once it is closed', () => {
    const p = props({ notice: { tone: 'error', text: P.notVerified } });
    act(() => root.render(h(Host, { sheet: p })));
    expect(page.hasAttribute('inert')).toBe(true);
    const q = props({ closed: true, notice: { tone: 'error', text: P.refusedProof } });
    act(() => root.render(h(Host, { sheet: q })));
    expect(page.hasAttribute('inert')).toBe(true);
    act(() => buttonNamed(P.close)?.click());
    expect(q.onClose).toHaveBeenCalledTimes(1);
    expect(page.hasAttribute('inert')).toBe(false);
  });

  it('with reduced motion, stays inert after Done until Close, then releases', () => {
    vi.useFakeTimers();
    const p = props({ phase: 'done', reducedMotion: true });
    act(() => root.render(h(Host, { sheet: p })));
    act(() => vi.advanceTimersByTime(5000));
    expect(p.onClose).not.toHaveBeenCalled();
    expect(page.hasAttribute('inert')).toBe(true);
    act(() => buttonNamed(P.close)?.click());
    expect(page.hasAttribute('inert')).toBe(false);
  });

  it('focus still returns to the opener, and the opener is live when it gets it', () => {
    act(() => pageButton.focus());
    const seen: boolean[] = [];
    const focus = pageButton.focus.bind(pageButton);
    pageButton.focus = (o?: FocusOptions) => {
      seen.push(pageButton.closest('[inert]') !== null);
      focus(o);
    };
    mount(props());
    expect(page.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).not.toBe(pageButton);
    act(() => root.render(h('div')));
    expect(document.activeElement).toBe(pageButton);
    expect(seen).toEqual([false]);
  });

  it('leaves an element that was inert before the sheet opened inert after it closes', () => {
    const before = document.createElement('aside');
    before.setAttribute('inert', '');
    document.body.prepend(before);
    mount(props());
    act(() => root.render(h('div')));
    expect(before.hasAttribute('inert')).toBe(true);
    expect(page.hasAttribute('inert')).toBe(false);
    before.remove();
  });
});
