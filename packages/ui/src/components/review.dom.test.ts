// @vitest-environment jsdom
// M1-35b-b: "review together" (brief B-2, D-68; 04 §2.5.2, 11 §5.1, §8). Behaviour in a DOM (S1, I-4,
// I-5): no default decision, no autofocus on Approve, the summary names exactly what is included,
// at most 20 cards soonest-to-expire first, terms are never in the list, hostile text stays inert.
import axe from 'axe-core';
import { createElement as h, act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XSS } from './components.fixture.js';
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
const mount = (el: ReactElement): void => act(() => root.render(el));
const click = (el: Element): void => act(() => (el as HTMLElement).click());
const q = <T extends Element = HTMLElement>(sel: string): T => {
  const el = host.querySelector<T>(sel);
  if (el === null) throw new Error(`missing ${sel}`);
  return el;
};
const item = (id: string, extra: Partial<ui.ReviewItem> = {}): ui.ReviewItem => ({
  id,
  type: 'proof',
  agent: 'work-agent',
  headline: `Add proof ${id}`,
  ...extra,
});
const view = (props: Partial<ui.ReviewTogetherProps> = {}): ReactElement =>
  h(ui.ReviewTogether, {
    agent: 'work-agent',
    items: [item('a'), item('b'), item('c'), item('d')],
    decisions: {},
    onDecide: () => undefined,
    onConfirm: () => undefined,
    ...props,
  });

describe('decisionSummary', () => {
  it('names exactly what is included', () => {
    expect(ui.decisionSummary({ approve: 3, deny: 1 })).toBe('Approve 3 and deny 1');
    expect(ui.decisionSummary({ approve: 4, deny: 0 })).toBe('Approve 4');
    expect(ui.decisionSummary({ approve: 0, deny: 2 })).toBe('Deny 2');
    expect(ui.decisionSummary({ approve: 1, deny: 1 })).toBe('Approve 1 and deny 1');
  });
  it('is undefined when nothing is included', () => {
    expect(ui.decisionSummary({ approve: 0, deny: 0 })).toBeUndefined();
  });
});

describe('ReviewTogether', () => {
  it('shows the heading with the count, the footer and no autofocus on a control', () => {
    mount(view());
    expect(q('h1').textContent).toBe('Waiting for you (4)');
    expect(host.textContent).toContain("Your AI can't approve this for you.");
    expect(document.activeElement?.tagName).not.toBe('BUTTON');
    expect(document.activeElement?.tagName).not.toBe('INPUT');
  });
  it('starts with no decision chosen anywhere and the summary button disabled', () => {
    mount(view());
    for (const r of host.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
      expect(r.checked).toBe(false);
    }
    expect(q<HTMLButtonElement>('[data-review-confirm]').disabled).toBe(true);
    expect(host.textContent).not.toContain('This covers exactly');
  });
  it('offers Approve, Deny and Later on every card, as a labelled group', () => {
    mount(view());
    const groups = host.querySelectorAll('fieldset');
    expect(groups).toHaveLength(4);
    const labels = [...groups[0]!.querySelectorAll('label')].map((l) => l.textContent);
    expect(labels).toEqual(['Approve', 'Deny', 'Later']);
    expect(groups[0]!.querySelector('legend')?.textContent).toContain('Add proof a');
  });
  it('reports a choice and names the included cards on the button', () => {
    const onDecide = vi.fn();
    mount(
      view({ onDecide, decisions: { a: 'approve', b: 'approve', c: 'approve', d: 'deny' } }),
    );
    const summary = q<HTMLButtonElement>('[data-review-confirm]');
    expect(summary.textContent).toContain('Approve 3 and deny 1');
    expect(summary.disabled).toBe(false);
    expect(host.textContent).toContain(
      'This covers exactly these 4. Anything new waits for your next review.',
    );
    click(host.querySelectorAll<HTMLInputElement>('input[value="later"]')[0]!);
    expect(onDecide).toHaveBeenCalledWith('a', 'later');
  });
  it('does not count Later', () => {
    mount(view({ decisions: { a: 'approve', b: 'later', c: 'later', d: 'later' } }));
    expect(q('[data-review-confirm]').textContent).toContain('Approve 1');
    expect(host.textContent).toContain('This covers exactly these 1.');
  });
  it('calls onConfirm once per click and names the presence method', () => {
    const onConfirm = vi.fn();
    mount(view({ onConfirm, method: 'owner code', decisions: { a: 'approve' } }));
    expect(host.textContent).toContain('owner code');
    click(q('[data-review-confirm]'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
  it('lists soonest to expire first and shows at most 20; the rest wait', () => {
    const items = Array.from({ length: 23 }, (_, i) =>
      item(`i${i}`, { headline: `P${i}`, expiresAt: 1000 - i }),
    );
    mount(view({ items }));
    const heads = [...host.querySelectorAll('article h2')].map((e) => e.textContent);
    expect(heads).toHaveLength(20);
    expect(heads[0]).toBe('P22');
    expect(heads[19]).toBe('P3');
    expect(q('h1').textContent).toBe('Waiting for you (23)');
    expect(host.textContent).toContain('3 more are waiting. They show after this review.');
  });
  it('keeps terms out of the list: its own Approve, never in the summary', () => {
    const onApprove = vi.fn();
    const items = [item('a'), item('t', { decideAlone: true, onApprove, headline: 'Accept terms' })];
    mount(view({ items, decisions: { a: 'approve' } }));
    expect(host.textContent).toContain('Decide this one on its own');
    const terms = host.querySelectorAll('article')[1]!;
    expect(terms.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    click([...terms.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Approve'))!);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(q('[data-review-confirm]').textContent).toContain('Approve 1');
    expect(host.textContent).toContain('This covers exactly these 1.');
  });
  it('shows an expired card without choices and leaves it out of the count', () => {
    mount(
      view({
        items: [item('a'), item('b', { status: 'expired' })],
        decisions: { a: 'approve', b: 'approve' },
      }),
    );
    expect(host.querySelectorAll('fieldset')).toHaveLength(1);
    expect(host.textContent).toContain('This request expired.');
    expect(host.textContent).toContain('This covers exactly these 1.');
  });
  it('shows a card decided elsewhere without choices', () => {
    mount(view({ items: [item('a', { status: 'decided-elsewhere' })] }));
    expect(host.querySelectorAll('fieldset')).toHaveLength(0);
    expect(host.textContent).toContain('Already decided in your terminal or another window.');
  });
  it('nothing waiting: an empty state and no summary button', () => {
    mount(view({ items: [] }));
    expect(host.textContent).toContain('Nothing is waiting for you.');
    expect(host.querySelector('[data-review-confirm]')).toBeNull();
  });
  it('waiting for presence disables every control and announces it politely', () => {
    mount(view({ phase: 'waiting', decisions: { a: 'approve' } }));
    for (const el of host.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) {
      expect(el.disabled).toBe(true);
    }
    expect(q('[aria-live="polite"]').textContent).toContain('Confirm in the system prompt');
  });
  it('presence failed: says nothing was applied and keeps the choices', () => {
    mount(view({ phase: 'failed', decisions: { a: 'approve', b: 'deny' } }));
    expect(q('[role="alert"]').textContent).toContain('Nothing was applied');
    expect(host.querySelector<HTMLInputElement>('input[value="approve"]')?.checked).toBe(true);
    expect(q<HTMLButtonElement>('[data-review-confirm]').disabled).toBe(false);
  });
  it('done: shows a result per card and no buttons', () => {
    mount(
      view({
        phase: 'done',
        results: { a: 'approved', b: 'denied', c: 'later', d: 'expired' },
      }),
    );
    expect(host.querySelector('[data-review-confirm]')).toBeNull();
    expect(host.querySelectorAll('input')).toHaveLength(0);
    const text = host.textContent ?? '';
    expect(text).toContain('Approved. Your AI will continue.');
    expect(text).toContain('Denied. Nothing was sent.');
    expect(text).toContain('Left for later. It stays in your list.');
    expect(text).toContain('This request expired.');
  });
  it('has no accessibility violations (WCAG 2.1 AA) in the main states', async () => {
    for (const el of [
      view({ decisions: { a: 'approve', d: 'deny' } }),
      view({ items: [] }),
      view({ phase: 'failed' }),
      view({ phase: 'done', results: { a: 'approved' } }),
    ]) {
      mount(el);
      const r = await axe.run(host, {
        runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(r.violations.map((v) => v.id)).toEqual([]);
    }
  });
});

describe('review safety (I-5, 08 §4)', () => {
  it('renders hostile text inert and writes no style attribute', () => {
    const out = renderToStaticMarkup(
      view({ items: [item('x', { headline: XSS, who: XSS, what: XSS })] }),
    );
    expect(out).not.toMatch(/<script|<img|<svg|onerror=|onload=/i);
    expect(out).not.toMatch(/\sstyle=/);
  });
  it('uses no forbidden words in the default view', () => {
    const text = renderToStaticMarkup(
      view({ phase: 'failed', decisions: { a: 'approve' }, method: 'passkey' }),
    );
    expect(text).not.toMatch(/wallet|\bgas\b|seed phrase|transaction|0x[0-9a-f]{6}/i);
  });
});
