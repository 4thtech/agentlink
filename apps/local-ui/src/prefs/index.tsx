// UI-REFRESH-e: preferences for React. `usePrefs` follows the store; `PrefsHood` hands the Under the
// hood switch to every panel below it (the top bar switch comes with UI-REFRESH-f).
import { HoodProvider } from '@4thtech-io/ui';
import { useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { getPrefs, subscribePrefs, type Prefs } from './store.js';

export * from './store.js';

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);
}

export function PrefsHood({ children }: { children?: ReactNode }): ReactElement {
  const { hood } = usePrefs();
  return <HoodProvider value={hood}>{children}</HoodProvider>;
}
