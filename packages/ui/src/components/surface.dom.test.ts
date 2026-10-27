// @vitest-environment jsdom
// UI-REFRESH-b (S1): Surface levels, Sheet and the level-4 dialog frame (B-11 §13.1). DOM tests per
// level and state, focus trap, Escape, focus return and one level-4 layer at a time.
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DialogFrame, Sheet, Surface, type SurfaceLevel } from './index.js';

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

const render = (node: ReactNode): void => {
  act(() => root.render(node));
};
const key = (el: Element, k: string, shiftKey = false): void => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true }));
  });
};

describe('Surface', () => {
  const LEVELS: SurfaceLevel[] = [0, 1, 2, 3, 4, 'recessed'];

  it('renders every level with its own class and data-level', () => {
    for (const level of LEVELS) {
      render(h(Surface, { level, id: 's' }, 'x'));
      const el = host.querySelector('#s') as HTMLElement;
      const cls = level === 'recessed' ? 'recessed' : `l${level}`;
      expect(el.classList.contains('al-surface'), String(level)).toBe(true);
      expect(el.classList.contains(`al-surface--${cls}`), String(level)).toBe(true);
      expect(el.dataset.level).toBe(String(level));
    }
  });

  it('defaults to level 1 and renders the requested element', () => {
    render(h(Surface, { as: 'section', id: 's' }, 'x'));
    const el = host.querySelector('#s') as HTMLElement;
    expect(el.tagName).toBe('SECTION');
    expect(el.dataset.level).toBe('1');
    expect(el.classList.contains('al-surface--interactive')).toBe(false);
  });

  it('marks an interactive surface so it rises one level (never at level 4)', () => {
    for (const level of LEVELS) {
      render(h(Surface, { level, interactive: true, id: 's' }, 'x'));
      const el = host.querySelector('#s') as HTMLElement;
      expect(el.classList.contains('al-surface--interactive'), String(level)).toBe(level !== 4);
    }
  });

  it('keeps the caller class and passes other attributes through', () => {
    render(h(Surface, { className: 'mine', id: 'a1' }, 'x'));
    const el = host.firstElementChild as HTMLElement;
    expect(el.classList.contains('mine')).toBe(true);
    expect(el.id).toBe('a1');
  });
});

function sheetTree(onClose: () => void, open = true): ReactNode {
  return h(
    'div',
    null,
    h('button', { id: 'opener' }, 'Open'),
    h(
      Sheet,
      { open, title: 'Marko', onClose },
      h('button', { id: 'one' }, 'One'),
      h('button', { id: 'two' }, 'Two'),
    ),
  );
}

describe('Sheet', () => {
  it('renders nothing while closed', () => {
    render(sheetTree(() => undefined, false));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('is a level-3 modal dialog named by its title, with focus on the title', () => {
    render(sheetTree(() => undefined));
    const dlg = host.querySelector('[role="dialog"]') as HTMLElement;
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(dlg.classList.contains('al-sheet')).toBe(true);
    expect(dlg.classList.contains('al-surface--l3')).toBe(true);
    const title = host.querySelector(`#${dlg.getAttribute('aria-labelledby')}`) as HTMLElement;
    expect(title.textContent).toBe('Marko');
    expect(document.activeElement).toBe(title);
  });

  it('Escape closes it', () => {
    const onClose = vi.fn();
    render(sheetTree(onClose));
    key(document.activeElement as Element, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the close button closes it', () => {
    const onClose = vi.fn();
    render(sheetTree(onClose));
    const close = host.querySelector('.al-sheet-close') as HTMLButtonElement;
    expect(close.getAttribute('aria-label')).toBe('Close');
    act(() => close.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab inside: last wraps to first, Shift+Tab on the first wraps to last', () => {
    render(sheetTree(() => undefined));
    const first = host.querySelector('.al-sheet-close') as HTMLElement;
    const last = host.querySelector('#two') as HTMLElement;
    last.focus();
    key(last, 'Tab');
    expect(document.activeElement).toBe(first);
    key(first, 'Tab', true);
    expect(document.activeElement).toBe(last);
  });

  it('returns focus to the opener when it closes', () => {
    render(sheetTree(() => undefined, false));
    const opener = host.querySelector('#opener') as HTMLElement;
    opener.focus();
    render(sheetTree(() => undefined, true));
    expect(document.activeElement).not.toBe(opener);
    render(sheetTree(() => undefined, false));
    expect(document.activeElement).toBe(opener);
  });
});

function dialogTree(a: boolean, b: boolean): ReactNode {
  return h(
    'div',
    null,
    h('button', { id: 'opener' }, 'Open'),
    h(
      DialogFrame,
      { open: a, title: 'First', onClose: () => undefined },
      h('button', { id: 'a' }, 'A'),
    ),
    h(
      DialogFrame,
      { open: b, title: 'Second', onClose: () => undefined },
      h('button', { id: 'b' }, 'B'),
    ),
  );
}

describe('DialogFrame', () => {
  it('is a level-4 modal over the overlay, focus on the title, Escape closes', () => {
    const onClose = vi.fn();
    render(h(DialogFrame, { open: true, title: 'Confirm', onClose }, h('button', null, 'Go')));
    const dlg = host.querySelector('[role="dialog"]') as HTMLElement;
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(dlg.classList.contains('al-surface--l4')).toBe(true);
    expect(dlg.parentElement?.classList.contains('al-dialog-overlay')).toBe(true);
    expect(document.activeElement?.textContent).toBe('Confirm');
    key(document.activeElement as Element, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps Tab inside the frame', () => {
    render(
      h(
        DialogFrame,
        { open: true, title: 'Confirm', onClose: () => undefined },
        h('button', { id: 'x' }, 'X'),
        h('button', { id: 'y' }, 'Y'),
      ),
    );
    const first = host.querySelector('#x') as HTMLElement;
    const last = host.querySelector('#y') as HTMLElement;
    last.focus();
    key(last, 'Tab');
    expect(document.activeElement).toBe(first);
    key(first, 'Tab', true);
    expect(document.activeElement).toBe(last);
  });

  it('returns focus to the opener on close', () => {
    render(dialogTree(false, false));
    const opener = host.querySelector('#opener') as HTMLElement;
    opener.focus();
    render(dialogTree(true, false));
    render(dialogTree(false, false));
    expect(document.activeElement).toBe(opener);
  });

  it('shows one level-4 layer at a time: a second one waits until the first closes', () => {
    render(dialogTree(true, true));
    expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(host.querySelector('#a')).not.toBeNull();
    expect(host.querySelector('#b')).toBeNull();
    render(dialogTree(false, true));
    expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(host.querySelector('#b')).not.toBeNull();
  });
});
