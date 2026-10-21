// @vitest-environment jsdom
// M1-35b: behaviour in a DOM (S1): keyboard, focus, live regions and axe-core (WCAG 2.1 AA). The
// colour-contrast rule needs real layout and the real tokens, so jsdom cannot run it: contrast is
// proved from the token pairs (tokens.test.ts, M1-35a) and the rule is switched off here only.
import axe from 'axe-core';
import { createElement as h, act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtures, XSS } from './components.fixture.js';
import * as ui from './index.js';

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

function mount(el: ReactElement): void {
  act(() => root.render(el));
}
function key(el: Element, k: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}
function click(el: Element): void {
  act(() => (el as HTMLElement).click());
}
const q = <T extends Element = HTMLElement>(sel: string): T => {
  const el = host.querySelector<T>(sel);
  if (el === null) throw new Error(`missing ${sel}`);
  return el;
};
const byText = (tag: string, text: string): HTMLElement => {
  const el = [...host.querySelectorAll<HTMLElement>(tag)].find((e) =>
    e.textContent?.includes(text),
  );
  if (el === undefined) throw new Error(`missing ${tag} with ${text}`);
  return el;
};

describe('axe-core: zero WCAG 2.1 AA violations in every component state', () => {
  it.each(Object.keys(fixtures))('%s', async (name) => {
    mount(h('main', null, fixtures[name]!()));
    const result = await axe.run(host, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(result.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe('ApprovalCard focus and buttons (04 §2.5, 11 §8)', () => {
  const props = { type: 'proof', agent: 'work-agent', headline: 'Add proof' } as const;
  it('puts focus on the headline, never on Approve', () => {
    mount(h(ui.ApprovalCard, { ...props, method: 'Touch ID' }));
    expect(document.activeElement).toBe(q('h2'));
    expect(document.activeElement?.textContent).not.toContain('Approve');
  });
  it('tabs Deny then Approve and calls the handlers once per click', () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    mount(h(ui.ApprovalCard, { ...props, method: 'Touch ID', onApprove, onDeny }));
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Deny', 'Approve with Touch ID']);
    click(buttons[1]!);
    expect(onApprove).toHaveBeenCalledTimes(1);
    click(buttons[0]!);
    expect(onDeny).toHaveBeenCalledTimes(1);
  });
  it('disables both while waiting for the passkey and announces it politely', () => {
    mount(h(ui.ApprovalCard, { ...props, state: 'waiting', method: 'your passkey' }));
    for (const b of host.querySelectorAll('button')) expect(b.disabled).toBe(true);
    expect(q('[aria-live="polite"]').textContent).toContain('Waiting for your passkey');
  });
  it('shows no buttons once decided', () => {
    mount(h(ui.ApprovalCard, { ...props, state: 'approved' }));
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });
  it('the remember checkbox starts unchecked and reports its change', () => {
    const onRememberChange = vi.fn();
    mount(
      h(ui.ApprovalCard, {
        ...props,
        remember: { reason: 'ask-me', contactName: 'Marko', rule: 'Allow up to $1' },
        onRememberChange,
      }),
    );
    const box = q<HTMLInputElement>('input[type="checkbox"]');
    expect(box.checked).toBe(false);
    click(box);
    expect(onRememberChange).toHaveBeenCalledWith(true);
  });
});

describe('CommitmentCard buttons', () => {
  it('names the method and does not autofocus a button', () => {
    const onApprove = vi.fn();
    mount(h(ui.CommitmentCard, { headline: 'Deal', who: 'Marko', method: 'Touch ID', onApprove }));
    expect(document.activeElement?.tagName).not.toBe('BUTTON');
    click(byText('button', 'Accept with Touch ID'));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });
});

describe('Button', () => {
  it('ignores autoFocus', () => {
    mount(h(ui.Button, { autoFocus: true } as never, 'Go'));
    expect(document.activeElement).not.toBe(q('button'));
  });
  it('does not fire when disabled', () => {
    const onClick = vi.fn();
    mount(h(ui.Button, { disabled: true, onClick }, 'Go'));
    click(q('button'));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Switch', () => {
  it('toggles with a click, Space and Enter, and reports the new value', () => {
    const onChange = vi.fn();
    mount(h(ui.Switch, { label: 'Confirm', defaultChecked: false, onChange }));
    const sw = q('[role="switch"]');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(sw.textContent).toContain('On');
  });
  it('is a native button, so Space and Enter work, and is labelled by its row', () => {
    mount(h(ui.Switch, { label: 'Confirm deliveries', description: 'Public' }));
    expect(q('[role="switch"]').tagName).toBe('BUTTON');
    expect(q('label').textContent).toContain('Confirm deliveries');
  });
  it('does nothing when disabled', () => {
    const onChange = vi.fn();
    mount(h(ui.Switch, { label: 'x', disabled: true, onChange }));
    click(q('[role="switch"]'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Segmented', () => {
  const options = [
    { value: 'allowed', label: 'Allowed' },
    { value: 'ask', label: 'Ask me', hint: 'recommended' },
    { value: 'never', label: 'Never' },
  ];
  it('is a radio group with one tab stop and arrow-key selection', () => {
    const onChange = vi.fn();
    mount(h(ui.Segmented, { label: 'Files', options, defaultValue: 'ask', onChange }));
    const radios = [...host.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    key(radios[1]!, 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('never');
    expect(radios[2]!.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radios[2]);
    key(radios[2]!, 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('allowed');
    key(radios[0]!, 'ArrowLeft');
    expect(onChange).toHaveBeenLastCalledWith('never');
  });
  it('marks the recommended option in words', () => {
    mount(h(ui.Segmented, { label: 'Files', options }));
    expect(host.textContent).toContain('recommended');
  });
});

describe('SafetyCode', () => {
  it('calls the match and mismatch handlers', () => {
    const onMatch = vi.fn();
    const onMismatch = vi.fn();
    mount(h(ui.SafetyCode, { code: '1234 5678 9012', contactName: 'Marko', onMatch, onMismatch }));
    click(byText('button', 'They match'));
    click(byText('button', 'They don'));
    expect(onMatch).toHaveBeenCalledTimes(1);
    expect(onMismatch).toHaveBeenCalledTimes(1);
  });
});

describe('SecretDisplay (never echoes the secret elsewhere)', () => {
  it('keeps Continue disabled until "I\'ve saved it" is ticked', () => {
    const onContinue = vi.fn();
    mount(h(ui.SecretDisplay, { value: 'ABCD EFGH', onContinue }));
    const cont = byText('button', 'Continue') as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    click(cont);
    expect(onContinue).not.toHaveBeenCalled();
    click(q('input[type="checkbox"]'));
    expect(cont.disabled).toBe(false);
    click(cont);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
  it('copies through the handler and does not put the secret in an attribute', () => {
    const onCopy = vi.fn();
    mount(h(ui.SecretDisplay, { value: 'ABCD EFGH', onCopy }));
    click(byText('button', 'Copy'));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(host.innerHTML.match(/ABCD EFGH/g)).toBeNull(); // shown in groups, not as one string
    expect(host.innerHTML.replace(/<[^>]*>/g, '')).toContain('ABCDEFGH');
  });
});

describe('CopyPrompt', () => {
  it('copies the exact text and says Copied in a live region', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount(h(ui.CopyPrompt, { prompt: 'Set up AgentLink' }));
    await act(async () => byText('button', 'Copy').click());
    expect(writeText).toHaveBeenCalledWith('Set up AgentLink');
    expect(host.textContent).toContain('Copied');
  });
  it('survives a missing clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    mount(h(ui.CopyPrompt, { command: 'agentlink ui' }));
    await act(async () => byText('button', 'Copy').click());
    expect(host.textContent).toContain('agentlink ui');
  });
});

describe('Toast', () => {
  it('reports the action and the dismiss, and never takes focus', () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    mount(h(ui.Toast, { action: 'Undo', onAction, onDismiss }, 'Saved'));
    expect(document.activeElement).toBe(document.body);
    click(byText('button', 'Undo'));
    click(q('[aria-label="Dismiss"]'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('TextField', () => {
  it('connects the label, the input and the hint, and passes paste-friendly props through', () => {
    mount(h(ui.TextField, { label: 'Owner code', hint: 'Paste it', autoComplete: 'off' }));
    const input = q<HTMLInputElement>('input');
    expect(host.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
    expect(input.getAttribute('aria-describedby')).not.toBeNull();
    expect(input.type).not.toBe('password');
  });
  it('gives two fields different ids', () => {
    mount(h('div', null, h(ui.TextField, { label: 'A' }), h(ui.TextField, { label: 'B' })));
    const ids = [...host.querySelectorAll('input')].map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('TrayMenu and AppShell keyboard', () => {
  it('moves through the tray items with the arrow keys', () => {
    mount(h(ui.TrayMenu, { os: 'macos', approvals: 1 }));
    const items = [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.length).toBeGreaterThanOrEqual(3);
    act(() => items[0]!.focus());
    key(items[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    key(items[1]!, 'ArrowUp');
    expect(document.activeElement).toBe(items[0]);
  });
  it('AppShell nav links are real links in a labelled nav', () => {
    mount(fixtures['AppShell/default']!());
    expect(host.querySelectorAll('nav[aria-label="Main"] a').length).toBe(2);
  });
});

describe('XSS fixtures render inert in every component (I-5)', () => {
  const hostile: Record<string, ReactElement> = {
    ContactName: h(ui.ContactName, { alias: XSS, fingerprint: 'AB' }),
    ContactCard: h(ui.ContactCard, { alias: XSS, agent: XSS, aiApp: XSS, lastActivity: XSS }),
    UntrustedContent: h(ui.UntrustedContent, { from: XSS, fileName: XSS }),
    ApprovalCard: h(ui.ApprovalCard, { type: 'proof', agent: XSS, headline: XSS, who: XSS }),
    CommitmentCard: h(ui.CommitmentCard, { headline: XSS, who: XSS, proposer: XSS, subject: XSS }),
    TermsDiff: h(ui.TermsDiff, { rows: [{ field: XSS, old: XSS, new: XSS }] }),
    FileCard: h(ui.FileCard, { name: XSS, size: XSS, from: XSS }),
    EmptyState: h(ui.EmptyState, { title: XSS, prompt: XSS }),
    Banner: h(ui.Banner, { title: XSS }, XSS),
    Toast: h(ui.Toast, { action: XSS }, XSS),
    TextField: h(ui.TextField, { label: XSS, hint: XSS, error: XSS }),
    CopyPrompt: h(ui.CopyPrompt, { prompt: XSS, title: XSS, note: XSS }),
    SecretDisplay: h(ui.SecretDisplay, { value: XSS, label: XSS, explain: XSS }),
    SafetyCode: h(ui.SafetyCode, { code: XSS, contactName: XSS }),
    CreditsMeter: h(ui.CreditsMeter, { balance: XSS, proofsLeft: 1, spentLast24h: 1, budget: 2 }),
    ReceiptTimeline: h(ui.ReceiptTimeline, {
      steps: [{ key: 'delivered', label: XSS, time: XSS, done: true }],
    }),
  };
  it.each(Object.keys(hostile))('%s creates no element from the text', (name) => {
    mount(hostile[name]!);
    expect(host.querySelector('img, script, [onerror], [onload]')).toBeNull();
    expect(host.querySelectorAll('svg[onload]')).toHaveLength(0);
    expect(host.querySelector('a')).toBeNull();
    for (const el of host.querySelectorAll('*')) {
      for (const a of el.getAttributeNames()) expect(a.startsWith('on'), a).toBe(false);
    }
  });
});
