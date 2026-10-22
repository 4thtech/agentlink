// The shared frame: sidebar, content and status bar from the design system's AppShell. Content
// switches by route; the layout itself never changes (d1/screens/local). Seven sidebar items; the
// Settings item opens a sub-navigation (Backup, Passkeys, Advanced) above its page (D-120).
import { AppShell, type NavItem } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { NAV_ITEMS, SETTINGS_LABEL, SETTINGS_PAGES } from '../nav.js';

/**
 * What the status bar shows. The server exposes no connection status to the app yet, so the only
 * real signal is the browser's own online state; until one is known the value is "unknown" and the
 * bar never says "Connected". Gap: a server health endpoint should feed `setConnectionState`.
 */
export type ConnectionState = 'unknown' | 'connected' | 'offline';

let current: ConnectionState = 'unknown';
const listeners = new Set<() => void>();

/** Record the connection state (called by whatever learns it: the API client once it exposes one). */
export function setConnectionState(next: ConnectionState): void {
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

export function useConnectionState(): ConnectionState {
  const [state, setState] = useState<ConnectionState>(current);
  useEffect(() => {
    const sync = (): void => setState(current);
    const onOffline = (): void => setConnectionState('offline');
    const onOnline = (): void => setConnectionState('connected');
    listeners.add(sync);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    sync();
    return () => {
      listeners.delete(sync);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);
  return state;
}

// The shell has no "unknown" look: show the neutral Paused state rather than a false Connected.
const SHELL_STATE = { unknown: 'paused', connected: 'connected', offline: 'offline' } as const;

function inSettings(path: string): boolean {
  return SETTINGS_PAGES.some((p) => p.path === path);
}

export function Layout({ path, children }: { path: string; children: ReactNode }): ReactElement {
  const connection = useConnectionState();
  const settings = inSettings(path);
  const nav: NavItem[] = NAV_ITEMS.map((item) => ({
    icon: item.icon,
    label: item.label,
    href: item.path,
    active: item.routed && (item.label === SETTINGS_LABEL ? settings : item.path === path),
  }));
  return (
    <AppShell nav={nav} connection={SHELL_STATE[connection]}>
      {settings ? (
        <nav aria-label="Settings" className="al-subnav">
          {SETTINGS_PAGES.map((p) => (
            <a
              key={p.path}
              href={p.path}
              className={p.path === path ? 'is-active' : undefined}
              aria-current={p.path === path ? 'page' : undefined}
            >
              {p.label}
            </a>
          ))}
        </nav>
      ) : null}
      {children}
    </AppShell>
  );
}
