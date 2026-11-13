// @vitest-environment jsdom
// N1: the one copy button. It copies, says "Copied" for COPIED_MS, announces it once, and says
// plainly when the clipboard refused.
import { createElement as h, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPIED_MS, CopyButton, HEALTH_GRACE_MS } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const live = (): string => host.querySelector('[role="status"]')?.textContent ?? '';
const button = (): HTMLButtonElement => host.querySelector('button') as HTMLButtonElement;

describe('CopyButton', () => {
  it('has one timing constant for the notice system', () => {
    expect(COPIED_MS).toBe(1_600);
    expect(HEALTH_GRACE_MS).toBe(5_000);
  });

  it('copies, says Copied, announces once and goes back', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    act(() => root.render(h(CopyButton, { text: 'npx agentlink' })));
    expect(button().textContent).toBe('Copy');
    await act(async () => {
      button().click();
    });
    expect(writeText).toHaveBeenCalledWith('npx agentlink');
    expect(button().textContent).toBe('Copied');
    expect(live()).toBe('Copied');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COPIED_MS + 10);
    });
    expect(button().textContent).toBe('Copy');
    expect(live()).toBe('');
  });

  it('says so when the clipboard refuses or is missing', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error()) },
    });
    act(() => root.render(h(CopyButton, { text: 'x', failedLabel: 'Copy it yourself.' })));
    await act(async () => {
      button().click();
    });
    expect(button().textContent).toBe('Copy');
    expect(live()).toBe('Copy it yourself.');
    vi.stubGlobal('navigator', {});
    await act(async () => {
      button().click();
    });
    expect(live()).toBe('Copy it yourself.');
  });
});
