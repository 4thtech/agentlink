// @vitest-environment jsdom
// TRAY-TOGGLE (D-155; 11 §5): Settings › Appearance has "Show AgentLink in the menu bar" (Mac) or
// "near the clock" (Windows), desktop app only, and "Show message previews". Both are kept by the
// app in ui-settings; absent = on.
import { lintVocabulary } from '@4thtech-io/ui';
import type { UiSettings } from '@4thtech-io/types/ui-contract/ui-settings';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetPrefsForTests } from '../../prefs/index.js';
import { AppearancePage, type AppearancePageProps } from './index.js';
import { APPEARANCE_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement;
let root: Root;
let saved: UiSettings[];

beforeEach(() => {
  localStorage.clear();
  resetPrefsForTests();
  saved = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(
  props: Partial<AppearancePageProps> & { stored?: UiSettings; ok?: boolean },
): Promise<void> {
  const { stored, ok, ...rest } = props;
  await act(async () => {
    root.render(
      h(AppearancePage, {
        read: () => Promise.resolve(stored),
        save: (change: UiSettings) => {
          saved.push(change);
          return Promise.resolve(ok ?? true);
        },
        ...rest,
      }),
    );
    await Promise.resolve();
  });
}

const row = (label: string): HTMLElement | undefined =>
  [...host.querySelectorAll<HTMLElement>('.al-switch-row')].find((r) =>
    r.textContent?.includes(label),
  );
const sw = (label: string): HTMLButtonElement =>
  row(label)?.querySelector('[role="switch"]') as HTMLButtonElement;

describe('Appearance: menu bar widget switches', () => {
  it('in a browser shows only "Show message previews", on by default', async () => {
    await render({ platform: null });
    expect(row(S.menuBarMac)).toBeUndefined();
    expect(row(S.menuBarWindows)).toBeUndefined();
    expect(row(S.previewsLabel)?.textContent).toContain(S.previewsHint);
    expect(sw(S.previewsLabel).getAttribute('aria-checked')).toBe('true');
  });

  it('on a Mac says "menu bar", on by default', async () => {
    await render({ platform: 'mac' });
    expect(S.menuBarMac).toBe('Show AgentLink in the menu bar');
    const r = row(S.menuBarMac);
    expect(r?.textContent).toContain(S.menuBarHint);
    expect(r?.textContent).not.toContain(S.menuBarWindowsHint);
    expect(row(S.menuBarWindows)).toBeUndefined();
    expect(sw(S.menuBarMac).getAttribute('aria-checked')).toBe('true');
  });

  it('on Windows says "near the clock" and that closing the window quits while hidden', async () => {
    await render({ platform: 'windows' });
    expect(S.menuBarWindows).toBe('Show AgentLink near the clock');
    const r = row(S.menuBarWindows);
    expect(r?.textContent).toContain(S.menuBarHint);
    expect(r?.textContent).toContain(S.menuBarWindowsHint);
    expect(row(S.menuBarMac)).toBeUndefined();
  });

  it('shows the stored values and saves each change as its own boolean', async () => {
    await render({ platform: 'mac', stored: { menuBarIcon: false, widgetPreviews: true } });
    expect(sw(S.menuBarMac).getAttribute('aria-checked')).toBe('false');
    expect(sw(S.previewsLabel).getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      sw(S.menuBarMac).click();
      await Promise.resolve();
    });
    await act(async () => {
      sw(S.previewsLabel).click();
      await Promise.resolve();
    });
    expect(saved).toEqual([{ menuBarIcon: true }, { widgetPreviews: false }]);
    expect(sw(S.menuBarMac).getAttribute('aria-checked')).toBe('true');
    expect(sw(S.previewsLabel).getAttribute('aria-checked')).toBe('false');
  });

  it('a failed save puts the switch back', async () => {
    await render({ platform: 'windows', ok: false });
    await act(async () => {
      sw(S.previewsLabel).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(saved).toEqual([{ widgetPreviews: false }]);
    expect(sw(S.previewsLabel).getAttribute('aria-checked')).toBe('true');
  });

  it('copy is exact and uses plain words (11 §5)', () => {
    expect(S.menuBarHint).toBe('Quick look at messages, approvals and your connected AI apps.');
    expect(S.menuBarWindowsHint).toBe('While it is hidden, closing the window quits AgentLink.');
    expect(S.previewsLabel).toBe('Show message previews');
    expect(S.previewsHint).toBe('Show the first line of new messages in the menu bar widget.');
    expect(
      lintVocabulary(
        [S.menuBarMac, S.menuBarWindows, S.menuBarHint, S.menuBarWindowsHint, S.previewsLabel, S.previewsHint].join('\n'),
      ),
    ).toEqual([]);
  });
});
