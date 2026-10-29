// The shared frame: sidebar, content and status bar from the design system's AppShell. Content
// switches by route; the layout itself never changes (d1/screens/local).
// W4-SHELL (Decision 40; b11 §34.1, d2 console/home 1280 and 360): the agent switcher top left (first
// in the sidebar under the mark; at 360 at the start of the top bar), two destinations (Inbox and
// Contacts), the page title, and the avatar menu at the right (Settings, Advanced, Under the hood,
// Cmd+K). A Settings page shows the grouped Settings sub-navigation above it. The preferences reach
// every page through PrefsHood (the Under the hood switch).
import { AppShell, type NavItem } from '@4thtech-io/ui';
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { INBOX_PATH, NAV_ITEMS, OTHER_PAGES, SETTINGS_GROUPS, SETTINGS_PAGES } from '../nav.js';
import { PrefsHood } from '../prefs/index.js';
import { SHELL_STRINGS } from '../strings.js';
import { AgentSwitcher } from './agent-switcher.js';
import { GoTo } from './go-to.js';
import { AccountMenu, connectionChip } from './top-bar.js';
import { useUnseenMessages } from '../pages/messages/badge.js';
import { useApprovalsWaiting } from '../pages/approvals/badge.js';
import { detectPlatform, passkeysAvailable } from '../pages/first-run/passkey.js';
import { createUpgradeApi } from '../pages/first-run/setup-api.js';
import type { Platform } from '../pages/first-run/strings.js';
import { StartHereContext } from '../pages/home/start-here-context.js';
import type { StartHereReads } from '../pages/home/start-here.js';
import { useStartHere } from '../pages/home/use-start-here.js';
import { SwitchToPasskeyBanner } from '../states/index.js';
import type { ApiResult } from '../api/client.js';
import { TidyNote } from '../pages/agents/tidy-note.js';
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

/** The title in the top bar: the nav, Settings or other page entry of the path, else the app's name. */
function pageTitleOf(path: string): string {
  const item = NAV_ITEMS.find((i) => i.path === path);
  if (item !== undefined) return item.label;
  const page = SETTINGS_PAGES.find((p) => p.path === path);
  if (page !== undefined) return page.label;
  return OTHER_PAGES[path]?.title ?? SHELL_STRINGS.appName;
}

/** The nav item marked current on a path: its own, or the one a page belongs to (Approvals: Inbox). */
function navOf(path: string): string | undefined {
  if (NAV_ITEMS.some((i) => i.path === path)) return path;
  return OTHER_PAGES[path]?.nav;
}

const NARROW = '(max-width: 600px)';

/** True at 600 px and under, where the sidebar is the bottom bar (B-11 §13.2). */
function useNarrow(): boolean {
  return useSyncExternalStore(
    (on) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const query = window.matchMedia(NARROW);
      query.addEventListener?.('change', on);
      return () => query.removeEventListener?.('change', on);
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches,
  );
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
/** U3-invite: the join screen, in the same focused shell. */
const JOIN_PATH = '/settings/join';

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
  const narrow = useNarrow();
  const current = navOf(path);
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
    active: item.routed && item.path === current,
    // The Inbox carries what needs you first (approvals waiting), else the new messages: the same
    // shared tick badge (UI-REFRESH-o-b, -o-d), read as "3 waiting for you" or "3 new".
    ...(item.id === 'inbox' && waiting > 0
      ? { count: waiting, countLabel: SHELL_STRINGS.approvalsWaiting }
      : item.id === 'inbox' && unseen > 0
        ? { count: unseen, countLabel: SHELL_STRINGS.messagesNew }
        : {}),
  }));
  // U3-g (b11 §28): first run is a focused column, with no sidebar, top bar or status bar.
  // U3-invite (b11 §33.2): so is the join screen that ends it.
  if (path === FIRST_RUN_PATH || path === JOIN_PATH) {
    return (
      <PrefsHood>
        <a href="#al-main" className="al-skip al-text-body-sm" onClick={skipToContent}>
          {SHELL_STRINGS.skipToContent}
        </a>
        <main className="al-shell-content al-first-run" id="al-main">
          {children}
        </main>
      </PrefsHood>
    );
  }
  return (
    <PrefsHood>
      <a href="#al-main" className="al-skip al-text-body-sm" onClick={skipToContent}>
        {SHELL_STRINGS.skipToContent}
      </a>
      <AppShell
        nav={nav}
        pageTitle={pageTitleOf(path)}
        {...(narrow
          ? { topBarStart: <AgentSwitcher chip={connectionChip(connection)} place="bar" /> }
          : { sideTop: <AgentSwitcher chip={connectionChip(connection)} place="side" /> })}
        topBarEnd={<AccountMenu />}
        connection={SHELL_STATE[connection]}
        {...(version === undefined ? {} : { version })}
      >
        {switchNeeded && path !== FIRST_RUN_PATH ? (
          <SwitchToPasskeyBanner platform={platform} />
        ) : null}
        {settings ? (
          <nav aria-label="Settings" className="al-subnav al-chrome">
            {SETTINGS_GROUPS.map((group) => (
              <div key={group.label} className="al-subnav-group">
                <span className="al-subnav-label al-text-label al-muted">{group.label}</span>
                {group.pages.map((p) => (
                  <a
                    key={p.path}
                    href={p.path}
                    className={p.path === path ? 'is-active' : undefined}
                    aria-current={p.path === path ? 'page' : undefined}
                  >
                    {p.label}
                  </a>
                ))}
              </div>
            ))}
          </nav>
        ) : null}
        <StartHereContext.Provider value={start}>
          {/* The one-time Tidy up note (b11 §29.7), on the home: the Inbox (and Home while it stays). */}
          {path === INBOX_PATH || path === '/settings/home' ? <TidyNote /> : null}
          {children}
        </StartHereContext.Provider>
      </AppShell>
      <GoTo />
    </PrefsHood>
  );
}
