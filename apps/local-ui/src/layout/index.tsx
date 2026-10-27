// The shared frame: sidebar, content and status bar from the design system's AppShell. Content
// switches by route; the layout itself never changes (d1/screens/local). Seven sidebar items; the
// Settings item opens a sub-navigation (Backup, Passkeys, Advanced) above its page (D-120).
import { AppShell, type NavItem } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { NAV_ITEMS, SETTINGS_LABEL, SETTINGS_PAGES } from '../nav.js';
import { useUnseenMessages } from '../pages/messages/badge.js';
import { detectPlatform, passkeysAvailable } from '../pages/first-run/passkey.js';
import { createUpgradeApi } from '../pages/first-run/setup-api.js';
import type { Platform } from '../pages/first-run/strings.js';
import { SwitchToPasskeyBanner } from '../states/index.js';

/**
 * What the status bar shows. "Connected" may appear only when the local server reports healthy. No
 * health read exists yet, so the state stays "unknown" (shown as "Checking…"). The browser's offline
 * event is the one real signal we act on ("Not connected"); the online event only means the browser
 * has a network, not that the server is reachable, so it goes back to "unknown", never "connected".
 * Gap: a server health read should call `setConnectionState('connected')`.
 */
export type ConnectionState = 'unknown' | 'connected' | 'offline';

let current: ConnectionState = 'unknown';
const listeners = new Set<() => void>();

/** Record the connection state (called by whatever learns it: a server health read). */
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
    const onOnline = (): void => {
      if (current === 'offline') setConnectionState('unknown');
    };
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

// "Paused" means the user paused AgentLink, so it is never used for an unknown state.
const SHELL_STATE = {
  unknown: 'checking',
  connected: 'connected',
  offline: 'disconnected',
} as const;

function inSettings(path: string): boolean {
  return SETTINGS_PAGES.some((p) => p.path === path);
}

/**
 * M1-UX-FIRSTRUN-V2-c: true when the owner exists but approves only with the backup code (no
 * passkey) and this browser can make one. Any failure is false: the next step is a nudge, never a
 * gate, and nothing about it can be skipped or completed from here.
 */
export async function needsPasskeySwitch(): Promise<boolean> {
  if (!passkeysAvailable()) return false;
  const info = await createUpgradeApi().info();
  return info.kind === 'ok' && !info.registered;
}

const FIRST_RUN_PATH = '/first-run';

export interface LayoutProps {
  readonly path: string;
  readonly children?: ReactNode;
  /** Test seam: whether to show the "Switch to …" next step. Default: needsPasskeySwitch. */
  readonly nextStep?: () => Promise<boolean>;
  /** The platform the next step names. Default: detected from the browser. */
  readonly platform?: Platform;
  /** Test seam: the Messages badge count. Default: read from the local app. */
  readonly unseenMessages?: () => Promise<number>;
}

export function Layout({
  path,
  children,
  nextStep = needsPasskeySwitch,
  platform: givenPlatform,
  unseenMessages,
}: LayoutProps): ReactElement {
  const connection = useConnectionState();
  const unseen = useUnseenMessages(path, unseenMessages);
  const settings = inSettings(path);
  const [platform] = useState<Platform>(() => givenPlatform ?? detectPlatform());
  const [switchNeeded, setSwitchNeeded] = useState(false);
  useEffect(() => {
    if (path === FIRST_RUN_PATH) {
      setSwitchNeeded(false);
      return undefined;
    }
    let live = true;
    // Re-read on every page change, so the step is gone once the passkey is registered.
    nextStep().then(
      (needed) => {
        if (live) setSwitchNeeded(needed);
      },
      () => {
        if (live) setSwitchNeeded(false);
      },
    );
    return () => {
      live = false;
    };
  }, [path, nextStep]);
  const nav: NavItem[] = NAV_ITEMS.map((item) => ({
    icon: item.icon,
    label: item.label,
    href: item.path,
    active: item.routed && (item.label === SETTINGS_LABEL ? settings : item.path === path),
    ...(item.id === 'messages' && unseen > 0 ? { count: unseen } : {}),
  }));
  return (
    <AppShell nav={nav} connection={SHELL_STATE[connection]}>
      {switchNeeded && path !== FIRST_RUN_PATH ? (
        <SwitchToPasskeyBanner platform={platform} />
      ) : null}
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
