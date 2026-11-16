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
  const pageProps: AppearancePageProps = {
    read: () => Promise.resolve(stored),
    save: (change: UiSettings) => {
      saved.push(change);
      return Promise.resolve(ok ?? true);
    },
    ...rest,
  };
  await act(async () => {
    root.render(h(AppearancePage, pageProps));
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

  it('a late first read never overrides a switch the owner already toggled', async () => {
    let answer: (s: UiSettings | undefined) => void = () => undefined;
    const pending = new Promise<UiSettings | undefined>((r) => {
      answer = r;
    });
    const pageProps: AppearancePageProps = {
      platform: 'mac',
      read: () => pending,
      save: (change) => {
        saved.push(change);
        return Promise.resolve(true);
      },
    };
    await act(async () => {
      root.render(h(AppearancePage, pageProps));
      await Promise.resolve();
    });
    await act(async () => {
      sw(S.previewsLabel).click();
      await Promise.resolve();
    });
    expect(sw(S.previewsLabel).getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      answer({ menuBarIcon: false, widgetPreviews: true });
      await pending;
      await Promise.resolve();
    });
    // The untouched switch takes the stored value; the toggled one keeps the owner's choice.
    expect(sw(S.menuBarMac).getAttribute('aria-checked')).toBe('false');
    expect(sw(S.previewsLabel).getAttribute('aria-checked')).toBe('false');
    expect(saved).toEqual([{ widgetPreviews: false }]);
  });

  it('a quick double toggle with a failed save never reverts to an outdated value', async () => {
    const answers: ((ok: boolean) => void)[] = [];
    const pageProps: AppearancePageProps = {
      platform: null,
      read: () => Promise.resolve({ widgetPreviews: true }),
      save: (change) => {
        saved.push(change);
        return new Promise<boolean>((r) => answers.push(r));
      },
    };
    await act(async () => {
      root.render(h(AppearancePage, pageProps));
      await Promise.resolve();
    });
    const tick = async (fn: () => void): Promise<void> => {
      await act(async () => {
        fn();
        await Promise.resolve();
        await Promise.resolve();
      });
    };
    // off (save 1), then on again (save 2) before either answers.
    await tick(() => sw(S.previewsLabel).click());
    await tick(() => sw(S.previewsLabel).click());
    expect(saved).toEqual([{ widgetPreviews: false }, { widgetPreviews: true }]);
    expect(sw(S.previewsLabel).getAttribute('aria-checked')).toBe('true');
    // Both fail: the older failure changes nothing; the newest reverts to what the app holds (on),
    // never to the value seen when it was clicked (off).
    await tick(() => answers[0]?.(false));
    expect(sw(S.previewsLabel).getAttribute('aria-checked')).toBe('true');
    expect(host.textContent).not.toContain(S.traySaveFailed);
    await tick(() => answers[1]?.(false));
    expect(sw(S.previewsLabel).getAttribute('aria-checked')).toBe('true');
    expect(host.textContent).toContain(S.traySaveFailed);

    // Saved off (3) lands, then on (4) fails: it shows what the app holds (off), not the
    // value from before save 3.
    await tick(() => sw(S.previewsLabel).click());
    await tick(() => sw(S.previewsLabel).click());
    await tick(() => answers[2]?.(true));
    await tick(() => answers[3]?.(false));
    expect(sw(S.previewsLabel).getAttribute('aria-checked')).toBe('false');
    expect(host.textContent).toContain(S.traySaveFailed);
  });

  it('copy is exact and uses plain words (11 §5)', () => {
    expect(S.menuBarHint).toBe('Quick look at messages, approvals and your connected AI apps.');
    expect(S.menuBarWindowsHint).toBe('While it is hidden, closing the window quits AgentLink.');
    expect(S.previewsLabel).toBe('Show message previews');
    expect(S.previewsHint).toBe('Show the first line of new messages in the menu bar widget.');
    expect(
      lintVocabulary(
        [
          S.menuBarMac,
          S.menuBarWindows,
          S.menuBarHint,
          S.menuBarWindowsHint,
          S.previewsLabel,
          S.previewsHint,
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});
