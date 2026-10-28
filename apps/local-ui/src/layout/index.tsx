// The shared frame: sidebar, content and status bar from the design system's AppShell. Content
// switches by route; the layout itself never changes (d1/screens/local). Nine sidebar items; the
// Settings item opens a sub-navigation (Backup, Passkeys, Appearance, Advanced) above its page (D-120).
// UI-REFRESH-f: a top bar with the page title and the global controls; the preferences reach every
// page through PrefsHood (the Under the hood switch).
import { AppShell, type NavItem } from '@4thtech-io/ui';
import { useEffect, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { NAV_ITEMS, SETTINGS_LABEL, SETTINGS_PAGES } from '../nav.js';
import { PrefsHood } from '../prefs/index.js';
import { PAGE_TITLES, SHELL_STRINGS } from '../strings.js';
import { TopBarControls } from './top-bar.js';
import { useUnseenMessages } from '../pages/messages/badge.js';
import { useApprovalsWaiting } from '../pages/approvals/badge.js';
import { detectPlatform, passkeysAvailable } from '../pages/first-run/passkey.js';
import { createUpgradeApi } from '../pages/first-run/setup-api.js';
import type { Platform } from '../pages/first-run/strings.js';
import { StartHereContext, startHereShown } from '../pages/home/start-here-context.js';
import type { StartHereReads } from '../pages/home/start-here.js';
import { useStartHere } from '../pages/home/use-start-here.js';
import { SwitchToPasskeyBanner } from '../states/index.js';
import type { ApiResult } from '../api/client.js';
import { subscribeHealth } from './health-feed.js';
import { readHealth as defaultReadHealth, type HealthState } from './health.js';

/**
 * What the status bar shows. "Connected" appears only when the local server's health read says the
 * agent is running (M1-11s-a-d, health.ts); until the first answer the state is "unknown" (shown as
 * "Checking…", at most 4 s). The browser's offline event shows "Not connected" and wins over the
 * health read while the browser stays offline; the online event goes back to "unknown", never
 * straight to "connected": the next health read decides.
 */
export type ConnectionState = 'unknown' | 'offline' | HealthState;

let current: ConnectionState = 'unknown';
const listeners = new Set<() => void>();

/** Record the connection state (called by whatever learns it: the server health read). */
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

const browserOffline = (): boolean =>
  typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * M1-11s-a-d: polls the health read while mounted and records the state; returns the app version
 * it reported (a plain version, or undefined).
 */
export function useHealth(
  read: () => Promise<ApiResult<unknown>> = defaultReadHealth,
): string | undefined {
  const [version, setVersion] = useState<string | undefined>(undefined);
  useEffect(() => {
    // A fresh poller starts from "Checking…": an earlier answer is not evidence for this one.
    if (current !== 'offline') setConnectionState('unknown');
    // The poller is shared with Home (health-feed.ts): one read per tick for the whole app.
    return subscribeHealth(read, {
      onState: (state, reported) => {
        // The browser's own offline signal wins while it lasts.
        if (!browserOffline()) setConnectionState(state);
        setVersion(reported);
      },
    });
  }, [read]);
  return version;
}

// "Paused" means the user paused AgentLink, so it is never used for an unknown state.
const SHELL_STATE = {
  unknown: 'checking',
  connected: 'connected',
  offline: 'disconnected',
  paused: 'paused',
  not_running: 'not-running',
  needs_setup: 'needs-setup',
} as const;

function inSettings(path: string): boolean {
  return SETTINGS_PAGES.some((p) => p.path === path);
}

/** The title in the top bar: the nav or Settings entry of the path, else the app's name. */
function pageTitleOf(path: string): string {
  if (path === '/first-run') return PAGE_TITLES.firstRun;
  const item = NAV_ITEMS.find((i) => i.path === path && i.label !== SETTINGS_LABEL);
  if (item !== undefined) return item.label;
  const page = SETTINGS_PAGES.find((p) => p.path === path);
  return page === undefined ? SHELL_STRINGS.appName : page.label;
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

/** UI-REFRESH-t: the first Tab stop. Focus goes to the page content (it is made focusable here). */
function skipToContent(event: MouseEvent<HTMLAnchorElement>): void {
  const main = document.querySelector<HTMLElement>('main.al-shell-content');
  if (main === null) return;
  event.preventDefault();
  main.setAttribute('tabindex', '-1');
  main.focus();
}

export interface LayoutProps {
  readonly path: string;
  readonly children?: ReactNode;
  /** Test seam: whether to show the "Switch to …" next step. Default: needsPasskeySwitch. */
  readonly nextStep?: () => Promise<boolean>;
  /** The platform the next step names. Default: detected from the browser. */
  readonly platform?: Platform;
  /** Test seam: the Messages badge count. Default: read from the local app. */
  readonly unseenMessages?: () => Promise<number>;
  /** Test seam: the Approvals badge count. Default: read from the local app. */
  readonly waitingApprovals?: () => Promise<number>;
  /** Test seam: the health read (M1-11s-a-d). Default: GET /api/ui/health. */
  readonly readHealth?: () => Promise<ApiResult<unknown>>;
  /** Test seam: the reads behind Start here (UX2-g). Default: the app's own. */
  readonly startHere?: StartHereReads;
}

export function Layout({
  path,
  children,
  nextStep = needsPasskeySwitch,
  platform: givenPlatform,
  unseenMessages,
  waitingApprovals,
  readHealth,
  startHere,
}: LayoutProps): ReactElement {
  const connection = useConnectionState();
  const version = useHealth(readHealth);
  const unseen = useUnseenMessages(path, unseenMessages);
  const waiting = useApprovalsWaiting(path, waitingApprovals);
  const settings = inSettings(path);
  // UX2-g: one Start here model for the shell: the Home dot, the card and the empty states.
  const start = useStartHere(startHere, path !== FIRST_RUN_PATH, path);
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
    // UI-REFRESH-o-d: the same shared tick badge as Approvals, read as "3 new".
    ...(item.id === 'messages' && unseen > 0
      ? { count: unseen, countLabel: SHELL_STRINGS.messagesNew }
      : {}),
    // UX2-g (B-11 §27.4): a dot on Home while Start here is shown; it goes with the card.
    ...(item.id === 'home' && startHereShown(start) ? { dotLabel: SHELL_STRINGS.homeSetup } : {}),
    // UI-REFRESH-o-b: the shared tick badge; it counts down as requests are decided.
    ...(item.id === 'approvals' && waiting > 0
      ? { count: waiting, countLabel: SHELL_STRINGS.approvalsWaiting }
      : {}),
  }));
  return (
    <PrefsHood>
      <a href="#al-main" className="al-skip al-text-body-sm" onClick={skipToContent}>
        {SHELL_STRINGS.skipToContent}
      </a>
      <AppShell
        nav={nav}
        pageTitle={pageTitleOf(path)}
        topBarEnd={<TopBarControls connection={connection} />}
        connection={SHELL_STATE[connection]}
        {...(version === undefined ? {} : { version })}
      >
        {switchNeeded && path !== FIRST_RUN_PATH ? (
          <SwitchToPasskeyBanner platform={platform} />
        ) : null}
        {settings ? (
          <nav aria-label="Settings" className="al-subnav al-chrome">
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
        <StartHereContext.Provider value={start}>{children}</StartHereContext.Provider>
      </AppShell>
    </PrefsHood>
  );
}
