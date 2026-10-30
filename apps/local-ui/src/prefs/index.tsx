// UI-REFRESH-e: preferences for React. `usePrefs` follows the store; `PrefsHood` hands the Under the
// hood switch to every panel below it. W4-SHELL-V2: Under the hood and the section menu are kept by
// the local app (ui-settings.ts); `useMenuExpanded` follows the menu's state.
import { HoodProvider } from '@4thtech-io/ui';
import { useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { getPrefs, subscribePrefs, type Prefs } from './store.js';
import {
  getMenuExpanded,
  subscribeMenuExpanded,
  subscribeUiSettingsSettled,
  uiSettingsSettled,
} from './ui-settings.js';

export * from './store.js';
export * from './ui-settings.js';

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);
}

export function useMenuExpanded(): boolean {
  return useSyncExternalStore(subscribeMenuExpanded, getMenuExpanded, getMenuExpanded);
}

/** W4-SHELL-LIVE: whether the app's settings are read (Under the hood and the menu hold). */
export function useUiSettingsSettled(): boolean {
  return useSyncExternalStore(subscribeUiSettingsSettled, uiSettingsSettled, uiSettingsSettled);
}

export function PrefsHood({ children }: { children?: ReactNode }): ReactElement {
  const { hood } = usePrefs();
  return <HoodProvider value={hood}>{children}</HoodProvider>;
}
